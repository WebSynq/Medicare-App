"""FastAPI app — Gruening Health & Wealth Medicare Intake."""
import os
import logging
from pathlib import Path

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
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
from soa_router import router as soa_router  # noqa: E402
from audit_router import router as audit_router  # noqa: E402
from seed import seed_admin  # noqa: E402


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
app.include_router(soa_router, prefix="/api")
app.include_router(audit_router, prefix="/api")


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

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=_cors_origins,
    allow_origin_regex=None,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "Origin",
                   "X-Requested-With"],
    max_age=600,
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

    await seed_admin(db)
    logger.info("Startup complete. Admin seeded if missing.")
