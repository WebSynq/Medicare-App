"""Phase 4 — Per-agency email domain tests.

Covers
------
- Domain validation rejects bad inputs (IPs, reserved TLDs, junk)
- /setup happy path returns DNS records + flips agency row
- /verify polls Resend and flips verified=True on success
- /status reads from cached agency row only
- DELETE clears agency fields even when Resend errors
- Cross-agency isolation — one agency cannot read/modify another's
- /setup 503 when RESEND_API_KEY unset
- send_email uses per-agency FROM after verification; falls back to
  GHW for unverified / unset agencies

All Resend HTTP calls are stubbed via httpx.AsyncClient monkey-patch
so tests never reach the network.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict

import pytest

from agency_models import build_agency_defaults
from seed import GHW_AGENCY_ID


# ── Helpers ────────────────────────────────────────────────────────────
class _StubResp:
    def __init__(self, status_code: int, body: Any = None,
                  text: str = None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = text if text is not None else (
            "" if body is None else __import__("json").dumps(body)
        )

    def json(self):
        return self._body


class _StubHttpx:
    """Stand-in for httpx.AsyncClient used by resend_domains.* helpers.

    Holds a list of (method, path_match, response) tuples. On each
    request we pop the matching entry and return its response. If no
    entry matches we raise so the test author can see the missing
    expectation.
    """

    def __init__(self):
        self.queue: list = []
        self.requests: list = []

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self): return self
    async def __aexit__(self, *a): pass

    def queue_response(self, method: str, path_contains: str, resp: _StubResp):
        self.queue.append((method.upper(), path_contains, resp))

    def _handle(self, method: str, url: str, **kwargs):
        self.requests.append({"method": method, "url": url, **kwargs})
        for i, (m, p, r) in enumerate(self.queue):
            if m == method and p in url:
                self.queue.pop(i)
                return r
        raise AssertionError(
            f"unmocked resend call {method} {url}; queue={self.queue}"
        )

    async def post(self, url, **kwargs):
        return self._handle("POST", url, **kwargs)

    async def get(self, url, **kwargs):
        return self._handle("GET", url, **kwargs)

    async def delete(self, url, **kwargs):
        return self._handle("DELETE", url, **kwargs)


@pytest.fixture
def stub_resend(monkeypatch):
    """Patch resend_domains.httpx.AsyncClient with a stub. Returns
    the stub so the test can pre-load expected responses."""
    import resend_domains
    stub = _StubHttpx()
    monkeypatch.setattr(resend_domains.httpx, "AsyncClient",
                         lambda **kw: stub)
    monkeypatch.setenv("RESEND_API_KEY", "re_test_phase4")
    return stub


async def _seed_owner_agency(
    db, client, *, agency_id: str, slug: str,
    email: str = None, tier: str = "growth",
) -> Dict[str, Any]:
    from security import hash_password
    import uuid
    email = email or f"{slug}-owner@example.com"
    base = build_agency_defaults(
        name=slug.title(), slug=slug,
        owner_email=email, tier=tier,
    )
    doc = base.model_dump()
    doc["agency_id"] = agency_id
    await db.agencies.insert_one(doc)
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": email, "full_name": slug.title(),
        "role": "owner", "is_active": True, "status": "active",
        "agency_id": agency_id,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    login = client.post("/api/auth/login", json={
        "email": email, "password": "Q9pl#aux!7zT",
    })
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


# ── Domain validation ─────────────────────────────────────────────────
@pytest.mark.parametrize("bad", [
    "",                  # empty
    "localhost",         # reserved
    "not-a-domain",      # no TLD
    "..example.com",     # leading dot
    "example.com.",      # trailing dot
    "192.168.1.1",       # IP literal
    "test",              # bare label
    "x.test",            # blocked TLD .test
    "y.example",         # blocked TLD .example
    "z.local",           # blocked TLD .local
])
def test_setup_rejects_invalid_domains(
    client, admin_headers, stub_resend, bad,
):
    r = client.post("/api/email-domain/setup", headers=admin_headers,
                     json={"domain": bad})
    assert r.status_code in (400, 422), (
        f"expected 400/422 for {bad!r}, got {r.status_code}: {r.text}"
    )


def test_setup_accepts_valid_domain(client, admin_headers, stub_resend):
    """Valid domain + happy Resend response → 200, agency row updated."""
    stub_resend.queue_response("POST", "/domains", _StubResp(201, {
        "id": "rsd_dom_abc",
        "name": "mail.example.com",
        "status": "pending",
        "region": "us-east-1",
        "records": [
            {"record": "SPF", "name": "send", "type": "TXT",
             "value": "v=spf1 include:_spf.resend.com ~all",
             "status": "not_started", "ttl": "Auto"},
            {"record": "DKIM", "name": "resend._domainkey.send",
             "type": "TXT",
             "value": "p=MIGfMA0G...", "status": "not_started",
             "ttl": "Auto"},
        ],
    }))
    r = client.post("/api/email-domain/setup",
                     headers=admin_headers,
                     json={"domain": "mail.example.com",
                            "from_name": "Test Agency",
                            "from_local_part": "noreply"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["domain"] == "mail.example.com"
    assert body["verified"] is False
    assert body["from_email"] == "noreply@mail.example.com"
    assert body["from_name"] == "Test Agency"
    assert len(body["records"]) == 2


# ── Verify ─────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_verify_flips_verified_when_resend_says_verified(
    client, db, admin_headers, stub_resend,
):
    # Pre-seed the agency row.
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {
            "email_domain": "mail.example.com",
            "email_domain_verified": False,
            "resend_domain_id": "rsd_dom_v",
            "from_email": "noreply@mail.example.com",
            "from_name": "Test",
        }},
    )
    try:
        stub_resend.queue_response(
            "POST", "/domains/rsd_dom_v/verify",
            _StubResp(200, {"id": "rsd_dom_v", "status": "verified",
                              "records": []}),
        )
        r = client.post("/api/email-domain/verify", headers=admin_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "verified"
        assert body["verified"] is True
        refreshed = await db.agencies.find_one({"agency_id": GHW_AGENCY_ID})
        assert refreshed["email_domain_verified"] is True
    finally:
        await db.agencies.update_one(
            {"agency_id": GHW_AGENCY_ID},
            {"$set": {
                "email_domain": None,
                "email_domain_verified": False,
                "resend_domain_id": None,
                "from_email": None,
            }},
        )


@pytest.mark.asyncio
async def test_verify_keeps_unverified_when_resend_pending(
    client, db, admin_headers, stub_resend,
):
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {
            "email_domain": "mail.example.com",
            "email_domain_verified": False,
            "resend_domain_id": "rsd_dom_pending",
        }},
    )
    try:
        stub_resend.queue_response(
            "POST", "/domains/rsd_dom_pending/verify",
            _StubResp(200, {"id": "rsd_dom_pending", "status": "pending"}),
        )
        r = client.post("/api/email-domain/verify", headers=admin_headers)
        assert r.status_code == 200, r.text
        assert r.json()["verified"] is False
        refreshed = await db.agencies.find_one({"agency_id": GHW_AGENCY_ID})
        assert refreshed["email_domain_verified"] is False
    finally:
        await db.agencies.update_one(
            {"agency_id": GHW_AGENCY_ID},
            {"$set": {
                "email_domain": None,
                "email_domain_verified": False,
                "resend_domain_id": None,
            }},
        )


def test_verify_400_when_no_domain_setup(client, admin_headers, stub_resend):
    r = client.post("/api/email-domain/verify", headers=admin_headers)
    assert r.status_code == 400, r.text


# ── Status ────────────────────────────────────────────────────────────
def test_status_returns_empty_for_fresh_agency(client, admin_headers):
    r = client.get("/api/email-domain/status", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    # GHW seed doesn't set up a domain → all null/false.
    assert body["domain"] is None
    assert body["verified"] is False
    assert body["from_email"] is None


# ── Delete ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_delete_clears_agency_fields(
    client, db, admin_headers, stub_resend,
):
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {
            "email_domain": "mail.example.com",
            "email_domain_verified": True,
            "resend_domain_id": "rsd_dom_del",
            "from_email": "noreply@mail.example.com",
        }},
    )
    stub_resend.queue_response(
        "DELETE", "/domains/rsd_dom_del", _StubResp(200, {"deleted": True}),
    )
    r = client.delete("/api/email-domain", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["domain"] is None
    assert body["verified"] is False
    refreshed = await db.agencies.find_one({"agency_id": GHW_AGENCY_ID})
    assert refreshed["email_domain"] is None
    assert refreshed["email_domain_verified"] is False


@pytest.mark.asyncio
async def test_delete_clears_local_even_when_resend_errors(
    client, db, admin_headers, stub_resend,
):
    """If Resend errors on delete we still must clear the agency row —
    otherwise the agency is stuck in a half-state."""
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {
            "email_domain": "mail.example.com",
            "email_domain_verified": True,
            "resend_domain_id": "rsd_dom_err",
        }},
    )
    stub_resend.queue_response(
        "DELETE", "/domains/rsd_dom_err",
        _StubResp(500, {"message": "server error"}),
    )
    r = client.delete("/api/email-domain", headers=admin_headers)
    assert r.status_code == 200, r.text
    refreshed = await db.agencies.find_one({"agency_id": GHW_AGENCY_ID})
    assert refreshed["email_domain"] is None


# ── Auth + agency isolation ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_setup_403_for_non_owner(client, db, stub_resend):
    """Plain `agent` role can't set up the agency domain."""
    from security import hash_password
    import uuid
    aid = "ag-domiso-1"
    base = build_agency_defaults(
        name="Iso", slug="iso-co",
        owner_email="iso@example.com", tier="growth",
    )
    doc = base.model_dump()
    doc["agency_id"] = aid
    await db.agencies.insert_one(doc)
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": "iso-agent@example.com", "full_name": "Iso Agent",
        "role": "agent",  # not owner
        "is_active": True, "status": "active",
        "agency_id": aid,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    login = client.post("/api/auth/login", json={
        "email": "iso-agent@example.com", "password": "Q9pl#aux!7zT",
    })
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = client.post("/api/email-domain/setup", headers=headers,
                     json={"domain": "mail.example.com"})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_status_scoped_to_callers_agency(client, db, stub_resend):
    """Owner A reads agency A's status; owner B sees only agency B."""
    a_headers = await _seed_owner_agency(
        db, client, agency_id="ag-a", slug="agencyA",
        email="a-owner@example.com",
    )
    b_headers = await _seed_owner_agency(
        db, client, agency_id="ag-b", slug="agencyB",
        email="b-owner@example.com",
    )
    # Put a domain on agency A only.
    await db.agencies.update_one(
        {"agency_id": "ag-a"},
        {"$set": {
            "email_domain": "mail.a.example.com",
            "email_domain_verified": True,
            "from_email": "noreply@mail.a.example.com",
        }},
    )
    ra = client.get("/api/email-domain/status", headers=a_headers)
    rb = client.get("/api/email-domain/status", headers=b_headers)
    assert ra.json()["domain"] == "mail.a.example.com"
    assert rb.json()["domain"] is None
    assert rb.json()["verified"] is False


# ── Resend unconfigured ───────────────────────────────────────────────
@pytest.mark.asyncio
async def test_setup_503_when_resend_key_unset(
    client, admin_headers, monkeypatch,
):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    r = client.post("/api/email-domain/setup", headers=admin_headers,
                     json={"domain": "mail.example.com"})
    assert r.status_code == 503, r.text


# ── send_email FROM resolution ────────────────────────────────────────
@pytest.mark.asyncio
async def test_send_email_uses_agency_from_when_verified(
    db, monkeypatch,
):
    """resend_client.send_email picks the agency's from_email when
    the agency has a verified domain."""
    import resend_client as rc
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {
            "email_domain": "mail.example.com",
            "email_domain_verified": True,
            "from_email": "noreply@mail.example.com",
            "from_name": "Test Agency",
        }},
    )
    captured: list = []

    class _OkResp:
        status_code = 200
        text = ""

    class _FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def post(self, url, json=None, **kw):
            captured.append(json or {})
            return _OkResp()

    monkeypatch.setenv("RESEND_API_KEY", "re_test_phase4")
    monkeypatch.setattr(rc.httpx, "AsyncClient", lambda **kw: _FakeClient())
    try:
        ok = await rc.send_email(
            to="x@example.com", subject="s", html="<p>x</p>",
            agency_id=GHW_AGENCY_ID,
        )
        assert ok is True
        assert captured, "send_email never POSTed"
        # The agency FROM should win over the platform default.
        assert captured[-1]["from"] == "Test Agency <noreply@mail.example.com>"
    finally:
        await db.agencies.update_one(
            {"agency_id": GHW_AGENCY_ID},
            {"$set": {
                "email_domain": None,
                "email_domain_verified": False,
                "from_email": None,
                "from_name": None,
            }},
        )


@pytest.mark.asyncio
async def test_send_email_falls_back_when_domain_unverified(
    db, monkeypatch,
):
    """Domain set but not verified → fall back to GHW so Resend doesn't
    reject the send."""
    import resend_client as rc
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {
            "email_domain": "mail.example.com",
            "email_domain_verified": False,   # NOT verified
            "from_email": "noreply@mail.example.com",
            "from_name": "Test",
        }},
    )
    captured: list = []

    class _OkResp:
        status_code = 200
        text = ""

    class _FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def post(self, url, json=None, **kw):
            captured.append(json or {})
            return _OkResp()

    monkeypatch.setenv("RESEND_API_KEY", "re_test_phase4")
    monkeypatch.setattr(rc.httpx, "AsyncClient", lambda **kw: _FakeClient())
    try:
        ok = await rc.send_email(
            to="x@example.com", subject="s", html="<p>x</p>",
            agency_id=GHW_AGENCY_ID,
        )
        assert ok is True
        # Platform default in use.
        assert captured[-1]["from"] == rc.FROM_ADDRESS
    finally:
        await db.agencies.update_one(
            {"agency_id": GHW_AGENCY_ID},
            {"$set": {
                "email_domain": None,
                "email_domain_verified": False,
                "from_email": None,
                "from_name": None,
            }},
        )


@pytest.mark.asyncio
async def test_send_email_falls_back_when_no_agency_id(monkeypatch):
    """No agency context → platform default (untenanted automation
    alerts, lockout notifications, etc.)."""
    import resend_client as rc
    captured: list = []

    class _OkResp:
        status_code = 200
        text = ""

    class _FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def post(self, url, json=None, **kw):
            captured.append(json or {})
            return _OkResp()

    monkeypatch.setenv("RESEND_API_KEY", "re_test_phase4")
    monkeypatch.setattr(rc.httpx, "AsyncClient", lambda **kw: _FakeClient())
    ok = await rc.send_email(
        to="x@example.com", subject="s", html="<p>x</p>",
    )
    assert ok is True
    assert captured[-1]["from"] == rc.FROM_ADDRESS
