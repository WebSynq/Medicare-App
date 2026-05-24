"""
notes_router.py
===============
Notes and follow-up tasks pinned to a lead.

Every endpoint is auth-gated, agent-scoped via ``deps.agent_filter``,
60/hour IP-rate-limited, and audit-logged. Writes flow through
``deps.get_effective_agent`` so admin / coach / accounting users
impersonating an agent stamp their note under the impersonated
agent's identity (and the audit trail captures the actor).

Soft-delete semantics: ``DELETE /notes/{id}`` flips ``deleted=True``
+ ``deleted_at`` rather than removing the row, so the activity timeline
on a lead's profile stays reconstructible. Reads filter
``deleted: {"$ne": True}`` so the SPA never sees tombstones.
"""
import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    FULL_AGENCY_SCOPE_ROLES,
    agent_filter,
    get_agency_id,
    get_current_user,
    get_db,
    get_phi_db,
    get_effective_agent,
    write_audit,
)
from encryption import safe_lead_load


logger = logging.getLogger("gruening.notes")
router = APIRouter(prefix="/notes", tags=["notes"])
limiter = Limiter(key_func=get_remote_address)


NoteType = Literal["note", "call", "email", "task"]


# ── Pydantic bodies ──────────────────────────────────────────────────────
class NoteCreate(BaseModel):
    """Create a note OR a task in one shape.

    A task is just a note with ``is_task=True`` and a
    ``task_due_date``. Keeping both behind a single endpoint avoids
    duplicating the lead-ownership check and the audit plumbing.
    """
    lead_id: str = Field(..., min_length=1, max_length=128)
    content: str = Field(..., min_length=1, max_length=1000)
    type: NoteType = "note"
    is_task: bool = False
    task_due_date: Optional[str] = None

    @field_validator("task_due_date")
    @classmethod
    def _v_due_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        # Accept ISO YYYY-MM-DD. Rejected anything else so a misshapen
        # string can't poison the sort order on /notes reads later.
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except (TypeError, ValueError):
            raise ValueError("task_due_date must be YYYY-MM-DD")
        return v


# ── Helpers ──────────────────────────────────────────────────────────────
def _public(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Strip Mongo internals before shipping."""
    return {k: v for k, v in doc.items() if k != "_id"}


def _is_privileged(user: dict) -> bool:
    return user.get("role") in FULL_AGENCY_SCOPE_ROLES


async def _resolve_lead_or_403(
    db: AsyncIOMotorDatabase, lead_id: str, effective: dict,
) -> Dict[str, Any]:
    """Confirm the lead exists and the effective agent owns it
    (privileged roles bypass the ownership check). 404 missing /
    403 not-yours, same shape as leads_router._idor_or_403."""
    lead = safe_lead_load(await db.leads.find_one({"id": lead_id}, {"_id": 0}))
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    role = effective.get("role")
    if role not in FULL_AGENCY_SCOPE_ROLES and lead.get("agent_id") != effective["id"]:
        raise HTTPException(status_code=403, detail="Lead is not in your book")
    return lead


async def _fetch_note_or_idor(
    db: AsyncIOMotorDatabase, note_id: str, user: dict,
) -> Dict[str, Any]:
    """404 missing / 403 someone-else's. Privileged roles see everything."""
    doc = await db.notes.find_one({"note_id": note_id})
    if not doc or doc.get("deleted"):
        raise HTTPException(status_code=404, detail="Note not found")
    if _is_privileged(user):
        return doc
    if doc.get("agent_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return doc


# ── Endpoints ────────────────────────────────────────────────────────────
@router.post("", status_code=201)
@limiter.limit("60/hour")
async def create_note(
    request: Request,
    body: NoteCreate = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
):
    """Create a note or task tied to a lead the effective agent owns."""
    await _resolve_lead_or_403(db, body.lead_id, effective)

    if body.is_task and not body.task_due_date:
        raise HTTPException(
            status_code=422,
            detail="task_due_date is required when is_task is true",
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "note_id": str(uuid.uuid4()),
        "lead_id": body.lead_id,
        "agent_id": effective["id"],
        "agent_name": effective.get("agent_name") or effective.get("full_name"),
        "agency_id": get_agency_id(),
        "type": body.type,
        "content": body.content.strip(),
        "is_task": bool(body.is_task),
        "task_due_date": body.task_due_date,
        "task_completed": False,
        "task_completed_at": None,
        "deleted": False,
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    await db.notes.insert_one(doc)
    await write_audit(
        db, "note_created",
        actor_email=effective.get("email"),
        actor_id=effective["id"],
        target_type="note", target_id=doc["note_id"],
        request=request,
        metadata={
            "lead_id": body.lead_id,
            "type": body.type,
            "is_task": doc["is_task"],
            "impersonated_by": effective.get("_impersonated_by"),
        },
    )
    return _public(doc)


@router.get("")
@limiter.limit("60/hour")
async def list_notes(
    request: Request,
    lead_id: str = Query(..., min_length=1, max_length=128),
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """List notes + tasks for a single lead, newest first. Tombstones
    (deleted=True) are excluded. Scoped through agent_filter — an
    agent only sees notes on leads they own; privileged roles see
    the agency-wide book."""
    # Verify the caller can see this lead at all (404/403 propagate).
    await _resolve_lead_or_403(db, lead_id, current_user)
    scope = agent_filter(current_user)
    query: Dict[str, Any] = {
        **scope,
        "lead_id": lead_id,
        "deleted": {"$ne": True},
    }
    cursor = db.notes.find(query, {"_id": 0}).sort("created_at", -1).limit(500)
    rows: List[Dict[str, Any]] = [n async for n in cursor]
    return {"notes": rows, "total": len(rows)}


@router.patch("/{note_id}/complete")
@limiter.limit("60/hour")
async def complete_task(
    note_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Flip a task to completed. Idempotent — re-completing an already
    completed task returns the same row without bumping
    task_completed_at. Notes (is_task=False) 400 because there's no
    completion concept for them."""
    doc = await _fetch_note_or_idor(db, note_id, current_user)
    if not doc.get("is_task"):
        raise HTTPException(
            status_code=400,
            detail="Only tasks can be completed",
        )
    if doc.get("task_completed"):
        return _public(doc)

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.notes.update_one(
        {"note_id": note_id},
        {"$set": {
            "task_completed": True,
            "task_completed_at": now_iso,
            "updated_at": now_iso,
        }},
    )
    await write_audit(
        db, "task_completed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="note", target_id=note_id,
        request=request,
        metadata={"lead_id": doc.get("lead_id")},
    )
    fresh = await db.notes.find_one({"note_id": note_id}, {"_id": 0})
    return _public(fresh)


@router.delete("/{note_id}")
@limiter.limit("60/hour")
async def delete_note(
    note_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Soft-delete a note. Agents can only delete their own;
    admin / compliance / coach / accounting / client_success can
    delete any (the privileged-roles list, same as leads IDOR).
    Idempotent — re-deleting returns 404 because the first delete
    already tombstoned the row."""
    doc = await _fetch_note_or_idor(db, note_id, current_user)
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.notes.update_one(
        {"note_id": note_id},
        {"$set": {
            "deleted": True,
            "deleted_at": now_iso,
            "updated_at": now_iso,
        }},
    )
    await write_audit(
        db, "note_deleted",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="note", target_id=note_id,
        request=request,
        metadata={
            "lead_id": doc.get("lead_id"),
            "owned_by": doc.get("agent_id"),
        },
    )
    return {"ok": True, "note_id": note_id}
