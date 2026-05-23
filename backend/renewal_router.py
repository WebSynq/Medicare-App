"""
renewal_router.py
=================
Renewal calendar + AEP/OEP countdown.

AEP (Annual Enrollment Period): Oct 15 – Dec 7. Flag MA + PDP
clients 60 days before AEP opens so the agent can schedule plan
reviews.

OEP (Open Enrollment Period): Jan 1 – Mar 31. Flag MA clients 30
days before OEP opens.

Renewal alerts: policies whose ``effective_date + 1 year`` falls
inside the next 90 days. Agent-scoped via ``deps.agent_filter``.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends

from deps import (
    agent_filter,
    get_current_user,
    get_db,
    resolve_lead_id_for_policy,
)


logger = logging.getLogger("gruening.renewals")
router = APIRouter(prefix="/renewals", tags=["renewals"])


# Window boundaries (UTC). AEP / OEP windows are calendar-day events,
# so a date comparison is sufficient — we don't carry timezones.
def _today() -> date:
    return datetime.now(timezone.utc).date()


def _next_occurrence(year_anchor: int, month: int, day: int, today: date) -> date:
    """Next future date with the given month/day. Used to roll AEP /
    OEP boundaries forward when the year has already lapsed."""
    candidate = date(year_anchor, month, day)
    if candidate < today:
        candidate = date(year_anchor + 1, month, day)
    return candidate


def _aep_oep_countdowns(today: date) -> Dict[str, Any]:
    """Return current AEP/OEP status: countdown until next opening or
    "active" when today falls inside the window."""
    year = today.year

    aep_open = date(year, 10, 15)
    aep_close = date(year, 12, 7)
    if today > aep_close:
        # AEP closed for this year — next opening is next year.
        aep_open = date(year + 1, 10, 15)
        aep_close = date(year + 1, 12, 7)
    aep_active = aep_open <= today <= aep_close

    oep_open = date(year, 1, 1)
    oep_close = date(year, 3, 31)
    if today > oep_close:
        oep_open = date(year + 1, 1, 1)
        oep_close = date(year + 1, 3, 31)
    oep_active = oep_open <= today <= oep_close

    return {
        "aep_countdown": {
            "days_until": max(0, (aep_open - today).days),
            "is_active": aep_active,
            "opens": aep_open.isoformat(),
            "closes": aep_close.isoformat(),
        },
        "oep_countdown": {
            "days_until": max(0, (oep_open - today).days),
            "is_active": oep_active,
            "opens": oep_open.isoformat(),
            "closes": oep_close.isoformat(),
        },
    }


def _parse_iso_date(s: Optional[str]) -> Optional[date]:
    if not s or not isinstance(s, str):
        return None
    raw = s.strip()
    try:
        head = raw.split("T", 1)[0].split(" ", 1)[0]
        if "/" in head:
            mm, dd, yyyy = head.split("/")
            return date(int(yyyy), int(mm), int(dd))
        parts = head.split("-")
        if len(parts) == 3:
            yyyy, mm, dd = parts
            return date(int(yyyy), int(mm), int(dd))
    except Exception:
        return None
    return None


def _renewal_date(eff: date) -> date:
    """Anniversary of ``eff`` in the current or next year. Leap-day
    policies (Feb 29) snap to Feb 28 in non-leap years, matching how
    carriers process the anniversary."""
    today = _today()
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


@router.get("/alerts")
async def renewal_alerts(
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Agent-scoped renewal payload.

    Returns:
      - ``aep_countdown`` / ``oep_countdown`` with days_until + active flag
      - ``renewal_alerts``: policies whose anniversary falls in the next
        90 days (sorted soonest first)
      - ``total_ma_clients`` / ``total_pdp_clients`` for the AEP banner
    """
    today = _today()
    scope = agent_filter(current_user)

    countdowns = _aep_oep_countdowns(today)

    # Counts for the AEP/OEP banner copy.
    total_ma = await db.policies.count_documents({
        **scope,
        "product_type": {"$in": ["ma", "MA", "Medicare Advantage", "medicare_advantage"]},
    })
    total_pdp = await db.policies.count_documents({
        **scope,
        "product_type": {"$in": ["pdp", "PDP", "Prescription Drug Plan", "prescription_drug"]},
    })

    cutoff = today + timedelta(days=90)
    renewal_rows: List[Dict[str, Any]] = []
    proj = {
        "_id": 0, "policy_id": 1, "lead_id": 1, "ghl_contact_id": 1,
        "contact_name": 1, "product_type": 1, "product_label": 1,
        "carrier": 1, "effective_date": 1, "agent_name": 1,
    }
    # Collect first, sort, then resolve canonical lead ids — cheaper
    # than firing a lead-lookup for every policy when most won't survive
    # the 90-day window filter. policy.lead_id / ghl_contact_id are
    # NEVER trusted as leads-collection ids (they historically point at
    # GHL or legacy lifecycles); the SPA's /clients/:leadId route
    # expects the canonical leads.id, and bogus ids break the calendar's
    # event-click "View Client" navigation.
    candidates: List[Dict[str, Any]] = []
    async for p in db.policies.find(
        {**scope, "effective_date": {"$ne": None, "$ne": ""}},
        proj,
    ):
        eff = _parse_iso_date(p.get("effective_date"))
        if not eff:
            continue
        anniv = _renewal_date(eff)
        days_until = (anniv - today).days
        if days_until < 0 or days_until > 90:
            continue
        candidates.append({
            "_policy": p,
            "full_name": p.get("contact_name") or "—",
            "product_type": p.get("product_type"),
            "product_label": p.get("product_label") or p.get("product_type"),
            "carrier": p.get("carrier"),
            "effective_date": eff.isoformat(),
            "renewal_date": anniv.isoformat(),
            "days_until_renewal": days_until,
            "agent_name": p.get("agent_name"),
        })
    candidates.sort(key=lambda r: r["days_until_renewal"])

    for cand in candidates:
        lead_id = await resolve_lead_id_for_policy(db, scope, cand["_policy"])
        renewal_rows.append({
            "lead_id": lead_id,
            "full_name": cand["full_name"],
            "product_type": cand["product_type"],
            "product_label": cand["product_label"],
            "carrier": cand["carrier"],
            "effective_date": cand["effective_date"],
            "renewal_date": cand["renewal_date"],
            "days_until_renewal": cand["days_until_renewal"],
            "agent_name": cand["agent_name"],
        })

    return {
        "today": today.isoformat(),
        **countdowns,
        "renewal_alerts": renewal_rows,
        "total_ma_clients": total_ma,
        "total_pdp_clients": total_pdp,
    }
