"""Daily Agent Brief — today's prioritized call list.

The brief itself is generated nightly by the automations tick
(``run_daily_agent_brief`` in ``automations.py``) and stored in
``db.agent_daily_briefs`` keyed by ``(agent_id, date)``. This router
exposes a single read endpoint so the Today page widget can render
the brief without re-running the scoring logic per page-load.

Scoring rationale
=================
The score is the sum of additive heuristics defined in
``automations.compute_lead_urgency``:
  +40 birthday window open today (state-aware)
  +25 birthday window opens within 30 days
  +20 inside AEP season (Oct 15 – Dec 7)
  +30 never contacted before
  +15 days since last contact > 30
  +25 days since last contact > 60
  +30 turning 65 within 90 days
  +25 employer-transition tag present
  +10 CNA completed (ready for a formal recommendation)
  +25 SOA signed but not yet enrolled

The same value is also stamped onto each lead as ``ai_score`` so the
Clients list can sort by it without re-running the brief.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    get_current_user,
    get_db,
    get_phi_db,
    get_effective_agent,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/brief", tags=["brief"])
limiter = Limiter(key_func=get_remote_address)


def _today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@router.get("/today")
@limiter.limit("120/hour")
async def todays_brief(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
):
    """Return today's stored brief for the effective agent, or compute
    on-demand if the scheduler hasn't run yet today (fresh deploys,
    first-time agents). The on-demand path matches the scheduler's
    output exactly so the Today widget is consistent regardless of
    when the agent opens the portal."""
    agent_id = effective["id"]
    today = _today_str()
    stored = await db.agent_daily_briefs.find_one(
        {"agent_id": agent_id, "date": today}, {"_id": 0},
    )
    if stored:
        return stored

    # Live fallback — generate now so a brand-new agent sees their list
    # before the next scheduler tick. Lazy import so a missing
    # automations module (e.g. test env without scheduler bits) still
    # leaves /brief/today serviceable.
    try:
        from automations import build_brief_for_agent
        brief = await build_brief_for_agent(phi_db, effective, persist=True)
        return brief
    except Exception as e:                                    # noqa: BLE001
        logger.warning("brief/today live build failed: %s", e)
        return {
            "agent_id": agent_id,
            "date": today,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "top_calls": [],
            "total_urgent": 0,
            "total_priority": 0,
        }
