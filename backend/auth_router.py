"""Authentication routes: register, login, magic-link, me, approval, invite."""
import hashlib
import logging
import os
import secrets
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr
from slowapi import Limiter
from slowapi.util import get_remote_address

# Cookie / CSRF constants
_ACCESS_COOKIE = "ghw_access_token"

# ── Environment-aware cookie scoping ──────────────────────────────────────
# In staging/production the SPA lives at app.ghwcrm.com and the API lives
# at api.ghwcrm.com. For the cookie planted by /login on api.* to be
# carried back on requests from app.*, it MUST be set with
# Domain=.ghwcrm.com so both subdomains share the cookie jar. Setting
# Domain in development would scope the cookie to a .ghwcrm.com domain
# the dev browser never visits — so dev leaves Domain unset (cookie
# scopes to the request host, typically localhost).
#
# SameSite policy is coupled to Domain by the same cross-context logic.
# When Domain is set we expect the SPA to be a different eTLD+1-of-
# subdomain than the API origin, so we must opt-in to SameSite=None to
# allow the cookie to travel. SameSite=None REQUIRES Secure=True per the
# spec — never relax that pair. In dev (no Domain) we drop to
# SameSite=Lax which is the safer default and still lets same-origin
# tools work without HTTPS gymnastics.
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
COOKIE_DOMAIN = (
    ".ghwcrm.com" if ENVIRONMENT in ("production", "staging") else None
)
COOKIE_SAMESITE = "none" if COOKIE_DOMAIN else "lax"


async def _notify_admin_account_locked(email, attempt_result, request):
    """Send the agency admin an alert when an account locks. Best-effort.

    ADMIN_EMAIL env var holds the destination. Missing env → log + return.
    """
    import os as _os_alert
    admin_email = (_os_alert.getenv("ADMIN_EMAIL") or "").strip()
    if not admin_email:
        return
    from resend_client import send_email
    from datetime import datetime as _dt_alert, timezone as _tz_alert
    from deps import get_client_ip as _ip
    ip = _ip(request) if request is not None else None
    unlock_at = attempt_result.get("unlock_at")
    unlock_iso = unlock_at.isoformat() if unlock_at else "unknown"
    now_iso = _dt_alert.now(_tz_alert.utc).isoformat()
    html = f"""
      <h2 style="color:#991b1b;font-family:sans-serif;">Security alert: account locked</h2>
      <p style="font-family:sans-serif;font-size:14px;color:#1f2937;">
        An account has been temporarily locked after repeated failed
        login attempts.
      </p>
      <table style="font-family:sans-serif;font-size:13px;color:#1f2937;">
        <tr><td><strong>Email</strong></td><td>{email}</td></tr>
        <tr><td><strong>Failed attempts</strong></td>
            <td>{attempt_result.get('attempts', '?')}</td></tr>
        <tr><td><strong>IP address</strong></td><td>{ip or 'unknown'}</td></tr>
        <tr><td><strong>Locked at</strong></td><td>{now_iso}</td></tr>
        <tr><td><strong>Auto-unlock at</strong></td><td>{unlock_iso}</td></tr>
      </table>
      <p style="font-family:sans-serif;font-size:13px;color:#6b7280;">
        If this wasn't the legitimate account holder, investigate via
        the Audit Log in Settings.
      </p>
    """
    await send_email(
        to=admin_email,
        subject=f"Security alert: account locked — {email}",
        html=html,
    )
_CSRF_COOKIE = "ghw_csrf_token"
_COOKIE_MAX_AGE = 60 * 60 * 24  # 24h — matches what we ask of the JWT expiry


def _set_session_cookies(response: Response, jwt_token: str) -> None:
    """Plant the httpOnly access cookie + JS-readable CSRF cookie.

    Two flags never change regardless of environment:
      * httponly=True on the access cookie — XSS-stolen JS can't read
        the JWT
      * secure=True on both cookies — only ever sent over HTTPS

    Two flags are environment-aware (see COOKIE_DOMAIN / COOKIE_SAMESITE
    notes at the top of this module):
      * domain — only set in staging/production where the SPA and API
        live on different subdomains of ghwcrm.com
      * samesite — "none" alongside Domain, "lax" in dev for the safer
        default

    SameSite=None without Secure=True is rejected by every modern
    browser. Since Secure stays True in every environment, that pair
    invariant is maintained automatically.

    Dev caveat: Secure=True means the dev browser still needs HTTPS to
    accept these cookies (tunnel through ngrok / Caddy, or run the SPA
    against a deployed API for end-to-end testing).
    """
    response.set_cookie(
        key=_ACCESS_COOKIE,
        value=jwt_token,
        httponly=True,                 # XSS protection — never remove
        secure=True,                   # HTTPS only — never remove
        samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN,
        max_age=_COOKIE_MAX_AGE,
        path="/",
    )
    response.set_cookie(
        key=_CSRF_COOKIE,
        value=secrets.token_hex(32),
        httponly=False,                # JS must read this to echo as header
        secure=True,                   # HTTPS only — never remove
        samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN,
        max_age=_COOKIE_MAX_AGE,
        path="/",
    )


def _clear_session_cookies(response: Response) -> None:
    """Clear both cookies. CRITICAL: a cookie planted with
    Domain=.ghwcrm.com can ONLY be deleted by a Set-Cookie with the
    same Domain attribute. Pass the same COOKIE_DOMAIN we used at
    plant time so logout works in every environment."""
    response.delete_cookie(
        _ACCESS_COOKIE, path="/", domain=COOKIE_DOMAIN,
    )
    response.delete_cookie(
        _CSRF_COOKIE, path="/", domain=COOKIE_DOMAIN,
    )

# Dummy bcrypt hash used to keep response time constant when the email doesn't
# exist. Computed once at import; the plaintext is never used.
_DUMMY_BCRYPT_HASH = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8zJZ6yfsT9MrbXk7eDjmnQDQt2WJYS"

from models import (
    UserPublic, LoginRequest, LoginResponse,
    AgentRegistrationRequest, InviteRequest, UserProfileUpdate,
)
from security import (
    hash_password, verify_password, create_access_token,
    validate_password_strength,
)
from deps import (
    get_agency_id, get_db, get_current_user, get_client_ip, get_frontend_url,
    require_roles, write_audit, is_account_locked,
    check_and_record_login_attempt,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Per-router limiter — uses the same key_func as the app-level one. Endpoints
# below decorate themselves with @limiter.limit(...) to apply IP-based ceilings.
limiter = Limiter(key_func=get_remote_address)

# Magic-link config
_MAGIC_LINK_TTL_MINUTES = 15
_MAGIC_LINK_PER_EMAIL_HOURLY_CAP = 5


def _user_public(user: dict, super_admin: bool = False) -> UserPublic:
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
        created_at=user.get("created_at", datetime.now(timezone.utc).isoformat()),
        super_admin=bool(super_admin),
    )


async def _resolve_super_admin(user: dict, db) -> bool:
    """Compute the super_admin flag for the SPA's user payload.

    True when EITHER:
      - The user's agency carries super_admin=True (GHW platform team).
      - The user's email is in the SUPER_ADMIN_EMAILS env (Tim/Matt/Chase
        bypass, mirrors deps._is_super_admin).

    Best-effort — any lookup failure returns False rather than raising,
    so an agencies-collection hiccup can't break login. The same
    super_admin claim also rides in the JWT; this helper is purely the
    SPA convenience path so the sidebar can render without decoding
    the cookie.
    """
    try:
        import os as _os_sa
        emails_env = (_os_sa.environ.get("SUPER_ADMIN_EMAILS") or "").strip()
        if emails_env:
            allowlist = {e.strip().lower()
                          for e in emails_env.split(",") if e.strip()}
            email = (user.get("email") or "").strip().lower()
            if email and email in allowlist:
                return True
        from deps import get_agency_id
        agency_id = user.get("agency_id") or get_agency_id()
        agency = await db.agencies.find_one(
            {"agency_id": agency_id},
            {"_id": 0, "super_admin": 1},
        )
        return bool((agency or {}).get("super_admin"))
    except Exception as _e:                                    # noqa: BLE001
        logger.debug("_resolve_super_admin: lookup failed: %s", _e)
        return False


async def _jwt_claims(user: dict, db=None) -> dict:
    """Build the JWT payload.

    Agent identity travels in the token for fast downstream lookups,
    but server code MUST still resolve it from the DB row before
    trusting it for any high-impact action.

    Multi-tenant (Phase 1): when ``db`` is provided we also stamp the
    agency context (agency_id, tier, super_admin, list of enabled
    feature keys) so the SPA can render the navigation without an
    extra round-trip on every page load. The token is still NOT the
    authority — backend deps re-read the agency on every request that
    cares about features or billing.
    """
    claims = {
        "sub": user["id"],
        "email": user["email"],
        "role": user["role"],
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

    # Multi-tenant claims. Best-effort: an agency lookup failure here
    # must not block login — the user gets a JWT without agency context
    # and the backend re-resolves on the next request via deps.get_agency.
    if db is not None:
        try:
            from deps import get_agency_id as _default_agency_id
            agency_id = user.get("agency_id") or _default_agency_id()
            claims["agency_id"] = agency_id
            agency = await db.agencies.find_one(
                {"agency_id": agency_id}, {"_id": 0},
            )
            if agency:
                claims["agency_tier"] = agency.get("tier")
                claims["super_admin"] = bool(agency.get("super_admin"))
                # Compact list of enabled feature keys — much smaller
                # than the full dict, and the SPA only needs the truthy
                # set anyway.
                feats = agency.get("features") or {}
                claims["features"] = sorted(
                    k for k, v in feats.items() if v
                )
        except Exception:
            # Logged at debug level — login should never fail because
            # of a JWT enrichment hiccup.
            logger.debug(
                "jwt_claims: agency enrichment skipped for user_id=%s",
                user.get("id"),
            )
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
    # Auto-activate on register. The invite token is itself the
    # admin's approval gate — once a user redeems a valid token they
    # can sign in immediately.
    # Carry parent_agent_id from the invite when present — admin set
    # this so the registering team member starts inside the parent's
    # scope on first sign-in. Only honour it for roles that are
    # eligible to be team members; for other roles silently drop it.
    invite_parent_id = invite.get("parent_agent_id")
    parent_agent_id_to_stamp = (
        invite_parent_id
        if invite_parent_id and assigned_role in ("va", "agent")
        else None
    )

    user_doc = {
        "id": new_user_id,
        "agent_id": new_user_id,
        "email": email,
        "full_name": full_name,
        "role": assigned_role,
        "is_active": True,
        "status": "active",
        "agency_name": body.agency_name.strip(),
        "agent_name": full_name,
        "agent_npn": agent_npn,
        # Passive multi-tenant stamp — see deps.get_agency_id.
        "agency_id": get_agency_id(),
        "parent_agent_id": parent_agent_id_to_stamp,
        "hashed_password": hash_password(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(user_doc)
    await write_audit(db, "agent_registered", actor_email=email,
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

    logger.info(
        "[notification] Agent registered via invite: %s (%s) — agency=%s.",
        user_doc["full_name"], email, user_doc["agency_name"],
    )
    sa = await _resolve_super_admin(user_doc, db)
    return _user_public(user_doc, super_admin=sa)


@router.post("/login")
@limiter.limit("10/minute")
async def login(payload: LoginRequest, request: Request, response: Response,
                db: AsyncIOMotorDatabase = Depends(get_db)):
    """Password login (Option B). The other path is magic-link below.

    Magic link is the agency's primary second factor — possession of
    the registered inbox stands in for the old TOTP enrollment. Email
    + password is kept as an alternative when the user prefers it.
    Either path issues a full session cookie immediately."""
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
            # Hardening 4: best-effort admin notification on every
            # fresh lockout transition. Never raises — a Resend
            # outage shouldn't change the auth response shape.
            try:
                await _notify_admin_account_locked(
                    email, attempt_result, request,
                )
            except Exception:  # noqa: BLE001
                pass
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
        raise HTTPException(
            status_code=401,
            detail=(
                "Your account has been deactivated. "
                "Contact your administrator."
            ),
        )

    # MFA gate. If the user has TOTP enabled we DON'T issue the real
    # JWT yet — mint a 5-minute single-use session token and require
    # the client to complete the challenge at POST /auth/mfa/verify.
    # Existing tests don't enable MFA on the seeded admin, so the
    # legacy "password → JWT" flow continues to work unchanged.
    if user.get("mfa_enabled"):
        from mfa import create_pending_session
        session_token, expires_at = await create_pending_session(db, user["id"])
        await check_and_record_login_attempt(db, email, success=True)
        await write_audit(
            db, "mfa_challenge_required",
            actor_email=user["email"], actor_id=user["id"],
            request=request, metadata={"method": "password"},
        )
        # Don't plant the access cookie — that comes after MFA verifies.
        return {
            "mfa_required": True,
            "session_token": session_token,
            "expires_at": expires_at.isoformat(),
        }

    token = create_access_token(await _jwt_claims(user, db=db))
    await check_and_record_login_attempt(db, email, success=True)
    await write_audit(db, "login_success", actor_email=user["email"],
                      actor_id=user["id"], request=request,
                      metadata={"method": "password"})
    _set_session_cookies(response, token)
    sa = await _resolve_super_admin(user, db)
    return LoginResponse(access_token=token,
                          user=_user_public(user, super_admin=sa))


# ── Magic link (Option A) ──────────────────────────────────────────────────

class MagicLinkRequest(BaseModel):
    email: EmailStr


class MagicLinkVerifyRequest(BaseModel):
    token: str


def _magic_link_generic_response() -> dict:
    """One response shape regardless of whether the email exists, was
    rate-limited, or the send succeeded. Never leaks the existence of
    an account — see comment in request_magic_link."""
    return {
        "message": "If that email is registered, a login link has been sent.",
    }


@router.post("/magic-link")
@limiter.limit("20/hour")  # IP-based ceiling — per-email cap applied below
async def request_magic_link(
    payload: MagicLinkRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Issue a single-use, 15-minute magic link to the email if it
    matches an active user.

    Always returns the same body whether the email exists or not, so
    an attacker can't enumerate accounts. The per-email hourly cap is
    enforced silently for the same reason — when the cap is hit we
    simply skip the send and return success.
    """
    email = (payload.email or "").lower().strip()
    user = await db.users.find_one({"email": email}, {"_id": 0})

    if not user:
        await write_audit(db, "magic_link_requested", actor_email=email,
                          request=request,
                          metadata={"sent": False, "reason": "unknown_email"})
        return _magic_link_generic_response()

    # Per-email rate limit (5/hour). Count rows we've already minted for
    # this email in the last hour. Silently no-op when over the cap so
    # the response shape is indistinguishable from the unknown-email
    # branch — no enumeration signal.
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=1)
    recent = await db.magic_link_tokens.count_documents({
        "email": email,
        "created_at": {"$gte": window_start},
    })
    if recent >= _MAGIC_LINK_PER_EMAIL_HOURLY_CAP:
        await write_audit(db, "magic_link_requested", actor_email=email,
                          actor_id=user.get("id"), request=request,
                          metadata={"sent": False, "reason": "rate_limited"})
        return _magic_link_generic_response()

    # Refuse for accounts that can't sign in anyway — keeps the link
    # from being a back-door past the pending/rejected/deactivated
    # gates the password path enforces. Same opaque response.
    status_value = user.get("status", "active")
    if status_value in ("pending", "rejected") or not user.get("is_active", True):
        await write_audit(db, "magic_link_requested", actor_email=email,
                          actor_id=user.get("id"), request=request,
                          metadata={"sent": False,
                                    "reason": f"status_{status_value}_active_"
                                              f"{user.get('is_active', True)}"})
        return _magic_link_generic_response()

    # Mint the token. Store ONLY the SHA-256 hash so a DB dump can't
    # be replayed to log in as the user — the raw token only ever
    # exists in the email link.
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    expires_at = now + timedelta(minutes=_MAGIC_LINK_TTL_MINUTES)

    await db.magic_link_tokens.insert_one({
        "token_hash": token_hash,
        "email": email,
        "user_id": user["id"],
        "created_at": now,
        "expires_at": expires_at,
        "used": False,
        "used_at": None,
        "ip": get_client_ip(request),
    })

    magic_url = f"{get_frontend_url()}/auth/magic?token={raw_token}"

    # Fire the email — never-throw inside the service.
    from email_service import send_magic_link_email
    await send_magic_link_email(
        db,
        to_email=email,
        full_name=user.get("full_name"),
        magic_url=magic_url,
        expires_at=expires_at,
    )

    await write_audit(db, "magic_link_requested", actor_email=email,
                      actor_id=user["id"], request=request,
                      metadata={"sent": True, "expires_at": expires_at.isoformat()})

    return _magic_link_generic_response()


@router.post("/magic-link/verify", response_model=LoginResponse)
@limiter.limit("10/hour")
async def verify_magic_link(
    payload: MagicLinkVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Redeem a magic-link token for a full session cookie.

    Single-use: marks ``used=true`` atomically so re-posting the same
    token returns 400. Expiry is checked against the BSON Date stored
    at mint time (15 minutes). The same opaque error covers all the
    invalid-token branches so a caller can't distinguish "expired" from
    "wrong token" from "already used".
    """
    if not payload.token:
        raise HTTPException(400, "This link is invalid or has expired.")

    token_hash = hashlib.sha256(payload.token.encode()).hexdigest()
    now = datetime.now(timezone.utc)
    rec = await db.magic_link_tokens.find_one({
        "token_hash": token_hash,
        "used": False,
        "expires_at": {"$gt": now},
    }, {"_id": 0})
    if not rec:
        await write_audit(db, "magic_link_verify_failed",
                          request=request,
                          metadata={"reason": "invalid_or_expired"})
        raise HTTPException(400, "This link is invalid or has expired.")

    # Single-use: mark as used BEFORE issuing the session so a race that
    # double-submits the same token can't yield two sessions.
    flip = await db.magic_link_tokens.update_one(
        {"token_hash": token_hash, "used": False},
        {"$set": {"used": True, "used_at": now}},
    )
    if flip.modified_count != 1:
        await write_audit(db, "magic_link_verify_failed",
                          request=request,
                          metadata={"reason": "race_already_used"})
        raise HTTPException(400, "This link is invalid or has expired.")

    user = await db.users.find_one({"id": rec["user_id"]}, {"_id": 0})
    if not user:
        await write_audit(db, "magic_link_verify_failed",
                          request=request,
                          metadata={"reason": "user_missing"})
        raise HTTPException(400, "This link is invalid or has expired.")

    status_value = user.get("status", "active")
    if status_value in ("pending", "rejected") or not user.get("is_active", True):
        await write_audit(db, "magic_link_verify_failed",
                          actor_email=user.get("email"), actor_id=user.get("id"),
                          request=request,
                          metadata={"reason": f"status_{status_value}_active_"
                                              f"{user.get('is_active', True)}"})
        raise HTTPException(400, "This link is invalid or has expired.")

    # Clear any failed-login lockout counters — the magic link is
    # proof of inbox control, equivalent to a fresh password reset.
    await check_and_record_login_attempt(db, user["email"], success=True)

    token = create_access_token(await _jwt_claims(user, db=db))
    _set_session_cookies(response, token)

    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"last_login_at": now.isoformat()}},
    )
    await write_audit(db, "magic_link_used", actor_email=user["email"],
                      actor_id=user["id"], request=request,
                      metadata={"ip": get_client_ip(request)})
    await write_audit(db, "login_success", actor_email=user["email"],
                      actor_id=user["id"], request=request,
                      metadata={"method": "magic_link"})

    sa = await _resolve_super_admin(user, db)
    return LoginResponse(access_token=token,
                          user=_user_public(user, super_admin=sa))


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
async def me(
    current_user=Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    sa = await _resolve_super_admin(current_user, db)
    return _user_public(current_user, super_admin=sa)


@router.get("/me/parent")
async def my_parent_agent(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Resolve the team member's parent agent into a name the SPA can
    show in the persistent "Working in: …'s workspace" banner.

    Returns ``{"parent": null}`` when the caller isn't a team member
    (no parent_agent_id) or the parent row has been deleted. Never
    leaks any field beyond id / full_name / agent_name / email — the
    banner doesn't need anything else, and exposing role / status here
    would be a small privilege leak."""
    parent_id = current_user.get("parent_agent_id")
    if not parent_id:
        return {"parent": None}
    parent = await db.users.find_one(
        {"id": parent_id},
        {"_id": 0, "id": 1, "full_name": 1, "agent_name": 1, "email": 1},
    )
    if not parent:
        return {"parent": None}
    return {"parent": {
        "id": parent["id"],
        "full_name": parent.get("full_name"),
        "agent_name": parent.get("agent_name"),
        "email": parent.get("email"),
    }}


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
        # parent_agent_id carried from the invite to register so the
        # new user is auto-stamped into the parent's scope on first
        # sign-in. None means "stand-alone account", same as before.
        "parent_agent_id": invite.parent_agent_id,
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


# ── MFA (TOTP) ────────────────────────────────────────────────────────────
# Per-user opt-in TOTP. Setup mints a fresh secret and returns the
# otpauth:// URI for QR rendering; the user must then submit a valid
# code through /mfa/verify-setup to flip mfa_enabled=True. Backup
# codes are shown ONCE at successful setup — the agent must save them.

from pydantic import BaseModel as _MfaBaseModel  # local alias
from mfa import (
    generate_totp_secret as _gen_secret,
    encrypt_secret as _enc_secret,
    decrypt_secret as _dec_secret,
    build_otpauth_uri as _otpauth_uri,
    verify_totp as _verify_totp,
    generate_backup_codes as _gen_backup_codes,
    store_backup_codes as _store_backup_codes,
    consume_backup_code as _consume_backup_code,
    backup_codes_remaining as _backup_codes_remaining,
    redeem_pending_session as _redeem_pending,
    is_mfa_locked as _is_mfa_locked,
    record_mfa_attempt as _record_mfa_attempt,
)


class MfaSetupResponse(_MfaBaseModel):
    secret: str
    qr_code_url: str


class MfaVerifySetupRequest(_MfaBaseModel):
    totp_code: str


class MfaVerifyRequest(_MfaBaseModel):
    session_token: str
    totp_code: str


class MfaBackupRequest(_MfaBaseModel):
    session_token: str
    backup_code: str


class MfaDisableRequest(_MfaBaseModel):
    current_password: str
    totp_code: str


@router.post("/mfa/setup", response_model=MfaSetupResponse)
@limiter.limit("5/hour")
async def mfa_setup(
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Mint a new TOTP secret. Stored encrypted-at-rest but mfa_enabled
    stays False until the user proves they've successfully provisioned
    the authenticator via /mfa/verify-setup."""
    try:
        secret = _gen_secret()
        encrypted = _enc_secret(secret)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))

    await db.users.update_one(
        {"id": current_user["id"]},
        {"$set": {"mfa_secret": encrypted}},
    )
    uri = _otpauth_uri(secret, current_user["email"])
    await write_audit(
        db, "mfa_setup_started",
        actor_email=current_user["email"], actor_id=current_user["id"],
        target_type="user", target_id=current_user["id"],
        request=request,
    )
    return MfaSetupResponse(secret=secret, qr_code_url=uri)


@router.post("/mfa/verify-setup")
@limiter.limit("10/hour")
async def mfa_verify_setup(
    payload: MfaVerifySetupRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    fresh = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not fresh or not fresh.get("mfa_secret"):
        raise HTTPException(status_code=400,
                            detail="MFA setup not started. Call /mfa/setup first.")
    try:
        secret = _dec_secret(fresh["mfa_secret"])
    except Exception:
        raise HTTPException(status_code=500,
                            detail="MFA secret could not be read.")
    if not _verify_totp(secret, payload.totp_code):
        await write_audit(
            db, "mfa_setup_verify_failed",
            actor_email=current_user["email"], actor_id=current_user["id"],
            target_type="user", target_id=current_user["id"],
            request=request,
        )
        raise HTTPException(status_code=401, detail="Invalid code. Try again.")

    backup_codes = _gen_backup_codes()
    await _store_backup_codes(db, current_user["id"], backup_codes)
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": current_user["id"]},
        {"$set": {"mfa_enabled": True, "mfa_verified_at": now_iso}},
    )
    await write_audit(
        db, "mfa_enabled",
        actor_email=current_user["email"], actor_id=current_user["id"],
        target_type="user", target_id=current_user["id"],
        request=request,
    )
    return {"success": True, "backup_codes": backup_codes}


async def _issue_session_post_mfa(
    db, user: dict, response: Response, request: Request, method: str,
):
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user["id"]}, {"$set": {"mfa_verified_at": now_iso}},
    )
    fresh = await db.users.find_one({"id": user["id"]}, {"_id": 0}) or user
    token = create_access_token(await _jwt_claims(fresh, db=db))
    _set_session_cookies(response, token)
    await write_audit(
        db, "mfa_challenge_success",
        actor_email=fresh["email"], actor_id=fresh["id"],
        target_type="user", target_id=fresh["id"],
        request=request, metadata={"method": method},
    )
    await write_audit(
        db, "login_success",
        actor_email=fresh["email"], actor_id=fresh["id"],
        request=request, metadata={"method": f"password+{method}"},
    )
    sa = await _resolve_super_admin(fresh, db)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": _user_public(fresh, super_admin=sa).model_dump(),
    }


@router.post("/mfa/verify")
@limiter.limit("20/hour")
async def mfa_verify(
    payload: MfaVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    user_id = await _redeem_pending(db, payload.session_token)
    if not user_id:
        await write_audit(
            db, "mfa_challenge_failed", request=request,
            metadata={"reason": "session_token_invalid"},
        )
        raise HTTPException(status_code=401,
                            detail="Login session expired. Please sign in again.")
    if await _is_mfa_locked(db, user_id):
        raise HTTPException(status_code=429,
                            detail="Too many failed codes. Try again later.")
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user or not user.get("mfa_enabled") or not user.get("mfa_secret"):
        raise HTTPException(status_code=400, detail="MFA not configured.")
    try:
        secret = _dec_secret(user["mfa_secret"])
    except Exception:
        raise HTTPException(status_code=500,
                            detail="MFA secret could not be read.")
    if not _verify_totp(secret, payload.totp_code):
        attempt = await _record_mfa_attempt(db, user_id, success=False)
        await write_audit(
            db, "mfa_challenge_failed",
            actor_email=user["email"], actor_id=user["id"],
            target_type="user", target_id=user["id"],
            request=request, metadata={"reason": "wrong_code",
                                        "count": attempt["count"]},
        )
        if attempt.get("locked"):
            raise HTTPException(status_code=429,
                                detail="Too many failed codes. Try again in 15 minutes.")
        raise HTTPException(status_code=401, detail="Invalid code. Try again.")
    await _record_mfa_attempt(db, user_id, success=True)
    return await _issue_session_post_mfa(db, user, response, request, "totp")


@router.post("/mfa/backup-code")
@limiter.limit("10/hour")
async def mfa_backup(
    payload: MfaBackupRequest,
    request: Request,
    response: Response,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    user_id = await _redeem_pending(db, payload.session_token)
    if not user_id:
        raise HTTPException(status_code=401,
                            detail="Login session expired. Please sign in again.")
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    ok = await _consume_backup_code(db, user_id, payload.backup_code)
    if not ok:
        await _record_mfa_attempt(db, user_id, success=False)
        await write_audit(
            db, "mfa_challenge_failed",
            actor_email=user["email"], actor_id=user["id"],
            target_type="user", target_id=user["id"],
            request=request, metadata={"reason": "invalid_backup_code"},
        )
        raise HTTPException(status_code=401, detail="Invalid backup code.")
    await _record_mfa_attempt(db, user_id, success=True)
    return await _issue_session_post_mfa(db, user, response, request, "backup_code")


@router.post("/mfa/disable")
@limiter.limit("5/hour")
async def mfa_disable(
    payload: MfaDisableRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    fresh = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not fresh:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(payload.current_password, fresh["hashed_password"]):
        raise HTTPException(status_code=401, detail="Current password incorrect")
    if not fresh.get("mfa_enabled"):
        return {"success": True, "mfa_enabled": False}
    try:
        secret = _dec_secret(fresh.get("mfa_secret") or "")
    except Exception:
        secret = ""
    if not _verify_totp(secret, payload.totp_code):
        raise HTTPException(status_code=401, detail="Invalid TOTP code.")
    await db.users.update_one(
        {"id": fresh["id"]},
        {"$set": {"mfa_enabled": False, "mfa_secret": None,
                  "mfa_verified_at": None}},
    )
    await db.mfa_backup_codes.delete_many({"user_id": fresh["id"]})
    await write_audit(
        db, "mfa_disabled",
        actor_email=fresh["email"], actor_id=fresh["id"],
        target_type="user", target_id=fresh["id"],
        request=request,
    )
    return {"success": True, "mfa_enabled": False}


@router.get("/mfa/status")
async def mfa_status(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    fresh = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    remaining = await _backup_codes_remaining(db, current_user["id"]) if fresh else 0
    return {
        "mfa_enabled": bool(fresh and fresh.get("mfa_enabled")),
        "mfa_verified_at": fresh.get("mfa_verified_at") if fresh else None,
        "backup_codes_remaining": remaining,
    }


# ── Session refresh (idle-timeout extension) ─────────────────────────────
@router.post("/refresh")
@limiter.limit("10/minute")
async def refresh_session(
    request: Request,
    response: Response,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Issue a new JWT whose ``idle_exp`` is bumped back to now+30m.

    Fired by the SPA's activity tracker every ~20 minutes of detected
    user activity. The absolute ``exp`` is NOT extended past the
    JWT_EXPIRES_MINUTES window — once the original token times out
    on its absolute clock, refresh refuses (the request fails the
    get_current_user gate before reaching here).
    """
    fresh = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not fresh:
        raise HTTPException(status_code=401, detail="Session expired")
    token = create_access_token(await _jwt_claims(fresh, db=db))
    _set_session_cookies(response, token)
    await write_audit(
        db, "session_refresh",
        actor_email=fresh.get("email"), actor_id=fresh.get("id"),
        target_type="user", target_id=fresh.get("id"),
        request=request,
    )
    return {"access_token": token, "token_type": "bearer"}
