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
