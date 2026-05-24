"""
birthday_rule_router.py
=======================
Illinois Med Supp Birthday Rule alerts.

IL law lets Med Supp clients switch plans without underwriting for
63 days **after** their birthday each year. This router serves the
agent-facing alert list: who's in the window now, who's coming up
in the next 90 days, who's in the next 90–180.

Agent-scoped via ``deps.agent_filter``. Admin / compliance see the
agency-wide roll-up.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends

from deps import agent_filter, get_current_user, get_db, get_phi_db
from encryption import safe_lead_load


logger = logging.getLogger("gruening.birthday_rule")
router = APIRouter(prefix="/birthday-rule", tags=["birthday-rule"])


# Med-Supp-relevant statuses to skip (don't pester closed-out leads).
_EXCLUDED_STATUSES = {"lost", "not_interested"}

# How many days the IL birthday-rule window stays open.
WINDOW_DAYS = 63


def _parse_dob(s: Optional[str]) -> Optional[date]:
    """Tolerant DOB parse — accepts ISO ``YYYY-MM-DD`` (with or without
    a time component) and US-style ``MM/DD/YYYY``. Returns None on
    anything we can't understand so the lead just doesn't surface."""
    if not s or not isinstance(s, str):
        return None
    raw = s.strip()
    if not raw:
        return None
    try:
        # Drop a time portion if one is present (1962-04-12T00:00:00Z → 1962-04-12).
        head = raw.split("T", 1)[0].split(" ", 1)[0]
        if "/" in head:
            mm, dd, yyyy = head.split("/")
            return date(int(yyyy), int(mm), int(dd))
        if "-" in head:
            parts = head.split("-")
            if len(parts) == 3:
                yyyy, mm, dd = parts
                return date(int(yyyy), int(mm), int(dd))
    except Exception:
        return None
    return None


def _next_birthday(dob: date, today: date) -> date:
    """Next-future occurrence of a person's birthday from ``today``.

    Handles the leap-year edge case: Feb 29 birthdays anchor to Feb 28
    in non-leap years (matches how IL administrative rules treat it —
    the policyholder gets their window starting Feb 28).
    """
    year = today.year
    month, day = dob.month, dob.day
    if month == 2 and day == 29:
        # Try the actual leap-year date; if the target year isn't a
        # leap year, fall back to Feb 28.
        try:
            candidate = date(year, 2, 29)
        except ValueError:
            candidate = date(year, 2, 28)
    else:
        candidate = date(year, month, day)
    if candidate < today:
        next_year = year + 1
        if month == 2 and day == 29:
            try:
                candidate = date(next_year, 2, 29)
            except ValueError:
                candidate = date(next_year, 2, 28)
        else:
            candidate = date(next_year, month, day)
    return candidate


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _categorize(days_until: int, days_into_window: int) -> str:
    """Return one of: urgent / soon / upcoming. ``days_into_window`` is
    how many days *since* the birthday — ``0`` on the birthday itself,
    ``63`` on the last day of the IL window."""
    if 0 <= days_into_window <= WINDOW_DAYS:
        return "urgent"
    if 0 < days_until <= 90:
        return "soon"
    if 90 < days_until <= 180:
        return "upcoming"
    return "out_of_range"


def _evaluate_lead(lead: Dict[str, Any], today: date) -> Optional[Dict[str, Any]]:
    """Per-lead enrichment. Returns the dict the route ships, or None
    if the lead falls outside any of the three buckets we report."""
    dob = _parse_dob(lead.get("date_of_birth"))
    if not dob:
        return None
    nb = _next_birthday(dob, today)
    days_until = (nb - today).days
    # Compute "days into the most-recent past birthday's window" to
    # decide if we're in the window NOW. The most-recent birthday is
    # one year before next_birthday for non-leap-year flips.
    last_birthday = nb.replace(year=nb.year - 1) if nb.year > today.year - 1 else None
    # Simpler: subtract one year from nb. Leap-day special-cased the
    # same way as _next_birthday.
    try:
        last_birthday = nb.replace(year=nb.year - 1)
    except ValueError:
        last_birthday = date(nb.year - 1, 2, 28)
    days_into_window = (today - last_birthday).days

    bucket = _categorize(days_until, days_into_window)
    if bucket == "out_of_range":
        return None

    name = (
        f"{lead.get('first_name', '')} {lead.get('last_name', '')}".strip()
        or lead.get("email")
        or "Unknown"
    )
    return {
        "lead_id": lead.get("id"),
        "full_name": name,
        "phone": lead.get("phone"),
        "email": lead.get("email"),
        "date_of_birth": lead.get("date_of_birth"),
        "next_birthday": nb.isoformat(),
        "last_birthday": last_birthday.isoformat(),
        "window_opens": last_birthday.isoformat() if bucket == "urgent" else nb.isoformat(),
        "window_closes": (
            (last_birthday + timedelta(days=WINDOW_DAYS)).isoformat()
            if bucket == "urgent"
            else (nb + timedelta(days=WINDOW_DAYS)).isoformat()
        ),
        "days_until_birthday": days_until,
        "days_remaining_in_window": (
            max(0, WINDOW_DAYS - days_into_window) if bucket == "urgent" else None
        ),
        "window_status": "open" if bucket == "urgent" else "future",
        "current_plan": lead.get("current_plan"),
        "current_carrier": lead.get("current_carrier"),
        "agent_name": lead.get("agent_name"),
        "_bucket": bucket,
    }


@router.get("/alerts")
async def birthday_alerts(
    current_user: dict = Depends(get_current_user),
    db=Depends(get_phi_db),
):
    """Three buckets of IL leads keyed by window status.

    Filters server-side to ``state ∈ {IL, Illinois}`` (case-insensitive)
    and skips closed-out leads. Agent role sees only their own book;
    admin / compliance see the agency."""
    today = _today_utc()
    scope = agent_filter(current_user)
    # Mongo doesn't have a built-in case-insensitive eq match on a
    # string field without an index — we use a small set of allowed
    # values instead of $regex (cheaper, no index needed).
    query: Dict[str, Any] = {
        **scope,
        "$or": [
            {"state": "IL"},
            {"state": "il"},
            {"state": "Il"},
            {"state": "Illinois"},
            {"state": "illinois"},
        ],
        "status": {"$nin": list(_EXCLUDED_STATUSES)},
        "date_of_birth": {"$ne": None},
    }
    proj = {
        "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
        "email": 1, "phone": 1, "date_of_birth": 1,
        "current_carrier": 1, "current_plan": 1, "agent_name": 1,
    }

    buckets: Dict[str, List[Dict[str, Any]]] = {
        "urgent": [], "soon": [], "upcoming": [],
    }
    async for ld in db.leads.find(query, proj):
        ld = safe_lead_load(ld)
        item = _evaluate_lead(ld, today)
        if not item:
            continue
        b = item.pop("_bucket")
        buckets[b].append(item)

    # Sort: urgent by days_remaining_in_window asc; the other two by
    # days_until_birthday asc.
    buckets["urgent"].sort(key=lambda r: r.get("days_remaining_in_window") or 0)
    buckets["soon"].sort(key=lambda r: r["days_until_birthday"])
    buckets["upcoming"].sort(key=lambda r: r["days_until_birthday"])

    return {
        "today": today.isoformat(),
        "window_days": WINDOW_DAYS,
        "urgent": buckets["urgent"],
        "soon": buckets["soon"],
        "upcoming": buckets["upcoming"],
        "counts": {
            "urgent": len(buckets["urgent"]),
            "soon": len(buckets["soon"]),
            "upcoming": len(buckets["upcoming"]),
        },
    }
