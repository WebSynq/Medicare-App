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
from datetime import date, datetime, time as dtime, timezone
from typing import Any, Dict, List, Optional, Tuple

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


# ═══════════════════════════════════════════════════════════════════════
# Round-robin distribution engine (Feature C — sub-phase C3)
# ═══════════════════════════════════════════════════════════════════════
# Deficit-weighted selection: each member has a target share (weight /
# total_weight); the engine picks the available member whose actual
# share (count / total_count) is furthest below their target. Ties
# break to the oldest last_assigned_at, then to the lowest index in
# member_ids — the same order regardless of which member dict the
# caller hands in first, so the pick is deterministic given the input.

_WEEKDAY_KEYS = (
    "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday",
)


def _parse_iso_date(s: str) -> Optional[date]:
    try:
        y, m, d = (int(p) for p in s.split("-"))
        return date(y, m, d)
    except (ValueError, AttributeError):
        return None


def _parse_hhmm(s: str) -> Optional[dtime]:
    try:
        hh, mm = (int(p) for p in s.split(":"))
        return dtime(hh, mm)
    except (ValueError, AttributeError):
        return None


def _is_member_available(
    user_bs: dict, weekday_key: str, slot_time: Optional[dtime],
) -> bool:
    """A member is available for a slot when their working_hours has
    that weekday enabled AND the slot's HH:MM falls in the start/end
    window. A user with no working_hours dict for the weekday falls
    back to "available" — the calendar's working_hours already
    constrained the candidate slot.
    """
    wh = (user_bs or {}).get("working_hours") or {}
    day = wh.get(weekday_key)
    if not isinstance(day, dict):
        return True
    if not day.get("enabled", True):
        return False
    if slot_time is None:
        return True
    start = _parse_hhmm(day.get("start") or "00:00") or dtime(0, 0)
    end = _parse_hhmm(day.get("end") or "23:59") or dtime(23, 59)
    return start <= slot_time <= end


def _compute_deficit(
    weight: int, count: int, total_weight: int, total_count: int,
) -> float:
    """expected_share - actual_share. total_count is floored to 1 at
    the call site so first-booking deficits collapse to expected_share.
    """
    expected = weight / total_weight if total_weight else 0.0
    actual = count / total_count if total_count else 0.0
    return expected - actual


def _select_round_robin_member(
    members: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Inputs: list of member dicts with keys
       ``id, weight, count, last_assigned_at, index, available``.

    Returns the chosen member dict (with a ``deficit`` field added) or
    None when no member is available.

    Sort key: (-deficit, last_assigned_at-sentinel, index). The
    sentinel maps None → "" so untouched members sort before any
    member already assigned — first booking goes to the lowest-index
    available member when weights are equal.
    """
    available = [m for m in members if m["available"]]
    if not available:
        return None
    total_weight = sum(m["weight"] for m in available) or 1
    total_count = max(1, sum(m["count"] for m in available))
    for m in available:
        m["deficit"] = _compute_deficit(
            m["weight"], m["count"], total_weight, total_count,
        )
    available.sort(key=lambda m: (
        -m["deficit"],
        m["last_assigned_at"] or "",
        m["index"],
    ))
    return available[0]


async def _build_member_view(
    db: AsyncIOMotorDatabase, calendar: Dict[str, Any],
    slot_dt: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """Hydrate ``calendar.member_ids`` into a list of member dicts
    suitable for ``_select_round_robin_member``. Pulls per-member
    weight + assignment_count + last_assigned_at out of the
    distribution ledger and computes ``available`` against the slot
    datetime when provided (None → "available now" which uses the
    current UTC wall-clock).
    """
    dist = calendar.get("distribution") or {}
    weights = dist.get("weights") or {}
    counts = dist.get("assignment_counts") or {}
    last = dist.get("last_assigned_at") or {}

    member_ids = calendar.get("member_ids") or []
    if not member_ids:
        return []

    users = {
        u["id"]: u
        async for u in db.users.find(
            {"id": {"$in": member_ids}},
            {"_id": 0, "id": 1, "full_name": 1, "agent_name": 1,
             "email": 1, "is_active": 1, "booking_settings": 1},
        )
    }

    if slot_dt is None:
        slot_dt = datetime.now(timezone.utc)
    weekday_key = _WEEKDAY_KEYS[slot_dt.weekday()]
    slot_time = dtime(slot_dt.hour, slot_dt.minute)

    out = []
    for idx, uid in enumerate(member_ids):
        u = users.get(uid)
        if not u or not u.get("is_active", True):
            available = False
        else:
            available = _is_member_available(
                u.get("booking_settings") or {}, weekday_key, slot_time,
            )
        out.append({
            "id": uid,
            "full_name": (u or {}).get("full_name")
                or (u or {}).get("agent_name") or "",
            "weight": int(weights.get(uid, 1) or 1),
            "count": int(counts.get(uid, 0) or 0),
            "last_assigned_at": last.get(uid),
            "index": idx,
            "available": available,
            "_user": u,
        })
    return out


async def pick_and_record_round_robin(
    db: AsyncIOMotorDatabase, calendar: Dict[str, Any],
    slot_dt: Optional[datetime] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Pick a member for the requested slot and atomically bump their
    ledger entry.

    Returns ``(selected_member_dict, fresh_calendar_doc)``. When no
    member is available the tuple is ``(None, calendar)`` — caller
    raises 409. The increment uses Mongo's $inc + $set so two
    concurrent calls each bump the same counter without one
    clobbering the other; the picker still has the classic read /
    compute / write race for very-high-concurrency selection — for
    the booking workload's actual concurrency (single-digit RPS per
    slug) the race window is too small to matter, and the C5 admin
    UI can manually correct any visible drift via /distribution/reset.
    """
    members = await _build_member_view(db, calendar, slot_dt)
    chosen = _select_round_robin_member(members)
    if not chosen:
        return None, calendar
    uid = chosen["id"]
    now_iso = datetime.now(timezone.utc).isoformat()
    updated = await db.calendars.find_one_and_update(
        {"id": calendar["id"]},
        {
            "$inc": {f"distribution.assignment_counts.{uid}": 1},
            "$set": {
                f"distribution.last_assigned_at.{uid}": now_iso,
                "updated_at": now_iso,
            },
        },
        return_document=True,
    )
    return chosen, (updated or calendar)


# ── Distribution endpoints ───────────────────────────────────────────────


class DistributionPatchBody(BaseModel):
    """Body: partial weights. ``weights[user_id] = int 1-5``. Each
    supplied id is validated as a current member; unsupplied members
    are untouched on the row.
    """
    weights: Dict[str, int] = Field(..., min_length=1)

    @field_validator("weights")
    @classmethod
    def _v_weights(cls, v: Dict[str, int]) -> Dict[str, int]:
        for uid, w in v.items():
            if not isinstance(w, int) or not (1 <= w <= 5):
                raise ValueError(
                    f"weight for {uid!r} must be an integer 1-5",
                )
        return v


@router.get("/{calendar_id}/distribution")
async def get_distribution(
    calendar_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Per-member breakdown for a round_robin calendar.

    Each row carries the live deficit + an ``is_available_now`` flag
    computed against the current UTC wall clock. 404 when the
    calendar isn't round_robin so the UI surfaces an honest error
    instead of an empty distribution panel.
    """
    if not _is_privileged(current_user):
        raise HTTPException(
            status_code=403, detail="Only owners/admins can read distribution.",
        )
    cal = await _fetch_or_404(db, calendar_id, agency["agency_id"])
    if cal.get("type") != "round_robin":
        raise HTTPException(
            status_code=404,
            detail="Distribution is only defined for round_robin calendars.",
        )
    members = await _build_member_view(db, cal)
    # Compute deficits across ALL members (not just available ones) so
    # the UI can show the actual share-vs-target gap for every member.
    total_weight = sum(m["weight"] for m in members) or 1
    total_count = max(1, sum(m["count"] for m in members))
    out = []
    for m in members:
        out.append({
            "user_id": m["id"],
            "full_name": m["full_name"],
            "weight": m["weight"],
            "assignment_count": m["count"],
            "last_assigned_at": m["last_assigned_at"],
            "deficit": round(
                _compute_deficit(
                    m["weight"], m["count"], total_weight, total_count,
                ),
                6,
            ),
            "is_available_now": m["available"],
        })
    return {
        "calendar_id": cal["id"],
        "type": cal["type"],
        "members": out,
        "totals": {
            "total_weight": total_weight,
            "total_assignments": sum(m["count"] for m in members),
            "available_now": sum(1 for m in members if m["available"]),
        },
    }


@router.patch("/{calendar_id}/distribution")
async def patch_distribution(
    calendar_id: str,
    request: Request,
    body: DistributionPatchBody = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Partial weight update. Validates each user_id is a current
    member; rejects with 400 when any id is unknown so a typo can't
    create an orphan ledger entry that the engine then trips over.
    """
    if not _is_privileged(current_user):
        raise HTTPException(
            status_code=403, detail="Only owners/admins can patch distribution.",
        )
    cal = await _fetch_or_404(db, calendar_id, agency["agency_id"])
    if cal.get("type") != "round_robin":
        raise HTTPException(
            status_code=404,
            detail="Distribution is only defined for round_robin calendars.",
        )
    member_ids = set(cal.get("member_ids") or [])
    unknown = [uid for uid in body.weights if uid not in member_ids]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"user_id(s) {unknown!r} are not members of this calendar.",
        )

    set_payload = {
        f"distribution.weights.{uid}": int(w)
        for uid, w in body.weights.items()
    }
    set_payload["updated_at"] = _now_iso()
    await db.calendars.update_one(
        {"id": calendar_id, "agency_id": agency["agency_id"]},
        {"$set": set_payload},
    )

    await write_audit(
        db, "calendar_distribution_updated",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="calendar",
        target_id=calendar_id,
        request=request,
        metadata={"updated_weights": body.weights},
    )

    fresh = await db.calendars.find_one(
        {"id": calendar_id}, {"_id": 0},
    )
    return _public(fresh)


@router.post("/{calendar_id}/distribution/reset")
async def reset_distribution(
    calendar_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Zero every assignment_count and clear last_assigned_at. Weights
    untouched (manually-set shares persist across seasons).
    """
    if not _is_privileged(current_user):
        raise HTTPException(
            status_code=403, detail="Only owners/admins can reset distribution.",
        )
    cal = await _fetch_or_404(db, calendar_id, agency["agency_id"])
    if cal.get("type") != "round_robin":
        raise HTTPException(
            status_code=404,
            detail="Distribution is only defined for round_robin calendars.",
        )
    member_ids = cal.get("member_ids") or []
    zeroed_counts = {uid: 0 for uid in member_ids}
    await db.calendars.update_one(
        {"id": calendar_id, "agency_id": agency["agency_id"]},
        {"$set": {
            "distribution.assignment_counts": zeroed_counts,
            "distribution.last_assigned_at": {},
            "updated_at": _now_iso(),
        }},
    )
    await write_audit(
        db, "calendar_distribution_reset",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="calendar",
        target_id=calendar_id,
        request=request,
        metadata={"members": len(member_ids)},
    )
    fresh = await db.calendars.find_one(
        {"id": calendar_id}, {"_id": 0},
    )
    return _public(fresh)


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
