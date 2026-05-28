"""FastAPI dependencies: DB, current user, RBAC."""
import os
from typing import Optional, List
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from datetime import datetime, timezone

from security import decode_token  # noqa: F401 — used by get_current_user + get_optional_user
from encryption import safe_lead_load


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


# ═══════════════════════════════════════════════════════
# COLLECTION ARCHITECTURE — READ BEFORE ADDING COLLECTIONS
# ═══════════════════════════════════════════════════════
# leads      — Medicare beneficiary CRM records. One doc per prospect.
#              Keyed on agent_id + GHL contact sync. Owns: lead status,
#              enrollment pipeline, TCPA consent, source attribution.
#              DO NOT store application/policy data here.
#
# clients    — GHL contact persistence layer. One doc per GHL contact,
#              upserted on ghl_contact_id. Written by application_router
#              at submission time. DO NOT merge with leads.
#
# policies   — Application submission history. One doc per submitted
#              application. Insert-only (never updated after write).
#              Keyed on application_id. Owns: carrier, plan, premium,
#              effective date, and any ACH/banking fields.
#
# RULE: If you are unsure which collection a field belongs to —
#       leads = WHO the client is (CRM)
#       clients = GHL sync record (integration layer)
#       policies = WHAT they bought (transaction record)
# ═══════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════
# TWO MOTOR CLIENTS — DEFAULT vs PHI
# ═══════════════════════════════════════════════════════
# default_client — connection pool used by every router that does NOT
#                  touch the `leads` collection. readPreference is
#                  primaryPreferred so non-PHI list endpoints can use
#                  secondary capacity when the primary is under load.
#
# phi_client     — connection pool used by every router/route that
#                  reads or writes `leads`. readPreference is primary
#                  so PHI reads never come from a (possibly stale)
#                  secondary — a compliance posture statement, not a
#                  correctness statement (ciphertext is ciphertext
#                  whether stale or fresh).
#
# Both clients share write concern (w=majority, journal=True),
# readConcernLevel=majority, and identical connection-pool settings.
# Only readPreference differs.
#
# Pick the right Depends in each route:
#     Depends(get_db)      → no leads access in the route body
#     Depends(get_phi_db)  → ANY db.leads.* access in the route body
# ═══════════════════════════════════════════════════════
_default_client: Optional[AsyncIOMotorClient] = None
_phi_client: Optional[AsyncIOMotorClient] = None


def _build_client(read_preference: str) -> AsyncIOMotorClient:
    return AsyncIOMotorClient(
        os.environ["MONGO_URL"],
        w="majority",
        journal=True,
        readConcernLevel="majority",
        readPreference=read_preference,
        maxPoolSize=100,
        minPoolSize=5,
        waitQueueTimeoutMS=5000,
        maxIdleTimeMS=60000,
        serverSelectionTimeoutMS=5000,
        connectTimeoutMS=10000,
    )


def get_mongo_client() -> AsyncIOMotorClient:
    """Default (non-PHI) Motor client. Kept for back-compat with scripts
    and the legacy single-client call sites."""
    global _default_client
    if _default_client is None:
        _default_client = _build_client("primaryPreferred")
    return _default_client


def get_phi_mongo_client() -> AsyncIOMotorClient:
    """PHI Motor client — primary-only reads."""
    global _phi_client
    if _phi_client is None:
        _phi_client = _build_client("primary")
    return _phi_client


def get_db() -> AsyncIOMotorDatabase:
    return get_mongo_client()[os.environ["DB_NAME"]]


def get_phi_db() -> AsyncIOMotorDatabase:
    return get_phi_mongo_client()[os.environ["DB_NAME"]]


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

    # Hardening 2: idle-timeout enforcement. The SPA refreshes via
    # /auth/refresh on activity; tokens missing `idle_exp` (legacy /
    # tests not minting through the new path) skip this gate. Absolute
    # `exp` is still enforced by jwt.decode above.
    idle_exp = payload.get("idle_exp")
    if idle_exp:
        try:
            idle_exp_ts = int(idle_exp)
        except (TypeError, ValueError):
            idle_exp_ts = 0
        if idle_exp_ts and datetime.now(timezone.utc).timestamp() > idle_exp_ts:
            raise HTTPException(
                status_code=401,
                detail="Session expired due to inactivity",
            )

    # Stash the JWT's jti so write_audit can stamp a session_id
    # without re-parsing the token. Lives on request.state for the
    # duration of this request only.
    jti = payload.get("jti")
    if jti and hasattr(request, "state"):
        request.state.session_id = jti

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
    "owner",
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
    "owner",
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
        ld = safe_lead_load(await db.leads.find_one({**scope, "id": pid}, proj))
        if ld:
            return ld["id"]
    gcid = policy.get("ghl_contact_id")
    if gcid:
        ld = safe_lead_load(await db.leads.find_one({**scope, "ghl_contact_id": gcid}, proj))
        if ld:
            return ld["id"]
    cn = policy.get("contact_name")
    if cn and isinstance(cn, str):
        parts = cn.strip().rsplit(" ", 1)
        if len(parts) == 2:
            fn, ln = parts
            ld = safe_lead_load(await db.leads.find_one(
                {**scope, "first_name": fn, "last_name": ln}, proj,
            ))
            if ld:
                return ld["id"]
    return None


def agent_filter(current_user: dict,
                 override_agent_id: Optional[str] = None) -> dict:
    """Build a Mongo filter that scopes results to one agent's data.

    - **Team members** (``parent_agent_id`` set) are scoped to the
      parent agent's id. Checked FIRST so a team member can never
      escape their parent's scope by virtue of their own role.
      ``override_agent_id`` is silently ignored — a team-member VA
      can't widen scope via a forged header.
    - Admin / compliance roles see everything by default (empty filter). If
      they pass ``override_agent_id`` (e.g. via the X-Agent-ID impersonation
      header), the filter narrows to that agent.
    - Everyone else (agents) is pinned to their own ``agent_id`` — the
      ``override_agent_id`` argument is silently ignored for non-privileged
      roles so an attacker can't widen their scope.

    Pair with ``get_effective_agent`` (which does the impersonation check
    centrally) when you want both behaviors driven by the same header.
    """
    parent_id = current_user.get("parent_agent_id")
    if parent_id:
        return {"agent_id": parent_id}
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

    Resolution order:
      1. **Team member** (``current_user.parent_agent_id`` set) →
         returns the parent agent's DB row. The team member never
         impersonates anyone else — they ARE the parent for write
         purposes. The returned dict carries ``_impersonated_by`` /
         ``_impersonated_by_id`` set to the team member, so audit
         logs still record who actually fired the request.
      2. **Privileged role + X-Agent-ID header** → returns the named
         agent's row (admin/owner/compliance/coach/accounting only).
      3. **Otherwise** → returns ``current_user`` unchanged.

    The X-Agent-ID header is silently ignored for team members so a
    leaked header can't widen scope past the parent.
    """
    parent_id = current_user.get("parent_agent_id")
    if parent_id:
        parent = await db.users.find_one({"id": parent_id}, {"_id": 0})
        if not parent:
            # Parent removed out from under the team member. Fail
            # closed — refuse the request rather than silently fall
            # back to the team member's own (probably empty) scope.
            raise HTTPException(
                403,
                "Your parent agent account is no longer accessible. "
                "Contact your administrator.",
            )
        parent["_impersonated_by"] = current_user.get("email")
        parent["_impersonated_by_id"] = current_user.get("id")
        return parent

    target_id = request.headers.get("X-Agent-ID", "")
    if not target_id:
        return current_user
    # Case-insensitive membership check. A legacy row in production
    # had role="Admin" (capitalised), which silently fell out of the
    # tuple match and produced a misleading "Only admins can
    # impersonate agents" 403 for an actual admin. Normalise both
    # sides before comparing — mirrors the fix in
    # cna_router._is_privileged.
    role = (current_user.get("role") or "agent").strip().lower()
    allowed = {r.lower() for r in IMPERSONATION_ROLES}
    if role not in allowed:
        raise HTTPException(403, "Only admins can impersonate agents")
    target = await db.users.find_one({"id": target_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "Agent not found")
    target["_impersonated_by"] = current_user.get("email")
    target["_impersonated_by_id"] = current_user.get("id")
    return target


async def get_agent_team_members(db, agent_id: str) -> list:
    """Return all users whose ``parent_agent_id`` is ``agent_id``.

    Projection mirrors the /agents list view so the caller can render
    the rows directly without a second lookup. Sorted oldest-first by
    created_at so the team list stays stable as members are added /
    removed.
    """
    cursor = db["users"].find(
        {"parent_agent_id": agent_id},
        {
            "_id": 0,
            "id": 1,
            "full_name": 1,
            "email": 1,
            "agent_name": 1,
            "role": 1,
            "is_active": 1,
            "status": 1,
            "parent_agent_id": 1,
            "created_at": 1,
        },
    ).sort("created_at", 1)
    return await cursor.to_list(length=None)


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
    # Best-effort session_id pull from the request scope. The
    # get_current_user dependency stashes the JWT jti onto
    # request.state.session_id during auth — we read it back here so
    # every audit row written within an authenticated request can be
    # correlated to a single login session. None when called outside
    # an authenticated context (public endpoints, automations).
    session_id = None
    if request is not None:
        session_id = getattr(getattr(request, "state", None),
                              "session_id", None)
    doc = {
        "id": str(uuid.uuid4()),
        "event_type": event_type,
        "actor_email": actor_email,
        "actor_id": actor_id,
        "target_type": target_type,
        "target_id": target_id,
        "ip_address": get_client_ip(request) if request else None,
        # user_agent capped at 200 chars — some embedded clients ship
        # multi-kilobyte UA strings that bloat the audit_logs collection.
        "user_agent": (
            (request.headers.get("user-agent") or "")[:200] or None
        ) if request else None,
        "session_id": session_id,
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


# ═══════════════════════════════════════════════════════════════════════
# MULTI-TENANT FOUNDATION (Phase 1)
# ═══════════════════════════════════════════════════════════════════════
# Five new dependencies layered on top of the existing auth chain:
#
#   require_super_admin   → 403 unless caller is a platform admin
#   get_agency            → fetch agency row (cached on request.state)
#   require_feature(key)  → 403 unless agency.features[key] is True
#   require_billing_active → 402 unless billing_status in {trialing, active}
#   check_seat_available  → 402 unless agency.seats_active < seats_max
#
# Caching:
#   The agency row is looked up at most once per request — cached on
#   request.state.agency. Repeat calls (e.g. require_feature followed
#   by require_billing_active) hit the cache.
#
# super_admin bypass:
#   Users on the GHW (super_admin=True) agency, OR users whose email
#   is listed in SUPER_ADMIN_EMAILS env var, bypass every feature flag
#   and billing gate. Seat checks STILL apply to keep the seat counter
#   honest even for platform owners.
# ═══════════════════════════════════════════════════════════════════════


def _super_admin_emails() -> set:
    raw = (os.environ.get("SUPER_ADMIN_EMAILS") or "").strip()
    if not raw:
        return set()
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


async def get_agency(
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """Resolve the caller's agency record.

    Lookup order:
      1. request.state.agency (already-fetched on this request)
      2. db.agencies by current_user.agency_id
      3. db.agencies by agency_id="ghw_001" (legacy fallback —
         pre-multi-tenant users with no agency_id stamp)
      4. 500 if even ghw_001 is missing (means migration never ran).

    Returns the raw dict from Mongo (with _id removed). Routers that
    need the typed shape can hydrate with ``Agency.model_validate``.
    """
    cached = getattr(getattr(request, "state", None), "agency", None)
    if cached:
        return cached

    aid = current_user.get("agency_id") or get_agency_id()
    agency = await db.agencies.find_one({"agency_id": aid}, {"_id": 0})
    if not agency:
        # Legacy fallback: every pre-multi-tenant user belongs to GHW.
        # If even the GHW row is missing, the seed never ran — fail
        # loud so the operator notices, but with a 500 not a 401 so
        # we don't blame the user.
        if aid != get_agency_id():
            agency = await db.agencies.find_one(
                {"agency_id": get_agency_id()}, {"_id": 0},
            )
        if not agency:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Agency record not found. The multi-tenant seed "
                    "may not have run. Contact your administrator."
                ),
            )

    if hasattr(request, "state"):
        request.state.agency = agency
    return agency


def _is_super_admin(user: dict, agency: dict) -> bool:
    """True when this caller bypasses tenant gates."""
    if bool(agency.get("super_admin")):
        return True
    email = (user.get("email") or "").strip().lower()
    return bool(email) and email in _super_admin_emails()


def require_super_admin():
    """FastAPI dependency factory — 403 unless caller is a platform
    super admin (GHW agency OR listed in SUPER_ADMIN_EMAILS).

    Returns the agency dict on success so downstream code can read
    tier/feature info without a second lookup.
    """
    async def _checker(
        request: Request,
        current_user: dict = Depends(get_current_user),
        agency: dict = Depends(get_agency),
    ) -> dict:
        if not _is_super_admin(current_user, agency):
            raise HTTPException(
                status_code=403,
                detail="Super admin access required.",
            )
        return agency
    return _checker


def require_feature(feature_name: str):
    """FastAPI dependency factory — 403 unless the caller's agency has
    the named feature enabled.

    Super admins bypass. The error response includes ``feature`` and
    ``upgrade_url`` so the SPA can render a contextual upsell prompt
    instead of a generic "Forbidden" toast.
    """
    async def _checker(
        request: Request,
        current_user: dict = Depends(get_current_user),
        agency: dict = Depends(get_agency),
    ) -> dict:
        if _is_super_admin(current_user, agency):
            return agency
        features = agency.get("features") or {}
        if not features.get(feature_name):
            front = get_frontend_url()
            raise HTTPException(
                status_code=403,
                detail={
                    "message": (
                        f"Feature '{feature_name}' is not enabled for "
                        "your agency."
                    ),
                    "feature": feature_name,
                    "upgrade_url": f"{front}/settings/billing",
                },
            )
        return agency
    return _checker


def require_billing_active():
    """FastAPI dependency factory — 402 (Payment Required) when the
    agency's billing_status is suspended/cancelled. Trialing + active
    + past_due (in grace period) all still allow writes.

    Super admins bypass. Read endpoints should not depend on this —
    we never block reads on billing state per the "graceful
    degradation" principle.
    """
    async def _checker(
        request: Request,
        current_user: dict = Depends(get_current_user),
        agency: dict = Depends(get_agency),
    ) -> dict:
        if _is_super_admin(current_user, agency):
            return agency
        status = (agency.get("billing_status") or "").lower()
        if status in {"suspended", "cancelled"}:
            front = get_frontend_url()
            raise HTTPException(
                status_code=402,
                detail={
                    "message": (
                        "Your subscription is "
                        f"{status}. Restore billing to continue."
                    ),
                    "billing_status": status,
                    "billing_url": f"{front}/settings/billing",
                },
            )
        return agency
    return _checker


def check_seat_available():
    """FastAPI dependency factory — 402 when the agency is at its seat
    cap. Used on the invite-agent endpoint. seats_max=-1 means
    unlimited (Domination tier).

    seats_active is the authoritative counter; rolled forward by the
    invite + suspend endpoints. The check looks at seats_max (the
    hard ceiling, which may have been raised via add-on purchase),
    NOT seats_included (the plan default).
    """
    async def _checker(
        request: Request,
        current_user: dict = Depends(get_current_user),
        agency: dict = Depends(get_agency),
    ) -> dict:
        seats_max = int(agency.get("seats_max", 0) or 0)
        if seats_max < 0:
            return agency  # unlimited
        seats_active = int(agency.get("seats_active", 0) or 0)
        if seats_active >= seats_max:
            front = get_frontend_url()
            raise HTTPException(
                status_code=402,
                detail={
                    "message": (
                        "Seat limit reached. Upgrade your plan or add "
                        "seats to invite more agents."
                    ),
                    "seats_active": seats_active,
                    "seats_max": seats_max,
                    "upgrade_url": f"{front}/settings/billing",
                },
            )
        return agency
    return _checker


def get_frontend_url() -> str:
    """Single source of truth for the frontend URL.

    All routers must use this — never os.getenv inline. Change the
    customer-facing SPA domain by updating the FRONTEND_URL env var
    on Render only; no code edits.

    Fallback is localhost so a deployed-but-unconfigured instance
    fails loud against a non-prod origin instead of silently using a
    stale hard-coded domain.
    """
    return (
        os.environ.get("FRONTEND_URL", "http://localhost:3000")
        .strip()
        .rstrip("/")
    )
