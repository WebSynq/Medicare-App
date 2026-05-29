"""
calendars_router.py
===================
Feature C — sub-phase C2: first-class calendar CRUD API.

Mounted at ``/api/calendars`` (note the plural — keeps the existing
``/api/calendar/google/*`` OAuth router untouched).

Role rules:
  - **owner / admin** (any FULL_AGENCY_SCOPE_ROLES member) — full
    CRUD on every calendar inside their agency, sees the full
    distribution internals on GET.
  - **agent / va / other** — read-only on their own Individual
    calendar (owner_id == self.id) AND any calendar where
    self.id is in ``member_ids``. May PATCH their own Individual
    calendar's ``name`` + ``booking_settings`` only.

Soft delete: DELETE flips ``is_active`` to False. The route refuses
the delete with 409 when there are upcoming non-cancelled
appointments stamped with ``calendar_id == id``.

Every write audits with the `calendar_created` / `calendar_updated`
/ `calendar_deactivated` event types so the compliance log can
reconstruct who changed what.
"""
import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import DuplicateKeyError

from deps import (
    FULL_AGENCY_SCOPE_ROLES,
    get_agency,
    get_current_user,
    get_db,
    get_phi_db,
    write_audit,
)
from models import (
    Calendar,
    CalendarType,
    CalendarSourceLabel,
    _default_calendar_booking_settings,
    _CALENDAR_COLOR_BY_TYPE,
)


logger = logging.getLogger("gruening.calendars")
router = APIRouter(prefix="/calendars", tags=["calendars"])


# ── Pydantic bodies ──────────────────────────────────────────────────────


class CalendarCreate(BaseModel):
    """Admin-only create. Strict validation per design Q1 (slug regex)
    + cross-field rules:

      - Individual: owner_id required, member_ids must be empty
      - Round Robin: member_ids non-empty, owner_id null
      - Group: same as Round Robin (member_ids non-empty, owner_id null)

    color defaults to the per-type palette in models if omitted.
    booking_settings defaults to the standard 30-min weekday shape.
    """
    name: str = Field(..., min_length=1, max_length=120)
    type: CalendarType
    slug: str = Field(..., min_length=3, max_length=60,
                      pattern=r"^[a-z0-9-]+$")
    source_label: CalendarSourceLabel = "manual"
    color: Optional[str] = Field(None, min_length=4, max_length=9)
    owner_id: Optional[str] = Field(None, max_length=128)
    member_ids: List[str] = Field(default_factory=list, max_length=200)
    distribution: Optional[dict] = None
    booking_settings: Optional[dict] = None


class CalendarPatch(BaseModel):
    """Patch payload. Field filtering by role happens in the handler —
    every field is nominally optional here so the Pydantic boundary
    can express the shape without role-coupling.

    A non-admin caller's body has every field except ``name`` +
    ``booking_settings`` ignored after validation (route silently
    drops them rather than 422 — keeps the SPA's PATCH-all-fields
    pattern working for both roles).
    """
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    type: Optional[CalendarType] = None
    slug: Optional[str] = Field(None, min_length=3, max_length=60,
                                 pattern=r"^[a-z0-9-]+$")
    source_label: Optional[CalendarSourceLabel] = None
    color: Optional[str] = Field(None, min_length=4, max_length=9)
    owner_id: Optional[str] = Field(None, max_length=128)
    member_ids: Optional[List[str]] = Field(None, max_length=200)
    distribution: Optional[dict] = None
    booking_settings: Optional[dict] = None
    is_active: Optional[bool] = None


# ── Helpers ──────────────────────────────────────────────────────────────


def _is_privileged(user: dict) -> bool:
    return user.get("role") in FULL_AGENCY_SCOPE_ROLES


def _strip_distribution_internals(cal: dict) -> dict:
    """Agent-facing response — drop the round-robin ledger fields
    (assignment_counts, last_assigned_at) so a member can't see how
    often their teammates have been picked. ``weights`` stays because
    a member legitimately needs to see their own share.
    """
    if not cal:
        return cal
    out = {k: v for k, v in cal.items() if k != "_id"}
    dist = out.get("distribution")
    if isinstance(dist, dict):
        out["distribution"] = {"weights": dist.get("weights") or {}}
    return out


def _public(cal: dict) -> dict:
    if not cal:
        return cal
    return {k: v for k, v in cal.items() if k != "_id"}


def _agent_can_read(cal: dict, user: dict) -> bool:
    if _is_privileged(user):
        return True
    if cal.get("owner_id") == user.get("id"):
        return True
    members = cal.get("member_ids") or []
    return user.get("id") in members


def _validate_create_rules(body: CalendarCreate) -> None:
    """Enforce the type → owner_id / member_ids invariant."""
    if body.type == "individual":
        if not body.owner_id:
            raise HTTPException(
                status_code=422,
                detail="Individual calendar requires owner_id.",
            )
        if body.member_ids:
            raise HTTPException(
                status_code=422,
                detail="Individual calendar must not list member_ids.",
            )
    else:  # round_robin or group
        if body.owner_id:
            raise HTTPException(
                status_code=422,
                detail=f"{body.type} calendar must not have owner_id.",
            )
        if not body.member_ids:
            raise HTTPException(
                status_code=422,
                detail=f"{body.type} calendar requires at least one member.",
            )


async def _fetch_or_404(
    db: AsyncIOMotorDatabase, calendar_id: str, agency_id: str,
) -> Dict[str, Any]:
    """Always-scoped lookup. Cross-agency calendars surface as 404
    (not 403) so callers can't probe slugs across tenants.
    """
    cal = await db.calendars.find_one(
        {"id": calendar_id, "agency_id": agency_id}, {"_id": 0},
    )
    if not cal:
        raise HTTPException(status_code=404, detail="Calendar not found")
    return cal


async def _count_upcoming_appointments(
    phi_db: AsyncIOMotorDatabase, calendar_id: str,
) -> int:
    today_iso = date.today().isoformat()
    return await phi_db.appointments.count_documents({
        "calendar_id": calendar_id,
        "status": {"$ne": "cancelled"},
        "appointment_date": {"$gte": today_iso},
    })


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("")
async def list_calendars(
    request: Request,
    type: Optional[CalendarType] = Query(None),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """List calendars visible to the caller.

    Owners/admins see every calendar in their agency.
    Agents see calendars they own (Individual) or are a member of
    (Round Robin / Group). Distribution internals are stripped for
    every non-privileged caller.
    """
    query: Dict[str, Any] = {"agency_id": agency["agency_id"]}
    if type:
        query["type"] = type

    if not _is_privileged(current_user):
        query["$or"] = [
            {"owner_id": current_user["id"]},
            {"member_ids": current_user["id"]},
        ]

    rows: List[Dict[str, Any]] = []
    async for cal in db.calendars.find(query, {"_id": 0}):
        if _is_privileged(current_user):
            rows.append(_public(cal))
        else:
            rows.append(_strip_distribution_internals(cal))
    # Stable sort: type then name. Cheap; the list is small per agency.
    rows.sort(key=lambda c: (c.get("type") or "", c.get("name") or ""))
    return {"calendars": rows, "total": len(rows)}


@router.post("", status_code=201)
async def create_calendar(
    request: Request,
    body: CalendarCreate = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Create a calendar. Admin / owner only.

    Slug collision → 409 (the slug-unique index throws DuplicateKey
    which we translate). The handler doesn't pre-check uniqueness —
    the index is the source of truth so a TOCTOU race can't slip
    through.
    """
    if not _is_privileged(current_user):
        raise HTTPException(
            status_code=403, detail="Only owners/admins can create calendars.",
        )
    _validate_create_rules(body)

    color = body.color or _CALENDAR_COLOR_BY_TYPE.get(
        body.type, "#6366f1",
    )
    bs = body.booking_settings or _default_calendar_booking_settings()
    distribution = body.distribution
    if body.type == "round_robin" and distribution is None:
        # Seed an empty ledger so the C3 engine can $inc into it
        # without an upsert.
        distribution = {
            "weights": {uid: 1 for uid in body.member_ids},
            "assignment_counts": {uid: 0 for uid in body.member_ids},
            "last_assigned_at": {},
        }

    doc = Calendar(
        agency_id=agency["agency_id"],
        name=body.name,
        type=body.type,
        slug=body.slug,
        color=color,
        source_label=body.source_label,
        owner_id=body.owner_id,
        member_ids=body.member_ids,
        booking_settings=bs,
    ).model_dump()
    # Pydantic Calendar.distribution is typed Optional[CalendarDistribution];
    # we set the raw dict here so round_robin gets the seeded ledger.
    doc["distribution"] = distribution

    try:
        await db.calendars.insert_one(doc)
    except DuplicateKeyError:
        raise HTTPException(
            status_code=409,
            detail=f"Slug {body.slug!r} is already taken. Pick another.",
        )

    await write_audit(
        db, "calendar_created",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="calendar",
        target_id=doc["id"],
        request=request,
        metadata={
            "type": doc["type"], "slug": doc["slug"], "name": doc["name"],
        },
    )
    return _public(doc)


@router.get("/{calendar_id}")
async def get_calendar(
    calendar_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Single calendar. Agent gets 403 when not owner/member. Admin
    gets the full doc including distribution internals.
    """
    cal = await _fetch_or_404(db, calendar_id, agency["agency_id"])
    if not _agent_can_read(cal, current_user):
        raise HTTPException(status_code=403, detail="Access denied")
    if _is_privileged(current_user):
        return _public(cal)
    return _strip_distribution_internals(cal)


# Admin-mutable field list. Excludes: id, agency_id, created_at.
_ADMIN_FIELDS = {
    "name", "type", "slug", "source_label", "color",
    "owner_id", "member_ids", "distribution",
    "booking_settings", "is_active",
}

# Agent-mutable field list. Strict subset — anything else is silently
# dropped on the agent path (NOT 422, to keep the SPA's "PATCH whole
# form" pattern working without role-coupling on the client).
_AGENT_FIELDS = {"name", "booking_settings"}


@router.patch("/{calendar_id}")
async def patch_calendar(
    calendar_id: str,
    request: Request,
    body: CalendarPatch = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Patch fields. Field allow-list differs by role.

    Agent rule: can patch own Individual calendar's name +
    booking_settings only. Round-robin / group are admin-managed —
    members never get write access to them through this path.
    """
    cal = await _fetch_or_404(db, calendar_id, agency["agency_id"])

    sent = body.model_dump(exclude_unset=True)
    if not sent:
        raise HTTPException(status_code=400, detail="No fields to update")

    privileged = _is_privileged(current_user)
    if not privileged:
        # Agents can ONLY patch their own Individual calendar.
        if cal.get("type") != "individual" or cal.get("owner_id") != current_user.get("id"):
            raise HTTPException(status_code=403, detail="Access denied")
        # Drop any non-allowlisted fields silently.
        sent = {k: v for k, v in sent.items() if k in _AGENT_FIELDS}
        if not sent:
            raise HTTPException(
                status_code=400,
                detail="Agents may only update name + booking_settings.",
            )

    # Admin path — keep only the allow-list (filters id / agency_id /
    # created_at if a client sneaks them in via the patch body).
    sent = {k: v for k, v in sent.items() if k in _ADMIN_FIELDS}

    sent["updated_at"] = _now_iso()
    try:
        result = await db.calendars.update_one(
            {"id": calendar_id, "agency_id": agency["agency_id"]},
            {"$set": sent},
        )
    except DuplicateKeyError:
        raise HTTPException(
            status_code=409,
            detail="That slug is already taken. Pick another.",
        )
    if result.matched_count == 0:
        # Race: row was deleted between fetch + update. Surface as 404
        # so the SPA can re-fetch the list and recover.
        raise HTTPException(status_code=404, detail="Calendar not found")

    await write_audit(
        db, "calendar_updated",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="calendar",
        target_id=calendar_id,
        request=request,
        metadata={
            "fields": sorted([k for k in sent if k != "updated_at"]),
            "role": current_user.get("role"),
        },
    )

    fresh = await db.calendars.find_one(
        {"id": calendar_id}, {"_id": 0},
    )
    if privileged:
        return _public(fresh)
    return _strip_distribution_internals(fresh)


@router.delete("/{calendar_id}")
async def delete_calendar(
    calendar_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Soft-delete (is_active=False). Refuses with 409 + the blocking
    appointment count when there are upcoming non-cancelled
    appointments. Admin / owner only.
    """
    if not _is_privileged(current_user):
        raise HTTPException(
            status_code=403, detail="Only owners/admins can deactivate calendars.",
        )
    cal = await _fetch_or_404(db, calendar_id, agency["agency_id"])
    if not cal.get("is_active", True):
        # Idempotent — already inactive.
        return _public(cal)

    blocking = await _count_upcoming_appointments(phi_db, calendar_id)
    if blocking > 0:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    f"Cannot deactivate — {blocking} upcoming "
                    "appointment(s) still reference this calendar."
                ),
                "blocking_appointments": blocking,
            },
        )

    await db.calendars.update_one(
        {"id": calendar_id, "agency_id": agency["agency_id"]},
        {"$set": {"is_active": False, "updated_at": _now_iso()}},
    )
    await write_audit(
        db, "calendar_deactivated",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="calendar",
        target_id=calendar_id,
        request=request,
        metadata={
            "slug": cal.get("slug"), "type": cal.get("type"),
            "name": cal.get("name"),
        },
    )
    fresh = await db.calendars.find_one(
        {"id": calendar_id}, {"_id": 0},
    )
    return _public(fresh)
