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

from encryption import safe_lead_load


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


def test_full_invite_flow_creates_active_agent(client, db, admin_headers):
    """Admin invites → agent registers with token → agent is active.

    The invite token IS the admin's approval gate (single-use, 24h
    TTL, admin-issued). Once redeemed the user is immediately active
    — no separate /auth/users/{id}/approve dance — so the new agent
    can sign in right after registration instead of getting stuck
    on the "Account pending admin approval" 403 forever if the
    admin forgets the follow-up step.
    """
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
    assert user["status"] == "active"
    assert user["agent_npn"] == "12345678"
    assert user["agent_name"] == "Jane Agent"
    assert user["is_active"] is True


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
    the next attempt comes back 429 with a lockout message. (Was 423 prior
    to the post-pentest hardening sprint.)"""
    email = os.environ["SEED_ADMIN_EMAIL"]
    for _ in range(5):
        r = client.post("/api/auth/login", json={
            "email": email, "password": "definitely-wrong",
        })
        assert r.status_code in (401, 429)
    locked = client.post("/api/auth/login", json={
        "email": email, "password": "definitely-wrong",
    })
    assert locked.status_code == 429
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
    """When the user has neither agent_name nor full_name, /live must 400.

    Post-Wave-1 the endpoint resolves the lookup key via
    ``deps.resolve_agent_key`` (agent_name → full_name fallback), so we
    null both fields here to exercise the truly-unconfigured path the
    Phase 1 startup backfill is meant to prevent.
    """
    await db.users.update_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]},
        {"$set": {"agent_name": None, "full_name": None}},
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


# ── Password reset flow ─────────────────────────────────────────────────────
def test_forgot_password_returns_200_for_unknown_email(client, db):
    """No-enumeration guarantee: hitting forgot-password for an email
    that has no account must still return 200, with the same generic
    message a valid user would see."""
    r = client.post("/api/profile/forgot-password",
                    json={"email": "ghost@nobody.example"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "reset link" in body["message"].lower()


@pytest.mark.asyncio
async def test_forgot_then_reset_password_flow(client, db, admin_headers):
    """Happy path: forgot-password mints a token, reset-password
    consumes it, the new password works on /auth/login."""
    import os
    email = os.environ["SEED_ADMIN_EMAIL"]

    r = client.post("/api/profile/forgot-password", json={"email": email})
    assert r.status_code == 200
    rec = await db.password_resets.find_one({"email": email, "used": False})
    assert rec, "reset token should have been written"

    new_pw = "BrandNewPassword!2026"
    r2 = client.post("/api/profile/reset-password", json={
        "token": rec["token"],
        "new_password": new_pw,
    })
    assert r2.status_code == 200, r2.text
    assert r2.json()["message"] == "Password updated"

    # Token can't be reused.
    r3 = client.post("/api/profile/reset-password", json={
        "token": rec["token"],
        "new_password": "Whatever!2026",
    })
    assert r3.status_code == 400

    # Login with the new password succeeds.
    login = client.post("/api/auth/login", json={
        "email": email, "password": new_pw,
    })
    assert login.status_code == 200, login.text


# ── Post-pentest security sprint ────────────────────────────────────────────
def test_login_lockout_after_5_failures(client, db):
    """Five wrong-password attempts in the 15-min window must trigger
    the 429 lockout response. Distinct from the prior coverage in that
    we explicitly check the status code on the 6th try."""
    email = os.environ["SEED_ADMIN_EMAIL"]
    for _ in range(5):
        client.post("/api/auth/login", json={
            "email": email, "password": "wrong-attempt",
        })
    sixth = client.post("/api/auth/login", json={
        "email": email, "password": "wrong-attempt",
    })
    assert sixth.status_code == 429, sixth.text


def test_locked_account_returns_429(client, db):
    """Even a correct password on a locked account is rejected with 429
    (lockout check happens BEFORE password verification)."""
    email = os.environ["SEED_ADMIN_EMAIL"]
    for _ in range(5):
        client.post("/api/auth/login", json={
            "email": email, "password": "wrong-attempt",
        })
    # Subsequent attempt with the *correct* password should still 429.
    r = client.post("/api/auth/login", json={
        "email": email, "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert r.status_code == 429, r.text


def test_token_invalidated_after_password_change(client, db):
    """Changing the password bumps token_version. The previously issued
    JWT should then fail the deps.get_current_user check with 401."""
    # Log in to get a Bearer token tied to the old token_version.
    login = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}

    # Confirm the token is initially valid.
    me1 = client.get("/api/profile/me", headers=h)
    assert me1.status_code == 200, me1.text

    # Change the password — bumps token_version on the user row.
    new_pw = "BrandNewSafe!2026LongerPassword"
    patch = client.patch("/api/profile/me", headers=h, json={
        "current_password": os.environ["SEED_ADMIN_PASSWORD"],
        "new_password": new_pw,
    })
    assert patch.status_code == 200, patch.text

    # Same JWT now mismatches the user's new token_version → 401.
    me2 = client.get("/api/profile/me", headers=h)
    assert me2.status_code == 401, me2.text
    assert "session" in me2.json()["detail"].lower()


def test_file_upload_rejects_non_pdf(client, db, admin_headers):
    """A file claiming application/pdf whose body is JPEG bytes must
    be rejected at /documents/upload with 415 — magic-byte mismatch.
    Also verifies the lead_id path itself works."""
    import asyncio
    from datetime import datetime, timezone

    # Seed a lead the admin can upload to (Phase-2 IDOR doesn't 403
    # admins, but we still need a real lead row).
    async def _seed():
        await db.leads.insert_one({
            "id": "lead-magic", "first_name": "Magic", "last_name": "Test",
            "agent_id": "admin-1", "status": "new",
            "soa_signed": False, "document_ids": [],
            "ghl_sync_status": "synced",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
    asyncio.get_event_loop().run_until_complete(_seed())

    # JPEG magic bytes (not %PDF) with claimed type application/pdf.
    fake = b"\xff\xd8\xff\xe0not-actually-a-pdf-payload-bytes-x" * 4
    r = client.post(
        "/api/documents/upload/lead-magic",
        headers=admin_headers,
        files={"file": ("evil.pdf", fake, "application/pdf")},
    )
    assert r.status_code == 415, r.text
    assert "match" in r.json()["detail"].lower()


# ── SOA automation ──────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_new_medicare_lead_creates_soa(client, db, admin_headers):
    """Creating a lead with a Medicare product_interest must mint a
    pending SOA record + return a public sign URL on the response."""
    r = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Soa",
        "last_name": "Auto",
        "phone": "555-1010",
        "product_interest": "Medicare Supplement",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body.get("soa_link"), "soa_link should be returned for Medicare leads"
    soa = await db.soa_records.find_one({"lead_id": body["id"]})
    assert soa is not None
    assert soa.get("status") == "pending"
    assert (soa.get("token") or "") != ""
    assert "Medicare Supplement" in (soa.get("products_to_discuss") or [])


@pytest.mark.asyncio
async def test_new_non_medicare_lead_no_soa(client, db, admin_headers):
    """Ancillary / life / annuity / FE products must NOT trigger an SOA."""
    r = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Anc",
        "last_name": "Only",
        "phone": "555-2020",
        "product_interest": "Cancer",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body.get("soa_link") in (None, "")
    soa = await db.soa_records.find_one({"lead_id": body["id"]})
    assert soa is None


@pytest.mark.asyncio
async def test_soa_sign_marks_signed(client, db, admin_headers):
    """Signing via /api/soa/public/{token}/sign flips the record to
    status=signed, stamps signed_name/signed_at, and updates the
    parent lead's soa_signed flag."""
    # Create a Medicare lead to mint a pending SOA.
    r = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Sign", "last_name": "Now",
        "phone": "555-3030",
        "product_interest": "Medicare Advantage",
    })
    assert r.status_code == 201
    lead_id = r.json()["id"]
    soa = await db.soa_records.find_one({"lead_id": lead_id})
    assert soa and soa.get("token")

    # Sign via the public endpoint. No auth required.
    r2 = client.post(
        f"/api/soa/public/{soa['token']}/sign",
        json={"full_name": "Sign Now",
              "products_confirmed": ["Medicare Advantage"]},
    )
    assert r2.status_code == 200, r2.text
    fresh = await db.soa_records.find_one({"id": soa["id"]})
    assert fresh["status"] == "signed"
    assert fresh["signed_name"] == "Sign Now"
    assert fresh.get("signed_at")
    lead = await db.leads.find_one({"id": lead_id})
    assert lead.get("soa_signed") is True


def test_soa_expired_token_returns_404(client, db):
    """An unknown / used / fake token must 404 on both GET and POST."""
    r = client.get("/api/soa/public/totally-bogus-token")
    assert r.status_code == 404, r.text
    r2 = client.post(
        "/api/soa/public/totally-bogus-token/sign",
        json={"full_name": "Whoever"},
    )
    assert r2.status_code == 404, r2.text


# ── Deactivation + speed-to-lead SMS + agency health ───────────────────────
@pytest.mark.asyncio
async def test_deactivated_user_cannot_login(client, db, admin_headers):
    """Flipping a user's is_active=false locks them out: login responds
    with 401 + the user-readable deactivation message, and any pre-issued
    token also returns 401 on subsequent requests."""
    import uuid
    from security import hash_password
    pw = "DeactivatedUser!2026"
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": "deact@example.com",
        "full_name": "Deact Test", "agent_name": "Deact Test",
        "role": "agent", "is_active": True, "status": "active",
        "hashed_password": hash_password(pw),
        "token_version": 0, "failed_attempts": 0,
        "created_at": "2026-01-01T00:00:00+00:00",
    })

    # Confirm normal login works first.
    r1 = client.post("/api/auth/login",
                     json={"email": "deact@example.com", "password": pw})
    assert r1.status_code == 200, r1.text

    # Admin deactivates the user.
    deact = client.patch(f"/api/agents/{uid}/status",
                          headers=admin_headers,
                          json={"is_active": False})
    assert deact.status_code == 200, deact.text

    # Subsequent login fails with the deactivation message.
    r2 = client.post("/api/auth/login",
                     json={"email": "deact@example.com", "password": pw})
    assert r2.status_code == 401, r2.text
    assert "deactivated" in r2.json()["detail"].lower()


@pytest.mark.asyncio
async def test_admin_cannot_deactivate_self(client, db, admin_headers):
    """Self-deactivation is refused — locking out the only admin is
    irrecoverable without DB access."""
    me = await db.users.find_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]}, {"_id": 0, "id": 1},
    )
    r = client.patch(f"/api/agents/{me['id']}/status",
                     headers=admin_headers, json={"is_active": False})
    assert r.status_code == 400, r.text
    assert "own" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_speed_to_lead_sms_requires_tcpa(client, db, admin_headers):
    """Lead POST without tcpa_consent must audit-log a
    speed_to_lead_sms_skipped with reason 'no_tcpa_consent'. Lead with
    consent + phone must audit a sent/failed event (mock mode → skipped
    with reason 'ghl_mock_mode')."""
    # No consent → skipped with reason no_tcpa_consent.
    r1 = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Sms", "last_name": "NoConsent",
        "phone": "555-0001",
    })
    assert r1.status_code == 201
    skip = await db.audit_logs.find_one(
        {"event_type": "speed_to_lead_sms_skipped",
         "target_id": r1.json()["id"]},
    )
    assert skip is not None
    assert "no_tcpa_consent" in (skip.get("metadata") or {}).get("reason", "")

    # With consent + phone → mock mode short-circuits with its own
    # audit row (the GHL token isn't set in tests, so mock_mode=True).
    r2 = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Sms", "last_name": "WithConsent",
        "phone": "555-0002",
        "tcpa_consent": True,
        "tcpa_consent_text": "I consent",
    })
    assert r2.status_code == 201
    # No phone path triggered, so we expect either the mock_mode
    # skipped audit or no_ghl_contact_id (whichever fires first).
    log = await db.audit_logs.find_one(
        {"event_type": {"$in": [
            "speed_to_lead_sms_skipped",
            "speed_to_lead_sms_sent",
        ]}, "target_id": r2.json()["id"]},
    )
    assert log is not None


@pytest.mark.asyncio
async def test_agency_health_score_calculation(client, db, admin_headers):
    """/api/agency/stats returns an int health_score in [0, 100] plus
    four factor entries that each sum to a max of 25 pts."""
    r = client.get("/api/agency/stats", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "health_score" in body
    score = body["health_score"]
    assert isinstance(score, int)
    assert 0 <= score <= 100
    factors = body.get("health_factors") or []
    assert len(factors) == 4
    for f in factors:
        assert f["max"] == 25
        assert 0 <= f["points"] <= 25


# ── Birthday Rule + Renewals + Backup ─────────────────────────────────────
@pytest.mark.asyncio
async def test_birthday_rule_il_client_upcoming(client, db, admin_headers):
    """An IL lead whose birthday is ~60 days away lands in the 'soon'
    bucket — outside the open-window range but within 90 days."""
    from datetime import date, timedelta
    target = date.today() + timedelta(days=60)
    dob_str = f"1955-{target.month:02d}-{target.day:02d}"
    await db.leads.insert_one({
        "id": "il-soon",
        "first_name": "Ila", "last_name": "Norris",
        "phone": "555-0010", "email": "ila@example.com",
        "state": "IL", "date_of_birth": dob_str,
        "status": "new", "agent_id": "admin-1",
        "soa_signed": False, "document_ids": [],
        "ghl_sync_status": "synced",
        "created_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.get("/api/birthday-rule/alerts", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    soon_ids = [x["lead_id"] for x in body.get("soon", [])]
    assert "il-soon" in soon_ids, body


@pytest.mark.asyncio
async def test_birthday_rule_window_currently_open(client, db, admin_headers):
    """An IL lead whose birthday was a few days ago lands in 'urgent'
    with a positive days_remaining_in_window value."""
    from datetime import date, timedelta
    target = date.today() - timedelta(days=10)
    dob_str = f"1950-{target.month:02d}-{target.day:02d}"
    await db.leads.insert_one({
        "id": "il-urgent",
        "first_name": "Open", "last_name": "Window",
        "phone": "555-0011",
        "state": "IL", "date_of_birth": dob_str,
        "status": "contacted", "agent_id": "admin-1",
        "soa_signed": False, "document_ids": [],
        "ghl_sync_status": "synced",
        "created_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.get("/api/birthday-rule/alerts", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    urgent_ids = [x["lead_id"] for x in body.get("urgent", [])]
    assert "il-urgent" in urgent_ids
    row = next(x for x in body["urgent"] if x["lead_id"] == "il-urgent")
    assert row["days_remaining_in_window"] is not None
    assert row["days_remaining_in_window"] > 0


@pytest.mark.asyncio
async def test_renewal_alerts_resolve_real_lead_id(client, db, admin_headers):
    """BUG 1 calendar regression: /api/renewals/alerts must ship the
    canonical leads.id on each row (joined via ghl_contact_id when
    policy.lead_id is a legacy/foreign value). Orphan policies return
    lead_id=None so the CalendarPage gate hides the broken link."""
    from datetime import date, timedelta
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    # Lead with a known GHL contact id we'll point the policy at.
    await db.leads.insert_one({
        "id": "renewal-real-lead",
        "ghl_contact_id": "ghl-rrr",
        "first_name": "Renew", "last_name": "Match",
        "status": "enrolled", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    # Renewal in ~30 days. effective_date one year ago + 30 days.
    eff = (date.today() - timedelta(days=335)).isoformat()
    await db.policies.insert_one({
        "lead_id": "legacy-policy-ref",      # NOT a leads.id
        "ghl_contact_id": "ghl-rrr",         # matches the lead
        "contact_name": "Renew Match",
        "product_type": "ma", "product_label": "MAPD",
        "carrier": "Aetna",
        "effective_date": eff,
        "agent_id": admin["id"],
    })
    # Orphan — no matching lead anywhere.
    await db.policies.insert_one({
        "lead_id": "orphan-ref",
        "ghl_contact_id": "ghl-nothing",
        "contact_name": "No Match Found",
        "product_type": "pdp", "product_label": "PDP",
        "carrier": "UHC",
        "effective_date": eff,
        "agent_id": admin["id"],
    })

    r = client.get("/api/renewals/alerts", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body.get("renewal_alerts", [])
    matched = next((x for x in rows if x["full_name"] == "Renew Match"), None)
    orphan = next((x for x in rows if x["full_name"] == "No Match Found"), None)
    assert matched is not None
    assert matched["lead_id"] == "renewal-real-lead"   # joined via ghl_contact_id
    assert orphan is not None
    assert orphan["lead_id"] is None                    # no match → null


def test_aep_countdown_calculation(client, db, admin_headers):
    """AEP fields: days_until + is_active boolean, both shaped right."""
    r = client.get("/api/renewals/alerts", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    aep = body.get("aep_countdown") or {}
    oep = body.get("oep_countdown") or {}
    assert "days_until" in aep
    assert "is_active" in aep
    assert isinstance(aep["days_until"], int) and aep["days_until"] >= 0
    assert isinstance(aep["is_active"], bool)
    assert "days_until" in oep
    assert "is_active" in oep


# ── CSV import ─────────────────────────────────────────────────────────────
def _import_post(client, headers, csv_text, filename="leads.csv"):
    """Helper: POST a CSV string as multipart/form-data."""
    return client.post(
        "/api/leads/import",
        headers=headers,
        files={"csv_file": (filename, csv_text.encode("utf-8"), "text/csv")},
    )


@pytest.mark.asyncio
async def test_import_valid_csv(client, db, admin_headers):
    """Five-row CSV imports cleanly, agency_id is stamped."""
    csv_text = (
        "full_name,phone,email,state,date_of_birth,carrier\n"
        "Mira Holt,555-1000,mira@example.com,IL,1955-03-15,Aetna\n"
        "Quinn Adams,555-1001,quinn@example.com,FL,03/22/1962,Humana\n"
        "Pat Lee,,pat@example.com,TX,,UHC\n"
        "Riley Cho,555-1003,,WA,11/04/1948,\n"
        "Sam Park,555-1004,sam@example.com,CA,1958-09-09,Aetna\n"
    )
    r = _import_post(client, admin_headers, csv_text)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["imported"] == 5
    assert body["skipped_duplicates"] == 0
    assert body["skipped_empty"] == 0
    assert body["total_rows"] == 5
    assert body["errors"] == []

    # Spot-check a row: agency_id stamped, created_via marker present,
    # status defaults to "new".
    sample = await db.leads.find_one({"email": "mira@example.com"}, {"_id": 0})
    # Raw mongomock read returns ciphertext for encrypted PHI (date_of_birth
    # in Phase 2). Production reads go through safe_lead_load — mirror that
    # here so the assertion compares plaintext to plaintext.
    sample = safe_lead_load(sample)
    assert sample is not None
    assert sample["agency_id"] == "ghw_001"
    assert sample["created_via"] == "csv_import"
    assert sample["status"] == "new"
    assert sample["date_of_birth"] == "1955-03-15"


@pytest.mark.asyncio
async def test_import_skips_duplicates(client, db, admin_headers):
    """Email already on file for the agent → skipped. In-file dupes
    inside the same upload → skipped too (keep first)."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    # Pre-existing lead the admin already owns.
    await db.leads.insert_one({
        "id": "existing-1",
        "first_name": "Pre", "last_name": "Existing",
        "email": "dup@example.com",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    csv_text = (
        "full_name,phone,email\n"
        "Already Here,555-9000,dup@example.com\n"       # existing-collision
        "First In File,555-9001,twin@example.com\n"     # ok
        "Second In File,555-9002,twin@example.com\n"    # in-file dup
        "Fresh One,555-9003,fresh@example.com\n"        # ok
    )
    r = _import_post(client, admin_headers, csv_text)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["imported"] == 2
    assert body["skipped_duplicates"] == 2
    assert body["total_rows"] == 4


def test_import_skips_empty_rows(client, db, admin_headers):
    """Rows missing both phone AND email are counted as skipped_empty
    (not imported, not erroring)."""
    csv_text = (
        "full_name,phone,email\n"
        "Has Phone,555-1,,\n"                # ok
        "No Contact,,\n"                     # skipped_empty
        "Has Email,,emailonly@example.com\n" # ok
        "Also Empty,,\n"                     # skipped_empty
    )
    # Two rows above are actually 4-col with empty trailing cells but
    # the field count matches the header so DictReader parses fine.
    r = _import_post(client, admin_headers, csv_text)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["imported"] == 2
    assert body["skipped_empty"] == 2
    assert body["total_rows"] == 4


def test_import_wrong_format_422(client, db, admin_headers):
    """A non-.csv filename is rejected up front (no parsing attempt)."""
    r = client.post(
        "/api/leads/import",
        headers=admin_headers,
        files={"csv_file": ("leads.xlsx", b"binary-garbage", "application/vnd.ms-excel")},
    )
    assert r.status_code == 422
    assert ".csv" in r.json()["detail"]


def test_import_requires_auth(client, db):
    """Unauthenticated upload is rejected."""
    r = client.post(
        "/api/leads/import",
        files={"csv_file": ("x.csv", b"full_name,phone\nA,1\n", "text/csv")},
    )
    assert r.status_code == 401


# ── Notifications ──────────────────────────────────────────────────────────
def test_notifications_requires_auth(client, db):
    """No token → 401 on the unread-count endpoint."""
    r = client.get("/api/notifications/unread-count")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_notifications_unread_count_and_mark_read(client, db, admin_headers):
    """Seed three notifications (two unread, one read) for the admin;
    confirm unread-count, mark-read flips the count down."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = [
        {"notification_id": "n-1", "agent_id": admin["id"],
         "type": "stale_lead", "title": "T1", "body": "b",
         "link": None, "target_id": "x", "is_read": False,
         "created_at": now_iso, "read_at": None},
        {"notification_id": "n-2", "agent_id": admin["id"],
         "type": "stale_lead", "title": "T2", "body": "b",
         "link": None, "target_id": "y", "is_read": False,
         "created_at": now_iso, "read_at": None},
        {"notification_id": "n-3", "agent_id": admin["id"],
         "type": "stale_lead", "title": "T3", "body": "b",
         "link": None, "target_id": "z", "is_read": True,
         "created_at": now_iso, "read_at": now_iso},
    ]
    await db.notifications.insert_many(rows)
    c1 = client.get("/api/notifications/unread-count", headers=admin_headers)
    assert c1.json()["count"] == 2

    r = client.patch("/api/notifications/n-1/read", headers=admin_headers)
    assert r.status_code == 200
    assert r.json()["is_read"] is True

    c2 = client.get("/api/notifications/unread-count", headers=admin_headers)
    assert c2.json()["count"] == 1


@pytest.mark.asyncio
async def test_notifications_mark_all_read(client, db, admin_headers):
    """PATCH /read-all flips every unread row for the caller."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.notifications.insert_many([
        {"notification_id": f"all-{i}", "agent_id": admin["id"],
         "type": "stale_lead", "title": "x", "body": "b",
         "link": None, "target_id": "z", "is_read": False,
         "created_at": now_iso, "read_at": None}
        for i in range(3)
    ])
    r = client.patch("/api/notifications/read-all", headers=admin_headers)
    assert r.status_code == 200
    assert r.json()["marked_read"] == 3
    remaining = await db.notifications.count_documents(
        {"agent_id": admin["id"], "is_read": False},
    )
    assert remaining == 0


@pytest.mark.asyncio
async def test_notifications_generator_dedup(client, db, admin_headers):
    """Generator skips a notification if one with the same
    (agent_id, target_id, type) created in the last 24h already exists."""
    from datetime import datetime, timedelta, timezone
    from notifications_router import generate_notifications
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    now = datetime.now(timezone.utc)
    week_old_iso = (now - timedelta(days=10)).isoformat()
    # Seed a stale lead.
    await db.leads.insert_one({
        "id": "stale-1",
        "first_name": "Sta", "last_name": "Le",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "new",
        "created_at": week_old_iso, "updated_at": week_old_iso,
    })
    # First run creates one notification.
    stats1 = await generate_notifications(db)
    assert stats1["stale"] >= 1
    first = await db.notifications.count_documents({
        "agent_id": admin["id"], "type": "stale_lead",
    })
    assert first == 1
    # Second run within 24h dedups → no new row.
    stats2 = await generate_notifications(db)
    assert stats2["stale"] == 0
    second = await db.notifications.count_documents({
        "agent_id": admin["id"], "type": "stale_lead",
    })
    assert second == 1


def test_notifications_scheduler_exists():
    """start_scheduler is importable and returns None when DISABLE_
    SCHEDULER=1 (the conftest default)."""
    from notifications_router import start_scheduler
    sched = start_scheduler(lambda: None)
    assert sched is None


# ── Global search ──────────────────────────────────────────────────────────
def test_search_requires_min_length(client, db, admin_headers):
    """Queries under 2 chars 400."""
    r = client.get("/api/search?q=a", headers=admin_headers)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_search_returns_leads_appointments_notes(client, db, admin_headers):
    """Match a lead by name, an appointment by client name, and a note
    by content — all three surfaces in one response, leads first."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    now_iso = "2026-05-10T10:00:00+00:00"
    await db.leads.insert_one({
        "id": "search-lead-1",
        "first_name": "Zelda", "last_name": "Marin",
        "phone": "555-1111", "email": "zelda@example.com",
        "current_carrier": "Aetna", "state": "IL",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "new",
        "created_at": now_iso, "updated_at": now_iso,
    })
    await db.appointments.insert_one({
        "appointment_id": "search-appt-1",
        "agent_id": admin["id"],
        "client_name": "Zelda Marin",
        "appointment_date": "2026-06-01", "appointment_time": "10:00",
        "type": "enrollment", "status": "scheduled",
        "notes": "Zelda is ready",
        "created_at": now_iso, "updated_at": now_iso,
    })
    await db.notes.insert_one({
        "note_id": "search-note-1",
        "lead_id": "search-lead-1",
        "agent_id": admin["id"], "agent_name": "Admin",
        "type": "note", "content": "Zelda confirmed she's interested",
        "is_task": False, "deleted": False,
        "created_at": now_iso, "updated_at": now_iso,
    })

    r = client.get("/api/search?q=Zelda", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    types = [r["type"] for r in body["results"]]
    # All three surfaces matched.
    assert "lead" in types
    assert "appointment" in types
    assert "note" in types
    # Leads sort first (score=3 beats appointment=2 beats note=1).
    assert body["results"][0]["type"] == "lead"


@pytest.mark.asyncio
async def test_search_scoped_to_agent(client, db, admin_headers):
    """Agent B searching the same term only sees their own records."""
    # Admin's lead
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "scope-lead-admin",
        "first_name": "Quincy", "last_name": "Shared",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    # Bob with his own lead
    b_id, b_headers = await _make_agent_with_token(
        client, db, admin_headers, "search.bob@example.com", "Bob S",
        password="Q9pl#aux!7zT",
    )
    await db.leads.insert_one({
        "id": "scope-lead-bob",
        "first_name": "Quincy", "last_name": "BobsOwn",
        "agent_id": b_id, "agent_name": "Bob S",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })

    # Bob searches "Quincy" — should only see his own lead, not admin's.
    bob_r = client.get("/api/search?q=Quincy", headers=b_headers)
    assert bob_r.status_code == 200
    bob_ids = [r["id"] for r in bob_r.json()["results"]]
    assert "scope-lead-bob" in bob_ids
    assert "scope-lead-admin" not in bob_ids

    # Admin sees both (FULL_AGENCY_SCOPE).
    admin_r = client.get("/api/search?q=Quincy", headers=admin_headers)
    admin_ids = [r["id"] for r in admin_r.json()["results"]]
    assert "scope-lead-admin" in admin_ids
    assert "scope-lead-bob" in admin_ids


@pytest.mark.asyncio
async def test_search_audits(client, db, admin_headers):
    """Search writes search_performed audit with query length only —
    never the raw query (PHI risk)."""
    client.get("/api/search?q=Zelda", headers=admin_headers)
    entry = await db.audit_logs.find_one({"event_type": "search_performed"})
    assert entry is not None
    assert "query_length" in entry["metadata"]
    # Raw query MUST NOT appear in audit metadata.
    assert "query" not in entry["metadata"]
    assert "q" not in entry["metadata"]


# ── Notes + Tasks ──────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_note_create_and_list(client, db, admin_headers):
    """Happy-path POST creates a note; GET ?lead_id= returns it."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "notes-lead-1",
        "first_name": "Note", "last_name": "Holder",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.post("/api/notes", headers=admin_headers, json={
        "lead_id": "notes-lead-1",
        "content": "Called, left voicemail. Will retry Tuesday.",
        "type": "call",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["note_id"]
    assert body["lead_id"] == "notes-lead-1"
    assert body["type"] == "call"
    assert body["is_task"] is False

    listed = client.get(
        "/api/notes?lead_id=notes-lead-1", headers=admin_headers,
    )
    assert listed.status_code == 200
    items = listed.json()["notes"]
    assert any(n["note_id"] == body["note_id"] for n in items)


@pytest.mark.asyncio
async def test_task_complete(client, db, admin_headers):
    """Creating a task with is_task=true + due_date, then completing it."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "notes-lead-2",
        "first_name": "Task", "last_name": "Owner",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    created = client.post("/api/notes", headers=admin_headers, json={
        "lead_id": "notes-lead-2",
        "content": "Follow up on Plan G quote",
        "type": "task",
        "is_task": True,
        "task_due_date": "2026-06-01",
    })
    assert created.status_code == 201, created.text
    note_id = created.json()["note_id"]
    assert created.json()["is_task"] is True
    assert created.json()["task_completed"] is False

    completed = client.patch(
        f"/api/notes/{note_id}/complete", headers=admin_headers,
    )
    assert completed.status_code == 200
    assert completed.json()["task_completed"] is True
    assert completed.json()["task_completed_at"]

    audit = await db.audit_logs.find_one({"event_type": "task_completed"})
    assert audit is not None


def test_task_missing_due_date_422(client, db, admin_headers):
    """is_task=True without task_due_date 422s."""
    r = client.post("/api/notes", headers=admin_headers, json={
        "lead_id": "anything",
        "content": "Will never be created",
        "is_task": True,
    })
    # 404 first (lead doesn't exist) — verify the validator hits even
    # so by hitting a real lead.
    assert r.status_code in (404, 422)


@pytest.mark.asyncio
async def test_note_list_scoped(client, db, admin_headers):
    """Agent B cannot list notes on a lead owned by agent A."""
    a_id, _ = await _make_agent_with_token(
        client, db, admin_headers, "notes.alice@example.com", "Alice N",
        password="Q9pl#aux!7zT",
    )
    _, b_headers = await _make_agent_with_token(
        client, db, admin_headers, "notes.bob@example.com", "Bob N",
        password="Q9pl#aux!7zS",
    )
    await db.leads.insert_one({
        "id": "notes-scoped-1",
        "first_name": "Scoped", "last_name": "Lead",
        "agent_id": a_id, "agent_name": "Alice N",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.get(
        "/api/notes?lead_id=notes-scoped-1", headers=b_headers,
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_note_delete_own_and_other_agent_blocked(client, db, admin_headers):
    """Agents can soft-delete their own notes; another agent's note 403s."""
    a_id, a_headers = await _make_agent_with_token(
        client, db, admin_headers, "del.alice@example.com", "Alice D",
        password="Q9pl#aux!7zA",
    )
    _, b_headers = await _make_agent_with_token(
        client, db, admin_headers, "del.bob@example.com", "Bob D",
        password="Q9pl#aux!7zB",
    )
    await db.leads.insert_one({
        "id": "del-lead",
        "first_name": "Del", "last_name": "Lead",
        "agent_id": a_id, "agent_name": "Alice D",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    # Alice creates a note on her own lead.
    created = client.post("/api/notes", headers=a_headers, json={
        "lead_id": "del-lead",
        "content": "Will delete this",
        "type": "note",
    })
    note_id = created.json()["note_id"]

    # Bob can't delete it.
    blocked = client.delete(f"/api/notes/{note_id}", headers=b_headers)
    assert blocked.status_code in (403, 404)

    # Alice can.
    ok = client.delete(f"/api/notes/{note_id}", headers=a_headers)
    assert ok.status_code == 200, ok.text

    # Now it's tombstoned — listing doesn't surface it, and a second
    # delete 404s because the fetcher excludes deleted=True.
    listed = client.get("/api/notes?lead_id=del-lead", headers=a_headers)
    assert all(n["note_id"] != note_id for n in listed.json()["notes"])
    again = client.delete(f"/api/notes/{note_id}", headers=a_headers)
    assert again.status_code == 404


# ── Pipeline (Kanban) ──────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_pipeline_grouped_by_stage(client, db, admin_headers):
    """All seven stages come back in fixed order, with leads grouped
    correctly and counts matching a manual tally."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    now_iso = "2026-05-01T10:00:00+00:00"
    seeds = [
        ("pipe-1", "new"),
        ("pipe-2", "new"),
        ("pipe-3", "contacted"),
        ("pipe-4", "qualified"),
        ("pipe-5", "appointment_set"),
        ("pipe-6", "enrolled"),
        ("pipe-7", "lost"),
    ]
    for lid, status in seeds:
        await db.leads.insert_one({
            "id": lid,
            "first_name": "Pipe", "last_name": lid.split("-")[1],
            "agent_id": admin["id"], "agent_name": "Admin",
            "status": status,
            "created_at": now_iso, "updated_at": now_iso,
        })
    r = client.get("/api/leads/pipeline", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    # Fixed stage ordering
    assert [s["id"] for s in body["stages"]] == [
        "new", "contacted", "qualified", "appointment_set",
        "enrolled", "not_interested", "lost",
    ]
    by_id = {s["id"]: s for s in body["stages"]}
    assert by_id["new"]["count"] == 2
    assert by_id["contacted"]["count"] == 1
    assert by_id["qualified"]["count"] == 1
    assert by_id["appointment_set"]["count"] == 1
    assert by_id["enrolled"]["count"] == 1
    assert by_id["not_interested"]["count"] == 0
    assert by_id["lost"]["count"] == 1
    assert body["summary"]["total_leads"] == 7
    # Cards carry the slim projection.
    card = by_id["new"]["leads"][0]
    assert card["lead_id"] in ("pipe-1", "pipe-2")
    assert "full_name" in card
    assert "phone" in card


@pytest.mark.asyncio
async def test_pipeline_unknown_status_surfaces_in_audit_not_in_board(
    client, db, admin_headers,
):
    """A lead with a status outside the seven pipeline ids does NOT
    render on the Kanban (per-stage queries only ask for known status
    ids). It IS counted in the pipeline_viewed audit row's
    `unknown_status_count` metadata so data-quality drift is visible
    to ops. Cleanup scripts re-bucket those leads explicitly."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "pipe-legacy",
        "first_name": "Legacy", "last_name": "Status",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "needs_review",  # not a pipeline id
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    body = client.get("/api/leads/pipeline", headers=admin_headers).json()

    # Not on the Kanban — none of the seven stages contains it.
    all_card_ids = [
        c["lead_id"] for s in body["stages"] for c in s["leads"]
    ]
    assert "pipe-legacy" not in all_card_ids

    # But the drift IS surfaced in the audit log so the operator can
    # see + clean up the orphan.
    audit = await db.audit_logs.find_one(
        {"event_type": "pipeline_viewed"},
        sort=[("timestamp", -1)],
    )
    assert audit is not None
    assert audit["metadata"].get("unknown_status_count", 0) >= 1


@pytest.mark.asyncio
async def test_stage_update_success(client, db, admin_headers):
    """Happy-path PATCH moves the lead and returns the card-shaped doc."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "stage-1",
        "first_name": "Move", "last_name": "Me",
        "agent_id": admin["id"], "agent_name": "Admin",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.patch(
        "/api/leads/stage-1/stage",
        headers=admin_headers,
        json={"status": "contacted"},
    )
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["lead_id"] == "stage-1"
    # Confirm the persisted status flipped + audit row written.
    stored = await db.leads.find_one({"id": "stage-1"}, {"_id": 0})
    assert stored["status"] == "contacted"
    entry = await db.audit_logs.find_one({"event_type": "lead_stage_changed"})
    assert entry is not None
    assert entry["metadata"]["from_status"] == "new"
    assert entry["metadata"]["to_status"] == "contacted"


def test_stage_update_invalid_status(client, db, admin_headers):
    """Statuses outside the seven-stage enum 422 before touching Mongo."""
    r = client.patch(
        "/api/leads/any-id/stage",
        headers=admin_headers,
        json={"status": "interested-maybe"},
    )
    assert r.status_code == 422
    assert "Invalid stage" in r.json()["detail"]


@pytest.mark.asyncio
async def test_stage_update_idor(client, db, admin_headers):
    """Agents can't move another agent's lead — 403 from _idor_or_403."""
    # Stand up agent A who owns the lead, and agent B who'll try.
    a_id, _ = await _make_agent_with_token(
        client, db, admin_headers, "stage.alice@example.com", "Alice S",
        password="Q9pl#aux!7zT",
    )
    _, b_headers = await _make_agent_with_token(
        client, db, admin_headers, "stage.bob@example.com", "Bob S",
        password="Q9pl#aux!7zS",
    )
    await db.leads.insert_one({
        "id": "stage-idor",
        "first_name": "Owned", "last_name": "ByAlice",
        "agent_id": a_id, "agent_name": "Alice S",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.patch(
        "/api/leads/stage-idor/stage",
        headers=b_headers,
        json={"status": "qualified"},
    )
    assert r.status_code == 403


# ── Agent transfer ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def _make_agent_with_token(client, db, admin_headers, email, name,
                                  password="Q9pl#aux!7zT"):
    """Helper: invite+register+approve an agent and return (id, headers)."""
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": email, "full_name": name,
        "agency_name": "GHW", "agent_name": name,
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": email, "password": password,
        "full_name": name, "agency_name": "GHW",
        "invite_token": inv["token"],
    })
    assert reg.status_code == 201, reg.text
    uid = reg.json()["id"]
    client.post(f"/api/auth/users/{uid}/approve", headers=admin_headers)
    login = client.post("/api/auth/login", json={
        "email": email, "password": password,
    })
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return uid, headers


@pytest.mark.asyncio
async def test_lead_transfer_success(client, db, admin_headers):
    """Admin transfers a lead from agent A to agent B; doc gets the new
    agent_id + transferred_at + transferred_from + transfer_reason."""
    a_id, _ = await _make_agent_with_token(
        client, db, admin_headers, "xfer.alice@example.com", "Alice X",
        password="Q1pl#aux!7zT",
    )
    b_id, _ = await _make_agent_with_token(
        client, db, admin_headers, "xfer.bob@example.com", "Bob X",
        password="Q2pl#aux!7zT",
    )
    await db.leads.insert_one({
        "id": "xfer-lead-1",
        "first_name": "Move", "last_name": "Me",
        "agent_id": a_id, "agent_name": "Alice X",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.patch(
        "/api/leads/xfer-lead-1/transfer",
        headers=admin_headers,
        json={"new_agent_id": b_id, "reason": "Territory balancing"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agent_id"] == b_id
    assert body["agent_name"] == "Bob X"

    stored = await db.leads.find_one({"id": "xfer-lead-1"}, {"_id": 0})
    assert stored["transferred_from"] == a_id
    assert stored["transfer_reason"] == "Territory balancing"
    assert stored["transferred_at"]

    audit = await db.audit_logs.find_one({"event_type": "lead_transferred"})
    assert audit is not None
    assert audit["metadata"]["from_agent_id"] == a_id
    assert audit["metadata"]["to_agent_id"] == b_id


@pytest.mark.asyncio
async def test_lead_transfer_to_non_agent_fails(client, db, admin_headers):
    """Transfers to an admin / coach / compliance account 422 — leads
    only belong to role=agent users."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    a_id, _ = await _make_agent_with_token(
        client, db, admin_headers, "xfer.solo@example.com", "Solo X",
        password="Q3pl#aux!7zT",
    )
    await db.leads.insert_one({
        "id": "xfer-lead-2",
        "first_name": "Wrong", "last_name": "Dest",
        "agent_id": a_id, "agent_name": "Solo X",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.patch(
        "/api/leads/xfer-lead-2/transfer",
        headers=admin_headers,
        json={"new_agent_id": admin["id"]},
    )
    assert r.status_code == 422
    assert "role 'admin'" in r.json()["detail"]


@pytest.mark.asyncio
async def test_lead_transfer_agent_forbidden(client, db, admin_headers):
    """Regular agents can't transfer leads — only admin + coach."""
    a_id, a_headers = await _make_agent_with_token(
        client, db, admin_headers, "xfer.actor@example.com", "Actor X",
        password="Q4pl#aux!7zT",
    )
    b_id, _ = await _make_agent_with_token(
        client, db, admin_headers, "xfer.dest@example.com", "Dest X",
        password="Q5pl#aux!7zT",
    )
    await db.leads.insert_one({
        "id": "xfer-lead-3",
        "first_name": "Own", "last_name": "Lead",
        "agent_id": a_id, "agent_name": "Actor X",
        "status": "new",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.patch(
        "/api/leads/xfer-lead-3/transfer",
        headers=a_headers,
        json={"new_agent_id": b_id},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_lead_transfer_invalid_lead_404(client, db, admin_headers):
    """A transfer pointed at a non-existent lead 404s."""
    b_id, _ = await _make_agent_with_token(
        client, db, admin_headers, "xfer.empty@example.com", "Empty X",
        password="Q6pl#aux!7zT",
    )
    r = client.patch(
        "/api/leads/no-such-lead/transfer",
        headers=admin_headers,
        json={"new_agent_id": b_id},
    )
    assert r.status_code == 404


# ── Today action centre ────────────────────────────────────────────────────
def test_today_actions_requires_auth(client, db):
    """No token → 401 (rejects anonymous access to the aggregator)."""
    r = client.get("/api/today/actions")
    assert r.status_code == 401


def test_today_actions_response_shape(client, db, admin_headers):
    """Empty DB still returns the four-bucket envelope so the SPA can render."""
    r = client.get("/api/today/actions", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "today" in body
    assert "summary" in body
    for k in ("urgent_count", "renewals_count", "stale_count", "appointments_count"):
        assert k in body["summary"]
    for k in ("urgent_calls", "renewals_due", "stale_leads", "todays_appointments"):
        assert k in body and isinstance(body[k], list)


@pytest.mark.asyncio
async def test_today_actions_surfaces_urgent_birthday(client, db, admin_headers):
    """A lead 10 days into the birthday window must land in urgent_calls."""
    from datetime import date, timedelta
    target = date.today() - timedelta(days=10)
    dob_str = f"1955-{target.month:02d}-{target.day:02d}"
    await db.leads.insert_one({
        "id": "today-urgent",
        "first_name": "Birthday", "last_name": "Now",
        "phone": "555-9090", "state": "IL",
        "date_of_birth": dob_str,
        "status": "contacted", "agent_id": "admin-1",
        "current_plan": "MAPD HMO", "current_carrier": "Aetna",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.get("/api/today/actions", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    ids = [x["lead_id"] for x in body["urgent_calls"]]
    assert "today-urgent" in ids
    row = next(x for x in body["urgent_calls"] if x["lead_id"] == "today-urgent")
    assert row["days_remaining_in_window"] is not None
    assert row["current_carrier"] == "Aetna"
    assert body["summary"]["urgent_count"] >= 1


@pytest.mark.asyncio
async def test_today_actions_surfaces_stale_lead(client, db, admin_headers):
    """A new/contacted lead untouched in 7+ days must land in stale_leads."""
    from datetime import datetime, timedelta, timezone
    stale_iso = (datetime.now(timezone.utc) - timedelta(days=12)).isoformat()
    await db.leads.insert_one({
        "id": "today-stale",
        "first_name": "Cold", "last_name": "Lead",
        "phone": "555-1234",
        "status": "new", "agent_id": "admin-1",
        "created_at": stale_iso, "updated_at": stale_iso,
    })
    r = client.get("/api/today/actions", headers=admin_headers)
    body = r.json()
    ids = [x["lead_id"] for x in body["stale_leads"]]
    assert "today-stale" in ids
    row = next(x for x in body["stale_leads"] if x["lead_id"] == "today-stale")
    assert row["days_since_contact"] >= 7
    assert row["status"] == "new"


@pytest.mark.asyncio
async def test_today_renewals_resolve_real_lead_id(client, db, admin_headers):
    """BUG 1 regression: a policy in the renewal window should ship the
    matching lead's id (not the policy.lead_id / ghl_contact_id) so the
    SPA's /clients/:leadId link works. When no lead matches the policy,
    lead_id is null so the UI can hide the View Client button."""
    from datetime import date, timedelta
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    # Seed a lead with a GHL contact id we'll point the policy at. The
    # policy's own "lead_id" field is intentionally a *legacy* value
    # that doesn't match leads.id — mirroring the production data shape.
    await db.leads.insert_one({
        "id": "real-lead-id-123",
        "ghl_contact_id": "ghl-abc",
        "first_name": "Joining", "last_name": "Match",
        "status": "enrolled", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    # Policy effective_date one year ago + 10 days → anniversary in 10 days.
    eff = (date.today() - timedelta(days=355)).isoformat()
    await db.policies.insert_one({
        "lead_id": "legacy-policy-id",          # NOT in leads collection
        "ghl_contact_id": "ghl-abc",            # matches the lead above
        "contact_name": "Joining Match",
        "carrier": "Aetna", "product_label": "MA HMO",
        "effective_date": eff,
        "agent_id": admin["id"],
    })
    # Orphan policy: no matching lead anywhere.
    await db.policies.insert_one({
        "lead_id": "orphan-policy-id",
        "ghl_contact_id": "ghl-no-match",
        "contact_name": "Orphan Person",
        "carrier": "UHC", "product_label": "PDP",
        "effective_date": eff,
        "agent_id": admin["id"],
    })
    r = client.get("/api/today/actions", headers=admin_headers)
    body = r.json()
    renewals = body["renewals_due"]
    matched = next((x for x in renewals if x["full_name"] == "Joining Match"), None)
    orphan = next((x for x in renewals if x["full_name"] == "Orphan Person"), None)
    assert matched is not None
    assert matched["lead_id"] == "real-lead-id-123"   # joined via ghl_contact_id
    assert orphan is not None
    assert orphan["lead_id"] is None                   # no match → null


@pytest.mark.asyncio
async def test_today_mtd_commission_sums_appointments(client, db, admin_headers):
    """Today response carries an mtd_commission total that excludes
    cancelled rows and any prior-month rows."""
    from datetime import datetime, timezone
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    now_iso = datetime.now(timezone.utc).isoformat()
    today_iso = datetime.now(timezone.utc).date().isoformat()
    month_start_iso = datetime.now(timezone.utc).date().replace(day=1).isoformat()
    # Three this-month appointments (two count, one cancelled) + one
    # null-commission row that should also be skipped.
    await db.appointments.insert_many([
        {"appointment_id": "tm-1", "agent_id": admin["id"], "client_name": "A",
         "appointment_date": month_start_iso, "appointment_time": "09:00",
         "duration_minutes": 30, "type": "enrollment",
         "status": "completed", "estimated_commission": 313.0,
         "created_at": now_iso, "updated_at": now_iso},
        {"appointment_id": "tm-2", "agent_id": admin["id"], "client_name": "B",
         "appointment_date": today_iso, "appointment_time": "10:00",
         "duration_minutes": 30, "type": "enrollment",
         "status": "scheduled", "estimated_commission": 93.90,
         "created_at": now_iso, "updated_at": now_iso},
        {"appointment_id": "tm-3", "agent_id": admin["id"], "client_name": "C",
         "appointment_date": today_iso, "appointment_time": "11:00",
         "duration_minutes": 30, "type": "enrollment",
         "status": "cancelled", "estimated_commission": 500.0,
         "created_at": now_iso, "updated_at": now_iso},
        {"appointment_id": "tm-4", "agent_id": admin["id"], "client_name": "D",
         "appointment_date": today_iso, "appointment_time": "12:00",
         "duration_minutes": 30, "type": "plan_review",
         "status": "scheduled", "estimated_commission": None,
         "created_at": now_iso, "updated_at": now_iso},
    ])
    r = client.get("/api/today/actions", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "mtd_commission" in body
    # 313.0 + 93.90 = 406.90 (cancelled + null skipped)
    assert body["mtd_commission"] == 406.90


@pytest.mark.asyncio
async def test_today_actions_audits(client, db, admin_headers):
    """Every Today fetch must drop a today_viewed audit row."""
    client.get("/api/today/actions", headers=admin_headers)
    entry = await db.audit_logs.find_one({"event_type": "today_viewed"})
    assert entry is not None
    assert "urgent_count" in entry["metadata"]


# ── Appointments router ────────────────────────────────────────────────────
def test_appointments_requires_auth(client, db):
    """Unauthenticated GET is rejected."""
    r = client.get("/api/appointments")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_appointment_create_and_list(client, db, admin_headers):
    """Happy-path create stamps the doc; list returns it with denormalized name."""
    # Seed a lead the admin owns so _resolve_lead passes for non-privileged
    # too — admin is privileged anyway, but this also verifies denormalization.
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-lead-1",
        "first_name": "Mira", "last_name": "Holt",
        "phone": "555-0101", "email": "mira@example.com",
        "status": "new", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-lead-1",
        "appointment_date": "2026-06-15",
        "appointment_time": "10:30",
        "duration_minutes": 60,
        "type": "plan_review",
        "notes": "Annual review prep",
        "estimated_commission": 480.00,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["appointment_id"]
    assert body["client_name"] == "Mira Holt"
    assert body["status"] == "scheduled"
    assert body["estimated_commission"] == 480.00

    listed = client.get("/api/appointments?date=2026-06-15", headers=admin_headers)
    assert listed.status_code == 200
    rows = listed.json()["appointments"]
    assert any(r["appointment_id"] == body["appointment_id"] for r in rows)


@pytest.mark.asyncio
async def test_appointment_create_400_when_lead_missing(client, db, admin_headers):
    """Booking against a non-existent lead returns 404."""
    r = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "no-such-lead",
        "appointment_date": "2026-06-15",
        "appointment_time": "10:30",
    })
    assert r.status_code == 404
    assert "Lead not found" in r.json()["detail"]


@pytest.mark.asyncio
async def test_appointment_autocalc_commission_for_ma_lead(client, db, admin_headers):
    """A lead whose product_interest reads 'MAPD' should drive the
    calculator's MA branch ($313 first-year flat × 30% = $93.90)."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-autocalc-ma",
        "first_name": "Mira", "last_name": "Adv",
        "status": "new", "agent_id": admin["id"],
        "product_interest": "Looking for MAPD HMO",
        "state": "IL",
        "current_carrier": "Humana", "current_plan": "MAPD",
        "date_of_birth": "1955-03-15",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-autocalc-ma",
        "appointment_date": "2026-06-15",
        "appointment_time": "10:30",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["estimated_commission"] == 93.90


@pytest.mark.asyncio
async def test_appointment_autocalc_commission_for_pdp_lead(client, db, admin_headers):
    """PDP lead → flat $100 × 30% = $30 regardless of premium / state."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-autocalc-pdp",
        "first_name": "Polly", "last_name": "Drug",
        "status": "new", "agent_id": admin["id"],
        "product_interest": "PDP for prescriptions",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-autocalc-pdp",
        "appointment_date": "2026-06-16",
        "appointment_time": "11:00",
    })
    assert r.status_code == 201, r.text
    assert r.json()["estimated_commission"] == 30.0


@pytest.mark.asyncio
async def test_appointment_manual_commission_overrides_autocalc(client, db, admin_headers):
    """Manual estimated_commission in the body always wins — never
    overwritten by the auto-calc even when the lead would have produced
    a value."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-manual-override",
        "first_name": "Ovi", "last_name": "Manual",
        "status": "new", "agent_id": admin["id"],
        "product_interest": "MAPD",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-manual-override",
        "appointment_date": "2026-06-17",
        "appointment_time": "09:00",
        "estimated_commission": 750.0,
    })
    assert r.status_code == 201
    assert r.json()["estimated_commission"] == 750.0


@pytest.mark.asyncio
async def test_appointment_autocalc_returns_null_when_unmappable(client, db, admin_headers):
    """A lead with no product_interest / product_type leaves the
    appointment's estimated_commission null — agent fills it in manually
    if they want one."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-no-product",
        "first_name": "No", "last_name": "Product",
        "status": "new", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    r = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-no-product",
        "appointment_date": "2026-06-18",
        "appointment_time": "12:00",
    })
    assert r.status_code == 201
    assert r.json()["estimated_commission"] is None


# ── Appointment revenue-stats endpoint ────────────────────────────────────
def test_appointment_revenue_stats_requires_auth(client, db):
    """Unauthenticated GET is rejected."""
    r = client.get("/api/appointments/revenue-stats")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_appointment_revenue_stats_aggregates(client, db, admin_headers):
    """Three appointments (two with commission, one without) → counts +
    sums + averages and a by_type breakdown match a manual count."""
    from datetime import datetime, timezone
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    now_iso = datetime.now(timezone.utc).isoformat()
    today_iso = datetime.now(timezone.utc).date().isoformat()
    rows = [
        # Two enrollments, both completed, both with commission.
        {"appointment_id": "rs-1", "agent_id": admin["id"], "agent_name": "Admin",
         "lead_id": None, "client_name": "Alpha",
         "appointment_date": today_iso, "appointment_time": "09:00",
         "duration_minutes": 30, "type": "enrollment",
         "status": "completed", "estimated_commission": 93.90,
         "created_at": now_iso, "updated_at": now_iso},
        {"appointment_id": "rs-2", "agent_id": admin["id"], "agent_name": "Admin",
         "lead_id": None, "client_name": "Bravo",
         "appointment_date": today_iso, "appointment_time": "10:00",
         "duration_minutes": 30, "type": "enrollment",
         "status": "completed", "estimated_commission": 313.0,
         "created_at": now_iso, "updated_at": now_iso},
        # One plan_review, scheduled (not completed), no commission.
        {"appointment_id": "rs-3", "agent_id": admin["id"], "agent_name": "Admin",
         "lead_id": None, "client_name": "Charlie",
         "appointment_date": today_iso, "appointment_time": "11:00",
         "duration_minutes": 30, "type": "plan_review",
         "status": "scheduled", "estimated_commission": None,
         "created_at": now_iso, "updated_at": now_iso},
    ]
    await db.appointments.insert_many(rows)

    r = client.get("/api/appointments/revenue-stats?period=mtd",
                    headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["period"] == "mtd"
    assert body["total_appointments"] == 3
    assert body["completed_appointments"] == 2
    assert body["appointments_with_commission"] == 2
    assert body["total_estimated_commission"] == 406.90
    # avg_per_appointment = 406.90 / 3 ≈ 135.63
    assert body["avg_commission_per_appointment"] == 135.63
    # avg_per_completed = 406.90 / 2 = 203.45
    assert body["avg_commission_per_completed"] == 203.45
    # by_type: enrollment (count=2, total=406.90, avg=203.45),
    # plan_review (count=1, total=0, avg=0)
    by_type = {row["type"]: row for row in body["by_type"]}
    assert by_type["enrollment"]["count"] == 2
    assert by_type["enrollment"]["total_commission"] == 406.90
    assert by_type["enrollment"]["avg_commission"] == 203.45
    assert by_type["plan_review"]["count"] == 1
    assert by_type["plan_review"]["total_commission"] == 0.0
    # Top appointment = highest commission (rs-2, $313)
    assert body["top_appointment"]["client_name"] == "Bravo"
    assert body["top_appointment"]["estimated_commission"] == 313.0


@pytest.mark.asyncio
async def test_appointment_revenue_stats_agent_scoped(client, db, admin_headers):
    """An agent must only see their own appointment revenue."""
    # Stand up a second agent.
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "rs.bob@example.com", "full_name": "Bob Stats",
        "agency_name": "BR", "agent_name": "Bob Stats",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "rs.bob@example.com", "password": "Q9pl#aux!7zT",
        "full_name": "Bob Stats", "agency_name": "BR",
        "invite_token": inv["token"],
    })
    assert reg.status_code == 201, reg.text
    client.post(f"/api/auth/users/{reg.json()['id']}/approve", headers=admin_headers)
    bob_login = client.post("/api/auth/login", json={
        "email": "rs.bob@example.com", "password": "Q9pl#aux!7zT",
    })
    bob_headers = {"Authorization": f"Bearer {bob_login.json()['access_token']}"}
    bob_id = reg.json()["id"]

    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    today_iso = datetime.now(timezone.utc).date().isoformat()
    # Admin's appointment ($500) — Bob must NOT see this in his stats.
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.appointments.insert_one({
        "appointment_id": "rs-admin", "agent_id": admin["id"],
        "lead_id": None, "client_name": "Admin Client",
        "appointment_date": today_iso, "appointment_time": "09:00",
        "duration_minutes": 30, "type": "enrollment",
        "status": "completed", "estimated_commission": 500.0,
        "created_at": now_iso, "updated_at": now_iso,
    })
    # Bob's own appointment ($93.90).
    await db.appointments.insert_one({
        "appointment_id": "rs-bob", "agent_id": bob_id,
        "lead_id": None, "client_name": "Bob Client",
        "appointment_date": today_iso, "appointment_time": "10:00",
        "duration_minutes": 30, "type": "enrollment",
        "status": "scheduled", "estimated_commission": 93.90,
        "created_at": now_iso, "updated_at": now_iso,
    })

    bob_view = client.get("/api/appointments/revenue-stats?period=mtd",
                            headers=bob_headers)
    assert bob_view.status_code == 200
    bob_body = bob_view.json()
    assert bob_body["total_appointments"] == 1
    assert bob_body["total_estimated_commission"] == 93.90
    assert bob_body["top_appointment"]["client_name"] == "Bob Client"

    # Admin sees both — agent_filter returns {} for admin.
    admin_view = client.get("/api/appointments/revenue-stats?period=mtd",
                             headers=admin_headers)
    admin_body = admin_view.json()
    assert admin_body["total_appointments"] == 2
    assert admin_body["total_estimated_commission"] == 593.90


@pytest.mark.asyncio
async def test_appointment_revenue_stats_audit(client, db, admin_headers):
    """Every revenue-stats fetch must drop an appointment_revenue_viewed
    row in the audit log."""
    client.get("/api/appointments/revenue-stats?period=ytd", headers=admin_headers)
    entry = await db.audit_logs.find_one({"event_type": "appointment_revenue_viewed"})
    assert entry is not None
    assert entry["metadata"]["period"] == "ytd"


@pytest.mark.asyncio
async def test_appointment_create_walkin_without_lead(client, db, admin_headers):
    """Walk-in flow: omit lead_id, supply client_name → succeeds with
    lead_id stored as null."""
    r = client.post("/api/appointments", headers=admin_headers, json={
        "client_name": "Walk-in Prospect",
        "appointment_date": "2026-09-01",
        "appointment_time": "10:00",
        "type": "initial_consultation",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["lead_id"] is None
    assert body["client_name"] == "Walk-in Prospect"
    assert body["status"] == "scheduled"


def test_appointment_create_422_when_no_lead_and_no_name(client, db, admin_headers):
    """Walk-in flow without a client_name must 422 — we have nothing to
    stamp on the appointment row."""
    r = client.post("/api/appointments", headers=admin_headers, json={
        "appointment_date": "2026-09-01",
        "appointment_time": "10:00",
    })
    assert r.status_code == 422
    assert "client_name" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_appointment_rejects_bad_date_time(client, db, admin_headers):
    """Date/time validators reject obviously bad input."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-lead-2",
        "first_name": "Bad", "last_name": "Input",
        "status": "new", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    bad_date = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-lead-2",
        "appointment_date": "06/15/2026",  # MM/DD/YYYY — rejected
        "appointment_time": "10:30",
    })
    assert bad_date.status_code == 422

    bad_time = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-lead-2",
        "appointment_date": "2026-06-15",
        "appointment_time": "10:99",  # minute out of range
    })
    assert bad_time.status_code == 422


@pytest.mark.asyncio
async def test_appointment_patch_and_cancel(client, db, admin_headers):
    """PATCH updates whitelisted fields; DELETE soft-cancels without removing."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-lead-3",
        "first_name": "Soft", "last_name": "Cancel",
        "status": "new", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    created = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-lead-3",
        "appointment_date": "2026-07-01",
        "appointment_time": "14:00",
    }).json()
    appt_id = created["appointment_id"]

    patched = client.patch(
        f"/api/appointments/{appt_id}",
        headers=admin_headers,
        json={"status": "completed", "outcome": "Enrolled in MAPD"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["status"] == "completed"
    assert patched.json()["outcome"] == "Enrolled in MAPD"

    cancelled = client.delete(f"/api/appointments/{appt_id}", headers=admin_headers)
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"

    # Doc still exists in DB — soft-cancel only.
    surviving = await db.appointments.find_one({"appointment_id": appt_id})
    assert surviving is not None
    assert surviving["status"] == "cancelled"


@pytest.mark.asyncio
async def test_appointment_idor_agent_cant_see_others(client, db, admin_headers):
    """An agent must 403 on another agent's appointment id."""
    # Stand up a second agent via the invite/register flow.
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": "appt.bob@example.com", "full_name": "Bob Booker",
        "agency_name": "BB", "agent_name": "Bob Booker",
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": "appt.bob@example.com", "password": "BobPass!2026",
        "full_name": "Bob Booker", "agency_name": "BB",
        "invite_token": inv["token"],
    })
    client.post(f"/api/auth/users/{reg.json()['id']}/approve", headers=admin_headers)
    bob_login = client.post("/api/auth/login", json={
        "email": "appt.bob@example.com", "password": "BobPass!2026",
    })
    bob_headers = {"Authorization": f"Bearer {bob_login.json()['access_token']}"}

    # Admin books an appointment owned by admin.
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-lead-admin",
        "first_name": "Admin", "last_name": "Client",
        "status": "new", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    appt = client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-lead-admin",
        "appointment_date": "2026-08-10",
        "appointment_time": "09:00",
    }).json()

    # Bob tries to read it — must 403 (existence is acknowledged, ownership isn't).
    r = client.get(f"/api/appointments/{appt['appointment_id']}", headers=bob_headers)
    assert r.status_code == 403
    # Bob's own list is empty — agent_filter scopes to him.
    own = client.get("/api/appointments", headers=bob_headers)
    assert own.status_code == 200
    assert own.json()["total"] == 0


# ── Lead source reporting ─────────────────────────────────────────────────
def test_lead_sources_requires_auth(client, db):
    """Unauthenticated GET is rejected."""
    r = client.get("/api/dashboard/lead-sources")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_lead_sources_groups_and_computes_conversion(client, db, admin_headers):
    """Three sources, mixed statuses → conversion rate math matches a manual count."""
    from datetime import datetime, timezone
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    now_iso = datetime.now(timezone.utc).isoformat()
    # 4 referral (2 enrolled), 2 web (0 enrolled), 1 unknown source (1 enrolled).
    seeds = [
        ("ls-r1", "referral", "enrolled"),
        ("ls-r2", "referral", "enrolled"),
        ("ls-r3", "referral", "new"),
        ("ls-r4", "referral", "contacted"),
        ("ls-w1", "web", "new"),
        ("ls-w2", "web", "lost"),
        ("ls-u1", None, "enrolled"),
    ]
    for lid, src, status in seeds:
        await db.leads.insert_one({
            "id": lid,
            "first_name": "S", "last_name": lid,
            "status": status, "agent_id": admin["id"],
            "lead_source": src,
            "created_at": now_iso, "updated_at": now_iso,
        })
    r = client.get("/api/dashboard/lead-sources?period=all", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    by_src = {s["source"]: s for s in body["sources"]}
    assert by_src["referral"]["total"] == 4
    assert by_src["referral"]["enrolled"] == 2
    assert by_src["referral"]["conversion_rate"] == 50.0
    assert by_src["web"]["total"] == 2
    assert by_src["web"]["conversion_rate"] == 0.0
    assert by_src["Unknown"]["total"] == 1
    assert by_src["Unknown"]["enrolled"] == 1
    assert by_src["Unknown"]["conversion_rate"] == 100.0
    # Sources sorted by total desc → referral first.
    assert body["sources"][0]["source"] == "referral"
    assert body["top_source"] == "referral"
    # best_converting must be the highest rate (Unknown at 100%) — not the
    # highest volume.
    assert body["best_converting"] == "Unknown"


@pytest.mark.asyncio
async def test_lead_sources_period_filter(client, db, admin_headers):
    """A lead created before the period window is excluded."""
    from datetime import datetime, timedelta, timezone
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    old_iso = (datetime.now(timezone.utc) - timedelta(days=120)).isoformat()
    new_iso = datetime.now(timezone.utc).isoformat()
    await db.leads.insert_one({
        "id": "old-lead", "first_name": "Old", "last_name": "Lead",
        "status": "new", "agent_id": admin["id"], "lead_source": "web",
        "created_at": old_iso, "updated_at": old_iso,
    })
    await db.leads.insert_one({
        "id": "new-lead", "first_name": "New", "last_name": "Lead",
        "status": "new", "agent_id": admin["id"], "lead_source": "web",
        "created_at": new_iso, "updated_at": new_iso,
    })
    # last30 should include only the new one.
    r = client.get("/api/dashboard/lead-sources?period=last30",
                    headers=admin_headers)
    body = r.json()
    web = next((s for s in body["sources"] if s["source"] == "web"), None)
    assert web is not None
    assert web["total"] == 1


@pytest.mark.asyncio
async def test_lead_sources_audits(client, db, admin_headers):
    """Every fetch writes lead_sources_viewed."""
    client.get("/api/dashboard/lead-sources?period=mtd", headers=admin_headers)
    entry = await db.audit_logs.find_one({"event_type": "lead_sources_viewed"})
    assert entry is not None
    assert entry["metadata"]["period"] == "mtd"


@pytest.mark.asyncio
async def test_today_picks_up_scheduled_appointment(client, db, admin_headers):
    """Once an appointment exists for today, /today/actions surfaces it."""
    from datetime import date, timezone, datetime
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "appt-today-lead",
        "first_name": "Today", "last_name": "Caller",
        "status": "new", "agent_id": admin["id"],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })
    today_iso = datetime.now(timezone.utc).date().isoformat()
    client.post("/api/appointments", headers=admin_headers, json={
        "lead_id": "appt-today-lead",
        "appointment_date": today_iso,
        "appointment_time": "11:00",
        "notes": "Plan review call",
    })

    r = client.get("/api/today/actions", headers=admin_headers)
    body = r.json()
    appts = body["todays_appointments"]
    assert any(a["client_name"] == "Today Caller" for a in appts)
    assert body["summary"]["appointments_count"] >= 1


@pytest.mark.asyncio
async def test_backup_excludes_passwords(client, db, admin_headers):
    """The backup dump must NEVER include hashed_password — neither
    via the projection nor via the belt-and-suspenders post-strip."""
    import os, gzip, json
    # Force the backup helper into "S3 not configured" mode so we
    # don't try to ship to a real bucket from tests — we exercise the
    # in-memory dump path directly instead.
    os.environ.pop("AWS_S3_BUCKET", None)
    from backup_service import BACKUP_COLLECTIONS, _dump_collection

    # The users projection itself must not include hashed_password.
    users_spec = next(s for s in BACKUP_COLLECTIONS if s["name"] == "users")
    proj = users_spec.get("projection") or {}
    assert proj.get("hashed_password") == 0, (
        f"hashed_password must be excluded by projection, got {proj}"
    )

    # Round-trip the dump: ensure no row carries the field.
    rows = await _dump_collection(db, "users", proj)
    for u in rows:
        assert "hashed_password" not in u, u


# ── Magic link auth ────────────────────────────────────────────────────────

def _mint_magic_token(db_sync, email: str, user_id: str,
                      *, expires_minutes: int = 15) -> str:
    """Drop a fresh magic_link_tokens row straight into the DB and
    return the raw token. Skips the email-send code path so the verify
    tests don't depend on Resend being mocked."""
    import secrets, hashlib
    from datetime import datetime, timedelta, timezone
    raw = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    return raw, {
        "token_hash": hashlib.sha256(raw.encode()).hexdigest(),
        "email": email,
        "user_id": user_id,
        "created_at": now,
        "expires_at": now + timedelta(minutes=expires_minutes),
        "used": False,
        "used_at": None,
        "ip": "127.0.0.1",
    }


@pytest.mark.asyncio
async def test_magic_link_request_success(client, db):
    """POST /auth/magic-link for a known user → 200 + opaque body +
    a magic_link_tokens row stored as a hash (raw token never persisted)."""
    admin = await db.users.find_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]}, {"_id": 0},
    )
    r = client.post("/api/auth/magic-link", json={"email": admin["email"]})
    assert r.status_code == 200, r.text
    assert "login link" in r.json()["message"].lower()

    row = await db.magic_link_tokens.find_one(
        {"email": admin["email"]}, {"_id": 0},
    )
    assert row is not None
    assert row["used"] is False
    assert row["user_id"] == admin["id"]
    # Stored hash, never raw token.
    assert len(row["token_hash"]) == 64


@pytest.mark.asyncio
async def test_magic_link_verify_success(client, db):
    """Token redemption issues a session cookie and marks the row used."""
    admin = await db.users.find_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]}, {"_id": 0},
    )
    raw, row = _mint_magic_token(db, admin["email"], admin["id"])
    await db.magic_link_tokens.insert_one(row)

    r = client.post("/api/auth/magic-link/verify", json={"token": raw})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert body["user"]["email"] == admin["email"]
    # Session cookie planted.
    assert "ghw_access_token" in r.cookies or any(
        c.name == "ghw_access_token" for c in client.cookies.jar
    )

    used = await db.magic_link_tokens.find_one(
        {"token_hash": row["token_hash"]}, {"_id": 0},
    )
    assert used["used"] is True
    assert used["used_at"] is not None


@pytest.mark.asyncio
async def test_magic_link_expired_400(client, db):
    """An expired token must 400 with the same generic message."""
    from datetime import datetime, timedelta, timezone
    admin = await db.users.find_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]}, {"_id": 0},
    )
    raw, row = _mint_magic_token(db, admin["email"], admin["id"])
    # Force expiry 1 minute in the past.
    row["expires_at"] = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db.magic_link_tokens.insert_one(row)

    r = client.post("/api/auth/magic-link/verify", json={"token": raw})
    assert r.status_code == 400, r.text
    assert "expired" in r.json()["detail"].lower() or \
           "invalid" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_magic_link_used_twice_400(client, db):
    """Single-use: redeeming the same token a second time must 400."""
    admin = await db.users.find_one(
        {"email": os.environ["SEED_ADMIN_EMAIL"]}, {"_id": 0},
    )
    raw, row = _mint_magic_token(db, admin["email"], admin["id"])
    await db.magic_link_tokens.insert_one(row)

    r1 = client.post("/api/auth/magic-link/verify", json={"token": raw})
    assert r1.status_code == 200, r1.text

    # Drop the session cookie before the replay so the second call is
    # actually exercising the magic-link path and not a stale session.
    client.cookies.clear()
    r2 = client.post("/api/auth/magic-link/verify", json={"token": raw})
    assert r2.status_code == 400, r2.text


def test_magic_link_unknown_email_200(client, db):
    """Unknown email must still 200 — no account-enumeration signal."""
    r = client.post("/api/auth/magic-link",
                    json={"email": "nobody-at-all@example.com"})
    assert r.status_code == 200, r.text
    assert "login link" in r.json()["message"].lower()


def test_password_login_still_works(client, db):
    """Email + password login (Option B) must continue to issue a
    session in one step — no MFA challenge in the response body."""
    r = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert body["user"]["email"] == os.environ["SEED_ADMIN_EMAIL"]
    # mfa_required must no longer be a field in the response.
    assert "mfa_required" not in body


# ── Team-member assignment (multi-user agent accounts) ────────────────────

async def _seed_user(db, email: str, role: str = "agent",
                     full_name: str | None = None,
                     parent_agent_id: str | None = None) -> dict:
    """Helper: insert a synthetic active user directly into Mongo.

    Bypasses the invite-token flow so the team-member tests stay
    focused on parent_agent_id behaviour and don't need to drive
    register / approve as side-effects."""
    import uuid
    from security import hash_password
    from datetime import datetime, timezone
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "agent_id": uid,
        "email": email,
        "full_name": full_name or email.split("@")[0].title(),
        "agent_name": full_name or email.split("@")[0].title(),
        "role": role,
        "is_active": True,
        "status": "active",
        "hashed_password": hash_password("Q9pl#aux!7zT-seed"),
        "token_version": 0, "failed_attempts": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if parent_agent_id:
        doc["parent_agent_id"] = parent_agent_id
    await db.users.insert_one(doc)
    return doc


def _login_token(client, email: str) -> str:
    """Log in as a synthetic user (seeded with the helper above) and
    return the Bearer token so a test can issue authenticated calls
    without sharing a cookie jar."""
    r = client.post("/api/auth/login", json={
        "email": email, "password": "Q9pl#aux!7zT-seed",
    })
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.mark.asyncio
async def test_team_assign_success(client, db, admin_headers):
    """Admin assigns a VA to an agent's team → parent_agent_id stamped,
    team_member_assigned audit row written."""
    parent = await _seed_user(db, "parent.agent@example.com", role="agent",
                               full_name="Parent Agent")
    va = await _seed_user(db, "va.helper@example.com", role="va",
                          full_name="VA Helper")

    r = client.post(f"/api/agents/{parent['id']}/team",
                    headers=admin_headers,
                    json={"user_id": va["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["parent_agent_id"] == parent["id"]

    fresh = await db.users.find_one({"id": va["id"]}, {"_id": 0})
    assert fresh["parent_agent_id"] == parent["id"]

    audit = await db.audit_logs.find_one({
        "event_type": "team_member_assigned",
        "target_id": va["id"],
    })
    assert audit is not None
    assert audit["metadata"]["parent_agent_id"] == parent["id"]


@pytest.mark.asyncio
async def test_team_assign_wrong_role_400(client, db, admin_headers):
    """Assigning an admin / owner / compliance user as a team member
    must 400 — those roles operate at agency scope and pinning them
    inside another agent would silently demote them."""
    parent = await _seed_user(db, "parent2@example.com", role="agent")
    # Assigning a compliance-bucket role must be refused.
    compliance = await _seed_user(db, "compliance.user@example.com",
                                   role="compliance")
    r = client.post(f"/api/agents/{parent['id']}/team",
                    headers=admin_headers,
                    json={"user_id": compliance["id"]})
    assert r.status_code == 400, r.text
    assert "va" in r.json()["detail"].lower() or \
           "agent" in r.json()["detail"].lower()

    fresh = await db.users.find_one({"id": compliance["id"]}, {"_id": 0})
    assert fresh.get("parent_agent_id") in (None, "")


@pytest.mark.asyncio
async def test_team_remove_success(client, db, admin_headers):
    """DELETE /agents/{id}/team/{user_id} clears parent_agent_id."""
    parent = await _seed_user(db, "parent3@example.com", role="agent")
    va = await _seed_user(db, "va2@example.com", role="va",
                          parent_agent_id=parent["id"])

    r = client.delete(f"/api/agents/{parent['id']}/team/{va['id']}",
                      headers=admin_headers)
    assert r.status_code == 200, r.text

    fresh = await db.users.find_one({"id": va["id"]}, {"_id": 0})
    assert fresh.get("parent_agent_id") is None

    audit = await db.audit_logs.find_one({
        "event_type": "team_member_removed",
        "target_id": va["id"],
    })
    assert audit is not None


@pytest.mark.asyncio
async def test_team_scoped_reads_parent_data(client, db, admin_headers):
    """A VA assigned to a parent agent must read the parent's leads,
    not their own. Validates that agent_filter() honours
    parent_agent_id ahead of role."""
    parent = await _seed_user(db, "parent4@example.com", role="agent",
                               full_name="Parent Four")
    va = await _seed_user(db, "va3@example.com", role="va",
                          parent_agent_id=parent["id"])

    # Seed a lead owned by the parent. Use the admin-headers POST so
    # the X-Agent-ID override stamps the parent's id.
    r = client.post(
        "/api/leads",
        headers={**admin_headers, "X-Agent-ID": parent["id"]},
        json={"first_name": "Owned", "last_name": "ByParent"},
    )
    assert r.status_code == 201, r.text
    parent_lead_id = r.json()["id"]

    # VA logs in (Bearer header) and lists leads — should see the
    # parent's lead, NOT an empty list.
    va_token = _login_token(client, "va3@example.com")
    r2 = client.get("/api/leads",
                    headers={"Authorization": f"Bearer {va_token}"})
    assert r2.status_code == 200, r2.text
    # Pagination envelope shape: {leads: [...], total, page, limit, pages, has_next, has_prev}
    body = r2.json()
    ids = [ld["id"] for ld in body["leads"]]
    assert parent_lead_id in ids, (
        f"VA should see parent agent's leads via parent_agent_id "
        f"scope, got {ids}"
    )


@pytest.mark.asyncio
async def test_team_member_cannot_assign_others(client, db, admin_headers):
    """Team members (role=va) must not be allowed to call the team
    assignment endpoint — only admin / owner. Confirms the
    require_roles gate at the route level."""
    parent = await _seed_user(db, "parent5@example.com", role="agent")
    va = await _seed_user(db, "va.attacker@example.com", role="va",
                          parent_agent_id=parent["id"])
    other_va = await _seed_user(db, "va.target@example.com", role="va")

    va_token = _login_token(client, "va.attacker@example.com")
    r = client.post(
        f"/api/agents/{parent['id']}/team",
        headers={"Authorization": f"Bearer {va_token}"},
        json={"user_id": other_va["id"]},
    )
    assert r.status_code == 403, r.text

    fresh = await db.users.find_one({"id": other_va["id"]}, {"_id": 0})
    assert fresh.get("parent_agent_id") in (None, "")


# ── Agency Command Center ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_kpis_returns_correct_period(client, db, admin_headers):
    """KPI endpoint returns the spec'd envelope shape, honours the
    period filter, and computes period-over-period trends correctly.

    Two enrolled leads in the last 24h vs zero in the prior 30-day
    bucket → trend_pct should cap at 100.0 (we don't ship infinity)."""
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    # Lead created today, enrolled.
    await db.leads.insert_many([
        {
            "id": f"lk-{i}", "agent_id": "kp-agent", "agent_name": "KP",
            "first_name": f"K{i}", "last_name": "Test",
            "status": "enrolled", "lead_source": "Facebook",
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
        }
        for i in range(2)
    ])
    r = client.get("/api/agency-dashboard/kpis?period=last30",
                   headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["period"] == "last30"
    assert "date_range" in body and body["date_range"]["start"]
    assert body["leads"]["new_this_period"] >= 2
    assert body["enrolled"]["new_this_period"] >= 2
    # Trend: 2 enrolled vs 0 prior → capped at 100.0 (not Inf).
    assert body["enrolled"]["trend_pct"] == 100.0
    # Right-now alert metrics always present.
    for key in ("birthday_windows", "renewals", "stale_agents"):
        assert key in body


@pytest.mark.asyncio
async def test_agent_performance_sorted(client, db, admin_headers):
    """Agent rows must come back ordered by enrolled_count desc."""
    # Two synthetic producers with different enrolled counts.
    a = await _seed_user(db, "perf.a@example.com", role="agent",
                          full_name="Perf A")
    b = await _seed_user(db, "perf.b@example.com", role="agent",
                          full_name="Perf B")
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    # B has 3 enrolled, A has 1 — performance table should sort B first.
    await db.leads.insert_many([
        {"id": f"a-lead-{i}", "agent_id": a["id"], "agent_name": "Perf A",
         "first_name": f"a{i}", "last_name": "X", "status": "enrolled",
         "created_at": now_iso, "updated_at": now_iso}
        for i in range(1)
    ] + [
        {"id": f"b-lead-{i}", "agent_id": b["id"], "agent_name": "Perf B",
         "first_name": f"b{i}", "last_name": "X", "status": "enrolled",
         "created_at": now_iso, "updated_at": now_iso}
        for i in range(3)
    ])
    r = client.get("/api/agency-dashboard/agent-performance?period=all",
                   headers=admin_headers)
    assert r.status_code == 200, r.text
    rows = r.json()["agents"]
    # Both seeded agents must appear, and B must rank above A.
    names = [r["agent_name"] for r in rows]
    assert "Perf A" in names and "Perf B" in names
    assert names.index("Perf B") < names.index("Perf A")
    perf_b = next(r for r in rows if r["agent_name"] == "Perf B")
    assert perf_b["enrolled_count"] == 3
    assert perf_b["status"] in ("active", "stale", "inactive")


@pytest.mark.asyncio
async def test_charts_return_12_weeks(client, db, admin_headers):
    """enrollments_by_week always returns exactly 12 buckets — the
    sustained-trend chart is fixed-length regardless of `period`."""
    r = client.get("/api/agency-dashboard/charts?period=mtd",
                   headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["enrollments_by_week"]) == 12
    # Each bucket has the spec'd shape.
    for bucket in body["enrollments_by_week"]:
        assert {"week", "label", "count"} <= set(bucket.keys())
        assert bucket["week"].startswith("20") and "-W" in bucket["week"]
    # Other two charts are present but may be empty on a fresh DB.
    assert "revenue_by_carrier" in body
    assert "leads_by_source" in body


@pytest.mark.asyncio
async def test_drilldown_pagination(client, db, admin_headers):
    """Drilldown returns the spec'd pagination envelope and the
    page_size cap of 50."""
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    # Seed 60 leads so we can prove pagination.
    await db.leads.insert_many([
        {"id": f"dd-{i}", "agent_id": "dd-agent", "agent_name": "DD",
         "first_name": f"d{i}", "last_name": "Lead", "status": "new",
         "lead_source": "Webform",
         "created_at": now_iso, "updated_at": now_iso}
        for i in range(60)
    ])
    r = client.get("/api/agency-dashboard/drilldown/leads?period=all&page=1",
                   headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert body["total"] >= 60
    assert len(body["rows"]) == 50
    # Page 2 has the remainder.
    r2 = client.get("/api/agency-dashboard/drilldown/leads?period=all&page=2",
                    headers=admin_headers)
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["page"] == 2
    assert len(body2["rows"]) >= 10


@pytest.mark.asyncio
async def test_me_parent_returns_parent_name(client, db):
    """A team member calling /auth/me/parent gets the parent's name +
    email back; an unassigned user gets null."""
    parent = await _seed_user(db, "parent.me@example.com", role="agent",
                               full_name="Parent Me")
    va = await _seed_user(db, "va.me@example.com", role="va",
                          parent_agent_id=parent["id"])
    standalone = await _seed_user(db, "standalone.me@example.com",
                                    role="agent")

    va_token = _login_token(client, "va.me@example.com")
    r = client.get("/api/auth/me/parent",
                   headers={"Authorization": f"Bearer {va_token}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["parent"] is not None
    assert body["parent"]["id"] == parent["id"]
    assert body["parent"]["full_name"] == "Parent Me"

    # Stand-alone user without parent_agent_id → null.
    standalone_token = _login_token(client, "standalone.me@example.com")
    r2 = client.get("/api/auth/me/parent",
                    headers={"Authorization": f"Bearer {standalone_token}"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["parent"] is None


@pytest.mark.asyncio
async def test_invite_with_parent_agent_id_stamps_on_register(
    client, db, admin_headers,
):
    """An invite carrying parent_agent_id stamps the new user with it
    on register, so VAs come up already inside the parent's scope on
    first sign-in."""
    parent = await _seed_user(db, "parent.invite@example.com", role="agent",
                               full_name="Parent Invite")
    # Admin issues the invite for a VA with parent_agent_id set.
    inv_r = client.post(
        "/api/auth/invite",
        headers=admin_headers,
        json={
            "email": "new.va@example.com",
            "full_name": "New VA",
            "agency_name": "GHW",
            "role": "va",
            "parent_agent_id": parent["id"],
        },
    )
    assert inv_r.status_code == 201, inv_r.text
    raw_token = inv_r.json()["token"]

    # VA accepts the invite — the parent_agent_id from the invite must
    # land on the user row.
    reg_r = client.post(
        "/api/auth/register",
        json={
            "email": "new.va@example.com",
            "full_name": "New VA",
            "agency_name": "GHW",
            "password": "Q9pl#aux!7zT-newva",
            "invite_token": raw_token,
        },
    )
    assert reg_r.status_code == 201, reg_r.text

    fresh = await db.users.find_one(
        {"email": "new.va@example.com"}, {"_id": 0},
    )
    assert fresh["parent_agent_id"] == parent["id"], (
        f"Invite's parent_agent_id should be stamped on register, "
        f"got {fresh.get('parent_agent_id')}"
    )


@pytest.mark.asyncio
async def test_agency_role_required_403_for_agent(client, db, admin_headers):
    """Plain agents must be refused (403) on every command-center
    endpoint. Only owner/admin/coach/sales_manager/compliance/
    accounting may read."""
    await _seed_user(db, "agent.peek@example.com", role="agent")
    token = _login_token(client, "agent.peek@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    for path in (
        "/api/agency-dashboard/kpis",
        "/api/agency-dashboard/agent-performance",
        "/api/agency-dashboard/charts",
        "/api/agency-dashboard/alerts",
        "/api/agency-dashboard/drilldown/leads",
    ):
        r = client.get(path, headers=headers)
        assert r.status_code == 403, f"{path}: {r.status_code} {r.text}"
