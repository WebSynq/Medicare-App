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
deps.get_db = _fake_get_db

# Now safe to import server — its startup handler will use the patched get_db.
import server  # noqa: E402


# Dependency override too, so endpoints that re-import get_db get the mock.
server.app.dependency_overrides[deps.get_db] = _fake_get_db


# slowapi: disable per-IP rate limits across all routers so the suite can hit
# /auth/login dozens of times without tripping the 10/min ceiling.
for module_name in ("server", "auth_router", "leads_router",
                     "commission_audit_router", "leaderboard_router",
                     "today_router", "appointments_router",
                     "dashboard_router", "notes_router",
                     "search_router"):
    try:
        mod = sys.modules.get(module_name) or __import__(module_name)
        if hasattr(mod, "limiter"):
            mod.limiter.enabled = False
    except Exception:
        pass


@pytest.fixture(autouse=True)
async def _clean_db():
    """Per-test clean DB. Drops everything, then seeds the admin row directly.

    autouse=True means every test gets a fresh DB without having to declare
    the fixture explicitly.
    """
    inst = _fake_get_db()
    for coll in await inst.list_collection_names():
        await inst.drop_collection(coll)
    from security import hash_password
    from datetime import datetime, timezone
    import uuid
    await inst.users.insert_one({
        "id": str(uuid.uuid4()),
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "full_name": "Test Administrator",
        "role": "admin",
        "is_active": True,
        "status": "active",
        "agency_name": None,
        "agent_name": None,
        "agent_npn": None,
        "hashed_password": hash_password(os.environ["SEED_ADMIN_PASSWORD"]),
        "mfa_secret": None,
        "mfa_enabled": False,
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
