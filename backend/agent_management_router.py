"""
agent_management_router.py
==========================
Admin / compliance views over the agent roster, plus the admin
toggle that activates / deactivates an agent.

Phase 2 of the workspace-isolation work: now that leads, policies and
production_records all carry an `agent_id`, we can roll up per-agent
counts cheaply from the indexed scoping field instead of joining.

Exposed under the /api prefix from server.py.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from deps import (
    get_db,
    get_current_user,
    require_roles,
    write_audit,
    COMPLIANCE_ROLES,
)


router = APIRouter(prefix="/agents", tags=["agent-management"])


class AgentStatusUpdate(BaseModel):
    is_active: bool


@router.get("")
async def list_agents(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Roster view with rolled-up production counts per agent.

    Aggregates over leads / policies / production_records by `agent_id`
    in a single round-trip each, then folds the results into the user
    list in memory. Cheap at any realistic agent count and avoids N+1
    per-agent count queries.
    """
    users_cursor = db["users"].find(
        {},
        {
            "_id": 0,
            "id": 1,
            "full_name": 1,
            "email": 1,
            "agent_name": 1,
            "agent_npn": 1,
            "role": 1,
            "is_active": 1,
            "status": 1,
            "agency_name": 1,
            "created_at": 1,
        },
    )
    users = await users_cursor.to_list(length=None)

    async def _count_by_agent(coll: str) -> dict:
        pipeline = [
            {"$match": {"agent_id": {"$ne": None}}},
            {"$group": {"_id": "$agent_id", "n": {"$sum": 1}}},
        ]
        out: dict = {}
        async for row in db[coll].aggregate(pipeline):
            out[row["_id"]] = row["n"]
        return out

    async def _revenue_by_agent() -> dict:
        pipeline = [
            {"$match": {"agent_id": {"$ne": None, "$ne": ""}}},
            {"$group": {"_id": "$agent_id",
                         "revenue": {"$sum": "$revenue_expected"}}},
        ]
        out: dict = {}
        async for row in db["production_records"].aggregate(pipeline):
            out[row["_id"]] = float(row.get("revenue") or 0)
        return out

    async def _last_submission_by_agent() -> dict:
        pipeline = [
            {"$match": {"agent_id": {"$ne": None}}},
            {"$group": {"_id": "$agent_id",
                         "last": {"$max": "$created_at"}}},
        ]
        out: dict = {}
        async for row in db["policies"].aggregate(pipeline):
            out[row["_id"]] = row.get("last")
        return out

    lead_counts = await _count_by_agent("leads")
    policy_counts = await _count_by_agent("policies")
    revenue_totals = await _revenue_by_agent()
    last_submissions = await _last_submission_by_agent()

    agents = []
    for u in users:
        uid = u.get("id")
        agents.append({
            "id": uid,
            "full_name": u.get("full_name"),
            "email": u.get("email"),
            "agent_name": u.get("agent_name"),
            "agent_npn": u.get("agent_npn"),
            "role": u.get("role"),
            "is_active": u.get("is_active", True),
            "status": u.get("status"),
            "agency_name": u.get("agency_name"),
            "created_at": u.get("created_at"),
            "lead_count": lead_counts.get(uid, 0),
            "policy_count": policy_counts.get(uid, 0),
            "production_revenue": round(revenue_totals.get(uid, 0.0), 2),
            "last_submission_date": last_submissions.get(uid),
        })

    return {"agents": agents, "count": len(agents)}


@router.patch("/{agent_id}/status")
async def update_agent_status(
    agent_id: str,
    payload: AgentStatusUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin")),
    db=Depends(get_db),
):
    """Activate / deactivate an agent.

    Self-deactivation is refused — locking out the only admin is
    irrecoverable without DB access, so we require a second admin to
    perform the toggle if you ever need to disable your own account.
    """
    if agent_id == current_user.get("id"):
        raise HTTPException(400, "Cannot change your own active status")

    target = await db["users"].find_one(
        {"id": agent_id}, {"_id": 0, "id": 1, "email": 1, "is_active": 1},
    )
    if not target:
        raise HTTPException(404, "Agent not found")

    new_state = bool(payload.is_active)
    prev_state = bool(target.get("is_active", True))

    await db["users"].update_one(
        {"id": agent_id}, {"$set": {"is_active": new_state}},
    )

    await write_audit(
        db, "agent_status_changed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="user", target_id=agent_id,
        request=request,
        metadata={
            "target_email": target.get("email"),
            "previous_is_active": prev_state,
            "new_is_active": new_state,
        },
    )

    return {
        "success": True,
        "agent_id": agent_id,
        "is_active": new_state,
    }
