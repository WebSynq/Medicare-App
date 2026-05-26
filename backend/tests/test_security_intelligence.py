"""AI security console tests.

Network calls (ipapi.co, Anthropic) never fire in tests:
  - ANTHROPIC_API_KEY is unset in conftest → analysis returns safe defaults
  - lookup_ip on private IPs short-circuits without HTTP
Tests focus on the behaviour the API contract guarantees regardless of
upstream availability: role gates, schema, kill-switch toggle, ban/unban
round-trip, response shapes.
"""
import pytest

from security_intelligence import (
    _is_private_ip, execute_auto_ban, get_security_config,
    run_ai_security_analysis, set_security_config, unban_ip,
)


def _make_agent(client, admin_headers, email,
                 password="Q9pl#aux!7zT"):
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": email, "full_name": email.split("@")[0],
        "agency_name": "GHW", "agent_name": email.split("@")[0],
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": email, "password": password,
        "full_name": email.split("@")[0], "agency_name": "GHW",
        "invite_token": inv["token"],
    })
    uid = reg.json()["id"]
    client.post(f"/api/auth/users/{uid}/approve", headers=admin_headers)
    login = client.post("/api/auth/login", json={
        "email": email, "password": password,
    })
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


# ── Pure helpers ────────────────────────────────────────────────────────
def test_private_ip_detection():
    assert _is_private_ip("10.0.0.1")
    assert _is_private_ip("192.168.1.1")
    assert _is_private_ip("172.16.5.1")
    assert _is_private_ip("127.0.0.1")
    assert _is_private_ip("169.254.1.1")
    assert not _is_private_ip("8.8.8.8")
    assert not _is_private_ip("1.1.1.1")
    # Garbage → treat as private (skip lookup).
    assert _is_private_ip("not-an-ip")
    assert _is_private_ip("")


# ── /security/config ────────────────────────────────────────────────────
def test_config_get_default(client, admin_headers):
    r = client.get("/api/security/config", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_auto_ban_enabled"] is True
    assert "alert_emails" in body
    assert "agent_ip_whitelist" in body


def test_config_patch_kill_switch(client, admin_headers):
    # Disable
    r1 = client.patch("/api/security/config", headers=admin_headers,
                       json={"ai_auto_ban_enabled": False})
    assert r1.status_code == 200, r1.text
    assert r1.json()["ai_auto_ban_enabled"] is False
    # Re-enable
    r2 = client.patch("/api/security/config", headers=admin_headers,
                       json={"ai_auto_ban_enabled": True})
    assert r2.json()["ai_auto_ban_enabled"] is True


def test_config_agent_only_forbidden(client, db, admin_headers):
    agent_headers = _make_agent(client, admin_headers, "secagent@example.com")
    r = client.get("/api/security/config", headers=agent_headers)
    assert r.status_code == 403


# ── /security/events ────────────────────────────────────────────────────
def test_events_empty_returns_empty_list(client, admin_headers):
    r = client.get("/api/security/events", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    assert body == {"events": [], "count": 0}


def test_events_filter_validates_threat_level(client, admin_headers):
    r = client.get("/api/security/events?threat_level=bogus",
                    headers=admin_headers)
    assert r.status_code == 400


def test_events_unknown_id_404(client, admin_headers):
    r = client.get("/api/security/events/does-not-exist",
                    headers=admin_headers)
    assert r.status_code == 404


# ── /security/ip/{ip} ───────────────────────────────────────────────────
def test_ip_lookup_private(client, admin_headers):
    """Private IP returns {private: True} with no network call."""
    r = client.get("/api/security/ip/10.0.0.5", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ip"] == "10.0.0.5"
    assert body.get("private") is True


def test_ip_lookup_invalid_400(client, admin_headers):
    r = client.get("/api/security/ip/not-an-ip", headers=admin_headers)
    assert r.status_code == 400


# ── /security/ban-ip + unban round-trip ─────────────────────────────────
@pytest.mark.asyncio
async def test_ban_then_unban(client, db, admin_headers):
    ip = "203.0.113.42"
    r = client.post("/api/security/ban-ip", headers=admin_headers, json={
        "ip": ip, "reason": "test ban",
    })
    assert r.status_code == 200, r.text
    assert r.json()["banned"] is True
    # Should appear in banned-ips list.
    bl = client.get("/api/security/banned-ips", headers=admin_headers).json()
    assert any(b.get("ip") == ip for b in bl["banned_ips"])
    # Unban
    rd = client.delete(f"/api/security/ban-ip/{ip}", headers=admin_headers)
    assert rd.status_code == 200
    bl2 = client.get("/api/security/banned-ips", headers=admin_headers).json()
    assert not any(b.get("ip") == ip for b in bl2["banned_ips"])


def test_ban_invalid_ip_400(client, admin_headers):
    r = client.post("/api/security/ban-ip", headers=admin_headers, json={
        "ip": "garbage", "reason": "test",
    })
    assert r.status_code == 400


# ── /security/run-analysis (no API key → safe defaults) ─────────────────
@pytest.mark.asyncio
async def test_run_analysis_without_api_key_returns_safe_default(
    client, db, admin_headers,
):
    """ANTHROPIC_API_KEY is unset in test env. The analyzer should
    return safe defaults and STILL persist a security_events row."""
    r = client.post("/api/security/run-analysis", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["threat_level"] in ("unknown", "low")
    assert body["findings_count"] == 0
    # Persisted to the audit collection.
    events = await db.security_events.find({}, {"_id": 0}).to_list(length=5)
    assert events, "expected at least one security_events row after run"
    assert "ai_narrative" in events[0]


# ── /security/impossible-travel ─────────────────────────────────────────
def test_impossible_travel_empty(client, admin_headers):
    r = client.get("/api/security/impossible-travel", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["live"] == []
    assert body["historical_7d"] == []


# ── ops_router exposes ai_security ──────────────────────────────────────
@pytest.mark.asyncio
async def test_ops_health_includes_ai_security(client, admin_headers):
    r = client.get("/api/ops/health", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    assert "ai_security" in body
    ai = body["ai_security"]
    if "error" not in ai:
        assert "auto_ban_enabled" in ai
        assert "events_24hr" in ai
        assert "bans_active" in ai
