"""
admin_commissions_router.py
---------------------------
Admin-only endpoint returning all agents with their commission upload stats.
Phase 1: DB-only data (no Comtrack API calls).
Phase 2: will add live Comtrack pull + GHL push.
"""

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from motor.motor_asyncio import AsyncIOMotorDatabase

from deps import get_db, get_current_user, require_roles, write_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/commissions", tags=["admin-commissions"])

# Agent is "stale" if their last upload was more than this many days ago
STALE_DAYS = 30


def _status(total_uploads: int, last_upload: str | None) -> str:
    """Derive a display status from upload history."""
    if total_uploads == 0 or last_upload is None:
        return "no_data"
    try:
        last_dt = datetime.fromisoformat(last_upload.replace("Z", "+00:00"))
        cutoff = datetime.now(timezone.utc) - timedelta(days=STALE_DAYS)
        return "current" if last_dt >= cutoff else "stale"
    except (ValueError, AttributeError):
        return "stale"


@router.get("")
async def get_all_agent_commissions(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "compliance")),
):
    """
    Return all agents with their commission upload stats.
    Visible to admin and compliance roles only.
    """

    # ── 1. All agent users ────────────────────────────────────────────────────
    agents_cursor = db.users.find(
        {"role": "agent"},
        {
            "_id": 0,
            "hashed_password": 0,
            "mfa_secret": 0,
            "approved_by": 0,
            "rejected_by": 0,
        },
    ).sort("full_name", 1)
    agents = await agents_cursor.to_list(length=500)

    # ── 2. Aggregate commission_syncs per agent ───────────────────────────────
    pipeline = [
        {
            "$group": {
                "_id": "$agent_id",
                "total_uploads": {"$sum": 1},
                "last_upload": {"$max": "$uploaded_at"},
                "digested_count": {
                    "$sum": {
                        "$cond": [{"$eq": ["$status", "digested"]}, 1, 0]
                    }
                },
                "not_recognized_count": {
                    "$sum": {
                        "$cond": [{"$eq": ["$status", "not_recognized"]}, 1, 0]
                    }
                },
                "rejected_count": {
                    "$sum": {
                        "$cond": [{"$eq": ["$status", "rejected"]}, 1, 0]
                    }
                },
            }
        }
    ]
    sync_agg = await db.commission_syncs.aggregate(pipeline).to_list(length=500)
    sync_map: dict = {row["_id"]: row for row in sync_agg}

    # ── 3. Enrich each agent ──────────────────────────────────────────────────
    enriched = []
    for agent in agents:
        agent_id = agent.get("id", "")
        sync = sync_map.get(agent_id, {})

        total_uploads = sync.get("total_uploads", 0)
        last_upload = sync.get("last_upload")

        enriched.append(
            {
                "id": agent_id,
                "full_name": agent.get("full_name") or "",
                "email": agent.get("email") or "",
                "agency_name": agent.get("agency_name") or "",
                "account_status": agent.get("status", "active"),
                "created_at": agent.get("created_at"),
                # commission upload stats
                "total_uploads": total_uploads,
                "digested_count": sync.get("digested_count", 0),
                "not_recognized_count": sync.get("not_recognized_count", 0),
                "rejected_count": sync.get("rejected_count", 0),
                "last_upload": last_upload,
                # derived status
                "commission_status": _status(total_uploads, last_upload),
                # Phase 2 placeholders
                "ytd_commission": None,
                "active_policies": None,
            }
        )

    # ── 4. Summary stats ──────────────────────────────────────────────────────
    total_agents = len(enriched)
    current_count = sum(1 for a in enriched if a["commission_status"] == "current")
    stale_count = sum(1 for a in enriched if a["commission_status"] == "stale")
    no_data_count = sum(1 for a in enriched if a["commission_status"] == "no_data")

    await write_audit(
        db=db,
        event_type="admin_commission_overview_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="admin_commission_overview",
        target_id="all",
        metadata={"total_agents": total_agents},
    )

    return {
        "agents": enriched,
        "summary": {
            "total_agents": total_agents,
            "current": current_count,
            "stale": stale_count,
            "no_data": no_data_count,
        },
    }
