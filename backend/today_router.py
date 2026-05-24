"""
today_router.py
===============
"Today" action centre — what every agent should focus on right now.

GET /today/actions returns four buckets in one call, scoped through
``deps.agent_filter`` so each agent sees only their own book (admin /
compliance see the agency, or the impersonated agent's view when the
X-Agent-ID header is set).

Buckets:
  1. urgent_calls       — leads whose IL-style birthday-rule window
                          (63 days post-birthday) is OPEN right now.
  2. renewals_due       — policies whose anniversary lands inside the
                          next 30 days.
  3. stale_leads        — new/contacted leads that haven't been touched
                          in 7+ days.
  4. todays_appointments — appointments scheduled for today. Returns []
                          before the appointments collection exists (Task 2).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    agent_filter,
    get_current_user,
    get_db,
    get_phi_db,
    resolve_lead_id_for_policy,
    write_audit,
)
from encryption import safe_lead_load
# Re-use the birthday-rule evaluator so the urgent-call window math stays
# in one place (handles Feb 29, year rollover, last-birthday computation).
from birthday_rule_router import _evaluate_lead, _today_utc


logger = logging.getLogger("gruening.today")
router = APIRouter(prefix="/today", tags=["today"])
limiter = Limiter(key_func=get_remote_address)

_MAX_PER_BUCKET = 10
_STALE_DAYS = 7
_RENEWAL_WINDOW_DAYS = 30


def _parse_iso_date(s: Optional[str]) -> Optional[date]:
    """Tolerant ISO/US date parse — same shape used by the renewal router."""
    if not s or not isinstance(s, str):
        return None
    try:
        head = s.split("T", 1)[0].split(" ", 1)[0]
        if "/" in head:
            mm, dd, yyyy = head.split("/")
            return date(int(yyyy), int(mm), int(dd))
        parts = head.split("-")
        if len(parts) == 3:
            return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except Exception:
        return None
    return None


def _parse_iso_datetime(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _full_name(lead: Dict[str, Any]) -> str:
    return (
        f"{lead.get('first_name', '')} {lead.get('last_name', '')}".strip()
        or lead.get("email")
        or "Unknown"
    )


async def _urgent_calls(db, scope: dict, today: date) -> List[Dict[str, Any]]:
    """Leads in the IL birthday-rule window (≤63 days after birthday)."""
    proj = {
        "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
        "email": 1, "phone": 1, "date_of_birth": 1,
        "current_carrier": 1, "current_plan": 1,
    }
    rows: List[Dict[str, Any]] = []
    async for ld in db.leads.find({
        **scope,
        "status": {"$nin": ["lost", "not_interested"]},
        "date_of_birth": {"$ne": None},
    }, proj):
        ld = safe_lead_load(ld)
        item = _evaluate_lead(ld, today)
        if not item or item.get("_bucket") != "urgent":
            continue
        rows.append({
            "lead_id": item["lead_id"],
            "full_name": item["full_name"],
            "phone": item.get("phone"),
            "days_remaining_in_window": item.get("days_remaining_in_window"),
            "current_plan": item.get("current_plan"),
            "current_carrier": item.get("current_carrier"),
        })
    rows.sort(key=lambda r: r.get("days_remaining_in_window") or 0)
    return rows[:_MAX_PER_BUCKET]


def _renewal_anniversary(eff: date, today: date) -> date:
    """Next future occurrence of ``eff``'s month/day. Feb 29 snaps to
    Feb 28 in non-leap years, matching how carriers process renewals."""
    year = today.year
    if eff.month == 2 and eff.day == 29:
        try:
            anniv = date(year, 2, 29)
        except ValueError:
            anniv = date(year, 2, 28)
    else:
        anniv = date(year, eff.month, eff.day)
    if anniv < today:
        if eff.month == 2 and eff.day == 29:
            try:
                anniv = date(year + 1, 2, 29)
            except ValueError:
                anniv = date(year + 1, 2, 28)
        else:
            anniv = date(year + 1, eff.month, eff.day)
    return anniv


async def _renewals_due(db, scope: dict, today: date) -> List[Dict[str, Any]]:
    """Policies whose anniversary is within the next 30 days."""
    proj = {
        "_id": 0, "lead_id": 1, "ghl_contact_id": 1,
        "contact_name": 1, "product_type": 1, "product_label": 1,
        "carrier": 1, "effective_date": 1,
    }
    # Collect candidates first, then sort + truncate, then do the lead
    # join only for the rows we actually return. Avoids N lookups when N
    # could be much larger than _MAX_PER_BUCKET.
    candidates: List[Dict[str, Any]] = []
    async for p in db.policies.find({
        **scope,
        "effective_date": {"$nin": [None, ""]},
    }, proj):
        eff = _parse_iso_date(p.get("effective_date"))
        if not eff:
            continue
        anniv = _renewal_anniversary(eff, today)
        days = (anniv - today).days
        if days < 0 or days > _RENEWAL_WINDOW_DAYS:
            continue
        candidates.append({
            "_policy": p,
            "full_name": p.get("contact_name") or "—",
            "carrier": p.get("carrier"),
            "product_label": p.get("product_label") or p.get("product_type"),
            "renewal_date": anniv.isoformat(),
            "days_until_renewal": days,
        })
    candidates.sort(key=lambda r: r["days_until_renewal"])
    candidates = candidates[:_MAX_PER_BUCKET]

    rows: List[Dict[str, Any]] = []
    for cand in candidates:
        lead_id = await resolve_lead_id_for_policy(db, scope, cand["_policy"])
        rows.append({
            "lead_id": lead_id,
            "full_name": cand["full_name"],
            "carrier": cand["carrier"],
            "product_label": cand["product_label"],
            "renewal_date": cand["renewal_date"],
            "days_until_renewal": cand["days_until_renewal"],
        })
    return rows


async def _stale_leads(db, scope: dict, now_dt: datetime) -> List[Dict[str, Any]]:
    """Leads in new/contacted that haven't moved in 7+ days."""
    cutoff_iso = (now_dt - timedelta(days=_STALE_DAYS)).isoformat()
    proj = {
        "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
        "email": 1, "phone": 1, "status": 1, "updated_at": 1,
    }
    rows: List[Dict[str, Any]] = []
    async for ld in db.leads.find({
        **scope,
        "status": {"$in": ["new", "contacted"]},
        "updated_at": {"$lt": cutoff_iso},
    }, proj):
        ld = safe_lead_load(ld)
        upd = _parse_iso_datetime(ld.get("updated_at"))
        if not upd:
            continue
        # Compare on date so a 7d-2h-old lead still reports "7 days".
        days = max(0, (now_dt.date() - upd.date()).days)
        rows.append({
            "lead_id": ld.get("id"),
            "full_name": _full_name(ld),
            "phone": ld.get("phone"),
            "status": ld.get("status"),
            "days_since_contact": days,
        })
    rows.sort(key=lambda r: r["days_since_contact"], reverse=True)
    return rows[:_MAX_PER_BUCKET]


async def _mtd_commission(db, scope: dict, today: date) -> float:
    """Sum estimated_commission across this calendar month's non-cancelled
    appointments. Anchored to the same first-of-month boundary the
    dashboard router uses so the Today pill matches whatever
    /api/dashboard/stats and /api/appointments/revenue-stats are
    reporting for the same window.
    """
    month_start_iso = today.replace(day=1).isoformat()
    total = 0.0
    try:
        cursor = db.appointments.find(
            {
                **scope,
                "appointment_date": {"$gte": month_start_iso},
                "status": {"$ne": "cancelled"},
                "estimated_commission": {"$ne": None},
            },
            {"_id": 0, "estimated_commission": 1},
        )
        async for a in cursor:
            v = a.get("estimated_commission")
            if v is None:
                continue
            try:
                total += float(v)
            except (TypeError, ValueError):
                continue
    except Exception as e:                                 # noqa: BLE001
        logger.warning("today: mtd_commission query failed: %s", e)
        return 0.0
    return round(total, 2)


async def _todays_appointments(db, scope: dict, today: date) -> List[Dict[str, Any]]:
    """Appointments on ``today``. Returns [] before Task 2 creates the
    collection — mongomock + Atlas both auto-create on first insert."""
    today_iso = today.isoformat()
    proj = {
        "_id": 0, "appointment_id": 1, "lead_id": 1, "client_name": 1,
        "appointment_time": 1, "notes": 1, "status": 1,
    }
    rows: List[Dict[str, Any]] = []
    try:
        async for a in db.appointments.find({
            **scope,
            "appointment_date": today_iso,
            "status": "scheduled",
        }, proj):
            rows.append({
                "appointment_id": a.get("appointment_id"),
                "lead_id": a.get("lead_id"),
                "client_name": a.get("client_name"),
                "time": a.get("appointment_time"),
                "notes": a.get("notes") or "",
            })
    except Exception as e:
        # Defensive — Atlas / mongomock both return empty cursors on
        # missing collections, but a future driver change shouldn't
        # blank out the whole Today page.
        logger.warning("today: appointments query failed: %s", e)
        return []
    rows.sort(key=lambda r: r.get("time") or "")
    return rows


@router.get("/actions")
@limiter.limit("60/hour")
async def today_actions(
    request: Request,
    db=Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """Single-call aggregator for the Today page."""
    today = _today_utc()
    now_dt = datetime.now(timezone.utc)
    scope = agent_filter(current_user)

    urgent = await _urgent_calls(db, scope, today)
    renewals = await _renewals_due(db, scope, today)
    stale = await _stale_leads(db, scope, now_dt)
    appts = await _todays_appointments(db, scope, today)
    mtd_commission = await _mtd_commission(db, scope, today)

    summary = {
        "urgent_count": len(urgent),
        "renewals_count": len(renewals),
        "stale_count": len(stale),
        "appointments_count": len(appts),
    }

    await write_audit(
        db, "today_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={**summary, "mtd_commission": mtd_commission},
    )

    return {
        "today": today.isoformat(),
        "summary": summary,
        "urgent_calls": urgent,
        "renewals_due": renewals,
        "stale_leads": stale,
        "todays_appointments": appts,
        "mtd_commission": mtd_commission,
    }
