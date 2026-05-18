"""End-to-end tests for the hardened auth + commission flows.

Covers:
  - Invite-only registration: admin invites → agent registers with token
  - Account lockout after repeated failed logins
  - POST /api/leads requires auth (regression for the public-write CVE)
  - /docs disabled in production environment
  - ComTrack /commissions/live takes agent_name from DB, never from request
  - CSRF: cookie auth without X-CSRF-Token rejected on state-changing methods

All tests use the in-process TestClient + mongomock-motor — no external
services are touched.
"""
import os
import pytest


# ── Health ──────────────────────────────────────────────────────────────────
def test_root(client, db):
    r = client.get("/api/")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "hipaa_safeguards" in body


def test_health(client, db):
    r = client.get("/api/health")
    assert r.status_code == 200
    # /health used to echo MongoDB error/version. It must now only return status.
    body = r.json()
    assert set(body.keys()) == {"status"}


# ── Docs disabled in production ─────────────────────────────────────────────
def test_docs_disabled_in_production(monkeypatch):
    """/docs and /openapi.json must be unreachable when ENVIRONMENT != development.

    We re-import server with ENVIRONMENT=production in a fresh module to test
    the gating, since the IS_DEV branch is evaluated at module load.
    """
    import importlib, sys, importlib.util
    # Build the production app inside an isolated module load.
    monkeypatch.setenv("ENVIRONMENT", "production")
    # Force re-import of server
    sys.modules.pop("server", None)
    prod_server = importlib.import_module("server")
    try:
        assert prod_server.app.docs_url is None
        assert prod_server.app.openapi_url is None
        assert prod_server.app.redoc_url is None
    finally:
        # Restore dev-mode server for the rest of the suite.
        monkeypatch.setenv("ENVIRONMENT", "development")
        sys.modules.pop("server", None)
        importlib.import_module("server")


# ── Invite-only registration ────────────────────────────────────────────────
def test_open_registration_blocked(client, db):
    """Registration without an invite_token must be refused."""
    r = client.post("/api/auth/register", json={
        "email": "walkin@example.com",
        "password": "WalkInPass!2026",
        "full_name": "Walk In",
        "agency_name": "No Invite",
    })
    assert r.status_code == 403
    assert "invite" in r.json()["detail"].lower()


def test_full_invite_flow_creates_pending_agent(client, db, admin_headers):
    """Admin invites → agent registers with token → agent is pending."""
    invite_resp = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "new.agent@example.com",
        "full_name": "Jane Agent",
        "agency_name": "Acme Health",
        "agent_name": "Jane Agent",
        "agent_npn": "12345678",
    })
    assert invite_resp.status_code == 201, invite_resp.text
    body = invite_resp.json()
    raw_token = body["token"]
    assert raw_token
    assert body["invite_url"].endswith(f"token={raw_token}")

    # Token validates and exposes the invite fields
    val = client.get(f"/api/auth/invite/validate?token={raw_token}")
    assert val.status_code == 200, val.text
    assert val.json()["email"] == "new.agent@example.com"
    assert val.json()["agent_npn"] == "12345678"

    # Register with the token — wrong email is rejected
    bad = client.post("/api/auth/register", json={
        "email": "different@example.com",
        "password": "AgentPass!2026",
        "full_name": "Jane Agent",
        "agency_name": "Acme Health",
        "invite_token": raw_token,
    })
    assert bad.status_code == 400

    # Correct email succeeds
    reg = client.post("/api/auth/register", json={
        "email": "new.agent@example.com",
        "password": "AgentPass!2026",
        "full_name": "Jane Agent",
        "agency_name": "Acme Health",
        "invite_token": raw_token,
    })
    assert reg.status_code == 201, reg.text
    user = reg.json()
    assert user["status"] == "pending"
    assert user["agent_npn"] == "12345678"
    assert user["agent_name"] == "Jane Agent"
    assert user["is_active"] is False


def test_invite_token_single_use(client, db, admin_headers):
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "once@example.com",
        "full_name": "Once",
        "agency_name": "Single Use",
    }).json()
    raw = inv["token"]
    r1 = client.post("/api/auth/register", json={
        "email": "once@example.com", "password": "OncePass!2026",
        "full_name": "Once", "agency_name": "Single Use",
        "invite_token": raw,
    })
    assert r1.status_code == 201
    r2 = client.post("/api/auth/register", json={
        "email": "once@example.com", "password": "OncePass!2026",
        "full_name": "Once", "agency_name": "Single Use",
        "invite_token": raw,
    })
    assert r2.status_code == 400


def test_npn_must_be_digits(client, db, admin_headers):
    r = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "badnpn@example.com",
        "agent_npn": "abc123",
    })
    assert r.status_code == 422


# ── Account lockout ─────────────────────────────────────────────────────────
def test_account_lockout_after_repeated_failures(client, db):
    """The deps layer locks out after 5 attempts. Hit that ceiling and verify
    the next attempt comes back 423 with a lockout message."""
    email = os.environ["SEED_ADMIN_EMAIL"]
    for _ in range(5):
        r = client.post("/api/auth/login", json={
            "email": email, "password": "definitely-wrong",
        })
        assert r.status_code in (401, 423)
    locked = client.post("/api/auth/login", json={
        "email": email, "password": "definitely-wrong",
    })
    assert locked.status_code == 423
    assert "locked" in locked.json()["detail"].lower()


# ── POST /leads now requires auth ───────────────────────────────────────────
async def test_anonymous_lead_post_rejected(client, db):
    """Without any auth artefact, the request is blocked before reaching the
    DB. Either 401 (no token) or 403 (CSRF middleware fires first) is fine —
    the security guarantee is that no lead row gets written.
    """
    r = client.post("/api/leads", json={
        "first_name": "Anon", "last_name": "Attacker",
        "phone": "555-0000",
    })
    assert r.status_code in (401, 403), r.text
    # And nothing landed in the leads collection.
    count = await db.leads.count_documents({})
    assert count == 0


def test_authenticated_lead_post_succeeds(client, db, admin_headers):
    r = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Test", "last_name": "Lead",
        "phone": "555-1234",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["first_name"] == "Test"


# ── ComTrack live endpoint sources agent_name from DB ───────────────────────
@pytest.mark.asyncio
async def test_commissions_live_400_without_agent_name(client, db, admin_headers):
    """Default admin has no agent_name set — endpoint must 400."""
    r = client.get("/api/commissions/live", headers=admin_headers)
    assert r.status_code == 400
    assert "Agent name not configured" in r.json()["detail"]


@pytest.mark.asyncio
async def test_commissions_live_uses_db_agent_name_not_query(client, db, admin_headers):
    """Even if the client tries to inject a different agent via query param,
    the endpoint must use the DB row's agent_name."""
    # Patch the admin row to have an agent_name.
    await db.users.update_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]},
        {"$set": {"agent_name": "Real Admin"}},
    )

    captured = {}
    from unittest.mock import patch

    async def fake_get_rows(self, agent_name):
        captured["agent_name"] = agent_name
        return []

    with patch("commissions_router.ComtrackClient.get_rows", fake_get_rows):
        # Attempt IDOR: pass a tampered agent_name in query (must be ignored).
        r = client.get(
            "/api/commissions/live?agent_name=Someone%20Else",
            headers=admin_headers,
        )
        assert r.status_code == 200, r.text
        assert captured["agent_name"] == "Real Admin"
        assert r.json()["agent_name"] == "Real Admin"


@pytest.mark.asyncio
async def test_commissions_live_503_on_upstream_error(client, db, admin_headers):
    await db.users.update_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]},
        {"$set": {"agent_name": "Bob"}},
    )
    import httpx
    from unittest.mock import patch

    async def boom(self, agent_name):
        raise httpx.RequestError("upstream is down")

    with patch("commissions_router.ComtrackClient.get_rows", boom):
        r = client.get("/api/commissions/live", headers=admin_headers)
        assert r.status_code == 503
        # Error detail must be generic — never leak upstream message.
        assert "temporarily unavailable" in r.json()["detail"]
        assert "upstream is down" not in r.json()["detail"]


@pytest.mark.asyncio
async def test_commissions_live_audit_logged(client, db, admin_headers):
    await db.users.update_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]},
        {"$set": {"agent_name": "Audited Agent"}},
    )
    from unittest.mock import patch

    async def empty(self, agent_name):
        return []

    with patch("commissions_router.ComtrackClient.get_rows", empty):
        client.get("/api/commissions/live", headers=admin_headers)

    found = await db.audit_logs.find_one({"event_type": "commission_data_access"})
    assert found is not None
    assert found["metadata"]["agent_name"] == "Audited Agent"
    assert found["metadata"]["status"] == "success"


# ── CSRF protection ─────────────────────────────────────────────────────────
def test_csrf_required_on_cookie_state_changing_requests(client, db):
    """When the caller authenticates via cookie (no Authorization header),
    state-changing requests must carry a matching X-CSRF-Token."""
    # Log in to plant cookies.
    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert login.status_code == 200
    # Cookies are now in the TestClient jar. POST without X-CSRF-Token is 403.
    no_csrf = client.post("/api/leads", json={
        "first_name": "T", "last_name": "C",
    })
    assert no_csrf.status_code == 403
    assert "CSRF" in no_csrf.json()["detail"]

    # Same call with the correct CSRF header succeeds.
    csrf = client.cookies.get("ghw_csrf_token")
    assert csrf
    with_csrf = client.post(
        "/api/leads",
        json={"first_name": "T", "last_name": "C"},
        headers={"X-CSRF-Token": csrf},
    )
    assert with_csrf.status_code == 201, with_csrf.text


def test_csrf_exempt_for_authorization_bearer(client, db, admin_token):
    """The Bearer-header auth path is not CSRF-exploitable (browsers don't
    auto-send custom Authorization headers cross-origin). Verify the
    middleware allows it through."""
    r = client.post(
        "/api/leads",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"first_name": "BearerCSRF", "last_name": "Ok"},
    )
    assert r.status_code == 201


# ── Logout clears cookies ───────────────────────────────────────────────────
def test_logout_clears_cookies(client, db):
    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert login.status_code == 200
    assert "ghw_access_token" in client.cookies
    csrf = client.cookies.get("ghw_csrf_token")
    out = client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf})
    assert out.status_code == 200
    # After logout the cookies should be cleared from the jar.
    assert client.cookies.get("ghw_access_token") in (None, "", '""')


# ── Admin profile PATCH ─────────────────────────────────────────────────────
def test_admin_can_patch_agent_profile(client, db, admin_headers):
    """PATCH /api/auth/users/{id}/profile is admin-only and updates the
    DB row + audit-logs."""
    # Create another user via invite + register.
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "target@example.com",
        "full_name": "Target Agent",
        "agency_name": "T",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "target@example.com",
        "password": "TargetPass!2026",
        "full_name": "Target Agent",
        "agency_name": "T",
        "invite_token": inv["token"],
    })
    assert reg.status_code == 201
    user_id = reg.json()["id"]

    # Admin patches identity fields.
    patch = client.patch(
        f"/api/auth/users/{user_id}/profile",
        headers=admin_headers,
        json={"agent_name": "  Patched Name  ", "agent_npn": "987654"},
    )
    assert patch.status_code == 200, patch.text
    body = patch.json()
    assert body["agent_name"] == "Patched Name"  # whitespace trimmed
    assert body["agent_npn"] == "987654"
