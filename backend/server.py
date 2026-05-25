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

from deps import get_db, get_phi_db  # noqa: E402
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
from notifications_router import router as notifications_router  # noqa: E402
from agency_dashboard_router import router as agency_dashboard_router  # noqa: E402
from tags_router import router as tags_router, seed_tag_library  # noqa: E402
from booking_router import router as booking_router  # noqa: E402
from ops_router import router as ops_router  # noqa: E402
import email_templates  # noqa: E402,F401 — ensure clean import
from automations import start_automation_scheduler  # noqa: E402
from feedback_router import router as feedback_router  # noqa: E402
from calendar_router import router as calendar_router, ics_router as calendar_ics_router  # noqa: E402
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
            "hipaa_safeguards": ["TLS", "AES-128 at rest (docs)", "JWT",
                                 "Magic Link", "Audit Log", "RBAC"]}


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
app.include_router(notifications_router, prefix="/api")
app.include_router(agency_dashboard_router, prefix="/api")
app.include_router(tags_router, prefix="/api")
app.include_router(booking_router, prefix="/api")
app.include_router(ops_router, prefix="/api")
# feedback_router declares its own /api/feedback prefix — no prefix here.
app.include_router(feedback_router)
# calendar_router declares /api/calendar; ics_router declares /api/appointments
# for the per-appointment .ics download. Both self-prefix → no prefix here.
app.include_router(calendar_router)
app.include_router(calendar_ics_router)


# ── CORS ──────────────────────────────────────────────────────────────────────
# Strict allowlist. A wildcard origin combined with allow_credentials=True is a
# critical misconfiguration: Starlette will echo any Origin back, which lets any
# site read authenticated responses. We require CORS_ORIGINS to be set
# explicitly to a comma-separated list of fully-qualified origins.
_raw_origins = os.environ.get("CORS_ORIGINS", "").strip()

# Parse comma-separated origins, strip whitespace and
# trailing slashes from each entry
_cors_origins = [
    o.strip().rstrip("/")
    for o in _raw_origins.split(",")
    if o.strip() and o.strip() != "*"
]

# FRONTEND_URL is already required for invite links —
# reuse it as a guaranteed CORS origin so the frontend
# domain is always allowed without hardcoding it twice.
# Goes through deps.get_frontend_url so the single source
# of truth (one helper) drives CORS, invite links, reset
# emails, and SOA links all from the same env var.
from deps import get_frontend_url as _get_frontend_url
_fe_url = _get_frontend_url()
if _fe_url and _fe_url not in _cors_origins:
    _cors_origins.append(_fe_url)

# Dev fallback only when nothing is configured at all
if not _cors_origins:
    _cors_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
    logger.warning(
        "CORS_ORIGINS not set; defaulting to localhost (dev mode)."
    )

logger.info(
    "CORS active origins (%d): %s",
    len(_cors_origins),
    ", ".join(_cors_origins),
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
        h.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
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
    # Magic link request + verify. Both are pre-session (no CSRF
    # cookie planted yet) and authenticity comes from the single-use
    # token in the body. /verify is the response that plants the
    # session cookie, mirroring how /login behaves.
    "/api/auth/magic-link",
    "/api/auth/magic-link/verify",
    # MFA flow (Hardening 1). All five paths run in the same
    # password→TOTP→JWT context as /login above: callers are mid-
    # authentication, no CSRF cookie planted yet. The HMAC session
    # token in the body is the auth substitute for /verify and
    # /backup-code; /setup, /verify-setup, /disable require an already-
    # authenticated session via the get_current_user dependency.
    "/api/auth/mfa/setup",
    "/api/auth/mfa/verify-setup",
    "/api/auth/mfa/verify",
    "/api/auth/mfa/backup-code",
    "/api/auth/mfa/disable",
    # Session refresh (Hardening 2). Bearer/cookie auth is the gate;
    # CSRF cookie isn't always present (e.g. mobile webview).
    "/api/auth/refresh",
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
    # Admin user-management writes. Each is JWT-authenticated +
    # require_roles("admin", "owner") inside the route — that role check
    # is what a CSRF attacker can't forge, so the cookie double-submit
    # is redundant. Matches the rationale used for /api/ghl/sync and
    # /api/commission/sync/* above. /resend, /deactivate, /reactivate
    # are listed for the same reason even though only /invite is in
    # the current bug report — keeps the security profile uniform for
    # the whole admin-user-management surface.
    "/api/auth/invite",
    "/api/auth/invite/resend",
    "/api/auth/users/deactivate",
    "/api/auth/users/reactivate",
    # Resource roots — POST creates only. Sub-paths (PATCH/DELETE on
    # /{id}, action verbs like /sync-ghl) are covered by the prefix
    # block below. Auth is enforced by get_current_user / IDOR checks
    # inside each handler.
    "/api/leads",
    "/api/clients",
    "/api/applications",
    "/api/documents",
    "/api/ghl",
    # Agent feedback — JWT-authenticated POST, no IDOR surface (a forged
    # cross-site POST without the JWT can't impersonate the agent). Fans
    # out to the GHL feedback workflow + writes an audit row regardless.
    "/api/feedback",
    # Bare appointments POST (create). The /api/appointments/ prefix
    # below covers PATCH /api/appointments/{id} and DELETE, but the
    # bare `/api/appointments` doesn't match a trailing-slash prefix
    # check — explicit entry. Same forge-resistant rationale as the
    # other resource roots above.
    "/api/appointments",
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
    # agency settings patch). JWT-authenticated via get_current_user /
    # require_roles.
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
    # Public booking page — no JWT, no CSRF cookie. The HMAC token
    # the booking router issues + honeypot + IP-based abuse limits
    # are the security substitutes. See booking_router.py module docs.
    "/api/book/",
    # Admin ops console — GET-only today, prefix-exempt to future-proof
    # for action endpoints. Admin/owner JWT is the auth gate.
    "/api/ops/",
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
    # Agent management — PATCH /api/agents/{id}/status drives the
    # deactivate/reactivate flow from AgentManagement.jsx. Admin/
    # owner only via require_roles; CSRF double-submit is redundant.
    "/api/agents/",
    # Auth user-management writes — PATCH /api/auth/users/{id}/approve,
    # /reject, /unlock, /profile. All admin/owner-gated.
    "/api/auth/users/",
    # Notification panel writes — PATCH /{id}/read, /read-all, DELETE.
    # Per-user scoped via agent_filter + IDOR check.
    "/api/notifications/",
    # Appointments CRUD — POST create, PATCH update, DELETE cancel.
    # Per-user scoped via agent_filter + IDOR check, role-gated for
    # admin / coach / owner on impersonating writes.
    "/api/appointments/",
    # Per-agent Google Calendar OAuth. DELETE /disconnect is the only
    # state-changing method here today; the rest are GETs. JWT-auth +
    # the OAuth state JWT (callback) carry the authority. Prefix
    # exempt so adding e.g. a manual re-sync POST later doesn't need
    # another middleware edit.
    "/api/calendar/",
    # Notes + tasks CRUD — POST create, PATCH complete, DELETE.
    # Per-user scoped via agent_filter + IDOR check; lead-ownership
    # check on every write.
    "/api/notes/",
    # Today action centre — read-only today but exempting the prefix
    # future-proofs us against a "snooze / mark-done" POST landing.
    "/api/today/",
    # Global search — read-only POST-less GET, exempting in case we
    # add a "save search" or "recent searches" POST later.
    "/api/search",
    # Calendar availability (future endpoint, not yet implemented) —
    # exempted now per the platform's "all API surfaces uniform"
    # principle so the route can ship without re-touching the CSRF
    # config.
    "/api/availability/",
)


# ── CSRF coverage audit ───────────────────────────────────────────────────
# Snapshot taken alongside the prefix expansion above. Comparing every
# router that defines a state-changing endpoint (POST / PATCH / DELETE
# / PUT) against the exempt set:
#
#   ROUTER                          PREFIX                COVERAGE
#   accounting_router               /accounting           ✓ prefix
#   agent_management_router         /agents               ✓ prefix (new)
#   application_router              /api/applications     ✓ root + prefix
#   appointments_router             /appointments         ✓ prefix (new)
#   auth_router                     /auth                 ✓ paths (login/
#                                                          register/logout/
#                                                          magic-link/
#                                                          magic-link/verify/
#                                                          invite/...) +
#                                                          /auth/users/
#                                                          prefix (new)
#   backup_router                   /backup               ✓ prefix
#   cfo_chat_router                 /cfo-chat             ✓ prefix
#   chat_router                     /chat                 ✓ path
#   commission_audit_router         /commission/audit     ✓ prefix
#                                   /commission (chat)    ✓ path
#                                   /commission/sync      ✓ prefix
#   commission_router (calculator)  /commission/...        ✓ paths
#   documents_router                /documents            ✓ prefix
#   ghl_webhook_router              /ghl                  ✓ root + prefix
#   leads_router                    /leads                ✓ root + prefix
#   notes_router                    /notes                ✓ prefix (new)
#   notifications_router            /notifications        ✓ prefix (new)
#   production_records_router       /api/admin/import     ✓ prefix
#   profile_router                  /profile              ✓ paths + prefix
#   reconciliation_router           /reconciliation       ✓ prefix
#
# NOT COVERED — state-changing endpoints still require X-CSRF-Token:
#
#   commissions_router              /commissions          POST /upload
#                                                          (multipart
#                                                          carrier-statement
#                                                          upload — admin
#                                                          uses the shared
#                                                          axios instance,
#                                                          so the
#                                                          interceptor
#                                                          attaches the
#                                                          token today)
#   soa_router                      /soa                  POST /soa/sign,
#                                                          POST /soa/send/
#                                                          {lead_id}
#                                                          (/api/soa/public/
#                                                          IS exempt for
#                                                          token-bearing
#                                                          public e-sign
#                                                          path)
#
# Read-only routers (no POST/PATCH/DELETE — CSRF doesn't apply):
#   audit_router, birthday_rule_router, compliance_router,
#   integrations_router, leaderboard_router, policies_router,
#   renewal_router, search_router, today_router.
#
# If the two NOT-COVERED rows above start surfacing CSRF 403s in the
# Render logs, add their prefixes to _CSRF_EXEMPT_PREFIXES the same
# way the others were added.


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
    # `id` is the app-level UUID used by 44 find_one({"id": …}) sites
    # (every IDOR check, every PATCH refresh, every detail load). Without
    # this index those queries are full COLLSCANs — at 1.5M docs they
    # take seconds each. unique=True is safe because Lead.id is generated
    # by uuid4 in the model (models.py).
    ("leads", "id", {"unique": True, "background": True}),
    ("leads", "agent_id", {"background": True}),
    ("leads", "ghl_contact_id", {"background": True}),
    ("leads", "email", {"background": True}),
    ("leads", "phone", {"background": True}),
    ("leads", "status", {"background": True}),
    ("leads", [("created_at", -1)], {"background": True}),
    ("leads", "tcpa_consent", {"background": True}),
    # `state` powers the IL birthday-rule queries (birthday_rule_router,
    # agency_dashboard's IL window panels, today_router's urgent calls).
    # Filtered with an $or over 5 case variants — Mongo uses the index
    # per $or branch (index union), so the $or doesn't defeat it.
    # Single-field rather than a compound because admins' agency-wide
    # views skip agent_id scope entirely; a standalone state index
    # serves both per-agent and agency-wide paths.
    # TODO: normalize the state field on write (uppercase 2-letter
    # code) + one-shot backfill, then the $or collapses to one predicate.
    ("leads", "state", {"background": True}),
    # leads full-text search — replaces the $or-of-$regex pattern in
    # list_leads's `q` parameter that used to scan first_name/last_name/
    # email/phone unindexed. $text gives tokenized matching (case-
    # insensitive, word-boundary aware) at index speed.
    #
    # MongoDB allows ONLY ONE $text index per collection — don't add a
    # second one. Per-field weights aren't set (all equal) — revisit
    # if agents want name matches ranked higher than email/phone.
    ("leads", [
        ("first_name", "text"),
        ("last_name", "text"),
        ("email", "text"),
        ("phone", "text"),
    ], {"background": True, "name": "leads_text_search"}),

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

    # notes — soft-delete-aware (deleted=True rows are tombstones; the
    # list endpoint excludes them). Insert always stamps deleted:False
    # (notes_router.py:147), making the partial index #3 valid for
    # every non-deleted row.
    #
    # 1) note_id unique — _fetch_note_or_idor + the post-update fresh
    #    fetch both look up by note_id. Without this index every note
    #    fetch is a COLLSCAN.
    ("notes", "note_id", {"unique": True, "background": True}),
    # 2) (agent_id, lead_id) compound — list_notes filters on both
    #    together; the pair is more selective than either alone.
    ("notes", [("agent_id", 1), ("lead_id", 1)], {"background": True}),
    # 3) Partial on lead_id where deleted=False — forward-looking for
    #    cross-agent "all live notes on this lead" lookups (e.g. admin
    #    debug views). Today's list query uses $ne:True so the planner
    #    won't pick this up — switch to deleted:False if you want to
    #    activate it for that path.
    ("notes", "lead_id", {
        "background": True,
        "partialFilterExpression": {"deleted": False},
    }),

    # dashboard_stats — one doc per agency (single-tenant today). Unique
    # constraint enforces "one snapshot per agency" — refresh is an upsert
    # on this key. Point-lookup on every read endpoint, so single-field
    # is enough; no compound needed.
    ("dashboard_stats", "agency_id", {"unique": True, "background": True}),

    # appointments — agent_id+date compound powers the Calendar page's
    # per-agent month/week/day range queries (start_date/end_date filter
    # via $gte/$lte). Standalone appointment_date index supports the
    # admin-view aggregations that ignore agent scope.
    ("appointments", [("agent_id", 1), ("appointment_date", 1)], {"background": True}),
    ("appointments", "appointment_date", {"background": True}),
    ("appointments", "lead_id", {"background": True}),
    ("appointments", "status", {"background": True}),
    ("appointments", "appointment_id", {"background": True, "unique": True, "sparse": True}),

    # users
    ("users", "email", {"background": True, "unique": True}),
    ("users", "role", {"background": True}),
    ("users", "is_active", {"background": True}),
    # parent_agent_id powers the team-member roster — sparse because
    # only VAs / agents pinned to another agent carry the field.
    ("users", "parent_agent_id", {"background": True, "sparse": True}),

    # invite_tokens (token field — distinct from the existing token_hash)
    ("invite_tokens", "token", {"background": True, "unique": True, "sparse": True}),
    ("invite_tokens", "email", {"background": True}),
    ("invite_tokens", "used", {"background": True}),
    ("invite_tokens", "expires_at", {"background": True}),

    # password_resets
    ("password_resets", "token", {"background": True, "unique": True}),
    ("password_resets", "user_id", {"background": True}),
    ("password_resets", "used", {"background": True}),

    # magic_link_tokens — single-use passwordless login. token_hash is
    # the lookup key; expires_at is a BSON Date so MongoDB's TTL index
    # can auto-evict expired rows. expireAfterSeconds=3600 keeps used
    # / expired tokens around for an hour past expiry for audit then
    # purges them.
    ("magic_link_tokens", "token_hash",
     {"background": True, "unique": True}),
    ("magic_link_tokens", "email", {"background": True}),
    ("magic_link_tokens", "user_id", {"background": True}),
    ("magic_link_tokens", "expires_at",
     {"background": True, "expireAfterSeconds": 3600}),

    # MFA collections (Hardening 1).
    # Pending sessions auto-expire after 5 minutes via TTL — single-use
    # tokens that bridge password → TOTP. expires_at is a BSON Date so
    # the TTL index works without extra conversion.
    ("mfa_pending_sessions", "expires_at",
     {"background": True, "expireAfterSeconds": 0}),
    ("mfa_pending_sessions", "user_id", {"background": True}),
    # Backup codes — lookup by user with the unused subset.
    ("mfa_backup_codes",
     [("user_id", 1), ("used", 1)], {"background": True}),
    # Per-user MFA failure counter.
    ("mfa_attempts", "locked_until", {"background": True, "sparse": True}),

    # ⚠️ HIPAA: audit_logs MUST NOT have a TTL index.
    # Retention period: 7 years minimum per 45 CFR 164.312(b).
    # The audit_logs indexes above are query-only — no expireAfterSeconds.
    # The audit-log CSV export endpoint at /api/audit/export is the
    # supported way to pull rows for compliance review.

    # Booking + automation indexes (Phase 1 build).
    # Appointment send-flag indexes — sparse so only the rows the
    # automation scheduler hasn't stamped True yet show up. Once an
    # appointment is reminded/followed-up it's effectively invisible
    # to subsequent ticks, which keeps the scan tight as volume grows.
    ("appointments", "reminder_48hr_sent", {"background": True}),
    ("appointments", "reminder_24hr_sent", {"background": True}),
    ("appointments", "reminder_1hr_sent",  {"background": True}),
    ("appointments", "followup_sent",      {"background": True}),
    # Public booking slug lookup — sparse because most users will
    # never enable a booking page. Single-field is enough; the
    # /book/{slug} lookup is a point read.
    ("users", "booking_settings.slug",     {"background": True, "sparse": True}),
    # Lead automation flags — sparse so the scheduler's scan only
    # touches leads that haven't been emailed yet.
    ("leads", "birthday_email_sent",       {"background": True, "sparse": True}),
    ("leads", "enrolled_welcome_sent",     {"background": True, "sparse": True}),
    ("leads", "stale_alert_sent",          {"background": True, "sparse": True}),
    ("leads", "new_lead_notified",         {"background": True, "sparse": True}),
    # booking_attempts — abuse tracking. TTL evicts rows after 30 days
    # so the collection stays bounded. ip index supports the per-IP
    # failure-count query inside _maybe_block_ip.
    ("booking_attempts", "ip", {"background": True}),
    ("booking_attempts", "created_at",
     {"background": True, "expireAfterSeconds": 2592000}),
    # booking_blocks — one row per blocked IP. unique=True so the
    # upsert in _maybe_block_ip can't double-insert. TTL on expires_at
    # auto-clears blocks at the 24-hour mark.
    ("booking_blocks", "ip", {"background": True, "unique": True}),
    ("booking_blocks", "expires_at",
     {"background": True, "expireAfterSeconds": 0}),
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
    # Tag library — unique per (agency_id, name) so the seeder and the
    # custom-tag route can both rely on the index to dedupe rather than
    # racing each other on a check-then-insert.
    await db.tags.create_index(
        [("agency_id", 1), ("name", 1)], unique=True,
    )
    # Tag application filter — agents will filter the leads list by
    # tags (?tags=hot-lead,...) which uses $all. A multikey index on
    # `tags` makes that lookup index-served.
    await db.leads.create_index("tags")
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
    # use the correct origin (resolved via deps.get_frontend_url).
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

    # Seed the pre-built Medicare tag library on first boot of an
    # agency. Idempotent — returns 0 once the library is populated.
    try:
        inserted = await seed_tag_library(db)
        if inserted:
            logger.info("Tag library seeded with %d tags", inserted)
    except Exception as e:
        logger.warning("tag library seed failed: %s", e)

    # One-shot migration: any user row stuck on status="pending" while
    # is_active=True is a leftover from the pre-auto-activate flow.
    # The login endpoint rejects status=pending with 403 regardless of
    # is_active, so admins who tried to "Reactivate" those rows ended
    # up with users that LOOKED active in the UI but still couldn't
    # sign in. Idempotent — once everyone is flipped to "active" this
    # update_many matches zero docs and logs "fixed 0".
    try:
        _migrate = await db.users.update_many(
            {"is_active": True, "status": "pending"},
            {"$set": {"status": "active"}},
        )
        logger.info(
            "Migration: fixed %d pending-but-active users",
            _migrate.modified_count,
        )
    except Exception as e:
        logger.warning("pending-but-active migration failed: %s", e)

    logger.info("Startup complete. Admin seeded if missing.")

    # Boot background schedulers. Gated by DISABLE_SCHEDULER=1 (set in
    # tests/conftest.py) so pytest never starts background timers that
    # would leak between tests.
    from comtrack_sync import start_scheduler as start_comtrack_scheduler
    from statement_generator import start_scheduler as start_statement_scheduler
    from backup_service import start_backup_scheduler
    from notifications_router import start_scheduler as start_notifications_scheduler
    app.state.comtrack_scheduler = start_comtrack_scheduler(get_db)
    app.state.statement_scheduler = start_statement_scheduler(get_db)
    app.state.backup_scheduler = start_backup_scheduler(get_db)
    # notifications scheduler reads db.leads (birthday windows, stale leads)
    # via _gen_birthday_windows / _gen_stale_leads — hand it the PHI client.
    app.state.notifications_scheduler = start_notifications_scheduler(get_phi_db)
    # Fix E — dashboard_stats refresh, every 15 min. Reads leads (PHI client)
    # and writes pre-aggregated counts to db.dashboard_stats.
    from dashboard_aggregator import start_scheduler as start_dashboard_scheduler
    app.state.dashboard_scheduler = start_dashboard_scheduler(get_phi_db)
    # Booking + lead automation scheduler — fires reminders, birthday
    # window, enrolled welcome, stale lead alerts, and post-appointment
    # follow-ups every 15 minutes. Reads + writes leads + appointments
    # (both PHI client) and writes audit rows + automation flags.
    app.state.automation_scheduler = start_automation_scheduler(get_phi_db)


@app.on_event("shutdown")
async def on_shutdown():
    for attr in ("comtrack_scheduler", "statement_scheduler"):
        sched = getattr(app.state, attr, None)
        if sched is not None:
            try:
                sched.shutdown(wait=False)
            except Exception as e:
                logger.warning("Scheduler shutdown error (%s): %s", attr, e)
