"""
calendar_router.py
==================
Per-agent Google Calendar OAuth + per-appointment .ics download.

Five routes:

  GET    /api/calendar/google/connect      → returns Google OAuth URL
  GET    /api/calendar/google/callback     → completes OAuth, stores refresh token
  GET    /api/calendar/google/status       → reports connected state for current user
  DELETE /api/calendar/google/disconnect   → clears tokens
  GET    /api/appointments/{id}/ics        → downloads a single appointment as .ics

Design notes
------------
* Google SDK imports are LAZY — done inside the route bodies so the
  pytest suite (which doesn't install google-* yet) keeps loading
  this module cleanly. Production installs the deps via requirements.txt.
* OAuth state is a short-lived (10 min) signed JWT containing the
  initiating user's id. Stateless — no Mongo round-trip needed on
  the callback to look it up — and Google forwards it back to us
  verbatim so we can verify the flow originated from us.
* The refresh token is encrypted with the existing PHIEncryption
  helper before persistence. Same key (PHI_FIELD_KEY) — keeps key
  management to one bag.
* The .ics route requires JWT auth and IDOR-checks ownership.
  An anonymous .ics URL would leak client_name + notes (PHI-adjacent).
* No external calendar attendees are added — only the agent's own
  calendar. Per spec: do NOT add the client email.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    FULL_AGENCY_SCOPE_ROLES,
    get_current_user,
    get_db,
    get_phi_db,
    write_audit,
)
from encryption import phi_encryption
from security import create_access_token, decode_token


logger = logging.getLogger("gruening.calendar")
limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

# Separate router for the per-appointment .ics download — lives under
# /api/appointments/{id}/ics for URL coherence even though the code is
# colocated here with the rest of the calendar surface.
ics_router = APIRouter(prefix="/api/appointments", tags=["calendar-ics"])


# ── Constants ────────────────────────────────────────────────────────────
_GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events"
_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

# State JWT is short-lived — Google's redirect typically happens within
# seconds; 10 minutes is generous to cover slow networks and 2FA prompts.
_OAUTH_STATE_TTL_MINUTES = 10
_OAUTH_STATE_TYP = "google_calendar_oauth"


def _redirect_uri() -> str:
    """Where Google sends users after consent. Configurable so staging
    deploys can override; defaults to prod."""
    return os.environ.get(
        "GOOGLE_REDIRECT_URI",
        "https://api.ghwcrm.com/api/calendar/google/callback",
    ).strip()


def _frontend_settings_url(suffix: str = "") -> str:
    """Resolve the frontend Settings URL — uses FRONTEND_URL when set so
    staging/preview deploys land back on the right host."""
    from deps import get_frontend_url
    base = (get_frontend_url() or "https://app.ghwcrm.com").rstrip("/")
    return f"{base}/settings{suffix}"


def _sign_state(user_id: str) -> str:
    return create_access_token(
        {"sub": user_id, "typ": _OAUTH_STATE_TYP},
        expires_minutes=_OAUTH_STATE_TTL_MINUTES,
    )


def _verify_state(state: str) -> str:
    """Returns the user_id encoded in the state, or raises 400."""
    try:
        payload = decode_token(state)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid OAuth state") from exc
    if payload.get("typ") != _OAUTH_STATE_TYP:
        raise HTTPException(status_code=400, detail="Invalid OAuth state type")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=400, detail="OAuth state missing subject")
    return user_id


# ── ROUTE 1 — Connect ────────────────────────────────────────────────────
@router.get("/google/connect")
@limiter.limit("20/hour")
async def google_connect(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """Return the Google OAuth consent URL the SPA should navigate to.

    The state JWT carries the initiating agent's user id with a 10-minute
    expiry. The callback decodes it to know which user to attach the
    resulting refresh token to.
    """
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    if not client_id:
        raise HTTPException(
            status_code=503,
            detail="Google Calendar integration is not configured (GOOGLE_CLIENT_ID).",
        )

    state = _sign_state(current_user["id"])

    from urllib.parse import urlencode
    params = {
        "client_id": client_id,
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": _GOOGLE_SCOPE,
        "access_type": "offline",   # required to receive a refresh_token
        "prompt": "consent",        # force refresh_token even on re-auth
        "include_granted_scopes": "true",
        "state": state,
    }
    return {"auth_url": f"{_GOOGLE_AUTH_URL}?{urlencode(params)}"}


# ── ROUTE 2 — Callback ───────────────────────────────────────────────────
@router.get("/google/callback")
async def google_callback(
    request: Request,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Google redirects here after consent. Exchanges the auth code for
    access + refresh tokens, encrypts the refresh token, stamps it on
    the user document, then redirects back to /settings?calendar=*.

    No auth dependency on this route — Google is the caller. Authority
    comes from the signed state token instead.
    """
    if error:
        logger.info("google_calendar OAuth user-cancelled: %s", error)
        return RedirectResponse(
            url=_frontend_settings_url(f"?calendar=cancelled"),
            status_code=302,
        )
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")

    user_id = _verify_state(state)

    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="Google Calendar not configured")

    # Lazy import so this module loads cleanly even when google-* isn't
    # installed locally (e.g. in the pytest dev environment).
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15.0) as http_client:
            resp = await http_client.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": _redirect_uri(),
                    "grant_type": "authorization_code",
                },
            )
            resp.raise_for_status()
            tokens = resp.json()
    except Exception as exc:
        logger.warning("google_calendar token exchange failed: %s", exc)
        return RedirectResponse(
            url=_frontend_settings_url("?calendar=error"),
            status_code=302,
        )

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        # Google omits refresh_token when the user has previously granted
        # consent without `prompt=consent`. We request `prompt=consent`
        # in /connect so this should never happen — defend anyway.
        logger.warning("google_calendar callback for %s missing refresh_token", user_id)
        return RedirectResponse(
            url=_frontend_settings_url("?calendar=error"),
            status_code=302,
        )

    encrypted_refresh = phi_encryption.encrypt(refresh_token)
    now_iso = datetime.now(timezone.utc).isoformat()

    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "google_calendar_refresh_token": encrypted_refresh,
            "google_calendar_connected": True,
            "google_calendar_connected_at": now_iso,
        }},
    )

    await write_audit(
        db,
        "google_calendar_connected",
        actor_id=user_id,
        target_type="user",
        target_id=user_id,
        request=request,
        metadata={"connected_at": now_iso},
    )

    return RedirectResponse(
        url=_frontend_settings_url("?calendar=connected"),
        status_code=302,
    )


# ── ROUTE 3 — Status ─────────────────────────────────────────────────────
@router.get("/google/status")
async def google_status(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    return {
        "connected": bool(current_user.get("google_calendar_connected")),
        "connected_at": current_user.get("google_calendar_connected_at"),
    }


# ── ROUTE 4 — Disconnect ─────────────────────────────────────────────────
@router.delete("/google/disconnect")
async def google_disconnect(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    await db.users.update_one(
        {"id": current_user["id"]},
        {
            "$set": {"google_calendar_connected": False},
            "$unset": {
                "google_calendar_refresh_token": "",
                "google_calendar_connected_at": "",
            },
        },
    )
    await write_audit(
        db,
        "google_calendar_disconnected",
        actor_id=current_user["id"],
        target_type="user",
        target_id=current_user["id"],
        request=request,
    )
    return {"disconnected": True}


# ── ROUTE 5 — Per-appointment .ics download ──────────────────────────────
def _parse_appt_dt(date_str: str, time_str: str) -> Optional[datetime]:
    """Combine YYYY-MM-DD + HH:MM into a naive datetime. Returns None on
    bad inputs. We return the .ics in local-time form (no TZID) so it
    imports cleanly into any calendar app — same approach used by the
    CalendarPage frontend."""
    try:
        y, mo, d = (int(p) for p in date_str.split("-"))
        hh, mm = (int(p) for p in time_str.split(":"))
        return datetime(y, mo, d, hh, mm)
    except (ValueError, AttributeError):
        return None


_TYPE_LABEL = {
    "initial_consultation": "Initial Consultation",
    "plan_review": "Plan Review",
    "enrollment": "Enrollment",
    "annual_review": "Annual Review",
    "follow_up": "Follow-up",
    "other": "Appointment",
}


@ics_router.get("/{appointment_id}/ics")
@limiter.limit("60/hour")
async def appointment_ics(
    request: Request,
    appointment_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Stream a single appointment as a .ics file.

    IDOR-checked: only the owning agent (or admin/compliance) can download
    it. Anonymous URLs would leak client_name + notes (PHI-adjacent),
    so we require auth.
    """
    doc = await db.appointments.find_one({"appointment_id": appointment_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Appointment not found")

    if current_user.get("role") not in FULL_AGENCY_SCOPE_ROLES:
        if doc.get("agent_id") != current_user["id"]:
            raise HTTPException(status_code=403, detail="Access denied")

    start = _parse_appt_dt(doc.get("appointment_date", ""), doc.get("appointment_time", ""))
    if not start:
        raise HTTPException(status_code=422, detail="Appointment has invalid date/time")
    duration = int(doc.get("duration_minutes") or 30)
    end = start + timedelta(minutes=duration)

    type_label = _TYPE_LABEL.get(doc.get("type"), "Appointment")
    client_name = doc.get("client_name") or "Client"
    summary = f"{type_label} with {client_name}"

    notes = (doc.get("notes") or "").strip()
    description_lines = [notes] if notes else []
    description_lines.append("Booked via GHW Agent Portal")
    description = "\n".join(description_lines)

    organizer_email = doc.get("agent_email") or ""

    # Lazy import — icalendar isn't installed in the local pytest env.
    from icalendar import Calendar, Event, vCalAddress, vText
    cal = Calendar()
    cal.add("prodid", "-//GHW Agent Portal//Appointments//EN")
    cal.add("version", "2.0")
    cal.add("method", "PUBLISH")

    event = Event()
    event.add("uid", f"{appointment_id}@ghwcrm.com")
    event.add("summary", summary)
    event.add("dtstart", start)
    event.add("dtend", end)
    event.add("dtstamp", datetime.now(timezone.utc))
    event.add("description", description)
    if organizer_email:
        organizer = vCalAddress(f"MAILTO:{organizer_email}")
        organizer.params["cn"] = vText(doc.get("agent_name") or organizer_email)
        event["organizer"] = organizer

    cal.add_component(event)

    return Response(
        content=cal.to_ical(),
        media_type="text/calendar",
        headers={
            "Content-Disposition": (
                f'attachment; filename="appointment-{appointment_id[:8]}.ics"'
            ),
        },
    )
