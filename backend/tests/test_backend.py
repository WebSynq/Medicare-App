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
import json
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
    """When agent_name is missing the endpoint must 400.

    The Phase 1 startup backfill stamps agent_name = full_name, so the
    seeded test admin no longer has a null agent_name by default. We
    explicitly null it here to exercise the missing-agent-name code path.
    """
    await db.users.update_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]},
        {"$set": {"agent_name": None}},
    )
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
    state-changing requests on protected paths must carry a matching
    X-CSRF-Token.

    /api/leads is in the CSRF exempt list (resource-root + prefix
    exempts cover the lead/clients/applications/documents/ghl trees) so
    we point this test at /api/soa/sign — which is still CSRF-protected
    and exercises the same middleware decision tree.
    """
    # Log in to plant cookies.
    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert login.status_code == 200
    # Cookies are now in the TestClient jar. POST without X-CSRF-Token is 403.
    no_csrf = client.post("/api/soa/sign", json={})
    assert no_csrf.status_code == 403, no_csrf.text
    assert "CSRF" in no_csrf.json()["detail"]

    # Same call with the correct CSRF header makes it PAST the CSRF
    # middleware. The body is intentionally empty so we expect a 422
    # validation error from the handler — anything other than 403/401
    # is proof CSRF was satisfied.
    csrf = client.cookies.get("ghw_csrf_token")
    assert csrf
    with_csrf = client.post(
        "/api/soa/sign",
        json={},
        headers={"X-CSRF-Token": csrf},
    )
    assert with_csrf.status_code != 403, with_csrf.text


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


def test_csrf_exempt_commission_chat(client, db, monkeypatch):
    """POST /api/commission/chat is on the CSRF exempt list. A cookie-authed
    call without X-CSRF-Token must not 403 — it should make it through to
    the auth + endpoint logic."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    captured = {}
    fake = _make_fake_anthropic_client(captured, {
        "reply": "csrf-exempt path", "suggested_actions": [],
    })
    import anthropic
    monkeypatch.setattr(anthropic, "AsyncAnthropic", fake)

    # Plant the cookie via login (no auth header used for the chat call).
    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert login.status_code == 200

    # POST without X-CSRF-Token. Pre-exemption this was 403; post-exemption
    # the request reaches the endpoint and returns 200.
    r = client.post("/api/commission/chat", json={"message": "ping"})
    assert r.status_code == 200, r.text
    assert r.json()["reply"] == "csrf-exempt path"


async def test_csrf_exempt_commission_audit_mark_resolved(client, db, admin_headers):
    """POST /api/commission/audit/mark-resolved/{record_id} is exempt via
    prefix match. We log in as admin to get the cookie, then call the
    endpoint via cookie auth without X-CSRF-Token — should reach the
    endpoint (200) instead of being stopped at CSRF (403)."""
    await _seed_production_rows(db, [{
        "natural_key": "csrf-exempt-key", "agent_name": "Alice",
        "revenue_expected": 500, "revenue_received": 400,
    }])

    # Plant cookies via cookie-authed login.
    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert login.status_code == 200
    # Strip the Authorization header path — TestClient never adds one;
    # the only credential travelling is the cookie. No X-CSRF-Token header.
    r = client.post(
        "/api/commission/audit/mark-resolved/csrf-exempt-key",
        json={"notes": "csrf-exempt prefix path"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "resolved"


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


# ── Commission audit endpoints ──────────────────────────────────────────────
async def _seed_production_rows(db, rows):
    """Helper: seed production_records with a list of partial dicts."""
    from datetime import datetime as _dt, timezone as _tz
    now = _dt.now(_tz.utc).isoformat()
    for i, r in enumerate(rows):
        doc = {
            "natural_key": r.get("natural_key", f"nk-{i}"),
            "agent_email": r.get("agent_email"),
            "agent_name": r.get("agent_name"),
            "policy_number": r.get("policy_number", f"POL-{i}"),
            "carrier": r.get("carrier", "Aetna"),
            "product": r.get("product", "Cancer/H&S"),
            "state": r.get("state", "IL"),
            "effective_date": r.get("effective_date",
                                     _dt.now(_tz.utc).date().isoformat()),
            "premium_monthly": r.get("premium_monthly", 100.0),
            "premium_annual": r.get("premium_annual", 1200.0),
            "revenue_expected": r.get("revenue_expected"),
            "revenue_received": r.get("revenue_received"),
            "audit_status": r.get("audit_status", "pending"),
            "audit_notes": None,
            "ab_synced": r.get("ab_synced", False),
            "imported_at": now,
            "updated_at": now,
        }
        await db.production_records.insert_one(doc)


async def test_commission_audit_list_admin_sees_all(client, db, admin_headers):
    await _seed_production_rows(db, [
        {"agent_name": "Alice", "revenue_expected": 500, "revenue_received": 400},
        {"agent_name": "Bob",   "revenue_expected": 300, "revenue_received": 300},
    ])
    r = client.get("/api/commission/audit?period=all", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 2
    # Underpaid (Alice) sorts above matched (Bob) by absolute gap.
    assert body["records"][0]["agent_name"] == "Alice"
    assert body["records"][0]["status"] == "underpaid"
    assert body["records"][0]["gap"] == -100
    assert body["records"][1]["status"] == "matched"


async def test_commission_audit_idor_agent_scoped(client, db, admin_headers):
    """An agent must never see another agent's records, even by guessing an
    agent_id. We invite + register an agent, give them an agent_name,
    seed a row owned by Alice, and confirm the agent sees zero records.
    """
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "agent.bob@example.com", "full_name": "Bob",
        "agency_name": "B", "agent_name": "Bob",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "agent.bob@example.com", "password": "BobPass!2026",
        "full_name": "Bob", "agency_name": "B",
        "invite_token": inv["token"],
    })
    # Admin approves so login works.
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)
    login = client.post("/api/auth/login", json={
        "email": "agent.bob@example.com", "password": "BobPass!2026",
    })
    bob_token = login.json()["access_token"]
    bob_headers = {"Authorization": f"Bearer {bob_token}"}

    await _seed_production_rows(db, [
        {"agent_name": "Alice", "revenue_expected": 500,
         "revenue_received": 400},
        {"agent_name": "Bob",   "revenue_expected": 200,
         "revenue_received": 200},
    ])

    # Bob's own view — only his record
    own = client.get("/api/commission/audit?period=all", headers=bob_headers)
    assert own.status_code == 200
    assert own.json()["total"] == 1
    assert own.json()["records"][0]["agent_name"] == "Bob"

    # Even if Bob tries agent_id=admin (admin-only param), the agent_id
    # filter is ignored for non-admin and the scope filter still applies.
    admin_id = (await db.users.find_one(
        {"role": "admin"}, {"_id": 0, "id": 1}
    ))["id"]
    sneaky = client.get(
        f"/api/commission/audit?period=all&agent_id={admin_id}",
        headers=bob_headers,
    )
    assert sneaky.status_code == 200
    # Result is still Bob's own record, not Alice's or admin's.
    for row in sneaky.json()["records"]:
        assert row["agent_name"] == "Bob"


async def test_commission_audit_summary(client, db, admin_headers):
    await _seed_production_rows(db, [
        {"revenue_expected": 500, "revenue_received": 400},   # underpaid -100
        {"revenue_expected": 300, "revenue_received": 350},   # overpaid  +50
        {"revenue_expected": 200, "revenue_received": 200},   # matched     0
        {"revenue_expected": 100, "revenue_received": None},  # missing  -100
    ])
    r = client.get("/api/commission/audit/summary?period=all",
                    headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["policies"] == 4
    assert body["total_expected"] == 1100
    assert body["total_received"] == 950
    assert body["total_gap"] == -150
    assert body["count_by_status"]["underpaid"] == 1
    assert body["count_by_status"]["overpaid"] == 1
    assert body["count_by_status"]["matched"] == 1
    assert body["count_by_status"]["missing"] == 1


async def test_commission_audit_mark_resolved_admin_only(client, db, admin_headers):
    await _seed_production_rows(db, [
        {"natural_key": "to-resolve", "revenue_expected": 500,
         "revenue_received": 400, "agent_name": "Alice"},
    ])

    # Non-admin agent gets 403 (require_roles admin)
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "agent.sam@example.com", "full_name": "Sam",
        "agency_name": "S", "agent_name": "Sam",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "agent.sam@example.com", "password": "SamPass!2026",
        "full_name": "Sam", "agency_name": "S",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)
    sam_login = client.post("/api/auth/login", json={
        "email": "agent.sam@example.com", "password": "SamPass!2026",
    })
    sam_headers = {"Authorization": f"Bearer {sam_login.json()['access_token']}"}

    nope = client.post(
        "/api/commission/audit/mark-resolved/to-resolve",
        headers=sam_headers,
        json={"notes": "tried"},
    )
    assert nope.status_code == 403

    # Admin can mark it
    ok = client.post(
        "/api/commission/audit/mark-resolved/to-resolve",
        headers=admin_headers,
        json={"notes": "Carrier paid the gap manually on 2026-05-15."},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "resolved"
    assert ok.json()["audit_notes"].startswith("Carrier paid")

    # And the audit log captured it
    entry = await db.audit_logs.find_one({"event_type": "commission_audit_resolved"})
    assert entry is not None
    assert entry["metadata"]["policy_number"]


# ── Commission AI chat endpoint ─────────────────────────────────────────────
class _FakeUsage:
    def __init__(self, input_tokens=100, output_tokens=200,
                 cache_read_input_tokens=0):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_read_input_tokens = cache_read_input_tokens
        self.cache_creation_input_tokens = 0


class _FakeBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeAnthropicResponse:
    def __init__(self, payload):
        self.content = [_FakeBlock(json.dumps(payload))]
        self.usage = _FakeUsage()
        self.stop_reason = "end_turn"


def _make_fake_anthropic_client(captured: dict, payload: dict):
    """Builds a stand-in for anthropic.AsyncAnthropic with a single
    `messages.create` coroutine that records its kwargs and returns a
    fixed payload."""

    async def fake_create(**kwargs):
        captured["kwargs"] = kwargs
        return _FakeAnthropicResponse(payload)

    class _Messages:
        create = staticmethod(fake_create)

    class _FakeClient:
        def __init__(self, api_key=None):
            captured["api_key_received"] = api_key
            self.messages = _Messages()

    return _FakeClient


async def test_commission_chat_returns_structured_reply(client, db,
                                                          admin_headers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    await _seed_production_rows(db, [
        {"agent_name": "Alice", "revenue_expected": 500, "revenue_received": 400,
         "carrier": "Aetna", "policy_number": "POL-1"},
    ])

    captured = {}
    fake_payload = {
        "reply": "Aetna underpaid POL-1 by $100.",
        "suggested_actions": ["Draft dispute letter to Aetna for POL-1"],
    }
    fake_cls = _make_fake_anthropic_client(captured, fake_payload)
    # Patch the lazy import inside commission_audit_router
    import anthropic
    monkeypatch.setattr(anthropic, "AsyncAnthropic", fake_cls)

    r = client.post("/api/commission/chat", headers=admin_headers,
                     json={"message": "Which carrier underpaid me?"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reply"].startswith("Aetna underpaid")
    assert body["suggested_actions"] == ["Draft dispute letter to Aetna for POL-1"]

    # API key was read from env, not from request
    assert captured["api_key_received"] == "test-anthropic-key"
    # Model + cache_control wired correctly
    kw = captured["kwargs"]
    assert kw["model"] == "claude-sonnet-4-6"
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kw["thinking"] == {"type": "adaptive"}
    # Context is injected in the user message
    user_content = kw["messages"][0]["content"]
    assert "commission_context" in user_content
    assert "POL-1" in user_content


async def test_commission_chat_503_when_api_key_missing(client, db,
                                                          admin_headers, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/commission/chat", headers=admin_headers,
                     json={"message": "Anything?"})
    assert r.status_code == 503
    assert "temporarily unavailable" in r.json()["detail"]
    # And the gap is audit-logged
    entry = await db.audit_logs.find_one({"event_type": "commission_chat_unavailable"})
    assert entry is not None


async def test_commission_chat_idor_scoped_context(client, db,
                                                      admin_headers, monkeypatch):
    """An agent's chat must only inject their own production records as
    context. Even if another agent's row exists in the DB, it must not
    appear in the prompt sent to Anthropic."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    # Invite + register + approve Bob
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "agent.idor@example.com", "full_name": "Idor Bob",
        "agency_name": "B", "agent_name": "Idor Bob",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "agent.idor@example.com", "password": "IdorPass!2026",
        "full_name": "Idor Bob", "agency_name": "B",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)
    bob_login = client.post("/api/auth/login", json={
        "email": "agent.idor@example.com", "password": "IdorPass!2026",
    })
    bob_headers = {"Authorization": f"Bearer {bob_login.json()['access_token']}"}

    await _seed_production_rows(db, [
        {"agent_name": "Alice", "policy_number": "ALICE-001",
         "revenue_expected": 999},
        {"agent_name": "Idor Bob", "policy_number": "BOB-001",
         "revenue_expected": 100},
    ])

    captured = {}
    fake = _make_fake_anthropic_client(captured, {
        "reply": "ok", "suggested_actions": [],
    })
    import anthropic
    monkeypatch.setattr(anthropic, "AsyncAnthropic", fake)

    r = client.post("/api/commission/chat", headers=bob_headers,
                     json={"message": "Show me everything you know."})
    assert r.status_code == 200, r.text
    sent = captured["kwargs"]["messages"][0]["content"]
    assert "BOB-001" in sent
    # Alice's record must not be in the prompt the model receives
    assert "ALICE-001" not in sent


async def test_commission_chat_rate_limit_per_user(client, db,
                                                      admin_headers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    captured = {}
    fake = _make_fake_anthropic_client(captured, {"reply": "ok",
                                                    "suggested_actions": []})
    import anthropic
    monkeypatch.setattr(anthropic, "AsyncAnthropic", fake)

    # Burn the 20-call budget
    for _ in range(20):
        r = client.post("/api/commission/chat", headers=admin_headers,
                         json={"message": "ping"})
        assert r.status_code == 200, r.text
    # 21st call is throttled
    limited = client.post("/api/commission/chat", headers=admin_headers,
                            json={"message": "ping"})
    assert limited.status_code == 429
    assert "Rate limit" in limited.json()["detail"]


async def test_commission_chat_audit_logged(client, db, admin_headers, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    captured = {}
    fake = _make_fake_anthropic_client(captured, {
        "reply": "Here are your top gaps.",
        "suggested_actions": ["Review POL-1", "Mark POL-2 resolved"],
    })
    import anthropic
    monkeypatch.setattr(anthropic, "AsyncAnthropic", fake)

    client.post("/api/commission/chat", headers=admin_headers,
                 json={"message": "What are my biggest gaps?"})
    entry = await db.audit_logs.find_one({"event_type": "commission_chat"})
    assert entry is not None
    assert entry["metadata"]["actions_count"] == 2
    assert "biggest gaps" in entry["metadata"]["question_excerpt"]


# ── /leaderboard endpoint ────────────────────────────────────────────────────
def test_leaderboard_requires_auth(client, db):
    r = client.get("/api/leaderboard")
    assert r.status_code == 401


async def test_leaderboard_aggregates_from_production_records(client, db,
                                                                admin_headers):
    await _seed_production_rows(db, [
        # Alice: 2 policies, $1000 expected, $200 short
        {"agent_name": "Alice", "policy_number": "A-1",
         "revenue_expected": 500, "revenue_received": 400},  # gap -100
        {"agent_name": "Alice", "policy_number": "A-2",
         "revenue_expected": 500, "revenue_received": 400},  # gap -100
        # Bob: 1 policy, $300 expected, matched
        {"agent_name": "Bob", "policy_number": "B-1",
         "revenue_expected": 300, "revenue_received": 300},
        # Carol: 1 policy, $200 expected, resolved (should NOT count toward gap)
        {"agent_name": "Carol", "policy_number": "C-1",
         "revenue_expected": 200, "revenue_received": 100,
         "audit_status": "resolved"},
    ])
    r = client.get("/api/leaderboard?period=all", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()

    by_name = {row["agent_name"]: row for row in body["rows"]}
    # Alice
    assert by_name["Alice"]["revenue_total"] == 1000
    assert by_name["Alice"]["audit_gap"] == -200
    assert by_name["Alice"]["policies_count"] == 2
    # Bob (matched)
    assert by_name["Bob"]["revenue_total"] == 300
    assert by_name["Bob"]["audit_gap"] == 0
    assert by_name["Bob"]["policies_count"] == 1
    # Carol — resolved gap excluded
    assert by_name["Carol"]["revenue_total"] == 200
    assert by_name["Carol"]["audit_gap"] == 0
    assert by_name["Carol"]["policies_count"] == 1

    # Ranking: Alice ($1000) > Bob ($300) > Carol ($200)
    assert [row["agent_name"] for row in body["rows"]] == ["Alice", "Bob", "Carol"]
    assert body["rows"][0]["rank"] == 1
    assert body["rows"][1]["rank"] == 2
    assert body["rows"][2]["rank"] == 3


async def test_leaderboard_marks_is_self(client, db, admin_headers):
    """An agent's own row is flagged via is_self for UI highlighting."""
    # Invite + register Bob. Phase 1: register stamps agent_name = full_name
    # so we use "Bob" for full_name to keep it aligned with the production
    # rows seeded below (which key off agent_name).
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "lb.bob@example.com", "full_name": "Bob",
        "agency_name": "B", "agent_name": "Bob",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "lb.bob@example.com", "password": "LbBobPass!2026",
        "full_name": "Bob", "agency_name": "B",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)
    bob_login = client.post("/api/auth/login", json={
        "email": "lb.bob@example.com", "password": "LbBobPass!2026",
    })
    bob_headers = {"Authorization": f"Bearer {bob_login.json()['access_token']}"}

    await _seed_production_rows(db, [
        {"agent_name": "Alice", "revenue_expected": 500},
        {"agent_name": "Bob", "revenue_expected": 300},
    ])

    r = client.get("/api/leaderboard?period=all", headers=bob_headers)
    assert r.status_code == 200
    by_name = {row["agent_name"]: row for row in r.json()["rows"]}
    assert by_name["Bob"]["is_self"] is True
    assert by_name["Alice"]["is_self"] is False


async def test_leaderboard_audit_logged(client, db, admin_headers):
    client.get("/api/leaderboard?period=month", headers=admin_headers)
    entry = await db.audit_logs.find_one({"event_type": "leaderboard_viewed"})
    assert entry is not None
    assert entry["metadata"]["period"] == "month"


# ── ComTrack daily sync ─────────────────────────────────────────────────────
async def test_comtrack_sync_status_admin_only(client, db, admin_headers):
    """GET /api/commission/sync/status returns 403 for non-admins."""
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "agent.peep@example.com", "full_name": "Peep",
        "agency_name": "P", "agent_name": "Peep",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "agent.peep@example.com", "password": "PeepPass!2026",
        "full_name": "Peep", "agency_name": "P",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)
    peep_login = client.post("/api/auth/login", json={
        "email": "agent.peep@example.com", "password": "PeepPass!2026",
    })
    peep_headers = {"Authorization": f"Bearer {peep_login.json()['access_token']}"}

    nope = client.get("/api/commission/sync/status", headers=peep_headers)
    assert nope.status_code == 403

    ok = client.get("/api/commission/sync/status", headers=admin_headers)
    assert ok.status_code == 200
    assert ok.json()["last_run"] is None  # no runs yet
    assert ok.json()["mock_mode"] is True


async def test_comtrack_sync_runs_and_updates_records(client, db, admin_headers):
    """End-to-end: seed agent + production record, run sync, observe write-back."""
    # Seed an agent user with an agent_name matching what we'll put on the
    # production record below. ComtrackClient.mock returns its mock rows with
    # the requested agent_name applied to every row.
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "agent.demo@example.com", "full_name": "Demo Agent",
        "agency_name": "D", "agent_name": "Demo Agent",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "agent.demo@example.com", "password": "DemoPass!2026",
        "full_name": "Demo Agent", "agency_name": "D",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)

    # Production record with revenue_expected near the mock's commission so
    # the resulting ratio lands in the matched band (mock row commission
    # for MOCK-001 = 278.69; expected 280 → ratio 0.995 → matched).
    await _seed_production_rows(db, [
        {"natural_key": "sync-test-1", "agent_name": "Demo Agent",
         "carrier": "Aetna", "policy_number": "MOCK-001",
         "revenue_expected": 280.0, "revenue_received": None},
    ])

    # Manual trigger (same code path as scheduled job)
    r = client.post("/api/commission/sync/run", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["agents_processed"] >= 1
    assert body["records_updated"] >= 1
    assert body["mock_mode"] is True

    # Record now has revenue_received populated and audit_status flipped.
    updated = await db.production_records.find_one({"natural_key": "sync-test-1"})
    assert updated["revenue_received"] == 278.69
    assert updated["audit_status"] == "matched"
    assert updated.get("comtrack_synced_at")

    # And /sync/status now returns the last run.
    status = client.get("/api/commission/sync/status", headers=admin_headers)
    assert status.status_code == 200
    assert status.json()["last_run"]["records_updated"] >= 1


async def test_comtrack_sync_skips_resolved(client, db, admin_headers):
    """Sync must never overwrite an admin-resolved row."""
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "agent.resv@example.com", "full_name": "Demo Agent",
        "agency_name": "R", "agent_name": "Demo Agent",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "agent.resv@example.com", "password": "ResvPass!2026",
        "full_name": "Demo Agent", "agency_name": "R",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)

    await _seed_production_rows(db, [
        {"natural_key": "resolved-row", "agent_name": "Demo Agent",
         "carrier": "Aetna", "policy_number": "MOCK-001",
         "revenue_expected": 1000.0, "revenue_received": 100.0,
         "audit_status": "resolved"},
    ])

    r = client.post("/api/commission/sync/run", headers=admin_headers)
    assert r.status_code == 200

    # Untouched: revenue_received and audit_status stay as seeded.
    row = await db.production_records.find_one({"natural_key": "resolved-row"})
    assert row["revenue_received"] == 100.0
    assert row["audit_status"] == "resolved"


def test_classify_from_amounts_bands():
    """Unit-test the shared classifier covers every edge case."""
    from commission_audit_router import _classify_from_amounts as c
    # Null received
    assert c(None, None) == "pending"
    assert c(100, None) == "missing"
    # Zero received
    assert c(0, 0) == "matched"
    assert c(100, 0) == "missing"
    # Null expected
    assert c(None, 50) == "overpaid"
    assert c(None, 0) == "matched"
    # Zero expected with positive received
    assert c(0, 50) == "overpaid"
    # Ratio bands
    assert c(100, 100) == "matched"
    assert c(100, 95) == "matched"     # exactly 0.95 → matched (not <)
    assert c(100, 94) == "underpaid"
    assert c(100, 105) == "matched"    # exactly 1.05 → matched (not >)
    assert c(100, 106) == "overpaid"


# ── Monthly PDF statements ──────────────────────────────────────────────────
async def test_statement_admin_can_download_for_any_agent(
        client, db, admin_headers, tmp_path, monkeypatch):
    """Admin can fetch any agent's monthly statement; on-demand generation
    works even when the scheduled job hasn't fired yet."""
    # Redirect statement output into a per-test temp dir so we don't write
    # to the live secure_storage path.
    import statement_generator as sg
    monkeypatch.setattr(sg, "STATEMENTS_DIR", tmp_path)

    await _seed_production_rows(db, [
        {"agent_name": "Demo Agent", "carrier": "Aetna",
         "policy_number": "POL-101", "effective_date": "2026-04-10",
         "revenue_expected": 500.0, "revenue_received": 480.0},
        {"agent_name": "Demo Agent", "carrier": "Humana",
         "policy_number": "POL-102", "effective_date": "2026-04-22",
         "revenue_expected": 300.0, "revenue_received": None},
        # Outside the target month — must not appear in the statement
        {"agent_name": "Demo Agent", "carrier": "Aetna",
         "policy_number": "POL-103", "effective_date": "2026-03-15",
         "revenue_expected": 999.0, "revenue_received": 999.0},
    ])

    r = client.get(
        "/api/commission/statement/2026/4?agent_name=Demo%20Agent",
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/pdf")
    body = r.content
    assert body.startswith(b"%PDF")
    # Reasonable lower bound; the document has summary + table + footer
    assert len(body) > 1500

    # Audit log
    entry = await db.audit_logs.find_one(
        {"event_type": "commission_statement_downloaded"})
    assert entry is not None
    assert entry["metadata"]["agent_name"] == "Demo Agent"
    assert entry["metadata"]["year"] == 2026
    assert entry["metadata"]["month"] == 4

    # statement_generated audit was written when the file was built
    gen = await db.audit_logs.find_one({"event_type": "statement_generated"})
    assert gen is not None
    assert gen["metadata"]["policies"] == 2  # March row was filtered out


async def test_statement_admin_requires_agent_name(client, admin_headers,
                                                     tmp_path, monkeypatch):
    """Admin call without ?agent_name= must 400 — no all-agents PDF."""
    import statement_generator as sg
    monkeypatch.setattr(sg, "STATEMENTS_DIR", tmp_path)

    r = client.get("/api/commission/statement/2026/4", headers=admin_headers)
    assert r.status_code == 400


async def test_statement_agent_sees_own_only(client, db, admin_headers,
                                               tmp_path, monkeypatch):
    """Agent gets their own statement automatically and ignores ?agent_name."""
    import statement_generator as sg
    monkeypatch.setattr(sg, "STATEMENTS_DIR", tmp_path)

    # Provision an agent
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "agent.alice@example.com", "full_name": "Alice",
        "agency_name": "A", "agent_name": "Alice",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "agent.alice@example.com", "password": "AlicePass!2026",
        "full_name": "Alice", "agency_name": "A",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve",
                headers=admin_headers)
    alice_login = client.post("/api/auth/login", json={
        "email": "agent.alice@example.com", "password": "AlicePass!2026",
    })
    alice_headers = {"Authorization":
                     f"Bearer {alice_login.json()['access_token']}"}

    await _seed_production_rows(db, [
        {"agent_name": "Alice", "carrier": "Aetna",
         "policy_number": "A-1", "effective_date": "2026-04-05",
         "revenue_expected": 200.0, "revenue_received": 200.0},
        {"agent_name": "Bob", "carrier": "Aetna",
         "policy_number": "B-1", "effective_date": "2026-04-05",
         "revenue_expected": 9999.0, "revenue_received": 9999.0},
    ])

    # Agent passes ?agent_name=Bob in an attempt to fetch Bob's PDF — the
    # server must ignore the query param for non-admins.
    r = client.get("/api/commission/statement/2026/4?agent_name=Bob",
                    headers=alice_headers)
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")

    # Verify the audited row says target_name=Alice, not Bob.
    entry = await db.audit_logs.find_one(
        {"event_type": "commission_statement_downloaded",
         "actor_email": "agent.alice@example.com"})
    assert entry is not None
    assert entry["metadata"]["agent_name"] == "Alice"


def test_slugify_handles_messy_names():
    from statement_generator import _slugify
    assert _slugify("Tim Dazey") == "tim_dazey"
    assert _slugify("Connor O'Reilly") == "connor_o_reilly"
    assert _slugify("Leadership (Chase Gruening)") == "leadership_chase_gruening"
    assert _slugify("") == "agent"
    assert _slugify("   ") == "agent"



# ── Bidirectional GHL sync ──────────────────────────────────────────────────
#
# These three tests cover the bidirectional flow we shipped on top of
# the inbound webhook bridge:
#   1. Creating a lead via POST /api/leads stamps the GHL contact id
#      (mock mode produces a deterministic "mock_<lead_id>" string).
#   2. An inbound webhook with a `date_updated` AFTER the existing
#      lead's `updated_at` applies the GHL field changes.
#   3. An inbound webhook with a `date_updated` BEFORE the existing
#      lead's `updated_at` is skipped (portal_wins_conflict) and the
#      lead row is left untouched.

def test_create_lead_stamps_ghl_contact_id(client, db, admin_headers):
    """POST /api/leads → _sync_lead_to_ghl runs in mock mode (no
    GHL_PRIVATE_TOKEN) and stamps a mock_<id> ghl_contact_id."""
    r = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Bi", "last_name": "Sync",
        "phone": "555-7777",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ghl_contact_id"], "ghl_contact_id should be stamped after sync"
    assert body["ghl_contact_id"].startswith("mock_")
    # Mock mode lands as "mock", not "synced", so frontend can distinguish.
    assert body["ghl_sync_status"] in ("mock", "synced")
    assert body["ghl_synced_at"] is not None


@pytest.mark.asyncio
async def test_webhook_newer_updates_portal(client, db, admin_headers):
    """A webhook whose dateUpdated > portal updated_at applies its
    contact-info changes and audit-logs ghl_wins_conflict."""
    from datetime import datetime, timezone, timedelta
    # Seed an existing lead that was updated 1h ago.
    one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await db.leads.insert_one({
        "id": "lead-newer",
        "ghl_contact_id": "gc-newer",
        "first_name": "Old", "last_name": "Name",
        "email": "old@x.com",
        "agent_id": "admin-1",
        "agent_name": "Admin",
        "status": "new",
        "soa_signed": False, "document_ids": [],
        "ghl_sync_status": "synced",
        "created_via": "intake",
        "created_at": one_hour_ago,
        "updated_at": one_hour_ago,
    })
    # Webhook claims a more recent dateUpdated.
    payload = {
        "type": "ContactUpdate",
        "locationId": "L1",
        "contact": {
            "id": "gc-newer",
            "firstName": "Newer",
            "lastName": "Name",
            "dateUpdated": datetime.now(timezone.utc).isoformat(),
        },
    }
    # GHL_WEBHOOK_SECRET is unset in the test env → signature skipped.
    r = client.post("/api/ghl/webhook", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["action"] == "updated"
    assert body["conflict"] == "ghl_wins_conflict"
    # Lead was actually modified.
    doc = await db.leads.find_one({"id": "lead-newer"})
    assert doc["first_name"] == "Newer"


@pytest.mark.asyncio
async def test_webhook_older_skipped_portal_wins(client, db, admin_headers):
    """A webhook whose dateUpdated < portal updated_at is rejected with
    portal_wins_conflict and the lead row is NOT modified."""
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc).isoformat()
    long_ago = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    await db.leads.insert_one({
        "id": "lead-older",
        "ghl_contact_id": "gc-older",
        "first_name": "Portal", "last_name": "Wins",
        "email": "p@x.com",
        "agent_id": "admin-1",
        "status": "new",
        "soa_signed": False, "document_ids": [],
        "ghl_sync_status": "synced",
        "created_via": "intake",
        "created_at": long_ago,
        "updated_at": now,
    })
    payload = {
        "type": "ContactUpdate",
        "locationId": "L1",
        "contact": {
            "id": "gc-older",
            "firstName": "ShouldNotApply",
            "dateUpdated": long_ago,
        },
    }
    r = client.post("/api/ghl/webhook", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["action"] == "skipped_portal_wins"
    assert body["conflict"] == "portal_wins_conflict"
    # Row is untouched.
    doc = await db.leads.find_one({"id": "lead-older"})
    assert doc["first_name"] == "Portal"


# ── Dashboard stats endpoint ────────────────────────────────────────────────
def test_dashboard_stats_admin_returns_quote_and_agency_view(client, db, admin_headers):
    """Admin (no impersonation) sees agency-wide view, daily quote, and
    the per-agent breakdown block."""
    r = client.get("/api/dashboard/stats", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    # Daily quote is present and shaped correctly
    assert "daily_quote" in body
    assert body["daily_quote"]["text"]
    assert body["daily_quote"]["author"]
    assert body["daily_quote"]["category"] in {"mindset", "sales", "discipline", "winning"}
    # Agency view contains admin-only extras
    assert body["scope"] == "agency"
    assert body["impersonating"] is False
    assert "agents_active" in body
    assert "agent_breakdown" in body
    # Standard sections are present
    assert "leads_total" in body
    assert "revenue_by_month" in body and len(body["revenue_by_month"]) == 6
    assert "pipeline_funnel" in body
    assert "alerts" in body
    assert "recent_activity" in body


def test_dashboard_quote_stable_within_day():
    """The quote selector is a pure function of UTC day-of-year — two
    calls back-to-back must yield the same line. Regression guard for
    accidental randomisation."""
    from dashboard_router import _quote_for_today
    q1 = _quote_for_today()
    q2 = _quote_for_today()
    assert q1 == q2
    assert q1["text"]


# ── Application submission auto-create / search auto-import ─────────────────
@pytest.mark.asyncio
async def test_submit_application_auto_creates_lead(client, db, admin_headers):
    """Submitting a policy for a brand-new contact must create the
    portal lead row, stamp a GHL contact id (mock), save the policy
    with lead_id, and return lead_id in the response."""
    payload = {
        "contact_id": "",  # no GHL id yet — auto-create path
        "product_type": "medsupp",
        "extracted": {
            "first_name": "Brand", "last_name": "New",
            "email": "brand.new@example.com",
            "phone": "555-9911",
            "medsupp_policy_status": "Active",
        },
        "contact_name": "Brand New",
    }
    r = client.post("/api/applications/submit", headers=admin_headers, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["lead_id"], "lead_id should be returned"
    assert body["lead_created"] is True
    assert body["lead_name"] == "Brand New"
    # Lead row exists with the expected fields.
    lead = await db.leads.find_one({"id": body["lead_id"]})
    assert lead is not None
    assert lead["email"] == "brand.new@example.com"
    assert lead["status"] == "enrolled"
    assert lead["created_via"] == "application_submission"
    assert lead["product_interest"] == "medsupp"
    # GHL mock id was stamped back onto the row.
    assert (lead.get("ghl_contact_id") or "").startswith("mock_")


@pytest.mark.asyncio
async def test_submit_application_reuses_existing_lead(client, db, admin_headers):
    """Submitting a second application for the same email must NOT
    create a duplicate lead — it should reuse the existing one."""
    # Seed a lead with the email we'll submit against.
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    await db.leads.insert_one({
        "id": "lead-dup-test",
        "first_name": "Dup", "last_name": "Email",
        "email": "dup.email@example.com",
        "status": "contacted",
        "soa_signed": False, "document_ids": [],
        "agent_id": "admin-1",
        "ghl_sync_status": "synced",
        "created_via": "intake",
        "created_at": now, "updated_at": now,
    })
    payload = {
        "contact_id": "",
        "product_type": "medsupp",
        "extracted": {
            "first_name": "Dup", "last_name": "Email",
            "email": "dup.email@example.com",
        },
        "contact_name": "Dup Email",
    }
    r = client.post("/api/applications/submit", headers=admin_headers, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["lead_id"] == "lead-dup-test"
    assert body["lead_created"] is False
    # Only one row for that email exists.
    count = await db.leads.count_documents({"email": "dup.email@example.com"})
    assert count == 1
    # Status promoted to enrolled.
    promoted = await db.leads.find_one({"id": "lead-dup-test"})
    assert promoted["status"] == "enrolled"


@pytest.mark.asyncio
async def test_search_contacts_auto_imports_portal_lead(client, db, admin_headers):
    """GET /api/applications/search-contacts should return GHL contacts
    with portal lead_id attached, auto-creating portal rows for any
    contact that isn't already in leads."""
    # Mock GHL returns two contacts with ids mock_contact_1 / mock_contact_2.
    r = client.get(
        "/api/applications/search-contacts?query=smith",
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["contacts"]) >= 1
    # Every result has a portal lead_id.
    for c in body["contacts"]:
        assert c.get("lead_id"), c
        # And the lead actually exists.
        lead = await db.leads.find_one({"id": c["lead_id"]})
        assert lead is not None
        assert lead["created_via"] == "ghl_search_import"
        assert lead["ghl_contact_id"] == c["id"]


# ── Commission calculator (unit tests) ──────────────────────────────────────
def test_commission_med_supp_aetna_il_plan_g():
    """Aetna IL Plan G at age 70, $150/mo → 27% (low age band, fg)."""
    from commission_calculator import calculate_commission, AGENT_SPLIT_PCT
    r = calculate_commission(
        product_type="med_supp",
        carrier="Aetna",
        state="IL",
        plan_type="G",
        monthly_premium=150,
        client_age=70,
    )
    assert r["rate_type"] == "percentage"
    assert r["carrier_rate"] == 0.27
    assert r["annual_premium"] == 1800.00
    assert r["agency_revenue"] == round(1800 * 0.27, 2)         # 486.00
    assert r["agent_commission"] == round(486 * AGENT_SPLIT_PCT, 2)  # 145.80
    assert r["agent_split_pct"] == 0.30


def test_commission_ma_with_scope_completed():
    """MA with scope completed → flat $626 agency, $187.80 agent."""
    from commission_calculator import calculate_commission
    r = calculate_commission(
        product_type="ma",
        carrier="Aetna",
        state="IL",
        plan_type="PPO",
        monthly_premium=0,        # MA carriers pay a flat per-policy fee.
        client_age=68,
        scope_completed=True,
    )
    assert r["rate_type"] == "flat_dollar"
    assert r["carrier_rate"] == 626.0
    assert r["agency_revenue"] == 626.0
    assert r["agent_commission"] == 187.80
    # Without scope, should drop back to $313.
    r2 = calculate_commission(
        product_type="ma", carrier="Aetna", state="IL",
        plan_type="PPO", monthly_premium=0, client_age=68,
        scope_completed=False,
    )
    assert r2["carrier_rate"] == 313.0
    assert r2["agent_commission"] == 93.90


def test_commission_ancillary_aetna_hip_tx():
    """Aetna HIP in TX → 67.5% of annual premium."""
    from commission_calculator import calculate_commission
    r = calculate_commission(
        product_type="hip",
        carrier="Aetna",
        state="TX",
        plan_type=None,
        monthly_premium=50,
        client_age=72,
    )
    assert r["rate_type"] == "percentage"
    assert r["carrier_rate"] == 0.675
    assert r["annual_premium"] == 600.00
    assert r["agency_revenue"] == round(600 * 0.675, 2)             # 405.00
    assert r["agent_commission"] == round(405 * 0.30, 2)            # 121.50


def test_commission_uhc_flat_dollar():
    """UHC IL Plan G is a flat $330/yr — not a percentage."""
    from commission_calculator import calculate_commission
    r = calculate_commission(
        product_type="med_supp", carrier="UHC", state="IL",
        plan_type="G", monthly_premium=160, client_age=70,
    )
    assert r["rate_type"] == "flat_dollar"
    assert r["carrier_rate"] == 330.0
    assert r["agency_revenue"] == 330.0
    assert r["agent_commission"] == 99.00


def test_commission_unknown_combo_returns_zero_with_note():
    """Bogus state for Aetna MS shouldn't crash — None rate, $0 revenue,
    explanatory note."""
    from commission_calculator import calculate_commission
    r = calculate_commission(
        product_type="med_supp", carrier="Aetna", state="ZZ",
        plan_type="G", monthly_premium=100, client_age=70,
    )
    assert r["carrier_rate"] is None
    assert r["agency_revenue"] == 0.0
    assert r["agent_commission"] == 0.0
    assert "No Aetna" in r["notes"]


# ── TCPA consent ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_lead_post_stamps_tcpa_consent(client, db, admin_headers):
    """When the client supplies tcpa_consent=true + tcpa_consent_text,
    the server stamps the timestamp + IP and writes a separate
    tcpa_consent_recorded audit row."""
    payload = {
        "first_name": "Tcpa",
        "last_name": "Consenter",
        "phone": "555-4040",
        "tcpa_consent": True,
        "tcpa_consent_text": "I agree to receive text messages…",
    }
    r = client.post("/api/leads", headers=admin_headers, json=payload)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["tcpa_consent"] is True
    assert body["tcpa_consent_timestamp"], "timestamp should be server-stamped"
    # An audit row should land for the consent event.
    audit = await db.audit_logs.find_one(
        {"event_type": "tcpa_consent_recorded", "target_id": body["id"]},
    )
    assert audit is not None
    md = audit.get("metadata") or {}
    assert md.get("tcpa_consent_timestamp") == body["tcpa_consent_timestamp"]
    assert md.get("tcpa_consent_text_hash"), "verbatim text hash recorded"


@pytest.mark.asyncio
async def test_lead_post_without_tcpa_leaves_fields_unset(client, db, admin_headers):
    """No tcpa_consent flag → no timestamp / IP / audit row."""
    r = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "No",
        "last_name": "Consent",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["tcpa_consent"] is False
    assert body["tcpa_consent_timestamp"] is None
    audit = await db.audit_logs.find_one(
        {"event_type": "tcpa_consent_recorded", "target_id": body["id"]},
    )
    assert audit is None
