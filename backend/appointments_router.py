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
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from commission_calculator import calculate_commission
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
    """Create an appointment. Two flows:

    1. Linked: send ``lead_id`` for an existing lead. ``client_name`` is
       ignored — the backend denormalizes from the lead row so the name
       always matches the lead record.
    2. Walk-in: omit ``lead_id`` and send ``client_name`` (required in
       this case). Useful when an agent is booking a prospect who isn't
       yet in the CRM. ``lead_id`` stays null on the appointment row and
       the SPA hides "View Client" for these rows.

    The handler enforces "client_name required when no lead_id" — the
    schema can't express that conditional without a model_validator, so
    both fields are nominally optional at the Pydantic layer.
    """
    # min_length=1 means an empty-string lead_id is rejected at the
    # Pydantic boundary with a clear 422 instead of falling through to
    # _resolve_lead and producing a cryptic "Lead not found" — pass
    # null (or omit the field entirely) for the walk-in flow.
    lead_id: Optional[str] = Field(None, min_length=1, max_length=128)
    client_name: Optional[str] = Field(None, max_length=200)
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


class AppointmentEstimateRequest(BaseModel):
    """Preview request for the booking sheet — same shape as
    AppointmentCreate's lead_id field. Kept narrow so the sheet can
    call it on every typeahead pick without ever accidentally creating
    a row."""
    lead_id: str = Field(..., min_length=1, max_length=128)


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
    lead = safe_lead_load(await db.leads.find_one({"id": lead_id}, {"_id": 0}))
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    role = effective.get("role")
    if role not in FULL_AGENCY_SCOPE_ROLES and lead.get("agent_id") != effective["id"]:
        # Common race: agent searched the typeahead, leadership transferred
        # the lead between the search and the submit. We can detect this
        # specific case via `transferred_from` (stamped by the leads
        # transfer endpoint) — surface a recovery-oriented message so the
        # agent knows to refresh rather than thinking it's a permissions
        # bug. Other cases (stale URL share, direct-typed lead_id from a
        # lead they never owned) fall through to the generic IDOR 403.
        if lead.get("transferred_from") == effective["id"]:
            raise HTTPException(
                status_code=403,
                detail="This client has been reassigned. Refresh the page and search again.",
            )
        raise HTTPException(status_code=403, detail="Lead is not in your book")
    return lead


def _client_name(lead: Dict[str, Any]) -> str:
    fn = (lead.get("first_name") or "").strip()
    ln = (lead.get("last_name") or "").strip()
    full = f"{fn} {ln}".strip()
    return full or lead.get("email") or "Unknown"


# ── Commission auto-estimate from a lead row ─────────────────────────────
# Lead docs don't carry the strict product_type enum the calculator
# expects — they carry a free-text product_interest string and a few
# loosely-typed price strings. We do a best-effort map here so the
# appointment row picks up a sensible default that the agent can still
# override on the booking form.
_VALID_PRODUCT_TYPES = {
    "med_supp", "ma", "pdp", "final_expense", "dental",
    "cancer", "heart_stroke", "cancer_heart_stroke",
    "hip", "rc", "dvh", "dvh_plus", "stc", "hhc",
    "annuity", "life",
}

# Order matters — "ma plan" must be matched before bare "ma" inside
# a longer string, and "medicare supplement" before "medicare".
_PRODUCT_INTEREST_PATTERNS = [
    ("med_supp", ("med supp", "medsupp", "medicare supplement",
                   "medigap", "supplement")),
    ("ma", ("mapd", "medicare advantage", "ma plan", " ma ", " ma,",
            "advantage")),
    ("pdp", ("pdp", "drug plan", "prescription drug", "part d")),
    ("final_expense", ("final expense", "fex", "burial", "whole life")),
    ("dental", ("dental",)),
    ("cancer", ("cancer",)),
    ("hip", ("hospital indemnity", " hip ", "hip plan")),
]

_PREMIUM_RE = re.compile(r"\$?\s*([\d,]+(?:\.\d+)?)")


def _derive_product_type(lead: Dict[str, Any]) -> Optional[str]:
    """Pick a product_type the calculator understands, in this order:
    explicit ``lead.product_type`` (rare today), keyword match against
    ``lead.product_interest``, keyword match against
    ``lead.plan_type_premium`` (free-text label like "MAPD HMO — $0/mo").
    Returns None when nothing maps cleanly — caller leaves the
    appointment's estimated_commission null."""
    raw = (lead.get("product_type") or "").strip().lower()
    if raw in _VALID_PRODUCT_TYPES:
        return raw
    for source_field in ("product_interest", "plan_type_premium"):
        text = " " + (lead.get(source_field) or "").lower() + " "
        if not text.strip():
            continue
        for product, keywords in _PRODUCT_INTEREST_PATTERNS:
            for kw in keywords:
                if kw in text:
                    return product
    return None


def _derive_age(dob_str: Optional[str]) -> Optional[int]:
    """Tolerant DOB → integer age. Returns None when DOB is missing or
    unparseable so the calculator falls back to a band-less rate path."""
    if not dob_str or not isinstance(dob_str, str):
        return None
    try:
        head = dob_str.split("T", 1)[0].split(" ", 1)[0]
        if "/" in head:
            mm, dd, yyyy = head.split("/")
            dob = date(int(yyyy), int(mm), int(dd))
        else:
            parts = head.split("-")
            if len(parts) != 3:
                return None
            dob = date(int(parts[0]), int(parts[1]), int(parts[2]))
    except (ValueError, IndexError):
        return None
    today = datetime.now(timezone.utc).date()
    years = today.year - dob.year - (
        (today.month, today.day) < (dob.month, dob.day)
    )
    return max(0, years)


def _derive_premium(lead: Dict[str, Any]) -> float:
    """Try a structured field first, then sniff a dollar amount out of
    ``plan_type_premium``. Returns 0.0 when nothing parses — MA/PDP
    payouts are flat dollars and don't depend on premium, so 0 is a
    safe default that still produces a valid estimate for those products."""
    direct = lead.get("monthly_premium") or lead.get("premium")
    if isinstance(direct, (int, float)):
        return float(direct)
    text = lead.get("plan_type_premium") or ""
    if isinstance(text, str):
        match = _PREMIUM_RE.search(text)
        if match:
            try:
                return float(match.group(1).replace(",", ""))
            except ValueError:
                return 0.0
    return 0.0


def _estimate_commission(lead: Optional[Dict[str, Any]]) -> Optional[float]:
    """Run the lead's currently-known data through commission_calculator
    and return the agent-side dollar estimate. Returns None when the
    product_type can't be resolved or the calculator can't find a rate
    — the appointment row simply leaves estimated_commission unset and
    the agent provides a manual figure if they want one."""
    if not lead:
        return None
    product_type = _derive_product_type(lead)
    if not product_type:
        return None
    try:
        result = calculate_commission(
            product_type=product_type,
            carrier=(lead.get("current_carrier") or ""),
            state=(lead.get("state") or ""),
            plan_type=(lead.get("current_plan") or ""),
            monthly_premium=_derive_premium(lead),
            client_age=_derive_age(lead.get("date_of_birth")) or 0,
            scope_completed=False,
        )
    except Exception as exc:                                # noqa: BLE001
        logger.warning("commission estimate failed for lead %s: %s",
                       lead.get("id"), exc)
        return None
    commission = result.get("agent_commission")
    if not commission or commission <= 0:
        return None
    return float(commission)


# ── Google Calendar sync (background, fire-and-forget) ──────────────────
# Called as a BackgroundTask after a successful appointment create.
# NEVER raises — calendar sync failures must not surface to the user as
# a failed appointment. The appointment is already persisted by the
# time this runs; the worst case is "appointment exists in our DB but
# not on the agent's Google Calendar" which an operator can re-sync.
async def _sync_to_google_calendar(appointment_id: str, agent_id: str) -> None:
    from deps import get_phi_db as _get_phi_db
    db = _get_phi_db()
    try:
        user = await db.users.find_one(
            {"id": agent_id},
            {"_id": 0, "google_calendar_connected": 1,
             "google_calendar_refresh_token": 1},
        )
        if not user or not user.get("google_calendar_connected"):
            return  # silent: agent hasn't connected Google Calendar
        encrypted_token = user.get("google_calendar_refresh_token")
        if not encrypted_token:
            logger.warning(
                "google_calendar marked connected for %s but token missing",
                agent_id,
            )
            return

        from encryption import phi_encryption
        refresh_token = phi_encryption.decrypt(encrypted_token)

        appt = await db.appointments.find_one(
            {"appointment_id": appointment_id}, {"_id": 0},
        )
        if not appt:
            logger.warning("google sync: appointment %s vanished", appointment_id)
            return

        # Build start/end datetimes from the stored date + time strings.
        try:
            y, mo, d = (int(p) for p in appt["appointment_date"].split("-"))
            hh, mm = (int(p) for p in appt["appointment_time"].split(":"))
            start_dt = datetime(y, mo, d, hh, mm)
        except (ValueError, KeyError):
            logger.warning("google sync: bad date/time for %s", appointment_id)
            return
        duration = int(appt.get("duration_minutes") or 30)
        end_dt = start_dt + timedelta(minutes=duration)

        type_label = {
            "initial_consultation": "Initial Consultation",
            "plan_review": "Plan Review",
            "enrollment": "Enrollment",
            "annual_review": "Annual Review",
            "follow_up": "Follow-up",
            "other": "Appointment",
        }.get(appt.get("type"), "Appointment")
        client_name = appt.get("client_name") or "Client"
        notes = (appt.get("notes") or "").strip()
        description = (notes + "\n" if notes else "") + "Booked via GHW Agent Portal"

        # Lazy import — google-* aren't installed in the local pytest env,
        # but production has them via requirements.txt. Importing inside
        # the function keeps module load clean either way.
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
        client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            logger.warning("google sync: GOOGLE_CLIENT_ID/SECRET not configured")
            return

        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
            scopes=["https://www.googleapis.com/auth/calendar.events"],
        )

        # Note: do NOT add the client email as an attendee — per spec,
        # the calendar event lives only on the agent's calendar.
        # Local-naive datetimes paired with the user's timezone field
        # would be the cleanest path. We don't store agent timezone yet,
        # so the simpler safe choice is to send naive datetimes with
        # the calendar's default timezone (Google falls back to the
        # primary calendar's tz, which matches what the agent sees in
        # the UI).
        event_body = {
            "summary": f"{type_label} with {client_name}",
            "description": description,
            "start": {"dateTime": start_dt.isoformat()},
            "end": {"dateTime": end_dt.isoformat()},
        }

        service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        created = service.events().insert(
            calendarId="primary", body=event_body,
        ).execute()
        event_id = created.get("id")

        if event_id:
            await db.appointments.update_one(
                {"appointment_id": appointment_id},
                {"$set": {
                    "google_calendar_event_id": event_id,
                    "google_calendar_synced_at": datetime.now(timezone.utc).isoformat(),
                }},
            )
    except Exception as exc:                                # noqa: BLE001
        logger.warning(
            "google_calendar sync failed for appointment %s (agent %s): %s",
            appointment_id, agent_id, exc,
        )
        # Swallow: never let the calendar fan-out turn into a user error.


# ── Endpoints ────────────────────────────────────────────────────────────
@router.post("", status_code=201)
@limiter.limit("60/hour")
async def create_appointment(
    request: Request,
    background: BackgroundTasks,
    body: AppointmentCreate = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
):
    """Create an appointment. Linked to a lead when ``lead_id`` is sent
    (404 on missing, 403 if not owned by the effective agent); otherwise
    the appointment is a walk-in stamped with the user-supplied
    ``client_name`` and ``lead_id=None``."""
    lead = None
    if body.lead_id:
        lead = await _resolve_lead(db, body.lead_id, effective)
        client_name = _client_name(lead)
        stored_lead_id = body.lead_id
    else:
        # Walk-in flow: name must be supplied since we have nothing to
        # denormalize from.
        supplied = (body.client_name or "").strip()
        if not supplied:
            raise HTTPException(
                status_code=422,
                detail="client_name is required when no lead_id is provided",
            )
        client_name = supplied
        stored_lead_id = None

    # Commission estimate. A manually-supplied figure on the booking
    # form always wins — we only auto-calc when the caller left it
    # blank AND we have a lead to derive from.
    if body.estimated_commission is not None:
        estimated_commission = body.estimated_commission
    elif lead is not None:
        estimated_commission = _estimate_commission(lead)
    else:
        estimated_commission = None

    now_iso = datetime.now(timezone.utc).isoformat()

    doc = {
        "appointment_id": str(uuid.uuid4()),
        "agent_id": effective["id"],
        "agent_name": effective.get("agent_name") or effective.get("full_name"),
        "agent_email": (effective.get("email") or "").lower() or None,
        "lead_id": stored_lead_id,
        "client_name": client_name,
        "appointment_date": body.appointment_date,
        "appointment_time": body.appointment_time,
        "duration_minutes": body.duration_minutes,
        "type": body.type,
        "status": "scheduled",
        "notes": (body.notes or "").strip() or None,
        "outcome": None,
        "estimated_commission": estimated_commission,
        # Passive multi-tenant stamp — single-tenant today, future-proof.
        "agency_id": get_agency_id(),
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
            "lead_id": stored_lead_id,
            "walk_in": stored_lead_id is None,
            "appointment_date": body.appointment_date,
            "type": body.type,
            "impersonated_by": effective.get("_impersonated_by"),
        },
    )

    # Fan out to Google Calendar after the response is sent. The helper
    # is no-op if the agent hasn't connected Google; on any failure it
    # logs and swallows so it never converts a successful POST into a
    # 5xx for the user.
    background.add_task(
        _sync_to_google_calendar,
        doc["appointment_id"],
        effective["id"],
    )

    return _public(doc)


@router.get("")
@limiter.limit("60/hour")
async def list_appointments(
    request: Request,
    date: Optional[str] = Query(None, description="YYYY-MM-DD (exact-day match)"),
    start_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    end_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    status: Optional[AppointmentStatus] = Query(None),
    lead_id: Optional[str] = Query(None, max_length=128),
    limit: int = Query(200, ge=1, le=1000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """List the caller's appointments. Optional date / start_date / end_date
    / status / lead_id filters narrow the result for the same scope; they
    cannot widen it. `date` (exact-day) takes precedence over the range
    pair when both are supplied — kept that way so the existing single-day
    callers (TodayPage, audit links) continue to work unchanged."""
    query: Dict[str, Any] = dict(agent_filter(current_user))
    if date:
        # Validate so a malformed query param doesn't blow up the cursor.
        try:
            _validate_date(date)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        query["appointment_date"] = date
    elif start_date or end_date:
        range_filter: Dict[str, str] = {}
        if start_date:
            try:
                _validate_date(start_date)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"start_date: {exc}")
            range_filter["$gte"] = start_date
        if end_date:
            try:
                _validate_date(end_date)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"end_date: {exc}")
            range_filter["$lte"] = end_date
        query["appointment_date"] = range_filter
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


# ── Booking-sheet commission preview ─────────────────────────────────────
@router.post("/estimate")
@limiter.limit("60/hour")
async def estimate_commission(
    request: Request,
    body: AppointmentEstimateRequest = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
):
    """Return the auto-estimated commission for a lead without
    creating an appointment. The booking Sheet calls this when the
    agent picks a lead from the typeahead so they see the same figure
    that POST /appointments would stamp on save."""
    lead = await _resolve_lead(db, body.lead_id, effective)
    estimate = _estimate_commission(lead)
    return {"lead_id": body.lead_id, "estimated_commission": estimate}


# ── Revenue stats aggregator ─────────────────────────────────────────────
# Registered BEFORE /{appointment_id} so FastAPI routes /revenue-stats
# to this handler rather than treating "revenue-stats" as an id and
# 404-ing through _fetch_or_idor.
_VALID_PERIODS = ("mtd", "ytd", "last30", "last90", "all")


def _revenue_period_start(period: str) -> Optional[datetime]:
    """Match the dashboard router's _period_start semantics so the
    Today / dashboard / appointments revenue views are all anchored to
    the same window boundaries."""
    now = datetime.now(timezone.utc)
    if period == "mtd":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if period == "ytd":
        return now.replace(month=1, day=1, hour=0, minute=0, second=0,
                            microsecond=0)
    if period == "last30":
        return now - timedelta(days=30)
    if period == "last90":
        return now - timedelta(days=90)
    return None


@router.get("/revenue-stats")
@limiter.limit("60/hour")
async def revenue_stats(
    request: Request,
    period: str = Query("mtd", description="mtd|ytd|last30|last90|all"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Per-agent appointment revenue roll-up.

    Counts every appointment in scope for the period (used as the
    denominator on avg-per-appointment); commission totals only include
    rows where estimated_commission is non-null so an empty estimate
    doesn't drag the average down. Cancelled rows are excluded from
    the completed counter — completed means status == "completed".
    """
    if period not in _VALID_PERIODS:
        period = "mtd"
    start = _revenue_period_start(period)

    query: Dict[str, Any] = dict(agent_filter(current_user))
    if start is not None:
        query["appointment_date"] = {"$gte": start.date().isoformat()}

    proj = {
        "_id": 0, "appointment_id": 1, "type": 1, "status": 1,
        "estimated_commission": 1, "client_name": 1,
        "appointment_date": 1, "lead_id": 1,
    }
    total_appointments = 0
    completed_appointments = 0
    appointments_with_commission = 0
    total_commission = 0.0
    by_type: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "total_commission": 0.0, "with_commission": 0}
    )
    top: Optional[Dict[str, Any]] = None

    async for a in db.appointments.find(query, proj):
        total_appointments += 1
        if a.get("status") == "completed":
            completed_appointments += 1
        t = a.get("type") or "other"
        bucket = by_type[t]
        bucket["count"] += 1
        comm = a.get("estimated_commission")
        if comm is not None:
            try:
                comm_f = float(comm)
            except (TypeError, ValueError):
                continue
            appointments_with_commission += 1
            total_commission += comm_f
            bucket["with_commission"] += 1
            bucket["total_commission"] += comm_f
            if top is None or comm_f > top["estimated_commission"]:
                top = {
                    "client_name": a.get("client_name"),
                    "appointment_date": a.get("appointment_date"),
                    "type": t,
                    "estimated_commission": round(comm_f, 2),
                    "lead_id": a.get("lead_id"),
                }

    def _avg(numer: float, denom: int) -> float:
        return round(numer / denom, 2) if denom > 0 else 0.0

    by_type_list = [
        {
            "type": t,
            "count": v["count"],
            "total_commission": round(v["total_commission"], 2),
            "avg_commission": _avg(v["total_commission"], v["with_commission"]),
        }
        for t, v in by_type.items()
    ]
    by_type_list.sort(key=lambda r: r["count"], reverse=True)

    await write_audit(
        db,
        "appointment_revenue_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={
            "period": period,
            "total_appointments": total_appointments,
            "with_commission": appointments_with_commission,
        },
    )

    return {
        "period": period,
        "total_appointments": total_appointments,
        "completed_appointments": completed_appointments,
        "appointments_with_commission": appointments_with_commission,
        "total_estimated_commission": round(total_commission, 2),
        "avg_commission_per_appointment": _avg(total_commission, total_appointments),
        "avg_commission_per_completed": _avg(total_commission, completed_appointments),
        "by_type": by_type_list,
        "top_appointment": top,
    }


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
