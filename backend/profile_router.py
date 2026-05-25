"""
profile_router.py — Settings page backend.

Endpoints (all mounted under /api):
    GET  /profile/me                          — return current user profile
    PATCH /profile/me                         — update email/full_name/phone/npn/password
    GET  /profile/sessions                    — last 10 successful logins for caller
    GET  /profile/audit-log                   — audit history (own for agents, all for admin/compliance)
    GET  /profile/agency                      — single agency_settings document
    PATCH /profile/agency                     — update agency_settings (admin only)
    GET  /profile/team                        — list of active users for the Team tab (admin only)
    PATCH /admin/users/{user_id}/credentials  — admin force-reset email/password/role/is_active

Notes:
    - Password values are NEVER logged (audit metadata records the field NAMES that changed,
      not the values).
    - All state-changing routes write to the audit log via deps.write_audit.
"""
import csv
import io
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr, Field

from deps import get_current_user, get_db, get_frontend_url, require_roles, write_audit
from models import BookingSettings
from security import (
    hash_password,
    verify_password,
    validate_password_strength,
)


logger = logging.getLogger(__name__)

# No internal prefix — server.py mounts this with prefix="/api", and the
# admin credential endpoint lives at /api/admin/users/... (not /api/profile/...).
router = APIRouter(tags=["profile"])


# ── Helpers ────────────────────────────────────────────────────────────────
def _profile_dict(user: dict) -> dict:
    """Strip server-only fields. Used by /profile/me + after PATCH."""
    return {
        "id": user.get("id"),
        "email": user.get("email"),
        "full_name": user.get("full_name"),
        "agent_name": user.get("agent_name"),
        "agent_id": user.get("agent_id") or user.get("id"),
        "agent_npn": user.get("agent_npn"),
        "phone": user.get("phone"),
        "timezone": user.get("timezone") or "America/Chicago",
        "role": user.get("role"),
        "is_active": user.get("is_active", True),
        "status": user.get("status", "active"),
        "agency_name": user.get("agency_name"),
        "created_at": user.get("created_at"),
        "booking_settings": user.get("booking_settings"),
    }


def _audit_action(meta: dict) -> str:
    """Pull a stable 'action' label from an audit doc. Prefer event_type
    (the canonical name) and fall back to action (older rows may carry that)."""
    return meta.get("event_type") or meta.get("action") or "unknown"


# ── GET /api/profile/me ────────────────────────────────────────────────────
@router.get("/profile/me")
async def get_my_profile(current_user: dict = Depends(get_current_user)):
    return _profile_dict(current_user)


# ── PATCH /api/profile/me ─────────────────────────────────────────────────
class ProfilePatch(BaseModel):
    current_password: str = Field(..., min_length=1)
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    phone: Optional[str] = None
    timezone: Optional[str] = None
    agent_npn: Optional[str] = None
    new_password: Optional[str] = None


@router.patch("/profile/me")
async def update_my_profile(
    payload: ProfilePatch,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    # Always re-verify the password against the freshest DB row — current_user
    # is the JWT-decoded snapshot, which can lag behind a recent password
    # change. This also ensures the password verification is happening against
    # a row that still exists / is active.
    fresh = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not fresh:
        raise HTTPException(404, "User not found")

    if not verify_password(payload.current_password, fresh["hashed_password"]):
        # Don't reveal which field was wrong — keep it generic so we don't
        # leak "right password / wrong email" timing signals.
        raise HTTPException(401, "Current password incorrect")

    updates: dict = {}
    fields_changed: list = []

    if payload.email and payload.email.lower() != (fresh.get("email") or "").lower():
        new_email = payload.email.lower().strip()
        clash = await db.users.find_one(
            {"email": new_email, "id": {"$ne": fresh["id"]}}, {"_id": 0, "id": 1}
        )
        if clash:
            raise HTTPException(409, "That email is already in use")
        updates["email"] = new_email
        fields_changed.append("email")

    if payload.full_name is not None and payload.full_name.strip() != (fresh.get("full_name") or ""):
        updates["full_name"] = payload.full_name.strip()
        fields_changed.append("full_name")

    if payload.phone is not None and (payload.phone or None) != fresh.get("phone"):
        updates["phone"] = payload.phone.strip() or None
        fields_changed.append("phone")

    if payload.timezone is not None and payload.timezone != fresh.get("timezone"):
        tz = payload.timezone.strip()
        # Validate against the IANA database via stdlib zoneinfo. Accepts
        # anything Google's Calendar API will accept — no allowlist to
        # maintain when the frontend dropdown adds an option.
        try:
            ZoneInfo(tz)
        except ZoneInfoNotFoundError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown timezone: {tz!r}. Expected an IANA tz string "
                       "(e.g. 'America/Chicago').",
            ) from exc
        updates["timezone"] = tz
        fields_changed.append("timezone")

    if payload.agent_npn is not None and payload.agent_npn != fresh.get("agent_npn"):
        npn = payload.agent_npn.strip() or None
        # NPN is 5-10 digits per the model validator — apply here too so we
        # don't store garbage when patched via this surface.
        if npn and (not npn.isdigit() or not (5 <= len(npn) <= 10)):
            raise HTTPException(422, "agent_npn must be 5-10 digits, numbers only")
        updates["agent_npn"] = npn
        fields_changed.append("agent_npn")

    if payload.new_password:
        errors = validate_password_strength(
            payload.new_password,
            email=fresh.get("email"),
            full_name=fresh.get("full_name"),
        )
        if errors:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "Password does not meet security requirements.",
                    "requirements": errors,
                },
            )
        # Hardening 3: password history. Reject any of the last 5
        # passwords (current + 4 most-recent rotations) so an agent
        # can't oscillate between two values to satisfy a quarterly
        # rotation policy.
        from security import verify_password as _verify_pw
        history = list(fresh.get("password_history") or [])
        candidates = [fresh.get("hashed_password")] + history
        for old_hash in [h for h in candidates[:5] if h]:
            if _verify_pw(payload.new_password, old_hash):
                raise HTTPException(
                    status_code=422,
                    detail={
                        "message": "Password does not meet security requirements.",
                        "requirements": [
                            "Password cannot match any of your last 5 passwords.",
                        ],
                    },
                )
        new_hash = hash_password(payload.new_password)
        # Push current hash into history, keep 5 most recent.
        new_history = (
            [fresh.get("hashed_password")] + history
        )[:5]
        new_history = [h for h in new_history if h]
        updates["hashed_password"] = new_hash
        updates["password_history"] = new_history
        # Bump token_version so every previously-issued JWT for this
        # user fails the deps.get_current_user check on next request.
        updates["token_version"] = int(fresh.get("token_version", 0) or 0) + 1
        fields_changed.append("password")

    if not updates:
        return _profile_dict(fresh)

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.users.update_one({"id": fresh["id"]}, {"$set": updates})

    # Audit only the field NAMES — never the values, especially for password.
    await write_audit(
        db, "profile_updated",
        actor_email=fresh["email"],
        actor_id=fresh["id"],
        target_type="user",
        target_id=fresh["id"],
        request=request,
        metadata={"fields_changed": fields_changed},
    )

    updated = await db.users.find_one({"id": fresh["id"]}, {"_id": 0})
    return _profile_dict(updated)


# ── GET /api/profile/sessions ──────────────────────────────────────────────
@router.get("/profile/sessions")
async def my_sessions(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Last 10 successful login attempts for the caller. login_attempts is
    keyed by email and only stores the most recent activity (per
    deps.check_and_record_login_attempt's lockout cleanup), so we don't
    have rich historical data — this returns what's there plus a count."""
    email = (current_user.get("email") or "").lower().strip()
    # Look at login_success entries in the audit log — that's where we record
    # IP + UA for each successful sign-in.
    cursor = db.audit_logs.find(
        {"event_type": "login_success", "actor_email": email},
        {"_id": 0, "ip_address": 1, "user_agent": 1, "timestamp": 1},
    ).sort("timestamp", -1).limit(10)
    rows = await cursor.to_list(length=10)
    return {"sessions": rows, "count": len(rows)}


# ── GET /api/profile/audit-log ────────────────────────────────────────────
@router.get("/profile/audit-log")
async def my_audit_log(
    request: Request,
    user_id: Optional[str] = Query(None, max_length=64),
    action: Optional[str] = Query(None, max_length=64),
    from_: Optional[str] = Query(None, alias="from", max_length=40),
    to: Optional[str] = Query(None, max_length=40),
    limit: int = Query(100, ge=1, le=500),
    export: Optional[str] = Query(None, max_length=10),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    role = current_user.get("role", "agent")
    is_privileged = role in ("admin", "compliance")

    q: Dict[str, Any] = {}

    if not is_privileged:
        # Agents see only their own activity — scope is forced server-side.
        q["actor_email"] = (current_user.get("email") or "").lower().strip()
    elif user_id:
        # Admin/compliance can filter to one user. Resolve to email since
        # actor_email is the canonical key on audit_logs.
        target = await db.users.find_one(
            {"id": user_id}, {"_id": 0, "email": 1}
        )
        if target:
            q["actor_email"] = (target["email"] or "").lower().strip()
        else:
            # No such user — return empty cleanly rather than confusing 404.
            q["actor_email"] = "__no_match__"

    if action:
        q["event_type"] = action

    ts_clause: dict = {}
    if from_:
        ts_clause["$gte"] = from_
    if to:
        ts_clause["$lte"] = to
    if ts_clause:
        q["timestamp"] = ts_clause

    cap = limit if export != "csv" else min(max(limit, 5000), 5000)
    cursor = db.audit_logs.find(q, {"_id": 0}).sort("timestamp", -1).limit(cap)
    rows = await cursor.to_list(length=cap)

    # Enrich with target_email when target_type=user (so admins see who was acted on).
    target_ids = [r.get("target_id") for r in rows
                  if r.get("target_type") == "user" and r.get("target_id")]
    target_emails: Dict[str, str] = {}
    if target_ids:
        async for u in db.users.find(
            {"id": {"$in": list(set(target_ids))}},
            {"_id": 0, "id": 1, "email": 1},
        ):
            target_emails[u["id"]] = u.get("email") or ""
    for r in rows:
        if r.get("target_type") == "user":
            r["target_email"] = target_emails.get(r.get("target_id"))
        else:
            r["target_email"] = None
        r["action"] = _audit_action(r)

    if export == "csv":
        # Build CSV in-memory. Detail blob is JSON-encoded so a spreadsheet
        # cell holds the full payload without exploding to many columns.
        import json as _json
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "timestamp", "actor_email", "action", "target_email",
            "ip_address", "details",
        ])
        for r in rows:
            writer.writerow([
                r.get("timestamp") or "",
                r.get("actor_email") or "",
                r.get("action") or "",
                r.get("target_email") or "",
                r.get("ip_address") or "",
                _json.dumps(r.get("metadata") or {}, default=str),
            ])
        await write_audit(
            db, "audit_log_exported",
            actor_email=current_user.get("email"),
            actor_id=current_user.get("id"),
            request=request,
            metadata={"row_count": len(rows), "filters": {
                "user_id": user_id, "action": action,
                "from": from_, "to": to, "limit": limit,
            }},
        )
        filename = f"ghw-audit-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
        return StreamingResponse(
            iter([buf.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return {
        "entries": rows,
        "count": len(rows),
        "limit": limit,
        "scope": "self" if not is_privileged else ("user" if user_id else "agency"),
    }


# ── Agency settings (single-doc collection) ───────────────────────────────
# agency_settings is a one-row collection keyed by the constant "ghw".
# Anything we need across the agency lives here.
_AGENCY_SETTINGS_KEY = "ghw"


class AgencySettingsPatch(BaseModel):
    agency_name: Optional[str] = None
    business_address: Optional[str] = None
    phone: Optional[str] = None
    agency_npn: Optional[str] = None
    timezone: Optional[str] = None
    eo_carrier: Optional[str] = None
    eo_policy_number: Optional[str] = None
    eo_expires_at: Optional[str] = None


def _default_agency() -> dict:
    return {
        "_key": _AGENCY_SETTINGS_KEY,
        "agency_name": "Gruening Health & Wealth",
        "business_address": "",
        "phone": "",
        "agency_npn": "",
        "timezone": "America/Chicago",
        "eo_carrier": "",
        "eo_policy_number": "",
        "eo_expires_at": "",
        "updated_at": None,
    }


@router.get("/profile/agency")
async def get_agency_settings(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Anyone authenticated can read the agency settings (they're not
    secret), but only admin can write — see PATCH below."""
    doc = await db.agency_settings.find_one(
        {"_key": _AGENCY_SETTINGS_KEY}, {"_id": 0}
    )
    return doc or _default_agency()


@router.patch("/profile/agency")
async def update_agency_settings(
    payload: AgencySettingsPatch,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    sent = payload.model_dump(exclude_unset=True)
    if not sent:
        return await db.agency_settings.find_one(
            {"_key": _AGENCY_SETTINGS_KEY}, {"_id": 0}
        ) or _default_agency()
    sent["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.agency_settings.update_one(
        {"_key": _AGENCY_SETTINGS_KEY},
        {"$set": sent,
         "$setOnInsert": {"_key": _AGENCY_SETTINGS_KEY}},
        upsert=True,
    )
    await write_audit(
        db, "agency_settings_updated",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"fields_changed": list(sent.keys())},
    )
    fresh = await db.agency_settings.find_one(
        {"_key": _AGENCY_SETTINGS_KEY}, {"_id": 0}
    )
    return fresh


# ── GET /api/profile/team — for Team tab summary table ────────────────────
@router.get("/profile/team")
async def list_team(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    cursor = db.users.find(
        {},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1,
         "is_active": 1, "status": 1, "created_at": 1},
    ).sort("created_at", -1).limit(200)
    rows = await cursor.to_list(length=200)
    return {"members": rows, "count": len(rows)}


# ── PATCH /api/admin/users/{user_id}/credentials ───────────────────────────
class AdminCredentialPatch(BaseModel):
    email: Optional[EmailStr] = None
    new_password: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None


@router.patch("/admin/users/{user_id}/credentials")
async def admin_credential_change(
    user_id: str,
    payload: AdminCredentialPatch,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """Admin force-update of another user's credentials. No
    current_password required because the admin is the policy authority for
    every account. Logs the field NAMES changed, never values."""
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")

    updates: dict = {}
    fields_changed: list = []

    if payload.email and payload.email.lower() != (target.get("email") or "").lower():
        new_email = payload.email.lower().strip()
        clash = await db.users.find_one(
            {"email": new_email, "id": {"$ne": user_id}}, {"_id": 0, "id": 1}
        )
        if clash:
            raise HTTPException(409, "That email is already in use")
        updates["email"] = new_email
        fields_changed.append("email")

    if payload.role and payload.role != target.get("role"):
        if payload.role not in ("admin", "agent", "compliance"):
            raise HTTPException(422, "role must be admin, agent, or compliance")
        updates["role"] = payload.role
        fields_changed.append("role")

    if payload.is_active is not None and payload.is_active != target.get("is_active", True):
        updates["is_active"] = bool(payload.is_active)
        fields_changed.append("is_active")

    if payload.new_password:
        errors = validate_password_strength(
            payload.new_password,
            email=target.get("email"),
            full_name=target.get("full_name"),
        )
        if errors:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "Password does not meet security requirements.",
                    "requirements": errors,
                },
            )
        updates["hashed_password"] = hash_password(payload.new_password)
        # Admin force-reset must invalidate every existing session on
        # the target user — bump token_version.
        updates["token_version"] = int(target.get("token_version", 0) or 0) + 1
        fields_changed.append("password")

    if not updates:
        return _profile_dict(target)

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.users.update_one({"id": user_id}, {"$set": updates})

    await write_audit(
        db, "admin_credential_change",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="user",
        target_id=user_id,
        request=request,
        metadata={
            "target_email": target.get("email"),
            "fields_changed": fields_changed,
        },
    )

    fresh = await db.users.find_one({"id": user_id}, {"_id": 0})
    return _profile_dict(fresh)


# ── Forgot / reset password ──────────────────────────────────────────────
# Two-step flow:
#   1. POST /api/profile/forgot-password { email }
#      Always 200 (no user enumeration). When the email matches a user,
#      we mint a single-use token, store it in db.password_resets, and
#      ship a reset email via Resend.
#   2. POST /api/profile/reset-password { token, new_password }
#      Verifies the token (exists, not expired, not used). Re-hashes the
#      password, marks the token used, bumps the user's token_version
#      so existing sessions die.

import uuid as _uuid
from datetime import timedelta as _timedelta


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(..., min_length=8, max_length=200)


_FORGOT_RATE = "20/hour"  # Per-IP via slowapi global limiter.


@router.post("/profile/forgot-password")
async def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Email-anonymous: always 200 regardless of whether the email
    matches a user. Never reveals account existence."""
    email = (payload.email or "").lower().strip()
    user = await db.users.find_one({"email": email}, {"_id": 0})
    now = datetime.now(timezone.utc)

    if user:
        token = _uuid.uuid4().hex
        expires_at = now + _timedelta(hours=1)
        await db.password_resets.insert_one({
            "token": token,
            "user_id": user["id"],
            "email": email,
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
            "used": False,
        })
        # Build the reset URL pointing at the SPA.
        reset_url = f"{get_frontend_url()}/reset-password?token={token}"

        # Fire the email — never-throw inside the service.
        from email_service import send_password_reset_email
        await send_password_reset_email(
            db,
            to_email=email,
            reset_url=reset_url,
            full_name=user.get("full_name"),
        )
        await write_audit(
            db, "password_reset_requested",
            actor_email=email, request=request,
            target_type="user", target_id=user["id"],
        )
    else:
        # Audit failed lookups too — useful when triaging abuse.
        await write_audit(
            db, "password_reset_unknown_email",
            actor_email=email, request=request,
        )

    return {
        "message": "If an account exists for that email, a reset link "
                   "has been sent.",
    }


@router.post("/profile/reset-password")
async def reset_password(
    payload: ResetPasswordRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Verify token → set new password → invalidate token + sessions."""
    now = datetime.now(timezone.utc)
    rec = await db.password_resets.find_one({"token": payload.token},
                                             {"_id": 0})
    if not rec:
        raise HTTPException(400, "This link is invalid or has already been used.")
    if rec.get("used"):
        raise HTTPException(400, "This link has already been used.")
    expires_at = rec.get("expires_at")
    try:
        exp_dt = datetime.fromisoformat(
            expires_at.replace("Z", "+00:00") if expires_at and expires_at.endswith("Z") else expires_at
        )
        if exp_dt.tzinfo is None:
            exp_dt = exp_dt.replace(tzinfo=timezone.utc)
    except Exception:
        exp_dt = now - _timedelta(seconds=1)
    if exp_dt < now:
        raise HTTPException(400, "This link has expired.")

    # Update the user's password + bump token_version so any active
    # sessions are immediately invalidated.
    user = await db.users.find_one({"id": rec["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(400, "This link is invalid or has already been used.")
    # Enforce the full password policy on reset too — pen-test finding:
    # the reset path was accepting weaker passwords than registration.
    pw_errors = validate_password_strength(
        payload.new_password,
        email=user.get("email"),
        full_name=user.get("full_name"),
    )
    if pw_errors:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Password does not meet security requirements.",
                "requirements": pw_errors,
            },
        )
    new_hash = hash_password(payload.new_password)
    new_token_version = int(user.get("token_version", 0)) + 1
    await db.users.update_one(
        {"id": rec["user_id"]},
        {"$set": {
            "hashed_password": new_hash,
            "token_version": new_token_version,
            "updated_at": now.isoformat(),
        }},
    )
    await db.password_resets.update_one(
        {"token": payload.token},
        {"$set": {"used": True, "used_at": now.isoformat()}},
    )
    await write_audit(
        db, "password_reset",
        actor_email=user.get("email"),
        actor_id=user.get("id"),
        target_type="user",
        target_id=user.get("id"),
        request=request,
        metadata={"via": "reset_link"},
    )
    return {"message": "Password updated"}


# ── Booking settings ─────────────────────────────────────────────────────
# Per-agent booking page configuration. The full BookingSettings model
# lives in models.py — the patch payload below mirrors it but every
# field is Optional so the SPA can send just the diff.

import re as _re_booking


_SLUG_FALLBACK_RE = _re_booking.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    """'Tim Arnold' → 'tim-arnold'. Lowercase, hyphenate, trim hyphens.

    Falls back to 'agent' when normalization wipes everything (e.g. a
    full_name made entirely of punctuation). The collision-avoidance
    loop in the endpoint handles uniqueness.
    """
    if not value:
        return "agent"
    s = _SLUG_FALLBACK_RE.sub("-", value.strip().lower()).strip("-")
    return s or "agent"


async def _unique_slug(db, base: str, current_user_id: str) -> str:
    """Append -2, -3, … until the slug is unique across users.

    Excludes the calling user from the collision check so re-saving
    the same row doesn't bump the slug. Caps at 50 candidates to keep
    a degenerate pathological state (full_name = "Bob" with 49 Bobs
    in the agency) from looping forever — fallback after that adds a
    random hex suffix.
    """
    candidate = base
    for n in range(2, 51):
        existing = await db.users.find_one(
            {
                "booking_settings.slug": candidate,
                "id": {"$ne": current_user_id},
            },
            {"_id": 0, "id": 1},
        )
        if not existing:
            return candidate
        candidate = f"{base}-{n}"
    import secrets as _secrets
    return f"{base}-{_secrets.token_hex(3)}"


class BookingSettingsPatch(BaseModel):
    is_enabled: Optional[bool] = None
    bio: Optional[str] = Field(None, max_length=1000)
    meeting_types: Optional[list] = None
    phone_number: Optional[str] = Field(None, max_length=40)
    video_link: Optional[str] = Field(None, max_length=500)
    appointment_duration: Optional[int] = Field(None, ge=15, le=240)
    buffer_minutes: Optional[int] = Field(None, ge=0, le=120)
    max_per_day: Optional[int] = Field(None, ge=1, le=50)
    advance_notice_hours: Optional[int] = Field(None, ge=0, le=720)
    booking_window_days: Optional[int] = Field(None, ge=1, le=365)
    working_hours: Optional[dict] = None


@router.patch("/profile/booking-settings")
async def update_booking_settings(
    payload: BookingSettingsPatch,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Update the caller's booking_settings.

    First call auto-generates a slug from `full_name` (falling back to
    `email`'s local part) and ensures uniqueness across the agency.
    Subsequent calls preserve the existing slug — agents who want to
    rename a slug should ask an admin to rebuild it (we don't expose a
    rename endpoint because outstanding booking links would 404).
    """
    fresh = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not fresh:
        raise HTTPException(404, "User not found")

    sent = payload.model_dump(exclude_unset=True)
    existing_bs = fresh.get("booking_settings") or {}

    # Build the merged BookingSettings dict — start from existing,
    # overlay sent values. Validate by round-tripping through the
    # Pydantic model so a malformed working_hours dict fails clearly.
    merged = {**BookingSettings().model_dump(), **existing_bs, **sent}

    # Slug — set once, preserved forever (rename requires admin work).
    if not merged.get("slug"):
        seed = fresh.get("full_name") or (fresh.get("email") or "").split("@")[0]
        base = _slugify(seed)
        merged["slug"] = await _unique_slug(db, base, fresh["id"])

    # Validate (raises 422 from FastAPI on malformed shapes).
    validated = BookingSettings(**merged).model_dump()

    await db.users.update_one(
        {"id": fresh["id"]},
        {"$set": {"booking_settings": validated,
                  "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    await write_audit(
        db, "booking_settings_updated",
        actor_email=fresh.get("email"),
        actor_id=fresh.get("id"),
        target_type="user", target_id=fresh["id"],
        request=request,
        metadata={"fields_changed": list(sent.keys()),
                  "slug": validated.get("slug"),
                  "is_enabled": validated.get("is_enabled")},
    )

    updated = await db.users.find_one({"id": fresh["id"]}, {"_id": 0})
    profile = _profile_dict(updated)
    profile["booking_settings"] = updated.get("booking_settings")
    return profile
