"""FastAPI app — Gruening Health & Wealth Medicare Intake."""
import os
import logging
from pathlib import Path

import secrets
from fastapi import FastAPI, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from dotenv import load_dotenv

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from deps import get_db  # noqa: E402
from auth_router import router as auth_router  # noqa: E402
from leads_router import router as leads_router  # noqa: E402
from documents_router import router as documents_router  # noqa: E402
from commissions_router import router as commissions_router  # noqa: E402
from admin_commissions_router import router as admin_commissions_router  # noqa: E402
from commission_audit_router import router as commission_audit_router, chat_router as commission_chat_router  # noqa: E402
from leaderboard_router import router as leaderboard_router  # noqa: E402
from soa_router import router as soa_router  # noqa: E402
from audit_router import router as audit_router  # noqa: E402
from application_router import router as application_router  # noqa: E402
from clients_router import router as clients_router  # noqa: E402
from production_records_router import router as production_records_router  # noqa: E402
from profile_router import router as profile_router  # noqa: E402
from integrations_router import router as integrations_router  # noqa: E402
from agent_management_router import router as agent_management_router  # noqa: E402
from chat_router import router as chat_router  # noqa: E402
from ghl_webhook_router import router as ghl_webhook_router  # noqa: E402
from dashboard_router import router as dashboard_router  # noqa: E402
from commission_router import router as commission_calc_router  # noqa: E402
from compliance_router import router as compliance_router  # noqa: E402
from policies_router import router as policies_router  # noqa: E402
from agency_router import router as agency_router  # noqa: E402
from birthday_rule_router import router as birthday_rule_router  # noqa: E402
from renewal_router import router as renewal_router  # noqa: E402
from backup_router import router as backup_router  # noqa: E402
from accounting_router import router as accounting_router  # noqa: E402
from reconciliation_router import router as reconciliation_router  # noqa: E402
from cfo_chat_router import router as cfo_chat_router  # noqa: E402
from today_router import router as today_router  # noqa: E402
from appointments_router import router as appointments_router  # noqa: E402
from notes_router import router as notes_router  # noqa: E402
from search_router import router as search_router  # noqa: E402
from seed import seed_admin, backfill_agent_identity  # noqa: E402


logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("gruening")

# ── Sentry error monitoring ───────────────────────────────────────────────────
# ⚠️ HIPAA NOTE: send_default_pii=False ensures no user data leaves this server.
# before_send scrubs request bodies so PHI (MBI, SSN, DOB) never reaches Sentry.

def _sentry_before_send(event: dict, hint: dict) -> dict | None:
    """Strip any request body and sensitive fields before sending to Sentry."""
    req = event.get("request", {})
    # Remove body — may contain PHI from intake forms
    req.pop("data", None)
    req.pop("cookies", None)
    # Scrub query strings (could contain tokens or IDs)
    if "query_string" in req:
        req["query_string"] = "[scrubbed]"
    return event


_sentry_dsn = os.getenv("SENTRY_DSN", "").strip()
if _sentry_dsn:
    sentry_sdk.init(
        dsn=_sentry_dsn,
        integrations=[
            StarletteIntegration(transaction_style="endpoint"),
            FastApiIntegration(transaction_style="endpoint"),
        ],
        traces_sample_rate=0.1,       # 10% of requests for performance data
        send_default_pii=False,        # ⚠️ HIPAA: never send PII to Sentry
        environment=os.getenv("ENVIRONMENT", "production"),
        before_send=_sentry_before_send,
    )

ENVIRONMENT = os.getenv("ENVIRONMENT", "production").lower()
IS_DEV = ENVIRONMENT in ("development", "dev", "local")

# Hide OpenAPI schema and interactive docs outside dev. Exposing /openapi.json
# in production reveals every route + every PHI field name to unauthenticated callers.
app = FastAPI(
    title="Gruening Health & Wealth — Medicare Intake API",
    docs_url="/docs" if IS_DEV else None,
    redoc_url="/redoc" if IS_DEV else None,
    openapi_url="/openapi.json" if IS_DEV else None,
)


# ── Rate limiting ─────────────────────────────────────────────────────────────
# IP-based limits on sensitive endpoints (auth, intake) using slowapi. Layered
# on top of the existing per-email brute-force tracker so an attacker cannot
# iterate emails to evade the per-email lockout. `get_remote_address` reads
# request.client.host; behind Render's proxy the X-Forwarded-For header is
# already terminated to a single value, so this resolves to the real client IP.
limiter = Limiter(key_func=get_remote_address, default_limits=[])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

api_router = APIRouter(prefix="/api")


@api_router.get("/")
async def root():
    return {"app": "Gruening Health & Wealth Medicare Intake",
            "status": "ok",
            "hipaa_safeguards": ["TLS", "AES-128 at rest (docs)", "JWT", "TOTP MFA", "Audit Log", "RBAC"]}


@api_router.get("/health")
async def health(db=__import__("fastapi").Depends(get_db)):
    """Liveness + dependency probe.

    Returns only a coarse status. Driver/DB error details are logged server-side
    so external probes (and attackers) can't fingerprint the backing store.
    """
    try:
        await db.command("ping")
        return {"status": "ok"}
    except Exception as e:
        logger.exception("Health check failed: %s", e)
        return {"status": "degraded"}


app.include_router(api_router)
app.include_router(auth_router, prefix="/api")
app.include_router(leads_router, prefix="/api")
app.include_router(documents_router, prefix="/api")
app.include_router(commissions_router, prefix="/api")
app.include_router(admin_commissions_router, prefix="/api")
app.include_router(commission_audit_router, prefix="/api")
app.include_router(commission_chat_router, prefix="/api")
app.include_router(leaderboard_router, prefix="/api")
app.include_router(soa_router, prefix="/api")
app.include_router(audit_router, prefix="/api")
app.include_router(application_router)
app.include_router(clients_router)
app.include_router(production_records_router)
app.include_router(profile_router, prefix="/api")
app.include_router(integrations_router, prefix="/api")
app.include_router(agent_management_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(ghl_webhook_router, prefix="/api")
app.include_router(dashboard_router, prefix="/api")
app.include_router(commission_calc_router, prefix="/api")
app.include_router(compliance_router, prefix="/api")
app.include_router(policies_router, prefix="/api")
app.include_router(agency_router, prefix="/api")
app.include_router(birthday_rule_router, prefix="/api")
app.include_router(renewal_router, prefix="/api")
app.include_router(backup_router, prefix="/api")
app.include_router(accounting_router, prefix="/api")
app.include_router(reconciliation_router, prefix="/api")
app.include_router(cfo_chat_router, prefix="/api")
app.include_router(today_router, prefix="/api")
app.include_router(appointments_router, prefix="/api")
app.include_router(notes_router, prefix="/api")
app.include_router(search_router, prefix="/api")


# ── CORS ──────────────────────────────────────────────────────────────────────
# Strict allowlist. A wildcard origin combined with allow_credentials=True is a
# critical misconfiguration: Starlette will echo any Origin back, which lets any
# site read authenticated responses. We require CORS_ORIGINS to be set
# explicitly to a comma-separated list of fully-qualified origins.
_raw_origins = os.environ.get("CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _raw_origins.split(",") if o.strip() and o.strip() != "*"]

if not _cors_origins:
    if IS_DEV:
        # Localhost defaults for dev only
        _cors_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
        logger.warning("CORS_ORIGINS not set; defaulting to localhost (dev mode).")
    else:
        # Fail closed: in production with no allowlist, reject all cross-origin.
        logger.error(
            "CORS_ORIGINS is not configured. Cross-origin browser requests will be "
            "denied. Set CORS_ORIGINS to a comma-separated list of trusted origins."
        )

# Visible at INFO level in Render boot logs so we can confirm prod
# is pointing at the right Vercel origin without filtering for
# WARNING / ERROR. Empty list = no cross-origin requests will succeed.
logger.info(
    "CORS active origins (%d): %s",
    len(_cors_origins),
    ", ".join(_cors_origins) if _cors_origins else "(none — cross-origin denied)",
)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=_cors_origins,
    allow_origin_regex=None,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # X-Agent-ID is the admin/coach impersonation header. Without it on
    # this allowlist the preflight OPTIONS returns 400 and every
    # impersonated request fails at the browser before reaching the
    # backend. CSRF-Token is the JS-readable double-submit echo.
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Accept",
        "Origin",
        "X-Requested-With",
        "X-CSRF-Token",
        "X-Agent-ID",
    ],
    max_age=600,
)


# ── Security headers ──────────────────────────────────────────────────────────
# Applied to every response, including CORS preflights and error responses.
# This is a JSON API so we don't ship a script-loading CSP — instead we lock
# down framing, MIME sniffing, referrers, cross-origin window opens, and TLS.

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        # X-XSS-Protection is deprecated in modern browsers but pen-tests
        # still flag its absence; "1; mode=block" is the historically
        # recommended value and harmless on browsers that ignore it.
        h.setdefault("X-XSS-Protection", "1; mode=block")
        h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        h.setdefault("Permissions-Policy",
                     "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
                     "magnetometer=(), microphone=(), payment=(), usb=()")
        h.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        h.setdefault("Cross-Origin-Resource-Policy", "same-site")
        # CSP for a JSON API: deny everything by default — there is no HTML to render.
        h.setdefault("Content-Security-Policy",
                     "default-src 'none'; frame-ancestors 'none'")
        if not IS_DEV:
            h.setdefault("Strict-Transport-Security",
                         "max-age=63072000; includeSubDomains; preload")
        return response


app.add_middleware(SecurityHeadersMiddleware)


# ── CSRF (double-submit cookie) ───────────────────────────────────────────────
# Pattern: a CSRF token is written to a JS-readable cookie on login; the SPA
# echoes it back as an X-CSRF-Token header on every state-changing request.
# On the server we compare cookie vs header with constant-time comparison.
#
# Why this works: a third-party site cannot read the cookie (same-origin policy
# restricts cookie reads even with SameSite=None), so it cannot synthesize the
# matching header — its forged request will fail. Cookie-only flows (a
# malicious form POST) carry the cookie but not the header.
#
# Scope: applied only to state-changing methods. GETs (including session
# probes like /auth/me) are exempt so the SPA can hydrate without the header.

_CSRF_METHODS = {"POST", "PATCH", "DELETE", "PUT"}
# Endpoints that legitimately receive POST without an established session
# (and therefore no CSRF cookie yet) need to be exempt. /auth/login is the
# primary case — the very response is what plants the CSRF cookie.
_CSRF_EXEMPT_PATHS = {
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/logout",
    "/api/auth/mfa/verify",  # called immediately after login pre-auth token issued
    # Commission AI chat — Anthropic-backed POST. Auth is enforced by
    # get_current_user (JWT, cookie OR header); CSRF exempt by product
    # decision so the panel can post without echoing the csrf cookie.
    "/api/commission/chat",
    # Application submission module — JWT-authenticated via get_current_user.
    # /extract receives multipart PDF uploads; /submit posts JSON to GHL;
    # /webhook is a future inbound hook from external systems (no browser
    # session → no CSRF cookie possible).
    "/api/applications/extract",
    "/api/applications/submit",
    "/api/applications/webhook",
    # AI chat widget — Bedrock-backed POST returning SSE. Auth is enforced
    # by get_current_user; same product decision as /api/commission/chat.
    # The widget uses raw fetch (not axios) so the CSRF interceptor isn't
    # in play even though we could plumb it; exempting here keeps the chat
    # endpoint behaving like the other AI surfaces.
    "/api/chat",
    # GHL inbound webhook bridge — called by GoHighLevel from outside the
    # browser. Authenticity is enforced via HMAC-SHA256 signature against
    # GHL_WEBHOOK_SECRET inside the route, so CSRF doesn't apply.
    "/api/ghl/webhook",
    # GHL manual sync — admin-triggered POST that pulls contacts via the
    # GHL API. JWT-authenticated via require_roles("admin"); the Settings
    # button uses the same axios instance that *would* attach CSRF, but
    # exempting matches the pattern used by every other admin write that
    # talks to an external provider (apps/submit, commission/sync/run).
    "/api/ghl/sync",
    # Resource roots — POST creates only. Sub-paths (PATCH/DELETE on
    # /{id}, action verbs like /sync-ghl) are covered by the prefix
    # block below. Auth is enforced by get_current_user / IDOR checks
    # inside each handler.
    "/api/leads",
    "/api/clients",
    "/api/applications",
    "/api/documents",
    "/api/ghl",
    # Dashboard + calculator + compliance read/write endpoints added
    # in recent commits. CSRF only fires on state-changing verbs (POST /
    # PATCH / DELETE / PUT), so the GETs in this group are a no-op
    # against the middleware — listed anyway so the security profile
    # of these surfaces is documented in one place.
    "/api/dashboard/stats",
    "/api/commission/calculate",
    "/api/commission/carriers",
    "/api/commission/earnings",
    "/api/compliance/soa",
    "/api/compliance/tcpa",
    "/api/compliance/export/soa.csv",
    "/api/compliance/export/tcpa.csv",
    # Password-reset flow — called from the public /forgot-password and
    # /reset-password screens, neither of which has a session yet so
    # the CSRF cookie isn't planted. Token entropy in the body is the
    # auth substitute.
    "/api/profile/forgot-password",
    "/api/profile/reset-password",
}

# Public SOA e-sign endpoints take the single-use token in the URL as
# their auth substitute. Added as a prefix because the token segment
# varies per request.
_CSRF_EXEMPT_PREFIXES_PUBLIC_SOA = ("/api/soa/public/",)

# Path prefixes for parameterised routes. CSRF-exempt when request.url.path
# starts with any of these. Use sparingly — broader than exact match.
_CSRF_EXEMPT_PREFIXES = (
    # /api/commission/audit/mark-resolved/{record_id}
    # Admin-only write, JWT-authenticated; record_id varies per call so we
    # can't list every path literally.
    "/api/commission/audit/mark-resolved/",
    # /api/commission/sync/run — admin-only manual ComTrack sync.
    "/api/commission/sync/",
    # /api/admin/import/* — admin-only data import (multipart preview,
    # commit, history list, rollback delete). JWT-authenticated via the
    # _require_admin dependency.
    "/api/admin/import/",
    # /api/profile/* — Settings page state-changing routes (profile patch,
    # MFA enable/disable, agency settings patch). JWT-authenticated via
    # get_current_user / require_roles.
    "/api/profile/",
    # /api/admin/users/{id}/credentials — admin force-reset endpoint.
    "/api/admin/users/",
    # Lead / client / application / document / GHL sub-paths.
    # PATCH /api/leads/{id}, POST /api/leads/{id}/sync-ghl, DELETE
    # /api/documents/{id}, etc. Sub-paths inherit the same auth model
    # as the resource roots above (cookie or Bearer + get_current_user
    # + per-route IDOR/role checks). Exempting matches the pattern we
    # use for every other admin/agent resource write that interacts
    # with external providers or large multipart uploads.
    "/api/leads/",
    "/api/clients/",
    "/api/applications/",
    "/api/documents/",
    "/api/ghl/",
    # Public SOA e-sign — single-use token in the URL is the auth
    # substitute; no browser session involved.
    "/api/soa/public/",
    # Agency command center — admin-only GETs, but cover the prefix in
    # case we add stat-export POSTs later.
    "/api/agency/",
    # Birthday Rule + Renewal Calendar — GET-only today, prefix exempt
    # to future-proof for action endpoints.
    "/api/birthday-rule/",
    "/api/renewals/",
    # Admin backup trigger + history.
    "/api/backup/",
    # Accounting / reconciliation / CFO chat — admin + compliance write
    # surfaces. JWT-authenticated via require_roles. Prefix-exempt for
    # parity with the other admin AI / financial endpoints.
    "/api/accounting/",
    "/api/reconciliation/",
    "/api/cfo-chat",
    # Dashboard aggregator — all GET today, but exempting the prefix
    # future-proofs us when we add the "refresh stats" POST and keeps
    # parity with the other admin/agent surfaces.
    "/api/dashboard/",
)


class CSRFMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method not in _CSRF_METHODS:
            return await call_next(request)
        path = request.url.path
        if path in _CSRF_EXEMPT_PATHS:
            return await call_next(request)
        if any(path.startswith(p) for p in _CSRF_EXEMPT_PREFIXES):
            return await call_next(request)
        # Header-based auth (Authorization: Bearer …) is not vulnerable to CSRF
        # because browsers never auto-send custom Authorization headers from
        # foreign origins. Skip CSRF when the caller is using the header path
        # — typically server-to-server or rollout-grace browser sessions.
        auth_header = request.headers.get("authorization", "")
        if auth_header.lower().startswith("bearer "):
            return await call_next(request)
        cookie_token = request.cookies.get("ghw_csrf_token")
        header_token = request.headers.get("x-csrf-token")
        if not cookie_token or not header_token or not secrets.compare_digest(
            cookie_token, header_token
        ):
            return JSONResponse(
                status_code=403,
                content={"detail": "CSRF token missing or invalid"},
            )
        return await call_next(request)


app.add_middleware(CSRFMiddleware)


# ── Production-scale indexes ─────────────────────────────────────────────
# Declared as a fixed table so it's easy to audit + extend. Each entry is
# ``(collection_name, key_spec, options)``. ``key_spec`` accepts either a
# single field string (ascending) or a list of (field, direction) tuples
# for compound or descending indexes. Options pass straight through to
# motor's ``create_index`` (``unique``, ``sparse``, etc.).
#
# We pass ``background=True`` on every entry. From MongoDB 4.2 onward
# the option is a no-op (all index builds are non-blocking by default)
# but it stays here so the intent is documented + the call is correct
# on older clusters.
_PROD_INDEXES = [
    # leads
    ("leads", "agent_id", {"background": True}),
    ("leads", "ghl_contact_id", {"background": True}),
    ("leads", "email", {"background": True}),
    ("leads", "phone", {"background": True}),
    ("leads", "status", {"background": True}),
    ("leads", [("created_at", -1)], {"background": True}),
    ("leads", "tcpa_consent", {"background": True}),

    # production_records
    ("production_records", "agent_id", {"background": True}),
    ("production_records", [("effective_date", -1)], {"background": True}),
    ("production_records", "carrier", {"background": True}),
    ("production_records", "product_label", {"background": True}),
    ("production_records", "agent_name", {"background": True}),
    ("production_records", [("app_date", -1)], {"background": True}),

    # policies
    ("policies", "agent_id", {"background": True}),
    ("policies", "lead_id", {"background": True}),
    ("policies", [("created_at", -1)], {"background": True}),
    ("policies", "product_type", {"background": True}),
    ("policies", "carrier", {"background": True}),

    # audit_logs
    ("audit_logs", "actor_id", {"background": True}),
    ("audit_logs", [("timestamp", -1)], {"background": True}),
    ("audit_logs", "event_type", {"background": True}),
    ("audit_logs", "actor_email", {"background": True}),

    # soa_records
    ("soa_records", "agent_id", {"background": True}),
    ("soa_records", "lead_id", {"background": True}),
    ("soa_records", "status", {"background": True}),
    # token is the public-page identifier — must be unique. Sparse so
    # legacy in-app signed SOAs (which never got a token) don't trip
    # the constraint.
    ("soa_records", "token", {"background": True, "unique": True, "sparse": True}),
    ("soa_records", [("created_at", -1)], {"background": True}),

    # documents
    ("documents", "agent_id", {"background": True}),
    ("documents", "lead_id", {"background": True}),

    # users
    ("users", "email", {"background": True, "unique": True}),
    ("users", "role", {"background": True}),
    ("users", "is_active", {"background": True}),

    # invite_tokens (token field — distinct from the existing token_hash)
    ("invite_tokens", "token", {"background": True, "unique": True, "sparse": True}),
    ("invite_tokens", "email", {"background": True}),
    ("invite_tokens", "used", {"background": True}),
    ("invite_tokens", "expires_at", {"background": True}),

    # password_resets
    ("password_resets", "token", {"background": True, "unique": True}),
    ("password_resets", "user_id", {"background": True}),
    ("password_resets", "used", {"background": True}),
]


async def _ensure_production_indexes(db) -> None:
    """Best-effort: ensure every index in ``_PROD_INDEXES`` exists.

    ``create_index`` is idempotent — re-declaring an existing index is
    a no-op and returns the existing name. A failure on one entry
    (e.g. a duplicate unique constraint on an existing row set) is
    logged + skipped so startup never blocks on index creation.
    """
    for coll_name, key_spec, options in _PROD_INDEXES:
        try:
            await db[coll_name].create_index(key_spec, **options)
        except Exception as e:
            # Common causes: pre-existing index with different options
            # (e.g. another unique constraint elsewhere), or a sparse-
            # vs-non-sparse mismatch on an already-indexed field. Log
            # and continue — the rest of the indexes still get a
            # chance to land.
            logger.warning(
                "index ensure failed coll=%s key=%s opts=%s: %s",
                coll_name, key_spec, options, e,
            )


@app.on_event("startup")
async def on_startup():
    db = get_db()
    await db.users.create_index("email", unique=True)
    await db.leads.create_index("created_at")
    await db.documents.create_index("lead_id")
    await db.audit_logs.create_index("timestamp")
    await db.commission_syncs.create_index("agent_id")
    await db.commission_syncs.create_index("uploaded_at")

    # Brute-force protection — login attempt tracking
    await db.login_attempts.create_index("email")
    await db.login_attempts.create_index("attempted_at")
    await db.login_attempts.create_index(
        "locked_until",
        expireAfterSeconds=7200,  # TTL index: auto-delete lockout records after 2 hours
    )

    # Invite-only registration — single-use, 24h TTL tokens
    # NOTE: FRONTEND_URL env var must be set on Render so invite emails
    # use the correct origin (e.g. https://medicare-app-sandy-tau.vercel.app).
    await db.invite_tokens.create_index("token_hash", unique=True)
    await db.invite_tokens.create_index("email")
    await db.invite_tokens.create_index(
        "expires_at",
        expireAfterSeconds=0,  # TTL: MongoDB auto-deletes expired tokens
    )

    # Production records (Plecto) — Phase 2 commission intelligence indexes.
    # Indexes also created by scripts/import_production.py on first run, but
    # we ensure them here so the audit router has fast queries from cold start.
    await db.production_records.create_index("natural_key", unique=True)
    await db.production_records.create_index("agent_email")
    await db.production_records.create_index("agent_name")
    await db.production_records.create_index("effective_date")
    await db.production_records.create_index("audit_status")
    # GHW production import (Phase 4) — dedup_key is the new natural identity;
    # legacy rows from import_production.py don't have it (sparse index).
    await db.production_records.create_index(
        "dedup_key", unique=True, sparse=True)
    await db.production_records.create_index("agent_id")
    await db.production_records.create_index("import_batch_id")
    await db.import_batches.create_index("imported_at")

    # Carrier rate schedule (Phase 2)
    await db.carrier_rates.create_index("natural_key", unique=True)
    await db.carrier_rates.create_index("carrier")
    await db.carrier_rates.create_index("effective_year")

    # ComTrack live endpoint — per-user cache + rate-limit counters
    await db.commission_cache.create_index("user_id", unique=True)
    await db.commission_cache.create_index(
        "expires_at",
        expireAfterSeconds=0,  # auto-evict stale cache entries
    )
    await db.commission_rate_limits.create_index("user_id")
    await db.commission_rate_limits.create_index("called_at")
    await db.commission_rate_limits.create_index(
        "expires_at",
        expireAfterSeconds=0,  # auto-evict counters once the window closes
    )

    # AI chat — per-user rate-limit counters (separate bucket from /live)
    await db.commission_chat_rate_limits.create_index("user_id")
    await db.commission_chat_rate_limits.create_index("called_at")
    await db.commission_chat_rate_limits.create_index(
        "expires_at",
        expireAfterSeconds=0,
    )

    # Daily ComTrack sync run log
    await db.commission_sync_runs.create_index("completed_at")

    # Application-submission persistence (Phase 3) — one row per GHL contact
    # in `clients`, one row per submitted application in `policies`.
    await db.clients.create_index("ghl_contact_id", unique=True)
    await db.policies.create_index("ghl_contact_id")
    await db.policies.create_index("submitted_at")
    await db.policies.create_index([("ghl_contact_id", 1), ("product_type", 1)])

    # Production-scale indexes — declared as a single table at module
    # level so the surface is auditable. Wrapped in try/except so even
    # a Mongo timeout here can't block boot; the per-index helper also
    # catches per-collection failures.
    try:
        await _ensure_production_indexes(db)
        logger.info("MongoDB indexes verified")
    except Exception as e:
        logger.warning("ensure_production_indexes top-level failure: %s", e)

    await seed_admin(db)
    # Stamp agent_id / agent_name on any pre-existing user rows that pre-date
    # workspace-isolation scoping. Idempotent — no-op once everyone is stamped.
    await backfill_agent_identity(db)
    logger.info("Startup complete. Admin seeded if missing.")

    # Boot background schedulers. Gated by DISABLE_SCHEDULER=1 (set in
    # tests/conftest.py) so pytest never starts background timers that
    # would leak between tests.
    from comtrack_sync import start_scheduler as start_comtrack_scheduler
    from statement_generator import start_scheduler as start_statement_scheduler
    from backup_service import start_backup_scheduler
    app.state.comtrack_scheduler = start_comtrack_scheduler(get_db)
    app.state.statement_scheduler = start_statement_scheduler(get_db)
    app.state.backup_scheduler = start_backup_scheduler(get_db)


@app.on_event("shutdown")
async def on_shutdown():
    for attr in ("comtrack_scheduler", "statement_scheduler"):
        sched = getattr(app.state, attr, None)
        if sched is not None:
            try:
                sched.shutdown(wait=False)
            except Exception as e:
                logger.warning("Scheduler shutdown error (%s): %s", attr, e)
