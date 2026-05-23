"""
search_router.py
================
Unified search across the three collections an agent thinks about all
day — leads, appointments, notes — behind a single endpoint that the
SPA's Cmd+K dialog calls on every debounced keystroke.

Every result is agent-scoped via ``deps.agent_filter`` (admin /
compliance / coach / accounting / client_success see the agency).
Rate-limited 30/hour because text search is the most expensive read
in the API surface. Audit-logged as ``search_performed`` with the
query length only — never the raw query, since users routinely type
PHI fragments (MBI, full names, phone numbers) into search bars.

Scoring is intentionally simple (constants by collection) so the
ordering is deterministic and easy to reason about: leads first,
then appointments, then notes; ties broken by most-recently-updated.
"""
import logging
import re
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    agent_filter,
    get_current_user,
    get_db,
    write_audit,
)


logger = logging.getLogger("gruening.search")
router = APIRouter(prefix="/search", tags=["search"])
limiter = Limiter(key_func=get_remote_address)


_MIN_QUERY_LEN = 2
_PER_COLLECTION_LIMIT = 20
_SCORE_LEAD = 3
_SCORE_APPT = 2
_SCORE_NOTE = 1


def _safe_regex(q: str) -> str:
    """Escape user input before handing it to Mongo's $regex so a
    pattern like ``(a+)+$`` can't trigger ReDoS or leak structure via
    PCRE feature abuse. Same defence leads_router.list_leads uses."""
    return re.escape(q.strip())


def _full_name(lead: Dict[str, Any]) -> str:
    fn = (lead.get("first_name") or "").strip()
    ln = (lead.get("last_name") or "").strip()
    return f"{fn} {ln}".strip() or lead.get("email") or "Unknown"


@router.get("")
@limiter.limit("30/hour")
async def search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=128),
    limit: int = Query(10, ge=1, le=50),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Search across leads, appointments, and notes.

    Returns a flat list sorted by (score desc, updated_at desc).
    Empty list when the query matches nothing — never 404.
    """
    raw = (q or "").strip()
    if len(raw) < _MIN_QUERY_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Query must be at least {_MIN_QUERY_LEN} characters",
        )

    scope = agent_filter(current_user)
    safe = _safe_regex(raw)
    rx = {"$regex": safe, "$options": "i"}
    results: List[Dict[str, Any]] = []

    # --- Leads ---------------------------------------------------------
    lead_proj = {
        "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
        "email": 1, "phone": 1, "current_carrier": 1,
        "current_plan": 1, "state": 1, "updated_at": 1, "status": 1,
    }
    lead_query = {
        **scope,
        "$or": [
            {"first_name": rx},
            {"last_name": rx},
            {"email": rx},
            {"phone": rx},
            {"current_carrier": rx},
            {"state": rx},
        ],
    }
    async for ld in (
        db.leads.find(lead_query, lead_proj)
        .sort("updated_at", -1)
        .limit(_PER_COLLECTION_LIMIT)
    ):
        name = _full_name(ld)
        subtitle_bits = [
            ld.get("current_carrier"),
            ld.get("current_plan"),
            ld.get("state"),
            ld.get("status"),
        ]
        subtitle = " · ".join(b for b in subtitle_bits if b) or "Lead"
        results.append({
            "type": "lead",
            "id": ld.get("id"),
            "title": name,
            "subtitle": subtitle,
            "url": f"/clients/{ld.get('id')}",
            "score": _SCORE_LEAD,
            "updated_at": ld.get("updated_at"),
        })

    # --- Appointments --------------------------------------------------
    appt_proj = {
        "_id": 0, "appointment_id": 1, "lead_id": 1,
        "client_name": 1, "appointment_date": 1, "appointment_time": 1,
        "type": 1, "status": 1, "notes": 1, "updated_at": 1,
    }
    appt_query = {
        **scope,
        "$or": [
            {"client_name": rx},
            {"notes": rx},
        ],
    }
    async for a in (
        db.appointments.find(appt_query, appt_proj)
        .sort("updated_at", -1)
        .limit(_PER_COLLECTION_LIMIT)
    ):
        when = f"{a.get('appointment_date', '')} {a.get('appointment_time', '')}".strip()
        subtitle = " · ".join(
            b for b in (when, a.get("type"), a.get("status")) if b
        ) or "Appointment"
        results.append({
            "type": "appointment",
            "id": a.get("appointment_id"),
            "title": a.get("client_name") or "Appointment",
            "subtitle": subtitle,
            "url": "/appointments",
            "score": _SCORE_APPT,
            "updated_at": a.get("updated_at"),
        })

    # --- Notes ---------------------------------------------------------
    note_proj = {
        "_id": 0, "note_id": 1, "lead_id": 1, "content": 1,
        "type": 1, "is_task": 1, "agent_name": 1, "updated_at": 1,
    }
    note_query = {
        **scope,
        "deleted": {"$ne": True},
        "content": rx,
    }
    async for n in (
        db.notes.find(note_query, note_proj)
        .sort("updated_at", -1)
        .limit(_PER_COLLECTION_LIMIT)
    ):
        content = (n.get("content") or "").strip()
        # Trim the note body to a one-liner so the dropdown stays compact.
        title = content[:80] + ("…" if len(content) > 80 else "")
        kind = "Task" if n.get("is_task") else (n.get("type") or "note").title()
        subtitle = f"{kind} · {n.get('agent_name') or '—'}"
        results.append({
            "type": "note",
            "id": n.get("note_id"),
            "title": title,
            "subtitle": subtitle,
            # Notes don't have their own page — deep-link to the lead
            # they're pinned to so the user lands on the right profile.
            "url": f"/clients/{n.get('lead_id')}",
            "score": _SCORE_NOTE,
            "updated_at": n.get("updated_at"),
        })

    # Sort by (score desc, updated_at desc) and trim to the requested limit.
    results.sort(
        key=lambda r: (r["score"], r.get("updated_at") or ""),
        reverse=True,
    )
    results = results[:limit]
    # Strip the sort key — never been part of the public contract.
    for r in results:
        r.pop("updated_at", None)

    await write_audit(
        db, "search_performed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={
            "query_length": len(raw),
            "result_count": len(results),
            "role": current_user.get("role"),
        },
    )

    return {
        "query": raw,
        "results": results,
        "total": len(results),
    }
