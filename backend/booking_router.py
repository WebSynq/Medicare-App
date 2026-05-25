"""Public booking page endpoints.

Mounted at ``/api/book`` (server.py adds the ``/api`` prefix). **No auth
required on any route in this file** — these are the endpoints the
client-facing booking page hits. The CSRF middleware exempts
``/api/book/`` (server.py _CSRF_EXEMPT_PREFIXES) because the public form
has no session to plant a CSRF cookie against; the HMAC booking token +
honeypot + IP-based abuse limits are the security substitutes.

Security model
==============
This is the highest-attack-surface endpoint family on the platform. The
spec is enumerated in the task brief; the safeguards in this file are:

  1. Slug regex (`^[a-z0-9-]{3,60}$`) validated before any DB lookup.
     Pattern mismatch returns 404 immediately. Error messages are
     identical for "slug doesn't exist" vs "agent disabled" so the
     surface can't be used for agent enumeration.
  2. Per-IP rate limits via slowapi (30/min info, 20/min slots,
     5/min + 10/hour create, 30/min token).
  3. Strict Pydantic payload (`PublicBookingPayload`) — every field
     length-capped, `client_email` validated as EmailStr,
     `meeting_type` + `booking_reason` are closed Literals.
  4. HTML stripped from `client_name` and `notes` before persist
     (defense-in-depth: tags shouldn't get past the pydantic str
     validation but we don't want stored XSS surface either).
  5. Honeypot field `website` — bots fill hidden fields. When
     populated the route returns a fake 200 with no DB insert and no
     emails sent. The attempt is logged with IP.
  6. HMAC anti-replay token. `GET /book/{slug}/token` issues a
     10-minute HMAC token bound to the slug. `POST /book/{slug}`
     refuses to write if the token is missing/expired/forged.
  7. `booking_attempts` collection records every attempt with
     `{ip, slug, outcome, timestamp}`. TTL 30 days. 10+ failures from
     the same IP in 1 hour → 24-hour entry in `booking_blocks`.
  8. Response sanitization — `/info` returns first name only, never
     `agent_email`, `phone_number`, `video_link`, `agent_id`, `_id`.
     POST confirmation returns only `status/message/date/time/
     meeting_type` — no `appointment_id`, no `agent_id`.
"""
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr, Field, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import get_agency_id, get_db, get_phi_db, get_frontend_url, get_client_ip


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/book", tags=["booking"])
limiter = Limiter(key_func=get_remote_address)


# ── Constants / regex ────────────────────────────────────────────────────
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")
_SLUG_RE = re.compile(r"^[a-z0-9-]{3,60}$")
_HTML_RE = re.compile(r"<[^>]+>")

# Weekday → working_hours key. Python's date.weekday() returns 0=Mon.
_WEEKDAY_KEYS = (
    "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday",
)

_BOOKING_REASONS = (
    "New to Medicare",
    "Plan Review",
    "Turning 65 Soon",
    "Employer to Medicare",
    "Cost & Coverage Questions",
    "Other",
)

# Failure outcomes that count toward the IP-block threshold. Successful
# bookings DON'T count — a single IP can legitimately book multiple
# appointments (family members, returning clients).
_FAILURE_OUTCOMES = {
    "rate_limited", "honeypot", "invalid_token", "slot_taken",
    "validation_error", "slug_invalid", "agent_disabled",
}
_ABUSE_THRESHOLD = 10
_ABUSE_WINDOW_HOURS = 1
_ABUSE_BLOCK_HOURS = 24


# ── HMAC booking token ───────────────────────────────────────────────────
def _booking_secret() -> str:
    """Read the secret at call time so test code can monkey-patch env.

    Production deployments MUST set BOOKING_SECRET (Render env var).
    The per-process random fallback exists so dev/test environments
    work end-to-end without env setup, at the cost of tokens not
    surviving a restart (single-instance only).
    """
    s = os.getenv("BOOKING_SECRET")
    if s and s.strip():
        return s.strip()
    # Cache a per-process secret so tokens issued by this process
    # validate within the same process. Resetting requires a restart.
    global _PROCESS_SECRET
    if not _PROCESS_SECRET:
        _PROCESS_SECRET = secrets.token_hex(32)
        logger.warning(
            "BOOKING_SECRET not set — using per-process random secret. "
            "Set this env var on Render for production.",
        )
    return _PROCESS_SECRET


_PROCESS_SECRET = ""
_TOKEN_BUCKET_SECONDS = 600   # 10 minutes
_TOKEN_TTL_DESCRIPTION = 600


def _current_bucket() -> int:
    return int(time.time()) // _TOKEN_BUCKET_SECONDS


def _make_token(slug: str, bucket: int) -> str:
    msg = f"{slug}:{bucket}".encode("utf-8")
    return hmac.new(
        _booking_secret().encode("utf-8"), msg, hashlib.sha256,
    ).hexdigest()


def _verify_token(slug: str, token: str) -> bool:
    """Accept tokens issued in the current bucket or the immediately
    previous one. Gives clients ~10–20 minutes of validity depending on
    when in the bucket they fetched it. compare_digest blocks the
    obvious timing oracle on token comparison."""
    if not token or not isinstance(token, str):
        return False
    current = _current_bucket()
    for bucket in (current, current - 1):
        if hmac.compare_digest(token, _make_token(slug, bucket)):
            return True
    return False


# ── Helpers ──────────────────────────────────────────────────────────────
def _strip_html(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    return _HTML_RE.sub("", s).strip()


def _validate_slug_or_404(slug: str) -> str:
    if not slug or not _SLUG_RE.fullmatch(slug):
        raise HTTPException(status_code=404, detail="Booking page not found")
    return slug


def _parse_date(value: str) -> date:
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="Bad date format (use YYYY-MM-DD)")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid calendar date") from exc


def _parse_time(value: str) -> dtime:
    if not isinstance(value, str) or not _TIME_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="Bad time format (use HH:MM)")
    hh, mm = value.split(":")
    if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
        raise HTTPException(status_code=400, detail="Time out of range")
    return dtime(int(hh), int(mm))


async def _agent_by_slug(db, slug: str) -> Optional[Dict[str, Any]]:
    """Return the active agent owning ``slug`` or None.

    Caller decides whether to 404 — we don't raise here so the abuse
    logger can record `slug_invalid` / `agent_disabled` distinctly
    while always returning a generic 404 to the public.
    """
    return await db.users.find_one(
        {
            "booking_settings.slug": slug,
            "booking_settings.is_enabled": True,
            "is_active": True,
            "status": "active",
        },
        {"_id": 0},
    )


def _first_name(full_name: Optional[str]) -> str:
    if not full_name:
        return "Your agent"
    parts = full_name.strip().split()
    return parts[0] if parts else "Your agent"


def _public_profile(user: Dict[str, Any]) -> Dict[str, Any]:
    """Strip everything except what the public booking page needs.

    Specifically NEVER includes: agent_id, agent_email, phone_number,
    video_link, _id, lead data, slug (caller already has it).
    """
    bs = user.get("booking_settings") or {}
    full = user.get("full_name") or user.get("agent_name") or ""
    return {
        "agent_name": _first_name(full),
        "bio": bs.get("bio") or "",
        "meeting_types": bs.get("meeting_types") or ["phone", "video"],
        "appointment_duration": int(bs.get("appointment_duration") or 30),
        "advance_notice_hours": int(bs.get("advance_notice_hours") or 24),
        "booking_window_days": int(bs.get("booking_window_days") or 60),
        "working_hours": bs.get("working_hours") or {},
    }


# ── Abuse tracking ───────────────────────────────────────────────────────
async def _log_attempt(
    db, ip: Optional[str], slug: str, outcome: str,
    metadata: Optional[dict] = None,
) -> None:
    """Persist a booking attempt for IP-based abuse tracking.

    Never raises — a logging failure must not prevent the booking
    response. TTL index in server.py expires rows after 30 days.
    """
    try:
        await db.booking_attempts.insert_one({
            "_id": str(uuid.uuid4()),
            "ip": ip or "unknown",
            "slug": slug,
            "outcome": outcome,
            "created_at": datetime.now(timezone.utc),
            "metadata": metadata or {},
        })
    except Exception as e:                                    # noqa: BLE001
        logger.warning("booking_attempts insert failed: %s", e)


async def _check_blocked(db, ip: Optional[str]) -> bool:
    """True if this IP has an active booking_blocks row. TTL index
    auto-evicts expired blocks; we still check expires_at to handle the
    fraction-of-a-second window between expiry and TTL sweep."""
    if not ip:
        return False
    try:
        row = await db.booking_blocks.find_one({"ip": ip}, {"_id": 0})
    except Exception as e:                                    # noqa: BLE001
        logger.warning("booking_blocks read failed: %s", e)
        return False
    if not row:
        return False
    expires_at = row.get("expires_at")
    if isinstance(expires_at, datetime):
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return expires_at > datetime.now(timezone.utc)
    return True


async def _maybe_block_ip(db, ip: Optional[str]) -> None:
    """Count failure attempts from this IP in the last hour. If above
    the threshold, upsert into booking_blocks with a 24-hour expiry.
    """
    if not ip:
        return
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=_ABUSE_WINDOW_HOURS)
        count = await db.booking_attempts.count_documents({
            "ip": ip,
            "outcome": {"$in": list(_FAILURE_OUTCOMES)},
            "created_at": {"$gte": cutoff},
        })
        if count >= _ABUSE_THRESHOLD:
            expires_at = datetime.now(timezone.utc) + timedelta(hours=_ABUSE_BLOCK_HOURS)
            await db.booking_blocks.update_one(
                {"ip": ip},
                {"$set": {
                    "ip": ip,
                    "blocked_at": datetime.now(timezone.utc),
                    "expires_at": expires_at,
                    "failure_count": count,
                }},
                upsert=True,
            )
            logger.warning(
                "booking_blocks: IP %s blocked until %s (%d failures in 1h)",
                ip, expires_at.isoformat(), count,
            )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("booking_blocks upsert failed: %s", e)


async def _record_and_maybe_block(
    db, ip: Optional[str], slug: str, outcome: str,
    metadata: Optional[dict] = None,
) -> None:
    """Convenience: log attempt then escalate if the threshold tripped."""
    await _log_attempt(db, ip, slug, outcome, metadata)
    if outcome in _FAILURE_OUTCOMES:
        await _maybe_block_ip(db, ip)


# ── Slot generation ──────────────────────────────────────────────────────
def _generate_slots(
    start_str: str,
    end_str: str,
    duration: int,
    buffer_minutes: int,
) -> List[str]:
    start = _parse_time(start_str)
    end = _parse_time(end_str)
    step_minutes = max(duration + max(buffer_minutes, 0), 5)
    cursor = datetime.combine(date(2000, 1, 1), start)
    end_dt = datetime.combine(date(2000, 1, 1), end)
    slots: List[str] = []
    while cursor + timedelta(minutes=duration) <= end_dt:
        slots.append(cursor.strftime("%H:%M"))
        cursor += timedelta(minutes=step_minutes)
    return slots


def _slot_conflicts(slot_hhmm: str, duration: int,
                     appts: List[Dict[str, Any]]) -> bool:
    slot_start = _parse_time(slot_hhmm)
    slot_start_dt = datetime.combine(date(2000, 1, 1), slot_start)
    slot_end_dt = slot_start_dt + timedelta(minutes=duration)
    for a in appts:
        if a.get("status") == "cancelled":
            continue
        a_time = a.get("appointment_time")
        a_dur = int(a.get("duration_minutes") or 30)
        if not a_time or not _TIME_RE.fullmatch(a_time):
            continue
        a_start = _parse_time(a_time)
        a_start_dt = datetime.combine(date(2000, 1, 1), a_start)
        a_end_dt = a_start_dt + timedelta(minutes=a_dur)
        if slot_start_dt < a_end_dt and a_start_dt < slot_end_dt:
            return True
    return False


# ── GET /book/{slug}/info ────────────────────────────────────────────────
@router.get("/{slug}/info")
@limiter.limit("30/minute")
async def booking_info(
    slug: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    ip = get_client_ip(request)
    if await _check_blocked(db, ip):
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")

    try:
        slug = _validate_slug_or_404(slug)
    except HTTPException:
        await _record_and_maybe_block(db, ip, slug or "<invalid>", "slug_invalid")
        raise

    user = await _agent_by_slug(db, slug)
    if not user:
        await _record_and_maybe_block(db, ip, slug, "agent_disabled")
        raise HTTPException(status_code=404, detail="Booking page not found")

    return _public_profile(user)


# ── GET /book/{slug}/token ───────────────────────────────────────────────
@router.get("/{slug}/token")
@limiter.limit("30/minute")
async def booking_token(
    slug: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Mint an HMAC token the booking page must submit with POST.

    The booking page fetches this on mount + refreshes if the user
    sits idle past the token lifetime. Token is bound to the slug so
    re-using a token across booking pages doesn't help an attacker.
    """
    ip = get_client_ip(request)
    if await _check_blocked(db, ip):
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")

    try:
        slug = _validate_slug_or_404(slug)
    except HTTPException:
        await _record_and_maybe_block(db, ip, slug or "<invalid>", "slug_invalid")
        raise

    user = await _agent_by_slug(db, slug)
    if not user:
        await _record_and_maybe_block(db, ip, slug, "agent_disabled")
        raise HTTPException(status_code=404, detail="Booking page not found")

    token = _make_token(slug, _current_bucket())
    return {"token": token, "expires_in": _TOKEN_TTL_DESCRIPTION}


# ── GET /book/{slug}/slots ───────────────────────────────────────────────
@router.get("/{slug}/slots")
@limiter.limit("20/minute")
async def booking_slots(
    slug: str,
    request: Request,
    date: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
):
    """Available time slots for one day.

    Returns 200 with `{date, slots, duration, reason?}`. Out-of-window
    days yield an empty list with a `reason` string so the UI can
    explain rather than throw.
    """
    ip = get_client_ip(request)
    if await _check_blocked(db, ip):
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")

    try:
        slug = _validate_slug_or_404(slug)
    except HTTPException:
        await _record_and_maybe_block(db, ip, slug or "<invalid>", "slug_invalid")
        raise

    user = await _agent_by_slug(db, slug)
    if not user:
        await _record_and_maybe_block(db, ip, slug, "agent_disabled")
        raise HTTPException(status_code=404, detail="Booking page not found")

    bs = user.get("booking_settings") or {}
    target_date = _parse_date(date)
    today = datetime.now(timezone.utc).date()

    window_days = int(bs.get("booking_window_days") or 60)
    if target_date < today:
        return {"date": date, "slots": [], "reason": "Date is in the past"}
    if (target_date - today).days > window_days:
        return {
            "date": date, "slots": [],
            "reason": f"Outside the {window_days}-day booking window",
        }

    weekday = _WEEKDAY_KEYS[target_date.weekday()]
    working = (bs.get("working_hours") or {}).get(weekday) or {}
    if not working.get("enabled"):
        return {
            "date": date, "slots": [],
            "reason": f"{weekday.title()} is not a working day",
        }

    duration = int(bs.get("appointment_duration") or 30)
    buffer_mins = int(bs.get("buffer_minutes") or 15)
    advance_hours = int(bs.get("advance_notice_hours") or 24)
    max_per_day = int(bs.get("max_per_day") or 10)

    try:
        candidate_slots = _generate_slots(
            working.get("start") or "09:00",
            working.get("end") or "17:00",
            duration,
            buffer_mins,
        )
    except HTTPException:
        return {"date": date, "slots": [], "reason": "Working hours misconfigured"}

    cursor = phi_db.appointments.find(
        {"agent_id": user["id"], "appointment_date": date},
        {"_id": 0, "appointment_time": 1, "duration_minutes": 1, "status": 1},
    )
    appts = [a async for a in cursor]
    active_appts = [a for a in appts if a.get("status") != "cancelled"]
    if len(active_appts) >= max_per_day:
        return {
            "date": date, "slots": [],
            "reason": f"Agent is fully booked ({max_per_day} appointments)",
        }

    now = datetime.now(timezone.utc)
    earliest_allowed = now + timedelta(hours=advance_hours)

    available: List[str] = []
    for slot in candidate_slots:
        hh, mm = (int(p) for p in slot.split(":"))
        slot_dt = datetime(
            target_date.year, target_date.month, target_date.day,
            hh, mm, tzinfo=timezone.utc,
        )
        if slot_dt < earliest_allowed:
            continue
        if _slot_conflicts(slot, duration, active_appts):
            continue
        available.append(slot)

    return {"date": date, "slots": available, "duration": duration}


# ── POST /book/{slug} ────────────────────────────────────────────────────
class PublicBookingPayload(BaseModel):
    """Strict booking payload.

    `website` is the honeypot — visually hidden in the booking form so
    real users never touch it. Bots that fill every input get a 200
    response with no DB write.
    """
    client_name: str = Field(..., min_length=2, max_length=100)
    client_phone: str = Field(..., min_length=7, max_length=20)
    client_email: Optional[EmailStr] = None
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    meeting_type: Literal["phone", "video"]
    booking_reason: Literal[
        "New to Medicare",
        "Plan Review",
        "Turning 65 Soon",
        "Employer to Medicare",
        "Cost & Coverage Questions",
        "Other",
    ]
    notes: Optional[str] = Field(None, max_length=500)
    token: str = Field(..., min_length=16, max_length=128)
    # Honeypot — accepted but expected to be empty. Real users see a
    # hidden input; bots fill every field. We range-check by hand inside
    # the handler so a populated value still hits us as a 200 instead
    # of a Pydantic 422 (the spec explicitly wants fake success here).
    website: Optional[str] = Field(None, max_length=200)


@router.post("/{slug}", status_code=201)
@limiter.limit("5/minute")
@limiter.limit("10/hour")
async def create_booking(
    slug: str,
    request: Request,
    body: PublicBookingPayload = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
):
    """Public booking creation.

    Response shape (success): `{status, message, date, time, meeting_type}`.
    NEVER includes appointment_id, agent_id, or any other internal id.
    """
    ip = get_client_ip(request)

    # 0. Blocklist — fast-path 429 before any work.
    if await _check_blocked(db, ip):
        raise HTTPException(status_code=429, detail="Too many requests. Try again later.")

    # 1. Slug shape.
    try:
        slug = _validate_slug_or_404(slug)
    except HTTPException:
        await _record_and_maybe_block(db, ip, slug or "<invalid>", "slug_invalid")
        raise

    # 2. Agent exists + booking enabled.
    user = await _agent_by_slug(db, slug)
    if not user:
        await _record_and_maybe_block(db, ip, slug, "agent_disabled")
        raise HTTPException(status_code=404, detail="Booking page not found")

    # 3. Honeypot. Any non-empty value = bot. We DO log + count toward
    #    the abuse threshold; we DON'T tell the bot it was caught.
    if body.website and body.website.strip():
        await _record_and_maybe_block(
            db, ip, slug, "honeypot",
            metadata={"website_len": len(body.website)},
        )
        # Fake success payload — same shape a real booking returns.
        return {
            "status": "confirmed",
            "message": "Your booking has been received.",
            "date": body.date,
            "time": body.time,
            "meeting_type": body.meeting_type,
        }

    # 4. Token. compare_digest blocks the timing oracle.
    if not _verify_token(slug, body.token):
        await _record_and_maybe_block(db, ip, slug, "invalid_token")
        raise HTTPException(
            status_code=403,
            detail="Booking session expired. Refresh the page and try again.",
        )

    # 5. Meeting type must be one this agent offers.
    bs = user.get("booking_settings") or {}
    if body.meeting_type not in (bs.get("meeting_types") or ["phone", "video"]):
        await _record_and_maybe_block(db, ip, slug, "validation_error",
                                       metadata={"reason": "meeting_type_not_offered"})
        raise HTTPException(
            status_code=422,
            detail="That meeting type isn't available for this agent.",
        )

    # 6. Slot still available — re-run the slot computation to defeat
    #    advance-notice / working-hours / max-per-day bypasses via raw POST.
    slots_resp = await booking_slots(
        slug=slug, request=request, date=body.date,
        db=db, phi_db=phi_db,
    )
    if body.time not in (slots_resp.get("slots") or []):
        await _record_and_maybe_block(db, ip, slug, "slot_taken",
                                       metadata={"date": body.date, "time": body.time})
        raise HTTPException(
            status_code=409,
            detail="That time is no longer available. Please pick another.",
        )

    # 7. Persist. Strip HTML from anything that becomes part of an
    #    outgoing email body (defense in depth — the Pydantic str
    #    fields shouldn't carry tags either, but we don't want stored
    #    XSS surface if an upstream layer ever changes).
    clean_name = _strip_html(body.client_name) or ""
    clean_notes = _strip_html(body.notes) if body.notes else None
    clean_phone = (body.client_phone or "").strip()
    clean_email = (str(body.client_email).strip().lower()
                   if body.client_email else None)

    duration = int(bs.get("appointment_duration") or 30)
    now_iso = datetime.now(timezone.utc).isoformat()
    appointment_id = str(uuid.uuid4())

    doc = {
        "appointment_id": appointment_id,
        "agent_id": user["id"],
        "agent_name": user.get("agent_name") or user.get("full_name"),
        "agent_email": (user.get("email") or "").lower() or None,
        "lead_id": None,
        "client_name": clean_name,
        "client_phone": clean_phone,
        "client_email": clean_email,
        "appointment_date": body.date,
        "appointment_time": body.time,
        "duration_minutes": duration,
        "type": "initial_consultation",
        "status": "scheduled",
        "notes": clean_notes,
        "outcome": None,
        "estimated_commission": None,
        "meeting_type": body.meeting_type,
        "booking_reason": body.booking_reason,
        "booked_by_client": True,
        "reminder_48hr_sent": False,
        "reminder_24hr_sent": False,
        "reminder_1hr_sent": False,
        "followup_sent": False,
        "agency_id": get_agency_id(),
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    await phi_db.appointments.insert_one(doc)

    await _log_attempt(db, ip, slug, "success", metadata={
        "date": body.date, "time": body.time,
        "meeting_type": body.meeting_type,
    })

    # 8. Best-effort email fan-out. Failures must not surface — the
    #    appointment is already persisted.
    try:
        await _send_booking_emails(user, doc)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("booking email fan-out failed: %s", e)

    # 9. Sanitized confirmation response.
    return {
        "status": "confirmed",
        "message": (
            f"You're booked on {body.date} at {body.time}. "
            "Check your email for confirmation."
            if clean_email else
            f"You're booked on {body.date} at {body.time}."
        ),
        "date": body.date,
        "time": body.time,
        "meeting_type": body.meeting_type,
    }


# ── Email fan-out ────────────────────────────────────────────────────────
def _format_date(iso_date: str) -> str:
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d").date()
        # %A %B %d %Y is portable across win/linux; we drop the leading
        # zero on day with a strip + zfill dance.
        s = d.strftime("%A, %B %d, %Y")
        return s.replace(" 0", " ", 1) if " 0" in s else s
    except Exception:
        return iso_date


def _format_time(hhmm: str) -> str:
    try:
        t = datetime.strptime(hhmm, "%H:%M").time()
        hour = t.hour % 12 or 12
        suffix = "AM" if t.hour < 12 else "PM"
        return f"{hour}:{t.minute:02d} {suffix}"
    except Exception:
        return hhmm


async def _send_booking_emails(user: Dict[str, Any], appt: Dict[str, Any]) -> None:
    """Fan out client confirmation + agent notification. Never raises."""
    from email_templates import (
        booking_confirmation_client,
        booking_notification_agent,
    )
    from resend_client import send_email

    bs = user.get("booking_settings") or {}
    agent_phone = bs.get("phone_number") or user.get("phone") or ""
    video_link = bs.get("video_link") or ""
    meeting_link = video_link if appt.get("meeting_type") == "video" else agent_phone
    date_str = _format_date(appt["appointment_date"])
    time_str = _format_time(appt["appointment_time"])

    if appt.get("client_email"):
        html = booking_confirmation_client(
            client_name=appt["client_name"],
            agent_name=user.get("full_name") or "your agent",
            agent_phone=agent_phone,
            date_str=date_str,
            time_str=time_str,
            meeting_type=appt.get("meeting_type") or "phone",
            meeting_link=meeting_link,
            booking_reason=appt.get("booking_reason") or "",
            cancel_url="#",
        )
        await send_email(
            to=appt["client_email"],
            subject=f"Your appointment with {user.get('full_name') or 'GHW'} is confirmed",
            html=html,
            reply_to=user.get("email"),
        )

    if user.get("email"):
        portal_url = f"{get_frontend_url()}/appointments"
        html = booking_notification_agent(
            agent_name=user.get("full_name") or "Agent",
            client_name=appt["client_name"],
            client_phone=appt.get("client_phone") or "",
            client_email=appt.get("client_email") or "",
            date_str=date_str,
            time_str=time_str,
            meeting_type=appt.get("meeting_type") or "phone",
            booking_reason=appt.get("booking_reason") or "",
            portal_url=portal_url,
        )
        await send_email(
            to=user["email"],
            subject=f"New booking: {appt['client_name']} on {date_str}",
            html=html,
        )
