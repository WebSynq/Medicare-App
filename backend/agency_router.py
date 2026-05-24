"""
agency_router.py
================
Admin-only agency command center.

Two endpoints:
  - ``GET /api/agency/stats`` — aggregated health score, pipeline,
    agent cards, compliance snapshot, recent activity.
  - ``GET /api/agency/activity`` — paginated live activity feed.

All endpoints require an admin role. The data here is intentionally
agency-wide (no agent_filter scoping) — admins only.
"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query

from deps import get_current_user, get_db, get_phi_db, require_roles
from encryption import safe_lead_load


logger = logging.getLogger("gruening.agency")
router = APIRouter(prefix="/agency", tags=["agency"])


# Stage codes the funnel reports on. Order is significant — the UI
# renders these left-to-right.
_PIPELINE_STAGES = ("new", "contacted", "qualified", "appointment_set", "enrolled")


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        cleaned = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _safe_float(v: Any) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


# ── Activity-feed humaniser ──────────────────────────────────────────────
_EVENT_VERB = {
    "lead_created": ("added a new lead", "lead"),
    "lead_updated": ("updated a lead", "lead"),
    "ghl_lead_created": ("added a lead from GHL", "lead"),
    "ghl_lead_updated": ("updated a GHL lead", "lead"),
    "doc_uploaded": ("uploaded a document", "document"),
    "doc_downloaded": ("downloaded a document", "document"),
    "soa_signed": ("captured an in-app SOA signature", "SOA"),
    "soa_signed_public": ("had an SOA signed", "SOA"),
    "soa_auto_generated": ("sent a new SOA link", "SOA"),
    "soa_send_new": ("sent a new SOA link", "SOA"),
    "speed_to_lead_sms_sent": ("sent a speed-to-lead SMS", "SMS"),
    "application_submitted": ("submitted an application", "application"),
    "ghl_lead_pushed": ("pushed lead changes to GHL", "lead"),
    "user_deactivated": ("deactivated a team member", "user"),
    "user_reactivated": ("reactivated a team member", "user"),
    "tcpa_consent_recorded": ("captured TCPA consent", "lead"),
}


def _humanise(event: dict, name_index: Dict[str, str]) -> str:
    et = event.get("event_type") or ""
    verb, _ = _EVENT_VERB.get(et, (et.replace("_", " "), ""))
    actor_email = event.get("actor_email") or ""
    actor = name_index.get(actor_email) or actor_email or "Someone"
    md = event.get("metadata") or {}
    target_name = (
        md.get("contact_name")
        or md.get("lead_name")
        or md.get("target_email")
        or ""
    )
    if target_name:
        return f"{actor} {verb} — {target_name}"
    return f"{actor} {verb}"


# ── Health score ─────────────────────────────────────────────────────────
async def _health_score(db) -> Dict[str, Any]:
    """0-100 score with four 25-pt buckets. Each bucket has its own
    sub-score so the UI can render "what's pulling your score down".
    All bucket math is bounded to [0, 25]."""
    now = datetime.now(timezone.utc)

    # SOA compliance: signed_within_window / leads_needing_soa.
    medicare_leads_total = await db.leads.count_documents({
        "product_interest": {"$regex": "medicare|med supp|pdp", "$options": "i"},
    })
    soa_signed = await db.leads.count_documents({
        "product_interest": {"$regex": "medicare|med supp|pdp", "$options": "i"},
        "soa_signed": True,
    })
    soa_rate = (soa_signed / medicare_leads_total) if medicare_leads_total else 1.0
    soa_pts = round(soa_rate * 25, 1)

    # TCPA consent rate across all leads.
    total_leads = await db.leads.count_documents({})
    consented = await db.leads.count_documents({"tcpa_consent": True})
    tcpa_rate = (consented / total_leads) if total_leads else 1.0
    tcpa_pts = round(tcpa_rate * 25, 1)

    # Revenue vs last month — full 25pts when this month >= last month.
    mtd_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_month_start = (mtd_start - timedelta(days=1)).replace(day=1)
    last_month_end = mtd_start
    rev_mtd = 0.0
    rev_last = 0.0
    async for r in db["production_records"].find(
        {}, {"_id": 0, "app_date": 1, "revenue_expected": 1},
    ):
        dt = _parse_iso(r.get("app_date"))
        if not dt:
            continue
        amt = _safe_float(r.get("revenue_expected"))
        if dt >= mtd_start:
            rev_mtd += amt
        elif last_month_start <= dt < last_month_end:
            rev_last += amt
    if rev_last <= 0:
        rev_pts = 25.0 if rev_mtd > 0 else 12.5
    else:
        rev_pts = round(min(1.0, rev_mtd / rev_last) * 25, 1)
    rev_change_pct = (
        round(((rev_mtd - rev_last) / rev_last) * 100, 1)
        if rev_last > 0 else None
    )

    # Active agents this week — any team member with an audit_logs event
    # in the last 7 days, divided by total active team members.
    week_ago = now - timedelta(days=7)
    actor_ids = set()
    async for ev in db.audit_logs.find(
        {"timestamp": {"$gte": week_ago.isoformat()}},
        {"_id": 0, "actor_id": 1},
    ):
        if ev.get("actor_id"):
            actor_ids.add(ev["actor_id"])
    total_active = await db.users.count_documents({"is_active": True}) or 1
    active_week = await db.users.count_documents({
        "id": {"$in": list(actor_ids)}, "is_active": True,
    }) if actor_ids else 0
    active_pts = round(min(1.0, active_week / total_active) * 25, 1)

    score = round(soa_pts + tcpa_pts + rev_pts + active_pts, 1)
    factors = [
        {"name": "SOA compliance", "points": soa_pts, "max": 25,
         "rate_pct": round(soa_rate * 100, 1)},
        {"name": "TCPA consent",   "points": tcpa_pts, "max": 25,
         "rate_pct": round(tcpa_rate * 100, 1)},
        {"name": "Revenue vs last month", "points": rev_pts, "max": 25,
         "change_pct": rev_change_pct},
        {"name": "Active agents this week", "points": active_pts, "max": 25,
         "active_count": active_week, "total_count": total_active},
    ]
    # Top-3 issues (lowest sub-scores first).
    pulling_down = sorted(
        [f for f in factors if f["points"] < f["max"]],
        key=lambda f: f["points"],
    )[:3]
    return {
        "score": int(round(score)),
        "factors": factors,
        "pulling_down": pulling_down,
        "revenue_mtd": round(rev_mtd, 2),
        "revenue_last_month": round(rev_last, 2),
        "revenue_change_pct": rev_change_pct,
    }


# ── Pipeline + stalled leads ─────────────────────────────────────────────
async def _pipeline(db) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    seven_days_ago = now - timedelta(days=7)
    counts: Counter = Counter()
    stalled: List[Dict[str, Any]] = []
    async for ld in db.leads.find(
        {},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "status": 1, "updated_at": 1, "agent_name": 1},
    ):
        ld = safe_lead_load(ld)
        st = (ld.get("status") or "new").lower()
        counts[st] += 1
        upd = _parse_iso(ld.get("updated_at"))
        if st in _PIPELINE_STAGES and upd and upd < seven_days_ago and st != "enrolled":
            stalled.append({
                "id": ld["id"],
                "name": f"{ld.get('first_name', '')} {ld.get('last_name', '')}".strip() or "—",
                "stage": st,
                "since": ld.get("updated_at"),
                "agent_name": ld.get("agent_name"),
            })
    stalled.sort(key=lambda r: r.get("since") or "", reverse=False)
    return {
        "by_stage": {s: counts.get(s, 0) for s in _PIPELINE_STAGES},
        "stalled_leads": stalled[:10],
    }


# ── Compliance snapshot ──────────────────────────────────────────────────
async def _compliance_snapshot(db) -> Dict[str, Any]:
    total = await db.leads.count_documents({}) or 0
    consented = await db.leads.count_documents({"tcpa_consent": True})
    soa_signed = await db.leads.count_documents({"soa_signed": True})
    non_compliant = total - consented if total else 0
    return {
        "tcpa_rate_pct": round((consented / total) * 100, 1) if total else 0.0,
        "soa_rate_pct": round((soa_signed / total) * 100, 1) if total else 0.0,
        "non_compliant_leads": non_compliant,
        "total_leads": total,
    }


# ── Per-agent cards ──────────────────────────────────────────────────────
async def _agent_cards(db) -> List[Dict[str, Any]]:
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_ago = now - timedelta(days=7)
    mtd_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    users = await db.users.find(
        {"is_active": True},
        {"_id": 0, "id": 1, "full_name": 1, "email": 1, "role": 1},
    ).to_list(length=500)

    # Per-agent counters from the various collections.
    last_seen: Dict[str, str] = {}
    async for ev in db.audit_logs.find(
        {}, {"_id": 0, "actor_id": 1, "timestamp": 1},
    ).sort("timestamp", -1):
        aid = ev.get("actor_id")
        if not aid or aid in last_seen:
            continue
        last_seen[aid] = ev.get("timestamp")

    leads_week: Dict[str, int] = defaultdict(int)
    async for ld in db.leads.find(
        {"created_at": {"$gte": week_ago.isoformat()}},
        {"_id": 0, "agent_id": 1},
    ):
        ld = safe_lead_load(ld)
        if ld.get("agent_id"):
            leads_week[ld["agent_id"]] += 1

    apps_mtd: Dict[str, int] = defaultdict(int)
    revenue_mtd: Dict[str, float] = defaultdict(float)
    async for p in db["policies"].find(
        {}, {"_id": 0, "agent_id": 1, "submitted_at": 1, "created_at": 1},
    ):
        ts = _parse_iso(p.get("submitted_at") or p.get("created_at"))
        if ts and ts >= mtd_start and p.get("agent_id"):
            apps_mtd[p["agent_id"]] += 1
    async for r in db["production_records"].find(
        {}, {"_id": 0, "agent_id": 1, "app_date": 1, "revenue_expected": 1},
    ):
        ts = _parse_iso(r.get("app_date"))
        if ts and ts >= mtd_start and r.get("agent_id"):
            revenue_mtd[r["agent_id"]] += _safe_float(r.get("revenue_expected"))

    cards: List[Dict[str, Any]] = []
    for u in users:
        uid = u["id"]
        ls = last_seen.get(uid)
        ls_dt = _parse_iso(ls)
        active_today = bool(ls_dt and ls_dt >= today_start)
        cards.append({
            "id": uid,
            "name": u.get("full_name") or u.get("email") or "—",
            "role": u.get("role"),
            "last_seen": ls,
            "active_today": active_today,
            "leads_this_week": leads_week.get(uid, 0),
            "apps_mtd": apps_mtd.get(uid, 0),
            "revenue_mtd": round(revenue_mtd.get(uid, 0.0), 2),
        })
    cards.sort(key=lambda c: (-1 if c["active_today"] else 0, -c["revenue_mtd"]))
    return cards


# ── Activity feed ────────────────────────────────────────────────────────
async def _recent_activity(db, limit: int = 50,
                            agent_id: Optional[str] = None,
                            event_type: Optional[str] = None,
                            ) -> List[Dict[str, Any]]:
    name_index: Dict[str, str] = {}
    async for u in db.users.find(
        {}, {"_id": 0, "email": 1, "full_name": 1},
    ):
        if u.get("email"):
            name_index[u["email"]] = u.get("full_name") or u["email"]

    query: dict = {}
    if agent_id:
        query["actor_id"] = agent_id
    if event_type:
        query["event_type"] = event_type
    cursor = (
        db.audit_logs.find(
            query,
            {"_id": 0, "event_type": 1, "timestamp": 1, "actor_email": 1,
             "actor_id": 1, "target_id": 1, "metadata": 1},
        )
        .sort("timestamp", -1)
        .limit(limit)
    )
    out = []
    async for e in cursor:
        out.append({
            "timestamp": e.get("timestamp"),
            "event_type": e.get("event_type"),
            "actor_email": e.get("actor_email"),
            "actor_name": name_index.get(e.get("actor_email") or "") or "",
            "description": _humanise(e, name_index),
        })
    return out


# ── Routes ───────────────────────────────────────────────────────────────
@router.get("/stats")
async def agency_stats(
    _admin: dict = Depends(require_roles("admin", "owner")),
    db=Depends(get_phi_db),
):
    """Single payload that powers the Agency command-center page.

    Wrapped in a top-level try/except so a slow aggregation can't blank
    the whole page — partial data is still better than nothing."""
    try:
        health = await _health_score(db)
        pipeline = await _pipeline(db)
        compliance = await _compliance_snapshot(db)
        cards = await _agent_cards(db)
        activity = await _recent_activity(db, limit=50)
        active_today = sum(1 for c in cards if c.get("active_today"))
        leads_this_week_total = sum(c.get("leads_this_week", 0) for c in cards)
        apps_mtd_total = sum(c.get("apps_mtd", 0) for c in cards)
        return {
            "health_score": health["score"],
            "health_factors": health["factors"],
            "health_pulling_down": health["pulling_down"],
            "active_agents_today": active_today,
            "leads_this_week": leads_this_week_total,
            "apps_this_month": apps_mtd_total,
            "revenue_mtd": health["revenue_mtd"],
            "revenue_change_pct": health["revenue_change_pct"],
            "pipeline_by_stage": pipeline["by_stage"],
            "stalled_leads": pipeline["stalled_leads"],
            "compliance": compliance,
            "agent_cards": cards,
            "recent_activity": activity,
        }
    except Exception as e:
        logger.exception("agency_stats partial failure: %s", e)
        return {"error": "partial data"}


@router.get("/activity")
async def agency_activity(
    limit: int = Query(100, le=500),
    agent_id: Optional[str] = None,
    event_type: Optional[str] = None,
    _admin: dict = Depends(require_roles("admin", "owner")),
    db=Depends(get_db),
):
    """Paginated agency-wide activity feed with optional filters."""
    rows = await _recent_activity(
        db, limit=limit, agent_id=agent_id, event_type=event_type,
    )
    return {"items": rows, "count": len(rows)}
