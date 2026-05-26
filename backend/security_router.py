"""Admin security console endpoints.

Read + control surface for the AI security loop in
``security_intelligence``. Admin / owner only; reads expose
infrastructure-only data (IPs, events, ban list) — no PHI.

The CSRF middleware exempts ``/api/security/`` so the SPA's GET
calls don't require a CSRF cookie. Writes are JWT-gated through
``require_roles("admin", "owner")``.
"""
import ipaddress
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from deps import get_db, get_phi_db, require_roles, write_audit
from security_intelligence import (
    detect_impossible_travel,
    execute_auto_ban,
    get_security_config,
    lookup_ip,
    run_ai_security_analysis,
    set_security_config,
    unban_ip,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/security", tags=["security"])


_IP_RE = re.compile(
    r"^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9A-Fa-f:]+$",
)
_VALID_THREAT_LEVELS = {"low", "medium", "high", "critical", "unknown"}


def _valid_ip_or_400(ip: str) -> str:
    ip = (ip or "").strip()
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid IP address.")
    return ip


def _admin_or_owner():
    return require_roles("admin", "owner")


# ── GET /security/events ───────────────────────────────────────────────────
@router.get("/events")
async def list_events(
    threat_level: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _user=Depends(require_roles("admin", "owner")),
):
    q: Dict[str, Any] = {}
    if threat_level:
        tl = threat_level.lower().strip()
        if tl not in _VALID_THREAT_LEVELS:
            raise HTTPException(
                status_code=400,
                detail=f"threat_level must be one of {sorted(_VALID_THREAT_LEVELS)}",
            )
        q["threat_level"] = tl
    cursor = (
        db.security_events.find(q, {"_id": 0})
        .sort("timestamp", -1)
        .limit(limit)
    )
    rows = [d async for d in cursor]
    # Strip the heavy raw_stats from the list endpoint — the detail
    # endpoint includes it. Keeps the list payload small.
    for r in rows:
        r.pop("raw_stats", None)
    return {"events": rows, "count": len(rows)}


# ── GET /security/events/{event_id} ────────────────────────────────────────
@router.get("/events/{event_id}")
async def get_event(
    event_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _user=Depends(require_roles("admin", "owner")),
):
    row = await db.security_events.find_one(
        {"event_id": event_id}, {"_id": 0},
    )
    if not row:
        raise HTTPException(status_code=404, detail="Event not found")
    return row


# ── GET /security/ip/{ip} ──────────────────────────────────────────────────
@router.get("/ip/{ip}")
async def get_ip(
    ip: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user=Depends(require_roles("admin", "owner")),
):
    ip = _valid_ip_or_400(ip)
    intel = await lookup_ip(ip, db)
    await write_audit(
        db, "security_ip_lookup",
        actor_email=user.get("email"), actor_id=user.get("id"),
        request=request, metadata={"ip": ip},
    )
    return intel


# ── POST /security/ban-ip ──────────────────────────────────────────────────
class BanRequest(BaseModel):
    ip: str
    reason: str = Field(..., min_length=1, max_length=300)
    duration_days: int = Field(30, ge=1, le=3650)


@router.post("/ban-ip")
async def ban_ip(
    body: BanRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user=Depends(require_roles("admin", "owner")),
):
    ip = _valid_ip_or_400(body.ip)
    ok = await execute_auto_ban(
        db, ip, reason=body.reason,
        source="manual_ban", duration_days=body.duration_days,
    )
    if not ok:
        raise HTTPException(status_code=500, detail="Could not ban IP.")
    await write_audit(
        db, "manual_ban",
        actor_email=user.get("email"), actor_id=user.get("id"),
        request=request,
        metadata={"ip": ip, "reason": body.reason,
                  "duration_days": body.duration_days},
    )
    return {"banned": True, "ip": ip}


# ── DELETE /security/ban-ip/{ip} ───────────────────────────────────────────
@router.delete("/ban-ip/{ip}")
async def unban(
    ip: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user=Depends(require_roles("admin", "owner")),
):
    ip = _valid_ip_or_400(ip)
    ok = await unban_ip(db, ip)
    await write_audit(
        db, "manual_unban",
        actor_email=user.get("email"), actor_id=user.get("id"),
        request=request, metadata={"ip": ip},
    )
    return {"unbanned": ok, "ip": ip}


# ── GET /security/banned-ips ───────────────────────────────────────────────
@router.get("/banned-ips")
async def banned_ips(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _user=Depends(require_roles("admin", "owner")),
):
    now = datetime.now(timezone.utc)
    # Pull both sources and merge by IP. ip_permanent_bans is the
    # authoritative manual-ban log; booking_blocks may carry AI auto-bans
    # that haven't migrated to the permanent collection yet (only the
    # auto-ban path writes to both — manual writes both too).
    permanent = await db.ip_permanent_bans.find(
        {"$or": [{"expires_at": None}, {"expires_at": {"$gt": now}}]},
        {"_id": 0},
    ).sort("banned_at", -1).limit(200).to_list(length=200)
    blocks = await db.booking_blocks.find(
        {"expires_at": {"$gt": now}}, {"_id": 0},
    ).sort("blocked_at", -1).limit(200).to_list(length=200)

    merged: Dict[str, Dict[str, Any]] = {}
    for row in permanent:
        ip = row.get("ip")
        if ip:
            merged[ip] = dict(row)
    for row in blocks:
        ip = row.get("ip")
        if not ip:
            continue
        if ip not in merged:
            merged[ip] = {
                "ip": ip,
                "banned_at": row.get("blocked_at"),
                "expires_at": row.get("expires_at"),
                "reason": row.get("reason") or "abuse threshold",
                "source": row.get("source") or "auto",
            }

    # Attach intel (cache-only — never trigger a fresh lookup here so
    # the list endpoint stays cheap).
    out: List[Dict[str, Any]] = []
    for ip, row in merged.items():
        try:
            intel = await db.ip_intelligence.find_one(
                {"ip": ip}, {"_id": 0},
            )
        except Exception:
            intel = None
        row["intel"] = intel or {}
        out.append(row)
    out.sort(
        key=lambda r: (r.get("banned_at") or datetime.min).isoformat()
        if hasattr(r.get("banned_at"), "isoformat") else str(r.get("banned_at") or ""),
        reverse=True,
    )
    return {"banned_ips": out, "count": len(out)}


# ── GET /security/config ───────────────────────────────────────────────────
@router.get("/config")
async def get_config(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _user=Depends(require_roles("admin", "owner")),
):
    return await get_security_config(db)


# ── PATCH /security/config ─────────────────────────────────────────────────
class ConfigPatch(BaseModel):
    ai_auto_ban_enabled: Optional[bool] = None
    auto_ban_threshold: Optional[int] = Field(None, ge=1, le=1000)
    alert_emails: Optional[List[str]] = None
    agent_ip_whitelist: Optional[List[str]] = None


@router.patch("/config")
async def patch_config(
    body: ConfigPatch,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user=Depends(require_roles("admin", "owner")),
):
    sent = body.model_dump(exclude_unset=True)
    if not sent:
        return await get_security_config(db)
    # Validate IP whitelist entries before persisting.
    if "agent_ip_whitelist" in sent:
        cleaned = []
        for ip in (sent["agent_ip_whitelist"] or []):
            try:
                ipaddress.ip_address((ip or "").strip())
                cleaned.append((ip or "").strip())
            except ValueError:
                raise HTTPException(
                    status_code=422,
                    detail=f"Invalid IP in whitelist: {ip!r}",
                )
        sent["agent_ip_whitelist"] = cleaned
    if "alert_emails" in sent:
        sent["alert_emails"] = [
            e.strip().lower() for e in (sent["alert_emails"] or [])
            if isinstance(e, str) and "@" in e
        ]
    fresh = await set_security_config(db, sent, actor_email=user.get("email"))
    await write_audit(
        db, "security_config_change",
        actor_email=user.get("email"), actor_id=user.get("id"),
        request=request,
        metadata={"fields_changed": list(sent.keys()),
                  "ai_auto_ban_enabled": fresh.get("ai_auto_ban_enabled")},
    )
    return fresh


# ── POST /security/run-analysis ────────────────────────────────────────────
@router.post("/run-analysis")
async def run_analysis_now(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
    user=Depends(require_roles("admin", "owner")),
):
    """Manually trigger the AI security analysis loop. Returns the same
    summary the scheduler tick records."""
    result = await run_ai_security_analysis(db, phi_db)
    await write_audit(
        db, "security_analysis_manual",
        actor_email=user.get("email"), actor_id=user.get("id"),
        request=request, metadata=result,
    )
    return result


# ── GET /security/impossible-travel ────────────────────────────────────────
@router.get("/impossible-travel")
async def impossible_travel(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _user=Depends(require_roles("admin", "owner")),
):
    # 7-day window via repeated 2-hour scans would be expensive; the
    # underlying helper does the last 2 hours. For the "last 7 days"
    # view we read flagged events directly from security_events.
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    historical: List[Dict[str, Any]] = []
    try:
        cursor = db.security_events.find(
            {"timestamp": {"$gte": week_ago},
             "raw_stats.impossible_travel": {"$exists": True, "$ne": []}},
            {"_id": 0, "timestamp": 1,
             "raw_stats.impossible_travel": 1},
        ).sort("timestamp", -1).limit(100)
        async for r in cursor:
            for tr in (r.get("raw_stats", {}) or {}).get("impossible_travel", []):
                historical.append({**tr, "detected_at": r.get("timestamp")})
    except Exception as e:                                    # noqa: BLE001
        logger.warning("impossible-travel history read failed: %s", e)

    # Plus a fresh 2-hour scan to surface anything not yet in an event row.
    live = await detect_impossible_travel(db)
    return {
        "live": live,
        "historical_7d": historical[:50],
        "count": len(live) + len(historical),
    }
