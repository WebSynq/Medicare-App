"""FastAPI dependencies: DB, current user, RBAC."""
import os
from typing import Optional, List
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from datetime import datetime, timezone

from security import decode_token  # noqa: F401 — used by get_current_user + get_optional_user


# Cookie name for the httpOnly access token. Reading the cookie before the
# Authorization header keeps the header path as a graceful-rollout fallback
# (mobile clients, integration tests, the legacy bundle in flight) but new
# browser sessions will be cookie-driven.
ACCESS_TOKEN_COOKIE = "ghw_access_token"
CSRF_TOKEN_COOKIE = "ghw_csrf_token"
CSRF_HEADER = "X-CSRF-Token"


def _extract_token(request: Request, header_token: Optional[str]) -> Optional[str]:
    """Pull the JWT from the Authorization header first, then the httpOnly
    cookie. The header is an explicit, intentional credential; the cookie
    is sent automatically by the browser. When both are present we honour
    the explicit one — this also lets tests pass admin tokens via header
    without being shadowed by a stale browser cookie from an earlier user.
    Query-string tokens are never honoured (referer / log leakage risk)."""
    if header_token:
        return header_token
    return request.cookies.get(ACCESS_TOKEN_COOKIE)


_mongo_client: Optional[AsyncIOMotorClient] = None


def get_mongo_client() -> AsyncIOMotorClient:
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return _mongo_client


def get_db() -> AsyncIOMotorDatabase:
    return get_mongo_client()[os.environ["DB_NAME"]]


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


async def get_optional_user(
    request: Request,
    header_token: Optional[str] = Depends(oauth2_scheme),
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> Optional[dict]:
    """Returns the current user if authenticated, None if not.

    Reads token from httpOnly cookie first, then Authorization header.
    """
    token = _extract_token(request, header_token)
    if not token:
        return None
    try:
        payload = decode_token(token)
        user = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0})
        if not user:
            return None
        if not user.get("is_active", True):
            return None
        return user
    except Exception:
        return None


async def get_current_user(
    request: Request,
    header_token: Optional[str] = Depends(oauth2_scheme),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    token = _extract_token(request, header_token)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if not user.get("is_active", True):
        # Deactivated accounts get a specific, user-readable message so
        # the SPA can show it on the login redirect rather than the
        # generic "not authenticated" copy.
        raise HTTPException(
            status_code=401,
            detail=(
                "Your account has been deactivated. "
                "Contact your administrator."
            ),
        )

    # token_version invalidation — when an admin resets credentials or
    # the user changes their own password we bump user.token_version,
    # which makes every previously-issued JWT mismatch and 401 here.
    jwt_tv = int(payload.get("tv", 0) or 0)
    user_tv = int(user.get("token_version", 0) or 0)
    if jwt_tv != user_tv:
        raise HTTPException(
            status_code=401,
            detail="Session expired — please sign in again",
        )

    if not payload.get("mfa_verified", False) and user.get("mfa_enabled"):
        raise HTTPException(status_code=401, detail="MFA verification required")

    return user


def require_roles(*roles: str):
    async def _checker(current_user=Depends(get_current_user)):
        if current_user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user
    return _checker


def forbid_roles(*roles: str):
    """Inverse of ``require_roles``: 403s when the caller has one of the
    listed roles, otherwise returns the user. Used to keep support roles
    (e.g. client_success) out of the commission and leaderboard surfaces
    they must never see.
    """
    forbidden = set(roles)

    async def _checker(current_user=Depends(get_current_user)):
        if current_user.get("role") in forbidden:
            raise HTTPException(status_code=403, detail="Not authorized for this resource")
        return current_user

    return _checker


# Role groups. Use these constants when gating an endpoint so the
# expanded team roles (cyber_security, sales_manager, etc.) inherit
# the same access we already grant compliance — extending the list
# here updates every callsite without a hunt across routers.
COMPLIANCE_ROLES = (
    "admin",
    "compliance",
    "cyber_security",
    "sales_manager",
)

# Roles that see the full agency's lead/client data, not just their own.
# admin/compliance are agency leadership; client_success is support staff
# who needs visibility across every agent's book to help clients;
# coach mentors agents on performance and pipeline; accounting reconciles
# commissions across the agency.
FULL_AGENCY_SCOPE_ROLES = (
    "admin",
    "compliance",
    "client_success",
    "coach",
    "accounting",
)

# Roles that may impersonate an individual agent via X-Agent-ID. Wider
# than the leadership pair because coach/accounting also need to "view
# as" a specific agent when reviewing performance or commissions.
# client_success is intentionally excluded — they have full-scope read
# already and impersonation would mostly cause confusion.
IMPERSONATION_ROLES = (
    "admin",
    "compliance",
    "coach",
    "accounting",
)


def resolve_agent_key(user: dict) -> Optional[str]:
    """Canonical name used to look up an agent's commission/production records.

    Returns ``user.agent_name`` when set, otherwise falls back to
    ``user.full_name`` for legacy users whose ``agent_name`` field hasn't
    been backfilled yet. Returns ``None`` when neither is set so the caller
    can fail closed.

    Use this everywhere a commission endpoint needs to join the
    authenticated user to upstream/production data — ComTrack lookups,
    production_records scoping, leaderboard is_self matching. Keeping the
    rule in one place prevents the per-endpoint drift this helper was
    introduced to eliminate (see CLAUDE.md migration note).
    """
    name = (user.get("agent_name") or "").strip()
    if name:
        return name
    name = (user.get("full_name") or "").strip()
    return name or None


def get_agency_id() -> str:
    """Static tenant id stamped on every new record so we can flip on
    agency-level filtering without a schema rebuild when a second
    agency lands. Read from the AGENCY_ID env var; defaults to
    ``ghw_001`` (Gruening Health & Wealth, the only tenant today).

    Intentionally a passive stamp — no current read path filters on
    this field. Existing records pre-dating this rollout will have
    ``agency_id`` unset on disk and that's fine; the multi-tenant cut
    will backfill them in a one-shot migration.
    """
    return os.getenv("AGENCY_ID", "ghw_001")


async def resolve_lead_id_for_policy(
    db, scope: dict, policy: dict,
) -> Optional[str]:
    """Best-effort join policy → leads.id.

    The policies collection historically stored the GHL contact id (or a
    legacy lead id from a different lifecycle) under ``lead_id`` /
    ``ghl_contact_id``, neither of which matches the canonical
    ``leads.id`` the SPA's /clients/:leadId route expects. Tries, in
    order:

      1. ``leads.id == policy.lead_id``           (already correct)
      2. ``leads.ghl_contact_id == policy.ghl_contact_id``
      3. ``leads.first_name`` + ``last_name`` derived from
         ``policy.contact_name`` (split on the last space).

    All three lookups respect ``scope`` so a stray policy reference
    can't surface a lead outside the caller's book. Returns ``None``
    when nothing matches — callers ship ``lead_id: None`` and the SPA
    hides the View Client button rather than rendering a broken link.

    Lives in ``deps`` so today_router (Today action centre) and
    renewal_router (calendar feed) resolve renewals to the same lead
    ids without one importing internals from the other.
    """
    proj = {"_id": 0, "id": 1}
    pid = policy.get("lead_id")
    if pid:
        ld = await db.leads.find_one({**scope, "id": pid}, proj)
        if ld:
            return ld["id"]
    gcid = policy.get("ghl_contact_id")
    if gcid:
        ld = await db.leads.find_one({**scope, "ghl_contact_id": gcid}, proj)
        if ld:
            return ld["id"]
    cn = policy.get("contact_name")
    if cn and isinstance(cn, str):
        parts = cn.strip().rsplit(" ", 1)
        if len(parts) == 2:
            fn, ln = parts
            ld = await db.leads.find_one(
                {**scope, "first_name": fn, "last_name": ln}, proj,
            )
            if ld:
                return ld["id"]
    return None


def agent_filter(current_user: dict,
                 override_agent_id: Optional[str] = None) -> dict:
    """Build a Mongo filter that scopes results to one agent's data.

    - Admin / compliance roles see everything by default (empty filter). If
      they pass ``override_agent_id`` (e.g. via the X-Agent-ID impersonation
      header), the filter narrows to that agent.
    - Everyone else (agents) is pinned to their own ``agent_id`` — the
      ``override_agent_id`` argument is silently ignored for non-privileged
      roles so an attacker can't widen their scope.

    Pair with ``get_effective_agent`` (which does the impersonation check
    centrally) when you want both behaviors driven by the same header.
    """
    role = current_user.get("role", "agent")
    if role in FULL_AGENCY_SCOPE_ROLES:
        if override_agent_id:
            return {"agent_id": override_agent_id}
        return {}
    return {"agent_id": current_user["id"]}


async def get_effective_agent(
    request: Request,
    current_user=Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """Resolve the user whose data should be returned for this request.

    For agents this is always themselves (header is ignored). For admin /
    compliance, an ``X-Agent-ID`` header swaps the effective user to the
    target agent's DB row so the caller sees that agent's data — useful for
    "view as agent" support and audit-trail debugging.

    The returned dict carries two metadata fields the caller can audit-log:
      - ``_impersonated_by``     — caller's email
      - ``_impersonated_by_id``  — caller's user id
    """
    target_id = request.headers.get("X-Agent-ID", "")
    if not target_id:
        return current_user
    role = current_user.get("role", "agent")
    if role not in IMPERSONATION_ROLES:
        raise HTTPException(403, "Only admins can impersonate agents")
    target = await db.users.find_one({"id": target_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Agent not found")
    target["_impersonated_by"] = current_user.get("email")
    target["_impersonated_by_id"] = current_user.get("id")
    return target


def get_client_ip(request: Request) -> Optional[str]:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else None


async def write_audit(
    db: AsyncIOMotorDatabase,
    event_type: str,
    actor_email: Optional[str] = None,
    actor_id: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    request: Optional[Request] = None,
    metadata: Optional[dict] = None,
):
    import uuid
    doc = {
        "id": str(uuid.uuid4()),
        "event_type": event_type,
        "actor_email": actor_email,
        "actor_id": actor_id,
        "target_type": target_type,
        "target_id": target_id,
        "ip_address": get_client_ip(request) if request else None,
        "user_agent": request.headers.get("user-agent") if request else None,
        "metadata": metadata or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    await db.audit_logs.insert_one(doc)


# ── Brute-force protection ────────────────────────────────────────────────────

async def is_account_locked(db, email: str) -> dict:
    """Check if account is currently locked without recording a new attempt."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    lock_record = await db.login_attempts.find_one({
        "email": email,
        "locked_until": {"$gt": now}
    })
    if lock_record:
        return {"locked": True, "unlock_at": lock_record["locked_until"]}
    return {"locked": False, "unlock_at": None}


async def check_and_record_login_attempt(
    db, email: str, success: bool
) -> dict:
    """
    Track login attempts. Returns:
    {
        "locked": bool,
        "unlock_at": datetime | None,
        "attempts": int
    }
    HIPAA NOTE: We track attempts by email only — no PII stored in this collection.
    """
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=15)
    MAX_ATTEMPTS = 5
    LOCKOUT_MINUTES = 15  # post-pentest: was 30, tightened to match spec

    coll = db.login_attempts

    # Clean up old attempts outside the window first
    await coll.delete_many({
        "email": email,
        "attempted_at": {"$lt": window_start},
        "locked_until": None  # Only clean up non-lockout records
    })

    # Check if currently locked
    lock_record = await coll.find_one({
        "email": email,
        "locked_until": {"$gt": now}
    })
    if lock_record:
        return {
            "locked": True,
            "unlock_at": lock_record["locked_until"],
            "attempts": MAX_ATTEMPTS,
        }

    if success:
        # Clear all attempts on successful login
        await coll.delete_many({"email": email})
        return {"locked": False, "unlock_at": None, "attempts": 0}

    # Record this failed attempt
    await coll.insert_one({
        "email": email,
        "attempted_at": now,
        "locked_until": None,
    })

    # Count recent failed attempts
    recent_count = await coll.count_documents({
        "email": email,
        "attempted_at": {"$gte": window_start},
        "locked_until": None,
    })

    if recent_count >= MAX_ATTEMPTS:
        unlock_at = now + timedelta(minutes=LOCKOUT_MINUTES)
        # Record the lockout
        await coll.insert_one({
            "email": email,
            "attempted_at": now,
            "locked_until": unlock_at,
        })
        return {"locked": True, "unlock_at": unlock_at, "attempts": recent_count}

    return {"locked": False, "unlock_at": None, "attempts": recent_count}
