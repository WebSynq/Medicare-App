"""Pytest fixtures: in-process TestClient against mongomock-motor.

The pre-hardening suite was integration-style (`requests` against a live
backend). That broke after we hardened the auth flow (invite-only, default
password removed, etc.). This rewrite spins the FastAPI app in-process with
a mocked Mongo so tests are self-contained and re-run cheaply.
"""
import os
import sys
from pathlib import Path

import pytest

# ── Environment ─────────────────────────────────────────────────────────────
# Set required env vars BEFORE importing server.py — security.py reads JWT_SECRET
# at import time and seed.py reads SEED_ADMIN_PASSWORD at startup.
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-test-jwt-secret-test-jwt-secret-32")
os.environ.setdefault("JWT_ALGORITHM", "HS256")
os.environ.setdefault("JWT_EXPIRES_MINUTES", "60")
os.environ.setdefault("MONGO_URL", "mongodb://test-mock/")
os.environ.setdefault("DB_NAME", "ghw_test")
os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:3000")
os.environ.setdefault("SEED_ADMIN_EMAIL", "admin@grueninghw.com")
os.environ.setdefault("SEED_ADMIN_PASSWORD", "TestAdmin!2026Pass")
# Force ComTrack into mock mode so tests don't hit commissionconnector.com.
os.environ["COMTRACK_API_KEY"] = ""
# Disable the daily ComTrack scheduler — pytest must never spin up a
# background AsyncIOScheduler that would leak between tests.
os.environ["DISABLE_SCHEDULER"] = "1"
# PHI encryption key — generated per-session so no real key ever lands in
# the test process. encryption.py lazy-loads it on first PHI write/read.
from cryptography.fernet import Fernet as _Fernet  # noqa: E402
os.environ.setdefault("PHI_FIELD_KEY", _Fernet.generate_key().decode())
# Hardening 1: per-session Fernet key for the MFA TOTP secret. Never
# the production key. Tests that exercise /api/auth/mfa/* round-trip
# through encrypt_secret / decrypt_secret with this key.
os.environ.setdefault("MFA_ENCRYPTION_KEY", _Fernet.generate_key().decode())
# Hardening 2: tighten idle-timeout for tests so JWTs minted at
# session start aren't unexpectedly long-lived in fast runs. Anything
# above the test duration is fine — keep 30m to match production.
os.environ.setdefault("JWT_IDLE_TIMEOUT_MINUTES", "30")
# Hardening 4: ADMIN_EMAIL is required for the lockout notification
# helper. Tests don't actually send mail (RESEND_API_KEY is unset)
# but the helper still runs the env-read path.
os.environ.setdefault("ADMIN_EMAIL", "admin-alerts@example.com")
# Phase 3 — multi-tenant billing. Webhook tests construct + verify
# signatures against this secret. STRIPE_SECRET_KEY left unset so
# the user-facing checkout/portal endpoints 503 by design in tests
# (we mock the SDK module when exercising them).
os.environ.setdefault(
    "STRIPE_WEBHOOK_SECRET", "whsec_test_phase3_signing_secret_padding_xx",
)

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from mongomock_motor import AsyncMongoMockClient

import deps  # noqa: E402


# ── Mongo isolation ─────────────────────────────────────────────────────────
# Patch the deps module so EVERY get_db() call — both Depends() and direct
# calls from the startup event — returns our mongomock DB. We can't rely on
# FastAPI dependency_overrides because server.py's @app.on_event("startup")
# uses get_db() directly.
_mock_client = AsyncMongoMockClient()


def _fake_get_mongo_client():
    return _mock_client


def _fake_get_db():
    return _mock_client[os.environ["DB_NAME"]]


deps.get_mongo_client = _fake_get_mongo_client
deps.get_phi_mongo_client = _fake_get_mongo_client
deps.get_db = _fake_get_db
deps.get_phi_db = _fake_get_db

# Now safe to import server — its startup handler will use the patched get_db.
import server  # noqa: E402


# Dependency override too, so endpoints that re-import get_db / get_phi_db
# get the same mongomock DB.
server.app.dependency_overrides[deps.get_db] = _fake_get_db
server.app.dependency_overrides[deps.get_phi_db] = _fake_get_db


# slowapi: disable per-IP rate limits across all routers so the suite can hit
# /auth/login dozens of times without tripping the 10/min ceiling.
for module_name in ("server", "auth_router", "leads_router",
                     "commission_audit_router", "leaderboard_router",
                     "today_router", "appointments_router",
                     "dashboard_router", "notes_router",
                     "search_router", "notifications_router",
                     "agency_dashboard_router", "booking_router",
                     "billing_router", "email_domain_router",
                     "super_admin_router", "agency_settings_router"):
    try:
        mod = sys.modules.get(module_name) or __import__(module_name)
        if hasattr(mod, "limiter"):
            mod.limiter.enabled = False
    except Exception:
        pass


@pytest.fixture(autouse=True)
async def _clean_db():
    """Per-test clean DB. Drops everything, seeds the GHW agency row,
    then seeds the admin row directly.

    autouse=True means every test gets a fresh DB without having to
    declare the fixture explicitly.

    Multi-tenant (Phase 1): seeds db.agencies with the GHW super-admin
    record + stamps the admin user with agency_id="ghw_001". Existing
    tests should pass unchanged because every feature flag is True on
    the GHW agency and super_admin bypasses billing/feature gates.
    """
    inst = _fake_get_db()
    for coll in await inst.list_collection_names():
        await inst.drop_collection(coll)
    from security import hash_password
    from datetime import datetime, timezone
    import uuid

    # Seed the GHW agency FIRST so the JWT enrichment in _jwt_claims
    # finds an agency row when the admin logs in.
    from seed import seed_ghw_agency, GHW_AGENCY_ID
    await seed_ghw_agency(inst)

    await inst.users.insert_one({
        "id": str(uuid.uuid4()),
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "full_name": "Test Administrator",
        "role": "admin",
        "is_active": True,
        "status": "active",
        "agency_id": GHW_AGENCY_ID,
        "agency_name": None,
        "agent_name": None,
        "agent_npn": None,
        "hashed_password": hash_password(os.environ["SEED_ADMIN_PASSWORD"]),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    yield inst


@pytest.fixture
def db():
    """Convenience accessor for tests that want to read/write the DB directly."""
    return _fake_get_db()


@pytest.fixture
def client():
    """TestClient with cookies persisting across calls within a single test.

    base_url is https://testserver so the httpx cookie jar accepts the
    Secure-flagged session cookies the auth router plants. With the
    default http://testserver, Secure cookies would be silently dropped
    on receipt and the cookie/CSRF tests would all 401."""
    from fastapi.testclient import TestClient
    with TestClient(server.app, base_url="https://testserver") as c:
        yield c


@pytest.fixture
def admin_token(client):
    """Log in as the seeded admin and return the Bearer token."""
    resp = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}
