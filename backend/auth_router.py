"""Authentication routes: register, login, MFA enroll/verify, me, approval."""
import io
import os
import base64
import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timezone, timedelta

import pyotp
import qrcode
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter
from slowapi.util import get_remote_address

# Cookie / CSRF constants
_ACCESS_COOKIE = "ghw_access_token"
_CSRF_COOKIE = "ghw_csrf_token"
_COOKIE_MAX_AGE = 60 * 60 * 24  # 24h — matches what we ask of the JWT expiry


def _set_session_cookies(response: Response, jwt_token: str) -> None:
    """Plant the httpOnly access cookie + JS-readable CSRF cookie.

    SameSite=None;Secure is the only configuration that works for the
    cross-site Vercel → Render flow AND for mobile browsers that
    enforce SameSite=Lax-by-default with stricter cross-context rules
    than desktop. Per the spec these two flags must travel together —
    SameSite=None without Secure is rejected by every modern browser.

    Hardcoded (not env-conditional) so a misconfigured ENVIRONMENT
    var on Render can't silently downgrade prod cookies and break the
    mobile login flow. Local dev over plain HTTP cannot plant these
    cookies as a result — tunnel through HTTPS (ngrok, Caddy, etc.)
    or run the SPA against a deployed API for end-to-end testing.
    """
    response.set_cookie(
        key=_ACCESS_COOKIE,
        value=jwt_token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=_COOKIE_MAX_AGE,
        path="/",
    )
    response.set_cookie(
        key=_CSRF_COOKIE,
        value=secrets.token_hex(32),
        httponly=False,                # JS must read this to echo as header
        secure=True,
        samesite="none",
        max_age=_COOKIE_MAX_AGE,
        path="/",
    )


def _clear_session_cookies(response: Response) -> None:
    response.delete_cookie(_ACCESS_COOKIE, path="/")
    response.delete_cookie(_CSRF_COOKIE, path="/")

# Dummy bcrypt hash used to keep response time constant when the email doesn't
# exist. Computed once at import; the plaintext is never used.
_DUMMY_BCRYPT_HASH = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8zJZ6yfsT9MrbXk7eDjmnQDQt2WJYS"

from models import (
    UserPublic, LoginRequest, LoginResponse,
    MfaEnrollResponse, MfaVerifyRequest,
    AgentRegistrationRequest, InviteRequest, UserProfileUpdate,
)
from security import (
    hash_password, verify_password, create_access_token,
    validate_password_strength,
)
from deps import (
    get_db, get_current_user, get_frontend_url, require_roles, write_audit,
    is_account_locked, check_and_record_login_attempt,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Per-router limiter — uses the same key_func as the app-level one. Endpoints
# below decorate themselves with @limiter.limit(...) to apply IP-based ceilings.
limiter = Limiter(key_func=get_remote_address)


def _user_public(user: dict) -> UserPublic:
    return UserPublic(
        id=user["id"],
        email=user["email"],
        full_name=user.get("full_name"),
        role=user.get("role", "agent"),
        is_active=user.get("is_active", True),
        status=user.get("status", "active"),
        agency_name=user.get("agency_name"),
        # Fall back to the user's own id if agent_id hasn't been backfilled
        # yet — defensive so /auth/me never returns a null scoping key.
        agent_id=user.get("agent_id") or user.get("id"),
        agent_name=user.get("agent_name"),
        agent_npn=user.get("agent_npn"),
        mfa_enabled=user.get("mfa_enabled", False),
        created_at=user.get("created_at", datetime.now(timezone.utc).isoformat()),
    )


def _jwt_claims(user: dict, mfa_verified: bool, pre_auth: bool = False) -> dict:
    """Build the JWT payload. Agent identity travels in the token for fast
    downstream lookups, but server code MUST still resolve it from the DB row
    before trusting it for any high-impact action."""
    claims = {
        "sub": user["id"],
        "email": user["email"],
        "role": user["role"],
        "mfa_verified": mfa_verified,
        # token_version is compared in deps.get_current_user against
        # the live user row — bump it on the user (e.g. on password
        # change) and every JWT minted before the bump becomes invalid
        # on the next request.
        "tv": int(user.get("token_version", 0)),
    }
    if user.get("agent_name"):
        claims["agent_name"] = user["agent_name"]
    if user.get("agent_npn"):
        claims["agent_npn"] = user["agent_npn"]
    if pre_auth:
        claims["pre_auth"] = True
    return claims


@router.post("/register", response_model=UserPublic, status_code=201)
@limiter.limit("5/hour")
async def register(
    body: AgentRegistrationRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """
    Register a new agent using a valid invite token.
    Open registration is disabled — all agents must be invited by an admin.
    """
    # Require invite token
    if not body.invite_token:
        raise HTTPException(
            status_code=403,
            detail="Registration requires an invite. "
                   "Contact your administrator to receive an invite link.",
        )

    # Validate the invite token
    token_hash = hashlib.sha256(body.invite_token.encode()).hexdigest()
    now_iso = datetime.now(timezone.utc).isoformat()

    invite = await db.invite_tokens.find_one({
        "token_hash": token_hash,
        "used": False,
        "expires_at": {"$gt": now_iso},
    })

    if not invite:
        raise HTTPException(
            status_code=400,
            detail="This invite link is invalid or has expired. "
                   "Please contact your administrator for a new invite.",
        )

    # Email must match the invite
    if body.email.lower().strip() != invite["email"].lower().strip():
        raise HTTPException(
            status_code=400,
            detail="The email address does not match this invite. "
                   "Please register with the email address your invite was sent to.",
        )

    # Validate password strength
    pw_errors = validate_password_strength(
        body.password,
        email=body.email,
        full_name=body.full_name,
    )
    if pw_errors:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Password does not meet security requirements.",
                "requirements": pw_errors,
            },
        )

    # Invalidate the token IMMEDIATELY (before creating user)
    await db.invite_tokens.update_one(
        {"token_hash": token_hash},
        {"$set": {"used": True, "used_at": datetime.now(timezone.utc).isoformat()}},
    )

    # ── existing registration logic ────────────────────────────────────────
    email = body.email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    # Agent identity at write time:
    #   - agent_id = the new user's own id (scoping key for agent_filter)
    #   - agent_name = full_name (kept in lockstep so downstream lookups
    #     like ComTrack and the leaderboard resolve immediately)
    #   - agent_npn = invite's NPN if set, else body's. Admins control NPN
    #     via the invite so a registering agent cannot mint their own.
    new_user_id = str(uuid.uuid4())
    full_name = body.full_name.strip()
    agent_npn = invite.get("agent_npn") or body.agent_npn
    # Honour the role stamped on the invite (defaults to "agent" for any
    # invite that pre-dates the role expansion). The Pydantic Literal on
    # InviteRequest prevents "admin" from ever landing on an invite, so
    # this fallback is safe.
    assigned_role = invite.get("role") or "agent"
    user_doc = {
        "id": new_user_id,
        "agent_id": new_user_id,
        "email": email,
        "full_name": full_name,
        "role": assigned_role,
        "is_active": False,
        "status": "pending",
        "agency_name": body.agency_name.strip(),
        "agent_name": full_name,
        "agent_npn": agent_npn,
        "hashed_password": hash_password(body.password),
        "mfa_secret": None,
        "mfa_enabled": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(user_doc)
    await write_audit(db, "agent_registration_requested", actor_email=email,
                      target_type="user", target_id=user_doc["id"], request=request,
                      metadata={"agency_name": user_doc["agency_name"],
                                "full_name": user_doc["full_name"],
                                "invite_id": invite["id"]})
    await write_audit(db, "invite_used", actor_email=email,
                      target_type="invite", target_id=invite["id"],
                      metadata={"invited_email": invite["email"]})

    # Fire the welcome email. Never-throw — if Resend chokes the user
    # is still registered and can sign in.
    from email_service import send_welcome_email
    await send_welcome_email(
        db,
        to_email=email,
        full_name=user_doc.get("full_name"),
        role=user_doc.get("role"),
    )

    # Notification hook — keep the logger line so ops can grep for new
    # registrations even when the email path is in mock mode.
    logger.info(
        "[notification] Agent registered via invite: %s (%s) — agency=%s. "
        "Approve at /api/auth/users/%s/approve",
        user_doc["full_name"], email, user_doc["agency_name"], user_doc["id"],
    )
    return _user_public(user_doc)


def _format_unlock_message(unlock_at: datetime) -> str:
    return (
        "Account temporarily locked due to too many failed attempts. "
        f"Try again at {unlock_at.strftime('%H:%M')} UTC."
    )


@router.post("/login", response_model=LoginResponse)
@limiter.limit("10/minute")
async def login(payload: LoginRequest, request: Request, response: Response,
                db: AsyncIOMotorDatabase = Depends(get_db)):
    email = payload.email.lower().strip()

    # 1. Check existing lockout BEFORE verifying password
    lock_state = await is_account_locked(db, email)
    if lock_state["locked"]:
        await write_audit(db, "login_failed", actor_email=payload.email,
                          request=request,
                          metadata={"reason": "locked", "unlock_at": lock_state["unlock_at"].isoformat()})
        raise HTTPException(
            status_code=429,
            detail="Account temporarily locked. Try again in 15 minutes.",
        )

    user = await db.users.find_one({"email": email}, {"_id": 0})
    # Constant-time check: always invoke bcrypt verify so a missing user takes
    # the same wall-clock time as an existing user with a wrong password. Prior
    # behaviour short-circuited on `not user`, leaking user existence via
    # response timing.
    if not user:
        verify_password(payload.password, _DUMMY_BCRYPT_HASH)
        password_ok = False
    else:
        password_ok = verify_password(payload.password, user["hashed_password"])
    if not user or not password_ok:
        # 2. Record the failed attempt — may trigger a lockout
        attempt_result = await check_and_record_login_attempt(db, email, success=False)
        if attempt_result["locked"]:
            await write_audit(db, "account_locked", actor_email=payload.email,
                              actor_id=user.get("id") if user else None,
                              target_type="user",
                              target_id=user.get("id") if user else None,
                              request=request,
                              metadata={
                                  "unlock_at": attempt_result["unlock_at"].isoformat(),
                                  "attempts": attempt_result["attempts"],
                              })
            await write_audit(db, "login_failed", actor_email=payload.email, request=request,
                              metadata={"reason": "locked_now"})
            raise HTTPException(
                status_code=429,
                detail="Account temporarily locked. Try again in 15 minutes.",
            )
        await write_audit(db, "login_failed", actor_email=payload.email, request=request,
                          metadata={"reason": "invalid_credentials",
                                    "attempts": attempt_result["attempts"]})
        raise HTTPException(status_code=401, detail="Invalid credentials")

    status_value = user.get("status", "active")
    if status_value == "pending":
        await write_audit(db, "login_failed", actor_email=payload.email,
                          actor_id=user.get("id"), request=request,
                          metadata={"reason": "pending_approval"})
        raise HTTPException(status_code=403,
                            detail="Account pending admin approval")
    if status_value == "rejected":
        await write_audit(db, "login_failed", actor_email=payload.email,
                          actor_id=user.get("id"), request=request,
                          metadata={"reason": "rejected"})
        raise HTTPException(status_code=403,
                            detail="Account access denied")
    if not user.get("is_active", True):
        await write_audit(db, "login_failed", actor_email=payload.email,
                          actor_id=user.get("id"), request=request,
                          metadata={"reason": "inactive"})
        # 401 (not 403) + user-readable copy that the SPA can surface
        # on the redirect to /login. Matches the message returned by
        # deps.get_current_user when the user becomes deactivated
        # mid-session.
        raise HTTPException(
            status_code=401,
            detail=(
                "Your account has been deactivated. "
                "Contact your administrator."
            ),
        )

    mfa_verified = False
    if user.get("mfa_enabled"):
        if not payload.mfa_code:
            # Issue a short pre-auth token allowing MFA submission
            token = create_access_token(
                _jwt_claims(user, mfa_verified=False, pre_auth=True),
                expires_minutes=5,
            )
            await write_audit(db, "login_mfa_required", actor_email=payload.email,
                              actor_id=user["id"], request=request)
            return LoginResponse(access_token=token, mfa_required=True, user=_user_public(user))
        totp = pyotp.TOTP(user["mfa_secret"])
        if not totp.verify(payload.mfa_code, valid_window=1):
            await write_audit(db, "login_failed", actor_email=payload.email,
                              actor_id=user["id"], request=request,
                              metadata={"reason": "invalid_mfa"})
            raise HTTPException(status_code=401, detail="Invalid MFA code")
        mfa_verified = True

    token = create_access_token(
        _jwt_claims(user, mfa_verified=mfa_verified or not user.get("mfa_enabled", False))
    )
    # Successful auth — clear any tracked failed attempts for this email
    await check_and_record_login_attempt(db, email, success=True)
    await write_audit(db, "login_success", actor_email=user["email"], actor_id=user["id"],
                      request=request, metadata={"mfa": user.get("mfa_enabled", False)})
    # Plant cookies for browser sessions; still return access_token in the body
    # so the existing header-bearer code path keeps working during the rollout.
    _set_session_cookies(response, token)
    return LoginResponse(access_token=token, mfa_required=False, user=_user_public(user))


@router.post("/logout")
async def logout(request: Request, response: Response,
                 db: AsyncIOMotorDatabase = Depends(get_db),
                 current_user=Depends(get_current_user)):
    """Clear the session cookies. Stateless JWTs cannot be invalidated server
    side without a revocation list (out of scope here), but clearing the
    cookies removes the credential from the browser surface, which is the
    realistic threat model for an SPA on a shared device.
    """
    _clear_session_cookies(response)
    await write_audit(db, "logout", actor_email=current_user.get("email"),
                      actor_id=current_user.get("id"), request=request)
    return {"message": "Logged out"}


@router.get("/me", response_model=UserPublic)
async def me(current_user=Depends(get_current_user)):
    return _user_public(current_user)


@router.post("/mfa/enroll", response_model=MfaEnrollResponse)
async def mfa_enroll(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if current_user.get("mfa_enabled"):
        raise HTTPException(status_code=400, detail="MFA already enabled")

    secret = pyotp.random_base32()
    otpauth_uri = pyotp.TOTP(secret).provisioning_uri(
        name=current_user["email"], issuer_name="Gruening Health & Wealth"
    )

    img = qrcode.make(otpauth_uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    await db.users.update_one(
        {"id": current_user["id"]},
        {"$set": {"mfa_secret": secret}},
    )
    await write_audit(db, "mfa_enroll_started", actor_email=current_user["email"],
                      actor_id=current_user["id"], request=request)
    return MfaEnrollResponse(secret=secret, otpauth_uri=otpauth_uri, qr_png_base64=b64)


@router.post("/mfa/verify")
async def mfa_verify(
    payload: MfaVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    user = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not user or not user.get("mfa_secret"):
        raise HTTPException(status_code=400, detail="MFA not started")
    if not pyotp.TOTP(user["mfa_secret"]).verify(payload.code, valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid code")
    await db.users.update_one({"id": user["id"]}, {"$set": {"mfa_enabled": True}})
    await write_audit(db, "mfa_enabled", actor_email=user["email"], actor_id=user["id"], request=request)

    # Re-issue token with mfa_verified=true. Re-read user so any agent identity
    # fields populated between enroll and verify also land in the new token.
    refreshed = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    token = create_access_token(_jwt_claims(refreshed or user, mfa_verified=True))
    _set_session_cookies(response, token)
    return {"message": "MFA enabled", "access_token": token, "token_type": "bearer"}


# ----- Pending agent approval (admin only) -----

@router.get("/pending", response_model=list[UserPublic])
async def list_pending_agents(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _admin=Depends(require_roles("admin", "owner")),
):
    cursor = db.users.find({"status": "pending"}, {"_id": 0}).sort("created_at", -1)
    return [_user_public(u) async for u in cursor]


@router.post("/users/{user_id}/approve", response_model=UserPublic)
async def approve_agent(
    user_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    admin=Depends(require_roles("admin", "owner")),
):
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("status") == "active":
        return _user_public(user)
    if user.get("status") == "rejected":
        raise HTTPException(status_code=400,
                            detail="Cannot approve a rejected account")

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"status": "active", "is_active": True,
                  "approved_at": now_iso, "approved_by": admin["id"]}},
    )
    await write_audit(db, "agent_approved", actor_email=admin["email"],
                      actor_id=admin["id"], target_type="user", target_id=user_id,
                      request=request, metadata={"email": user["email"]})
    fresh = await db.users.find_one({"id": user_id}, {"_id": 0})
    return _user_public(fresh)


@router.post("/users/{user_id}/reject", response_model=UserPublic)
async def reject_agent(
    user_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    admin=Depends(require_roles("admin", "owner")),
):
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"status": "rejected", "is_active": False,
                  "rejected_at": now_iso, "rejected_by": admin["id"]}},
    )
    await write_audit(db, "agent_rejected", actor_email=admin["email"],
                      actor_id=admin["id"], target_type="user", target_id=user_id,
                      request=request, metadata={"email": user["email"]})
    fresh = await db.users.find_one({"id": user_id}, {"_id": 0})
    return _user_public(fresh)


# ----- Admin: invite + unlock -----

@router.post("/invite", status_code=201)
async def create_invite(
    invite: InviteRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """
    Admin creates an invite link for a new agent.
    The raw token is returned ONCE — it is stored hashed in MongoDB.
    """
    now = datetime.now(timezone.utc)
    # Check no pending invite already exists for this email
    existing = await db.invite_tokens.find_one({
        "email": invite.email,
        "used": False,
        "expires_at": {"$gt": now.isoformat()},
    })
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"An active invite already exists for {invite.email}. "
                   f"It expires at {existing['expires_at']}.",
        )

    # Generate token
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    expires = now + timedelta(hours=24)

    # Role on the invite — defaults to "agent". Admin is explicitly NOT
    # invitable from this endpoint (the Pydantic Literal excludes it) so
    # privilege escalation requires DB-level intervention.
    invite_role = invite.role or "agent"
    invite_doc = {
        "id": str(uuid.uuid4()),
        "token_hash": token_hash,
        "email": invite.email,
        "full_name": invite.full_name or "",
        "agency_name": invite.agency_name or "",
        "agent_name": invite.agent_name,
        "agent_npn": invite.agent_npn,
        "role": invite_role,
        "created_by": current_user["id"],
        "created_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "used": False,
        "used_at": None,
    }
    await db.invite_tokens.insert_one(invite_doc)

    await write_audit(
        db=db,
        event_type="invite_created",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="invite",
        target_id=invite_doc["id"],
        metadata={
            "invited_email": invite.email,
            "role": invite_role,
            "expires_at": expires.isoformat(),
        },
    )

    # Single source of truth lives in deps.get_frontend_url — set
    # FRONTEND_URL in Render env to rotate the SPA host.
    invite_url = f"{get_frontend_url()}/register?token={raw_token}"

    # Fire the invite email. Email send is wrapped never-throw inside
    # the service — a delivery failure must not roll back the invite
    # row we just inserted (admin can still copy the URL by hand).
    from email_service import send_invite_email
    email_res = await send_invite_email(
        db,
        to_email=invite.email,
        invite_url=invite_url,
        invited_by=current_user.get("full_name") or current_user.get("email"),
        role=invite_role,
        expires_at=expires.isoformat(),
    )

    # Surface the underlying reason on the response so the admin sees
    # "email not sent — domain not verified" instead of a generic
    # "email not sent" they'd have to file a ticket about. The token
    # is included regardless so the invite is always usable manually.
    email_reason = email_res.get("reason") if not email_res.get("ok") else None
    if email_res.get("ok"):
        message = f"Invite sent to {invite.email}"
    elif email_reason == "not_configured":
        message = (
            f"Invite created for {invite.email} — email skipped "
            f"(RESEND_API_KEY not set). Copy the link below."
        )
    elif email_reason:
        message = (
            f"Invite created for {invite.email} — email failed "
            f"({email_reason}). Copy the link below."
        )
    else:
        message = (
            f"Invite created for {invite.email} (email not sent — copy "
            f"the link below)"
        )
    return {
        "message": message,
        "invite_url": invite_url,
        "expires_at": expires.isoformat(),
        "token": raw_token,  # Raw token returned once for the admin to copy/send
        "email_sent": bool(email_res.get("ok")),
        "email_reason": email_reason,
    }


@router.get("/invite/validate")
@limiter.limit("20/hour")
async def validate_invite(
    request: Request,
    token: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """
    Frontend calls this before showing the registration form.
    Returns the pre-filled email if token is valid.
    """
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now_iso = datetime.now(timezone.utc).isoformat()

    invite = await db.invite_tokens.find_one({
        "token_hash": token_hash,
        "used": False,
        "expires_at": {"$gt": now_iso},
    })

    if not invite:
        raise HTTPException(
            status_code=400,
            detail="This invite link is invalid or has expired. "
                   "Please contact your administrator for a new invite.",
        )

    return {
        "valid": True,
        "email": invite["email"],
        "full_name": invite.get("full_name", ""),
        "agency_name": invite.get("agency_name", ""),
        "agent_name": invite.get("agent_name"),
        "agent_npn": invite.get("agent_npn"),
    }


@router.get("/invites")
async def list_invites(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """List all active (unused, non-expired) invite tokens."""
    now_iso = datetime.now(timezone.utc).isoformat()
    cursor = db.invite_tokens.find(
        {"used": False, "expires_at": {"$gt": now_iso}},
        {"_id": 0, "token_hash": 0},  # Never return the hash
    ).sort("created_at", -1).limit(50)
    invites = await cursor.to_list(length=50)
    return {"invites": invites, "total": len(invites)}


@router.delete("/invites/{invite_id}", status_code=200)
async def revoke_invite(
    invite_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """Revoke a pending invite.

    We don't hard-delete — flipping ``used=true`` keeps the audit trail
    intact (you can still see who was invited and when) while making
    the token unusable. Idempotent: revoking an already-used invite
    returns 200 with ``already_used: true`` rather than 404 so the UI
    can flush its local list without surfacing a confusing error.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    inv = await db.invite_tokens.find_one({"id": invite_id}, {"_id": 0})
    if not inv:
        raise HTTPException(status_code=404, detail="Invite not found")

    if inv.get("used"):
        await write_audit(
            db, "invite_revoke_noop",
            actor_email=current_user.get("email"),
            actor_id=current_user.get("id"),
            target_type="invite", target_id=invite_id,
            request=request,
            metadata={"reason": "already_used",
                      "invited_email": inv.get("email")},
        )
        return {"ok": True, "already_used": True}

    await db.invite_tokens.update_one(
        {"id": invite_id},
        {"$set": {
            "used": True,
            "used_at": now_iso,
            "revoked_by": current_user.get("id"),
            "revoked_at": now_iso,
        }},
    )
    await write_audit(
        db, "invite_revoked",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="invite", target_id=invite_id,
        request=request,
        metadata={"invited_email": inv.get("email"),
                  "role": inv.get("role")},
    )
    return {"ok": True, "revoked": True}


@router.post("/users/{user_id}/unlock")
async def unlock_account(
    user_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """Admin manually unlocks a locked account."""
    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    await db.login_attempts.delete_many({"email": user["email"]})

    await write_audit(
        db=db,
        event_type="account_unlocked",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="user",
        target_id=user_id,
        metadata={"unlocked_email": user["email"]},
    )
    return {"message": f"Account {user['email']} has been unlocked."}


@router.patch("/users/{user_id}/profile", response_model=UserPublic)
async def update_user_profile(
    user_id: str,
    payload: UserProfileUpdate,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """Admin-only: update an agent's identity fields (agent_name, agent_npn).

    These fields drive downstream lookups (e.g. ComTrack agent_name filter).
    Only admins can write them so an agent cannot mint their own NPN or
    impersonate another agent for commission queries.
    """
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    updates = {}
    # model_dump(exclude_unset=True) lets us distinguish "field not sent" from
    # "field sent as null". A null value clears the stored field intentionally.
    sent = payload.model_dump(exclude_unset=True)
    if "agent_name" in sent:
        updates["agent_name"] = sent["agent_name"]
    if "agent_npn" in sent:
        updates["agent_npn"] = sent["agent_npn"]

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.users.update_one({"id": user_id}, {"$set": updates})

    await write_audit(
        db=db,
        event_type="user_profile_updated",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="user",
        target_id=user_id,
        request=request,
        metadata={"fields": list(k for k in updates.keys() if k != "updated_at"),
                  "target_email": user["email"]},
    )

    fresh = await db.users.find_one({"id": user_id}, {"_id": 0})
    return _user_public(fresh)
