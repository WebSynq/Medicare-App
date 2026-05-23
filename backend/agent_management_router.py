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
    get_agent_team_members,
    require_roles,
    write_audit,
    COMPLIANCE_ROLES,
)


router = APIRouter(prefix="/agents", tags=["agent-management"])

# Roles that may be assigned to another agent's team. Admin / owner /
# compliance / coach / accounting / sales_manager all carry agency-wide
# privileges of their own — pinning them inside an agent's scope would
# silently demote them and lose audit visibility. Keep the list tight.
_TEAM_MEMBER_ELIGIBLE_ROLES = ("va", "agent")


class AgentStatusUpdate(BaseModel):
    is_active: bool


class TeamAssignRequest(BaseModel):
    user_id: str


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
            "agent_id": 1,
            "ghl_location_id": 1,
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

    async def _team_counts_by_parent() -> dict:
        # Rolled up alongside the lead / policy aggregates so the agent
        # roster can show "team_count" in one round-trip rather than
        # N+1 lookups per row.
        pipeline = [
            {"$match": {"parent_agent_id": {"$ne": None}}},
            {"$group": {"_id": "$parent_agent_id", "n": {"$sum": 1}}},
        ]
        out: dict = {}
        async for row in db["users"].aggregate(pipeline):
            out[row["_id"]] = row["n"]
        return out

    lead_counts = await _count_by_agent("leads")
    policy_counts = await _count_by_agent("policies")
    revenue_totals = await _revenue_by_agent()
    last_submissions = await _last_submission_by_agent()
    team_counts = await _team_counts_by_parent()

    agents = []
    for u in users:
        uid = u.get("id")
        agents.append({
            "id": uid,
            "full_name": u.get("full_name"),
            "email": u.get("email"),
            "agent_name": u.get("agent_name"),
            "agent_npn": u.get("agent_npn"),
            "agent_id": u.get("agent_id") or uid,
            "role": u.get("role"),
            "is_active": u.get("is_active", True),
            "status": u.get("status"),
            "agency_name": u.get("agency_name"),
            "ghl_location_id": u.get("ghl_location_id"),
            "created_at": u.get("created_at"),
            "lead_count": lead_counts.get(uid, 0),
            "policy_count": policy_counts.get(uid, 0),
            "production_revenue": round(revenue_totals.get(uid, 0.0), 2),
            "last_submission_date": last_submissions.get(uid),
            # Number of users whose parent_agent_id == this user.id.
            # Zero for everyone except agents who have VAs / teammates
            # assigned to their account.
            "team_count": team_counts.get(uid, 0),
        })

    return {"agents": agents, "count": len(agents)}


# ----- Team member assignment (multi-user agent accounts) -----

@router.post("/{agent_id}/team")
async def assign_team_member(
    agent_id: str,
    payload: TeamAssignRequest,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "owner")),
    db=Depends(get_db),
):
    """Assign a VA / agent to work inside another agent's account scope.

    Once stamped with ``parent_agent_id``, the target's
    ``deps.agent_filter`` and ``deps.get_effective_agent`` resolve to
    the parent — so reads / writes look like the parent's own
    activity, but audit logs still record the team member as the
    actor (``_impersonated_by_id``).

    Validation:
      - Parent agent must exist + be active.
      - Target user must exist + be active.
      - Target.role must be in _TEAM_MEMBER_ELIGIBLE_ROLES.
      - Target can't be the parent themselves (no self-assignment).
      - Target can't already be on someone else's team — the admin
        must remove them first to make the move auditable.
    """
    if agent_id == payload.user_id:
        raise HTTPException(400, "Cannot assign an agent to their own team")

    parent = await db["users"].find_one(
        {"id": agent_id},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1,
         "is_active": 1},
    )
    if not parent:
        raise HTTPException(404, "Parent agent not found")
    if not parent.get("is_active", True):
        raise HTTPException(400, "Parent agent is deactivated")

    target = await db["users"].find_one(
        {"id": payload.user_id},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1,
         "is_active": 1, "parent_agent_id": 1},
    )
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("role") not in _TEAM_MEMBER_ELIGIBLE_ROLES:
        raise HTTPException(
            400,
            f"Only {'/'.join(_TEAM_MEMBER_ELIGIBLE_ROLES)} users can be "
            "assigned as team members. Admin / owner / coach / "
            "compliance roles operate at agency scope.",
        )
    existing_parent = target.get("parent_agent_id")
    if existing_parent and existing_parent != agent_id:
        raise HTTPException(
            409,
            "User is already assigned to a different agent's team. "
            "Remove them from that team first.",
        )

    await db["users"].update_one(
        {"id": payload.user_id},
        {"$set": {"parent_agent_id": agent_id}},
    )
    await write_audit(
        db, "team_member_assigned",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="user", target_id=payload.user_id,
        request=request,
        metadata={
            "parent_agent_id": agent_id,
            "parent_agent_email": parent.get("email"),
            "target_email": target.get("email"),
            "target_role": target.get("role"),
        },
    )
    return {
        "success": True,
        "user_id": payload.user_id,
        "parent_agent_id": agent_id,
    }


@router.delete("/{agent_id}/team/{user_id}")
async def remove_team_member(
    agent_id: str,
    user_id: str,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "owner")),
    db=Depends(get_db),
):
    """Remove a team member from an agent's account scope.

    Sets ``parent_agent_id = None`` so the user reverts to their own
    agent scope. Idempotent on already-unassigned users would 404 —
    we 404 rather than 200 so the admin gets a visible signal if
    they're acting on stale UI state.
    """
    target = await db["users"].find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "email": 1, "role": 1, "parent_agent_id": 1},
    )
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("parent_agent_id") != agent_id:
        raise HTTPException(
            404,
            "User is not on this agent's team",
        )

    await db["users"].update_one(
        {"id": user_id},
        {"$set": {"parent_agent_id": None}},
    )
    await write_audit(
        db, "team_member_removed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="user", target_id=user_id,
        request=request,
        metadata={
            "parent_agent_id": agent_id,
            "target_email": target.get("email"),
            "target_role": target.get("role"),
        },
    )
    return {"success": True, "user_id": user_id, "parent_agent_id": None}


@router.get("/{agent_id}/team")
async def list_team_members(
    agent_id: str,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """List the VAs / agents assigned to one agent's team.

    Visible to admin / owner, or to the agent whose team it is. Other
    agents can't enumerate someone else's team membership — 403.
    """
    role = current_user.get("role")
    if role not in ("admin", "owner") and current_user.get("id") != agent_id:
        raise HTTPException(403, "Insufficient permissions")
    members = await get_agent_team_members(db, agent_id)
    return {"members": members, "count": len(members)}


@router.patch("/{agent_id}/status")
async def update_agent_status(
    agent_id: str,
    payload: AgentStatusUpdate,
    request: Request,
    current_user: dict = Depends(require_roles("admin", "owner")),
    db=Depends(get_db),
):
    """Activate / deactivate any team member.

    Works for ALL roles (admin / agent / compliance / sales_manager
    / coach / ...) — the soft-deactivation contract is identical
    regardless. Self-deactivation is refused — locking out the only
    admin is irrecoverable without DB access, so we require a second
    admin to perform the toggle if you ever need to disable your own
    account.

    No hard delete ever happens here. The user row stays in Mongo so
    the HIPAA audit trail stays intact; `is_active=false` is what
    `deps.get_current_user` keys off to refuse subsequent requests.
    """
    if agent_id == current_user.get("id"):
        raise HTTPException(400, "Cannot change your own active status")

    target = await db["users"].find_one(
        {"id": agent_id},
        {"_id": 0, "id": 1, "email": 1, "is_active": 1, "role": 1,
         "full_name": 1, "token_version": 1},
    )
    if not target:
        raise HTTPException(404, "User not found")

    new_state = bool(payload.is_active)
    prev_state = bool(target.get("is_active", True))

    updates: dict = {"is_active": new_state}
    # On reactivation also flip status → "active" so a previously
    # pending or admin-deactivated user can actually log in. Login
    # rejects status in {pending, rejected} with a 403 regardless of
    # is_active, so without this clear-up the Reactivate button
    # silently no-op'd against pending accounts. We don't touch
    # status on deactivation — deactivated accounts keep their
    # status so the admin can see why they were originally rejected
    # if applicable.
    if new_state:
        updates["status"] = "active"
    # Bump token_version on deactivation so any active JWT for the
    # target user fails the deps.get_current_user check on next
    # request — they're booted from every device immediately.
    if not new_state:
        updates["token_version"] = int(target.get("token_version", 0) or 0) + 1
    await db["users"].update_one({"id": agent_id}, {"$set": updates})

    event = (
        "user_reactivated" if new_state and not prev_state
        else "user_deactivated" if prev_state and not new_state
        else "agent_status_changed"
    )
    await write_audit(
        db, event,
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="user", target_id=agent_id,
        request=request,
        metadata={
            "target_email": target.get("email"),
            "target_role": target.get("role"),
            "previous_is_active": prev_state,
            "new_is_active": new_state,
        },
    )

    return {
        "success": True,
        "agent_id": agent_id,
        "is_active": new_state,
    }
