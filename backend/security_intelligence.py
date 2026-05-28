"""AI security analyst.

Runs every 15 minutes (via automations._tick). Pulls the last quarter
hour of security-shaped events from MongoDB, enriches each unique IP
through ipapi.co (+ optional AbuseIPDB), forms a structured stats
summary, asks Claude to triage it, and:

  1. Optionally auto-bans IPs flagged as high/critical (gated by the
     `system_config.security_config.ai_auto_ban_enabled` kill switch).
  2. Emails the configured alert recipients when threat_level rises.
  3. Persists every analysis to `security_events` for audit trail.

Hard rules
==========
- Never raises out of `run_ai_security_analysis` — the scheduler
  treats the function as best-effort.
- Never logs PHI. Only emails, IPs, and event metadata.
- Skips network calls entirely when ANTHROPIC_API_KEY is unset
  (test environment) — returns a safe no-op summary.
- Private IPs (RFC1918 + loopback) skip the ipapi lookup.
- Kill switch (`ai_auto_ban_enabled=False`) always works even when
  the AI call itself failed.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx


logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────────
_ANALYSIS_WINDOW_MIN = 15
_AUTO_BAN_DAYS = 30
_AI_MODEL = "claude-sonnet-4-6"
_AI_MAX_TOKENS = 1500
_IP_LOOKUP_TIMEOUT = 6.0          # seconds
_IP_LOOKUPS_PER_CYCLE = 20        # cap network round-trips per tick
_IPAPI_URL = "https://ipapi.co/{ip}/json/"
_ABUSEIPDB_URL = "https://api.abuseipdb.com/api/v2/check"

_VPN_HINTS = ("vpn", "proxy", "hosting", "datacenter", "data center",
              "digital ocean", "linode", "amazon", "aws ", "google cloud",
              "microsoft azure", "ovh", "hetzner")
_TOR_HINTS = ("tor", "exit node")

_SECURITY_CONFIG_KEY = "security_config"
_DEFAULT_ALERT_EMAILS: List[str] = []   # populated from env fallback below


# ── Config (system_config singleton) ───────────────────────────────────────
async def get_security_config(db) -> Dict[str, Any]:
    """Read the security-config singleton. Returns sensible defaults
    when no document exists yet — first-boot safe."""
    try:
        doc = await db.system_config.find_one(
            {"_id": _SECURITY_CONFIG_KEY}, {"_id": 0},
        )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("security_config read failed: %s", e)
        doc = None
    if not doc:
        admin = (os.getenv("ADMIN_EMAIL") or "").strip()
        return {
            "ai_auto_ban_enabled": True,
            "auto_ban_threshold": 10,
            "alert_emails": [admin] if admin else [],
            "agent_ip_whitelist": [],
            "last_updated": None,
            "updated_by": None,
        }
    doc.setdefault("ai_auto_ban_enabled", True)
    doc.setdefault("auto_ban_threshold", 10)
    doc.setdefault("alert_emails", [])
    doc.setdefault("agent_ip_whitelist", [])
    return doc


async def set_security_config(
    db, updates: Dict[str, Any], actor_email: Optional[str] = None,
) -> Dict[str, Any]:
    """Patch the security_config singleton + return the full doc."""
    payload = dict(updates)
    payload["last_updated"] = datetime.now(timezone.utc).isoformat()
    payload["updated_by"] = actor_email
    await db.system_config.update_one(
        {"_id": _SECURITY_CONFIG_KEY},
        {"$set": payload},
        upsert=True,
    )
    return await get_security_config(db)


# ── IP helpers ─────────────────────────────────────────────────────────────
def _is_private_ip(ip: str) -> bool:
    """RFC1918 + loopback + link-local. Skips lookup for these."""
    if not ip or not isinstance(ip, str):
        return True
    try:
        addr = ipaddress.ip_address(ip.strip())
    except ValueError:
        return True
    return addr.is_private or addr.is_loopback or addr.is_link_local


def _classify_org(org: str) -> Dict[str, bool]:
    o = (org or "").lower()
    is_vpn = any(h in o for h in _VPN_HINTS)
    is_tor = any(h in o for h in _TOR_HINTS)
    return {"is_vpn": is_vpn, "is_proxy": is_vpn, "is_tor": is_tor}


async def lookup_ip(ip: str, db) -> Dict[str, Any]:
    """Enriched IP intelligence with 24h cache.

    Returns a dict (never raises). For private IPs returns
    ``{"ip": ip, "private": True}`` without calling out.
    """
    if not ip:
        return {"ip": "", "error": "empty"}
    if _is_private_ip(ip):
        return {"ip": ip, "private": True}

    # Cache check
    try:
        cached = await db.ip_intelligence.find_one(
            {"ip": ip}, {"_id": 0},
        )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ip_intelligence cache read failed for %s: %s", ip, e)
        cached = None
    if cached:
        return cached

    enriched: Dict[str, Any] = {"ip": ip}
    try:
        async with httpx.AsyncClient(timeout=_IP_LOOKUP_TIMEOUT) as client:
            r = await client.get(_IPAPI_URL.format(ip=ip))
            if r.status_code == 200:
                d = r.json() or {}
                if isinstance(d, dict) and not d.get("error"):
                    org = d.get("org") or d.get("asn") or ""
                    enriched.update({
                        "country": d.get("country_name") or "",
                        "country_code": d.get("country_code") or "",
                        "city": d.get("city") or "",
                        "region": d.get("region") or "",
                        "isp": d.get("org") or d.get("asn") or "",
                        "org": org,
                        "hostname": d.get("hostname") or "",
                        "latitude": d.get("latitude"),
                        "longitude": d.get("longitude"),
                        "timezone": d.get("timezone") or "",
                        **_classify_org(org),
                    })
                else:
                    enriched["lookup_error"] = "ipapi_rejected"
            else:
                enriched["lookup_error"] = f"ipapi_http_{r.status_code}"
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ipapi lookup failed for %s: %s", ip, e)
        enriched["lookup_error"] = "ipapi_exception"

    # Optional AbuseIPDB
    abuse_key = (os.getenv("ABUSEIPDB_API_KEY") or "").strip()
    if abuse_key:
        try:
            async with httpx.AsyncClient(timeout=_IP_LOOKUP_TIMEOUT) as client:
                r = await client.get(
                    _ABUSEIPDB_URL,
                    headers={"Key": abuse_key, "Accept": "application/json"},
                    params={"ipAddress": ip, "maxAgeInDays": 90},
                )
                if r.status_code == 200:
                    data = (r.json() or {}).get("data") or {}
                    enriched["threat_score"] = int(data.get("abuseConfidenceScore") or 0)
                    enriched["abuse_reports"] = int(data.get("totalReports") or 0)
                    enriched["is_whitelisted"] = bool(data.get("isWhitelisted"))
                else:
                    enriched["abuseipdb_error"] = f"http_{r.status_code}"
        except Exception as e:                                # noqa: BLE001
            logger.warning("AbuseIPDB lookup failed for %s: %s", ip, e)
            enriched["abuseipdb_error"] = "exception"

    enriched["lookup_at"] = datetime.now(timezone.utc)

    # Cache (best-effort)
    try:
        await db.ip_intelligence.update_one(
            {"ip": ip},
            {"$set": enriched},
            upsert=True,
        )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ip_intelligence cache write failed for %s: %s", ip, e)

    return enriched


# ── Stats collection ───────────────────────────────────────────────────────
async def _collect_stats(
    db, phi_db, window_minutes: int = _ANALYSIS_WINDOW_MIN,
) -> Dict[str, Any]:
    """Pull every relevant counter / row from the last ``window_minutes``.

    The shape is the input we feed to Claude — keep it concise + JSON-
    serializable so the prompt budget stays bounded.
    """
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=window_minutes)
    bulk_window = now - timedelta(minutes=window_minutes)

    out: Dict[str, Any] = {
        "window_minutes": window_minutes,
        "window_start": window_start.isoformat(),
        "window_end": now.isoformat(),
    }

    # (a) Failed logins — login_attempts records have `attempted_at` and
    #     are created with `locked_until=None` for plain failures,
    #     `locked_until=<datetime>` for the lockout marker.
    try:
        fl = await db.login_attempts.find({
            "attempted_at": {"$gte": window_start},
            "locked_until": None,
        }, {"_id": 0, "email": 1, "attempted_at": 1}).to_list(length=500)
        by_email: Dict[str, int] = {}
        for row in fl:
            email = (row.get("email") or "").lower().strip()
            if email:
                by_email[email] = by_email.get(email, 0) + 1
        out["failed_logins"] = {
            "count": len(fl),
            "unique_emails": len(by_email),
            "top_targets": sorted(
                [{"email": k, "count": v} for k, v in by_email.items()],
                key=lambda r: r["count"], reverse=True,
            )[:10],
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("collect failed_logins failed: %s", e)
        out["failed_logins"] = {"error": "unavailable"}

    # (b) Currently-locked accounts.
    try:
        locked = await db.login_attempts.find(
            {"locked_until": {"$gt": now}},
            {"_id": 0, "email": 1, "locked_until": 1},
        ).to_list(length=100)
        out["accounts_locked"] = [
            {"email": r.get("email"),
             "locked_until": (
                 r.get("locked_until").isoformat()
                 if hasattr(r.get("locked_until"), "isoformat")
                 else str(r.get("locked_until") or "")
             )}
            for r in locked
        ]
    except Exception as e:                                    # noqa: BLE001
        logger.warning("collect accounts_locked failed: %s", e)
        out["accounts_locked"] = []

    # (c) Booking attacks — outcome != "success".
    try:
        ba = await db.booking_attempts.find({
            "created_at": {"$gte": window_start},
            "outcome": {"$nin": [None, "success"]},
        }, {"_id": 0, "ip": 1, "outcome": 1, "slug": 1,
            "created_at": 1}).to_list(length=500)
        by_ip: Dict[str, Dict[str, Any]] = {}
        for r in ba:
            ip = r.get("ip") or "unknown"
            d = by_ip.setdefault(ip, {"ip": ip, "count": 0, "slugs": set(),
                                       "outcomes": set()})
            d["count"] += 1
            if r.get("slug"):
                d["slugs"].add(r["slug"])
            if r.get("outcome"):
                d["outcomes"].add(r["outcome"])
        out["booking_attacks"] = {
            "count": len(ba),
            "unique_ips": len(by_ip),
            "by_ip": [
                {
                    "ip": d["ip"], "count": d["count"],
                    "slugs": sorted(d["slugs"])[:5],
                    "outcomes": sorted(d["outcomes"]),
                }
                for d in sorted(by_ip.values(),
                                 key=lambda r: r["count"], reverse=True)[:10]
            ],
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("collect booking_attacks failed: %s", e)
        out["booking_attacks"] = {"error": "unavailable"}

    # (d) Active IP bans.
    try:
        bans = await db.booking_blocks.find(
            {"expires_at": {"$gt": now}},
            {"_id": 0, "ip": 1, "blocked_at": 1, "expires_at": 1},
        ).to_list(length=200)
        out["ip_bans_active"] = [{
            "ip": r.get("ip"),
            "blocked_at": (r.get("blocked_at").isoformat()
                            if hasattr(r.get("blocked_at"), "isoformat")
                            else str(r.get("blocked_at") or "")),
            "expires_at": (r.get("expires_at").isoformat()
                            if hasattr(r.get("expires_at"), "isoformat")
                            else str(r.get("expires_at") or "")),
        } for r in bans]
    except Exception as e:                                    # noqa: BLE001
        logger.warning("collect ip_bans_active failed: %s", e)
        out["ip_bans_active"] = []

    # (e) Audit anomalies.
    try:
        # Bulk access: actor_ids with >50 events in window.
        bulk_pipeline = [
            {"$match": {"timestamp": {"$gte": bulk_window.isoformat()}}},
            {"$group": {"_id": "$actor_id", "count": {"$sum": 1}}},
            {"$match": {"count": {"$gt": 50}}},
            {"$sort": {"count": -1}},
            {"$limit": 10},
        ]
        bulk = []
        async for r in db.audit_logs.aggregate(bulk_pipeline):
            if r.get("_id"):
                bulk.append({"actor_id": r["_id"], "count": r["count"]})
        # High-value events.
        hv_types = ["lead_export", "mbi_viewed", "bulk_delete",
                     "audit_log_exported"]
        hv = await db.audit_logs.find({
            "event_type": {"$in": hv_types},
            "timestamp": {"$gte": bulk_window.isoformat()},
        }, {"_id": 0, "event_type": 1, "actor_email": 1,
            "ip_address": 1, "timestamp": 1}).to_list(length=50)
        out["audit_anomalies"] = {
            "bulk_actors": bulk,
            "high_value_events": hv,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("collect audit_anomalies failed: %s", e)
        out["audit_anomalies"] = {"bulk_actors": [], "high_value_events": []}

    # (f) Abandoned MFA sessions.
    try:
        abandoned = await db.mfa_pending_sessions.count_documents({
            "used": False, "expires_at": {"$lt": now},
        })
        out["mfa_abandoned"] = abandoned
    except Exception as e:                                    # noqa: BLE001
        logger.warning("collect mfa_abandoned failed: %s", e)
        out["mfa_abandoned"] = 0

    # IP source candidates (for enrichment + impossible travel)
    candidate_ips: set = set()
    for r in (out.get("audit_anomalies", {}) or {}).get("high_value_events", []):
        ip = r.get("ip_address")
        if ip:
            candidate_ips.add(ip)
    for r in (out.get("booking_attacks", {}) or {}).get("by_ip", []):
        if r.get("ip"):
            candidate_ips.add(r["ip"])
    for r in (out.get("ip_bans_active", []) or []):
        if r.get("ip"):
            candidate_ips.add(r["ip"])
    out["_candidate_ips"] = list(candidate_ips)[:_IP_LOOKUPS_PER_CYCLE]
    return out


async def _enrich_ips(stats: Dict[str, Any], db) -> Dict[str, Any]:
    """Attach IP intelligence to the booking_attacks.by_ip + ip_bans_active
    rows in-place. Caps at _IP_LOOKUPS_PER_CYCLE per tick."""
    ips_to_lookup = stats.get("_candidate_ips") or []
    enrichment: Dict[str, Dict[str, Any]] = {}
    for ip in ips_to_lookup:
        enrichment[ip] = await lookup_ip(ip, db)

    for row in (stats.get("booking_attacks", {}) or {}).get("by_ip", []):
        ip = row.get("ip")
        if ip and ip in enrichment:
            row["intel"] = enrichment[ip]
    for row in (stats.get("ip_bans_active", []) or []):
        ip = row.get("ip")
        if ip and ip in enrichment:
            row["intel"] = enrichment[ip]
    stats["ip_enrichments"] = enrichment
    return stats


# ── Impossible travel ──────────────────────────────────────────────────────
async def detect_impossible_travel(db) -> List[Dict[str, Any]]:
    """Same-actor events from different countries within 30 minutes.

    Looks back 2 hours. IP→country resolution uses the ip_intelligence
    cache (does NOT trigger fresh ipapi lookups — that's a separate
    code path so this is cheap on every call).
    """
    try:
        window = datetime.now(timezone.utc) - timedelta(hours=2)
        cursor = db.audit_logs.find(
            {
                "timestamp": {"$gte": window.isoformat()},
                "actor_id": {"$nin": [None, ""]},
                "ip_address": {"$nin": [None, ""]},
            },
            {"_id": 0, "actor_id": 1, "actor_email": 1,
             "ip_address": 1, "timestamp": 1},
        ).sort("timestamp", 1)
        by_actor: Dict[str, List[Dict[str, Any]]] = {}
        async for r in cursor:
            by_actor.setdefault(r["actor_id"], []).append(r)

        # IP cache lookup helper (cache-only).
        async def _country_for(ip: str) -> Optional[str]:
            if _is_private_ip(ip):
                return None
            try:
                row = await db.ip_intelligence.find_one(
                    {"ip": ip}, {"_id": 0, "country_code": 1},
                )
                return (row or {}).get("country_code") or None
            except Exception:
                return None

        flagged: List[Dict[str, Any]] = []
        for actor_id, events in by_actor.items():
            if len(events) < 2:
                continue
            for prev, curr in zip(events, events[1:]):
                try:
                    t_prev = datetime.fromisoformat(
                        (prev.get("timestamp") or "")
                        .replace("Z", "+00:00"),
                    )
                    t_curr = datetime.fromisoformat(
                        (curr.get("timestamp") or "")
                        .replace("Z", "+00:00"),
                    )
                except Exception:
                    continue
                gap_min = abs((t_curr - t_prev).total_seconds()) / 60.0
                if gap_min > 30:
                    continue
                ip_prev = prev.get("ip_address")
                ip_curr = curr.get("ip_address")
                if not ip_prev or not ip_curr or ip_prev == ip_curr:
                    continue
                c_prev = await _country_for(ip_prev)
                c_curr = await _country_for(ip_curr)
                if c_prev and c_curr and c_prev != c_curr:
                    flagged.append({
                        "actor_id": actor_id,
                        "actor_email": prev.get("actor_email"),
                        "ip1": ip_prev, "country1": c_prev,
                        "ip2": ip_curr, "country2": c_curr,
                        "time_gap_minutes": round(gap_min, 1),
                        "flagged": True,
                    })
        return flagged
    except Exception as e:                                    # noqa: BLE001
        logger.warning("impossible-travel detection failed: %s", e)
        return []


# ── Claude call ────────────────────────────────────────────────────────────
_SYSTEM_PROMPT = """You are a cybersecurity AI analyst for GHW Medicare \
Portal, a HIPAA-regulated healthcare platform serving Medicare insurance \
agents and their clients. Your job is to analyze security events from the \
last 15 minutes and identify real threats vs. normal activity.

The platform has 79 agents across the US. Normal activity includes:
- Agents logging in during business hours (8am-8pm their timezone)
- Clients booking appointments via public booking pages
- Agents accessing their own client records

Suspicious activity includes:
- Login attempts from foreign IPs, VPNs, or Tor nodes
- Credential stuffing (many different emails from one IP)
- Booking page abuse (high-volume requests)
- After-hours access from unfamiliar IPs
- Impossible travel (same account, two distant locations)
- Bulk data access (unusual number of records in short time)

Respond ONLY with valid JSON — no preamble, no markdown fences. \
JSON structure:
{
  "threat_level": "low|medium|high|critical",
  "summary": "One paragraph plain-English summary of security posture",
  "findings": [
    {
      "type": "credential_stuffing|booking_abuse|impossible_travel|\
after_hours|bulk_access|suspicious_ip|account_takeover",
      "severity": "low|medium|high|critical",
      "description": "Plain English description of the threat",
      "affected_ips": ["1.2.3.4"],
      "affected_accounts": ["email@example.com"],
      "recommended_action": "ban_ip|lock_account|alert_only|monitor",
      "auto_actionable": true
    }
  ],
  "auto_ban_ips": ["list of IPs that should be banned immediately"],
  "alert_required": true,
  "false_positive_risk": "low|medium|high"
}
"""

_SAFE_AI_DEFAULT = {
    "threat_level": "unknown",
    "summary": "AI analysis unavailable.",
    "findings": [],
    "auto_ban_ips": [],
    "alert_required": False,
    "false_positive_risk": "high",
}


async def _call_claude(stats: Dict[str, Any]) -> Dict[str, Any]:
    """Ask Claude to triage. Returns the parsed JSON dict or safe
    defaults on any failure. Never raises."""
    api_key = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
    if not api_key:
        logger.info("security_intelligence: ANTHROPIC_API_KEY unset — skipping AI call")
        return dict(_SAFE_AI_DEFAULT)
    try:
        # Strip the private-only helper key before serialising.
        payload = {k: v for k, v in stats.items() if not k.startswith("_")}
        user_msg = json.dumps(payload, default=str, indent=2)
        # Defensive cap — the prompt budget for the model is generous
        # but no point sending 200KB of repetitive structure.
        if len(user_msg) > 60_000:
            user_msg = user_msg[:60_000] + "\n…[truncated]"

        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=api_key)
        response = await client.messages.create(
            model=_AI_MODEL,
            max_tokens=_AI_MAX_TOKENS,
            system=[{
                "type": "text",
                "text": _SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{"role": "user", "content": user_msg}],
        )
        # Metering — fire-and-forget. Security analysis is a platform-
        # owned cost (runs every 15 min regardless of tenant activity)
        # so it bills to the GHW agency. Phase 4 may split it per-
        # tenant if we ever surface per-agency security findings.
        try:
            from metering import track_ai_usage
            from deps import get_agency_id
            usage = getattr(response, "usage", None)
            track_ai_usage(
                agency_id=get_agency_id(),
                agent_id=None,
                event_type="security_analysis",
                tokens_in=int(getattr(usage, "input_tokens", 0) or 0),
                tokens_out=int(getattr(usage, "output_tokens", 0) or 0),
                model=_AI_MODEL,
            )
        except Exception as _e:                                # noqa: BLE001
            logger.debug("security_intelligence: metering hook failed: %s", _e)
        # response.content is a list of content blocks; concatenate any
        # text blocks (we asked for JSON, but some clients echo the
        # structure).
        text = ""
        for block in (response.content or []):
            t = getattr(block, "text", None)
            if t:
                text += t
        text = (text or "").strip()
        # Strip accidental markdown fences just in case.
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        try:
            parsed = json.loads(text)
        except Exception:
            logger.warning("security_intelligence: AI returned non-JSON; raw=%r",
                            text[:300])
            return dict(_SAFE_AI_DEFAULT)
        # Light schema normalization — make sure required keys exist.
        for k, default in (
            ("threat_level", "low"),
            ("summary", ""),
            ("findings", []),
            ("auto_ban_ips", []),
            ("alert_required", False),
            ("false_positive_risk", "medium"),
        ):
            parsed.setdefault(k, default)
        return parsed
    except Exception as e:                                    # noqa: BLE001
        logger.warning("security_intelligence: Claude call failed: %s", e)
        return dict(_SAFE_AI_DEFAULT)


# ── Auto-actions ───────────────────────────────────────────────────────────
async def execute_auto_ban(
    db, ip: str, reason: str, source: str = "ai_auto_ban",
    duration_days: int = _AUTO_BAN_DAYS,
) -> bool:
    """Add an IP to booking_blocks (with TTL) AND ip_permanent_bans
    (with explicit expiry). Returns True on success."""
    if not ip:
        return False
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=duration_days)
    try:
        await db.booking_blocks.update_one(
            {"ip": ip},
            {"$set": {
                "ip": ip,
                "blocked_at": now,
                "expires_at": expires,
                "reason": reason or source,
                "source": source,
            }},
            upsert=True,
        )
        await db.ip_permanent_bans.update_one(
            {"ip": ip},
            {"$set": {
                "ip": ip,
                "banned_at": now,
                "expires_at": expires,
                "reason": reason or source,
                "source": source,
            }},
            upsert=True,
        )
        return True
    except Exception as e:                                    # noqa: BLE001
        logger.warning("auto_ban write failed for %s: %s", ip, e)
        return False


async def unban_ip(db, ip: str) -> bool:
    """Remove from both ban collections. Idempotent."""
    if not ip:
        return False
    try:
        await db.booking_blocks.delete_many({"ip": ip})
        await db.ip_permanent_bans.delete_many({"ip": ip})
        return True
    except Exception as e:                                    # noqa: BLE001
        logger.warning("unban_ip failed for %s: %s", ip, e)
        return False


# ── Main entrypoint ────────────────────────────────────────────────────────
async def run_ai_security_analysis(db, phi_db=None) -> Dict[str, Any]:
    """Tick-driven main loop. Never raises. Returns a summary dict."""
    started = time.monotonic()
    if phi_db is None:
        phi_db = db   # caller may pass a single client

    config = await get_security_config(db)
    auto_ban_on = bool(config.get("ai_auto_ban_enabled", True))
    whitelist = set(config.get("agent_ip_whitelist") or [])

    # 1. Collect + 2. Enrich
    stats = await _collect_stats(db, phi_db)
    stats = await _enrich_ips(stats, db)

    # 3. Impossible travel
    travel = await detect_impossible_travel(db)
    stats["impossible_travel"] = travel

    # 4. AI triage
    ai = await _call_claude(stats)
    threat_level = (ai.get("threat_level") or "low").lower()
    findings = ai.get("findings") or []
    auto_ban_ips = [
        ip for ip in (ai.get("auto_ban_ips") or [])
        if isinstance(ip, str) and ip and ip not in whitelist
    ]

    # 5. Auto-actions
    auto_actions: List[Dict[str, Any]] = []
    should_auto_ban = (
        auto_ban_on and threat_level in ("high", "critical")
    )
    if should_auto_ban:
        for ip in auto_ban_ips[:25]:    # cap per tick
            ok = await execute_auto_ban(
                db, ip,
                reason=f"AI auto-ban — {threat_level}",
            )
            if ok:
                auto_actions.append({
                    "type": "ban_ip", "ip": ip,
                    "duration_days": _AUTO_BAN_DAYS,
                })
                await _audit(
                    db, "ai_auto_ban",
                    metadata={"ip": ip, "threat_level": threat_level},
                )

    # 6. Email alert
    alert_required = bool(ai.get("alert_required")) or threat_level in (
        "high", "critical",
    )
    if alert_required:
        try:
            await _send_security_alert_email(
                config, threat_level, ai, auto_actions, auto_ban_on,
            )
        except Exception as e:                                # noqa: BLE001
            logger.warning("security alert email failed: %s", e)

    # 7. Persist
    duration_ms = int((time.monotonic() - started) * 1000)
    event_doc = {
        "event_id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc),
        "threat_level": threat_level,
        "findings": findings,
        "ai_narrative": ai.get("summary") or "",
        "auto_actions_taken": auto_actions,
        "raw_stats": {k: v for k, v in stats.items() if k != "ip_enrichments"},
        "analysis_duration_ms": duration_ms,
        "model": _AI_MODEL,
        "auto_ban_enabled": auto_ban_on,
        "alert_sent": alert_required,
    }
    try:
        await db.security_events.insert_one(event_doc)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("security_events insert failed: %s", e)

    return {
        "threat_level": threat_level,
        "findings_count": len(findings),
        "auto_actions": auto_actions,
        "alert_sent": alert_required,
        "duration_ms": duration_ms,
    }


async def _send_security_alert_email(
    config: Dict[str, Any],
    threat_level: str,
    ai: Dict[str, Any],
    auto_actions: List[Dict[str, Any]],
    auto_ban_enabled: bool,
) -> None:
    recipients = list(config.get("alert_emails") or [])
    if not recipients:
        return
    from email_templates import security_alert_email
    from resend_client import send_email
    html = security_alert_email(
        threat_level=threat_level,
        narrative=ai.get("summary") or "",
        findings=ai.get("findings") or [],
        banned_ips=[a.get("ip") for a in auto_actions if a.get("ip")],
        auto_ban_enabled=auto_ban_enabled,
    )
    subject_prefix = {
        "critical": "🚨 CRITICAL SECURITY ALERT",
        "high":     "⚠️ HIGH THREAT DETECTED",
        "medium":   "🔔 Security Notice",
    }.get(threat_level, "Security Notice")
    subject = f"{subject_prefix} — GHW Portal"
    for r in recipients:
        await send_email(to=r, subject=subject, html=html)


async def _audit(db, event_type: str, metadata: Optional[dict] = None) -> None:
    try:
        from deps import write_audit
        await write_audit(
            db, event_type,
            actor_email="system",
            actor_id="security_intelligence",
            metadata=metadata or {},
        )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("audit write failed for %s: %s", event_type, e)
