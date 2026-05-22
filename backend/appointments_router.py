"""
appointments_router.py
======================
Agent-scoped appointment CRUD.

Every endpoint requires auth, is rate-limited 60/hour per IP, and is
scoped server-side:
  - Reads via ``deps.agent_filter`` — agents see only their own
    appointments; admin/compliance see the agency (or impersonated
    agent's view via ``X-Agent-ID``).
  - Writes via ``deps.get_effective_agent`` so ``agent_id`` /
    ``agent_name`` are stamped from a trusted server-side identity.
  - Single-resource reads/writes IDOR-check the owner before returning
    or mutating the doc.

Cancellation is a soft transition (``status`` → ``cancelled``) — we
never hard-delete an appointment record so the audit trail is intact
and the row can still be referenced by past activity views.
"""
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    FULL_AGENCY_SCOPE_ROLES,
    agent_filter,
    get_current_user,
    get_db,
    get_effective_agent,
    write_audit,
)


logger = logging.getLogger("gruening.appointments")
router = APIRouter(prefix="/appointments", tags=["appointments"])
limiter = Limiter(key_func=get_remote_address)


# ── Enums / validators ────────────────────────────────────────────────────
AppointmentType = Literal[
    "initial_consultation",
    "plan_review",
    "enrollment",
    "annual_review",
    "follow_up",
    "other",
]

AppointmentStatus = Literal["scheduled", "completed", "cancelled", "no_show"]

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def _validate_date(v: str) -> str:
    """ISO YYYY-MM-DD only. Strict so the today_router date-eq query works."""
    if not isinstance(v, str) or not _DATE_RE.fullmatch(v):
        raise ValueError("appointment_date must be YYYY-MM-DD")
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("appointment_date is not a valid calendar date") from exc
    return v


def _validate_time(v: str) -> str:
    """24-hour HH:MM (00:00 – 23:59)."""
    if not isinstance(v, str) or not _TIME_RE.fullmatch(v):
        raise ValueError("appointment_time must be HH:MM (24h)")
    hh, mm = v.split(":")
    if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
        raise ValueError("appointment_time hours/minutes out of range")
    return v


# ── Pydantic bodies ──────────────────────────────────────────────────────
class AppointmentCreate(BaseModel):
    lead_id: str = Field(..., min_length=1, max_length=128)
    appointment_date: str
    appointment_time: str
    duration_minutes: int = Field(30, ge=5, le=480)
    type: AppointmentType = "initial_consultation"
    notes: Optional[str] = Field(None, max_length=500)
    estimated_commission: Optional[float] = Field(None, ge=0)

    @field_validator("appointment_date")
    @classmethod
    def _v_date(cls, v: str) -> str:
        return _validate_date(v)

    @field_validator("appointment_time")
    @classmethod
    def _v_time(cls, v: str) -> str:
        return _validate_time(v)


class AppointmentUpdate(BaseModel):
    """Patch payload. None means "don't touch"; explicit empty string for
    notes/outcome means "clear it". ``status`` must be a valid enum value
    when present."""
    status: Optional[AppointmentStatus] = None
    notes: Optional[str] = Field(None, max_length=500)
    outcome: Optional[str] = Field(None, max_length=500)


# ── Helpers ──────────────────────────────────────────────────────────────
def _public(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Strip Mongo internals before shipping to the client."""
    if not doc:
        return doc
    out = {k: v for k, v in doc.items() if k != "_id"}
    return out


def _is_privileged(user: dict) -> bool:
    return user.get("role") in FULL_AGENCY_SCOPE_ROLES


async def _fetch_or_idor(
    db: AsyncIOMotorDatabase, appointment_id: str, user: dict
) -> Dict[str, Any]:
    """Same pattern as leads_router._idor_or_403: 404 when missing, 403
    when found but not owned (and caller isn't admin/compliance/CS)."""
    doc = await db.appointments.find_one({"appointment_id": appointment_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Appointment not found")
    if _is_privileged(user):
        return doc
    if doc.get("agent_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return doc


async def _resolve_lead(
    db: AsyncIOMotorDatabase, lead_id: str, effective: dict
) -> Dict[str, Any]:
    """Verify the appointment's lead exists and the effective agent owns
    it (or is privileged). Returns the lead doc so we can denormalize
    client_name onto the appointment row.
    """
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    role = effective.get("role")
    if role not in FULL_AGENCY_SCOPE_ROLES and lead.get("agent_id") != effective["id"]:
        # Agents can only book appointments against leads they own.
        raise HTTPException(status_code=403, detail="Lead is not in your book")
    return lead


def _client_name(lead: Dict[str, Any]) -> str:
    fn = (lead.get("first_name") or "").strip()
    ln = (lead.get("last_name") or "").strip()
    full = f"{fn} {ln}".strip()
    return full or lead.get("email") or "Unknown"


# ── Endpoints ────────────────────────────────────────────────────────────
@router.post("", status_code=201)
@limiter.limit("60/hour")
async def create_appointment(
    request: Request,
    body: AppointmentCreate = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    """Create an appointment for a lead owned by the effective agent."""
    lead = await _resolve_lead(db, body.lead_id, effective)
    now_iso = datetime.now(timezone.utc).isoformat()

    doc = {
        "appointment_id": str(uuid.uuid4()),
        "agent_id": effective["id"],
        "agent_name": effective.get("agent_name") or effective.get("full_name"),
        "agent_email": (effective.get("email") or "").lower() or None,
        "lead_id": body.lead_id,
        "client_name": _client_name(lead),
        "appointment_date": body.appointment_date,
        "appointment_time": body.appointment_time,
        "duration_minutes": body.duration_minutes,
        "type": body.type,
        "status": "scheduled",
        "notes": (body.notes or "").strip() or None,
        "outcome": None,
        "estimated_commission": body.estimated_commission,
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    await db.appointments.insert_one(doc)

    await write_audit(
        db,
        "appointment_created",
        actor_email=effective.get("email"),
        actor_id=effective["id"],
        target_type="appointment",
        target_id=doc["appointment_id"],
        request=request,
        metadata={
            "lead_id": body.lead_id,
            "appointment_date": body.appointment_date,
            "type": body.type,
            "impersonated_by": effective.get("_impersonated_by"),
        },
    )
    return _public(doc)


@router.get("")
@limiter.limit("60/hour")
async def list_appointments(
    request: Request,
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    status: Optional[AppointmentStatus] = Query(None),
    lead_id: Optional[str] = Query(None, max_length=128),
    limit: int = Query(200, ge=1, le=1000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """List the caller's appointments. Optional date / status / lead_id
    filters narrow the result for the same scope; they cannot widen it."""
    query: Dict[str, Any] = dict(agent_filter(current_user))
    if date:
        # Validate so a malformed query param doesn't blow up the cursor.
        try:
            _validate_date(date)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        query["appointment_date"] = date
    if status:
        query["status"] = status
    if lead_id:
        query["lead_id"] = lead_id

    cursor = (
        db.appointments.find(query, {"_id": 0})
        .sort([("appointment_date", 1), ("appointment_time", 1)])
        .limit(limit)
    )
    rows = [d async for d in cursor]
    return {"appointments": rows, "total": len(rows)}


@router.get("/{appointment_id}")
@limiter.limit("60/hour")
async def get_appointment(
    appointment_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Single appointment with IDOR firewall."""
    doc = await _fetch_or_idor(db, appointment_id, current_user)
    return _public(doc)


@router.patch("/{appointment_id}")
@limiter.limit("60/hour")
async def update_appointment(
    appointment_id: str,
    request: Request,
    body: AppointmentUpdate = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Patch status / notes / outcome. IDOR-checked. Empty payload 400s
    so the SPA doesn't accidentally fire no-op writes."""
    await _fetch_or_idor(db, appointment_id, current_user)

    sent = body.model_dump(exclude_unset=True)
    if not sent:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates: Dict[str, Any] = {}
    if "status" in sent:
        updates["status"] = sent["status"]
    if "notes" in sent:
        updates["notes"] = (sent["notes"] or "").strip() or None
    if "outcome" in sent:
        updates["outcome"] = (sent["outcome"] or "").strip() or None
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()

    await db.appointments.update_one(
        {"appointment_id": appointment_id}, {"$set": updates}
    )

    await write_audit(
        db,
        "appointment_updated",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="appointment",
        target_id=appointment_id,
        request=request,
        metadata={"fields": [k for k in updates if k != "updated_at"]},
    )

    fresh = await db.appointments.find_one(
        {"appointment_id": appointment_id}, {"_id": 0}
    )
    return _public(fresh)


@router.delete("/{appointment_id}")
@limiter.limit("60/hour")
async def cancel_appointment(
    appointment_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Soft-cancel — flips status to "cancelled" so history + audit
    references stay intact. Idempotent: cancelling an already-cancelled
    appointment returns 200 with the unchanged doc."""
    doc = await _fetch_or_idor(db, appointment_id, current_user)

    if doc.get("status") == "cancelled":
        return _public(doc)

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.appointments.update_one(
        {"appointment_id": appointment_id},
        {"$set": {"status": "cancelled", "updated_at": now_iso}},
    )
    await write_audit(
        db,
        "appointment_cancelled",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="appointment",
        target_id=appointment_id,
        request=request,
        metadata={
            "lead_id": doc.get("lead_id"),
            "appointment_date": doc.get("appointment_date"),
        },
    )
    fresh = await db.appointments.find_one(
        {"appointment_id": appointment_id}, {"_id": 0}
    )
    return _public(fresh)
