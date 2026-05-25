"""Ops console tests.

Exercises:
  - Admin/owner-only gate (agent gets 403)
  - Full response shape (all six top-level sections + activity_7d + threat_log)
  - Section degradation is structural (errors land as `{"error":"unavailable"}`
    not 500)
  - Counts move correctly when underlying data changes
"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest


def _make_agent(client, db_admin_headers, email, password="Q9pl#aux!7zT"):
    inv = client.post("/api/auth/invite", headers=db_admin_headers, json={
        "email": email, "full_name": email.split("@")[0],
        "agency_name": "GHW", "agent_name": email.split("@")[0],
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": email, "password": password,
        "full_name": email.split("@")[0], "agency_name": "GHW",
        "invite_token": inv["token"],
    })
    uid = reg.json()["id"]
    client.post(f"/api/auth/users/{uid}/approve", headers=db_admin_headers)
    login = client.post("/api/auth/login", json={
        "email": email, "password": password,
    })
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def test_ops_health_admin_returns_full_shape(client, admin_headers):
    r = client.get("/api/ops/health", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in (
        "generated_at", "system", "security", "data_integrity",
        "usage", "automations", "compliance", "activity_7d", "threat_log",
    ):
        assert key in body, f"missing top-level key: {key}"

    # System always reports db_ping_ms in the happy path.
    sys = body["system"]
    if "error" not in sys:
        assert "api_status" in sys
        assert isinstance(sys.get("db_ping_ms"), int)
        assert "scheduler_running" in sys

    # 7-day activity is always 7 entries (or empty on failure).
    if body["activity_7d"]:
        assert len(body["activity_7d"]) == 7
        for d in body["activity_7d"]:
            for k in ("label", "leads", "enrollments", "bookings"):
                assert k in d

    # Compliance flags always present.
    comp = body["compliance"]
    if "error" not in comp:
        assert comp["baa_render"] in ("signed", "not_signed", "pending")
        assert comp["baa_mongodb"] in ("signed", "not_signed", "pending")


def test_ops_health_agent_forbidden(client, db, admin_headers):
    agent_headers = _make_agent(client, admin_headers,
                                 "ops.agent@example.com")
    r = client.get("/api/ops/health", headers=agent_headers)
    assert r.status_code == 403


def test_ops_health_anonymous_unauthorized(client):
    r = client.get("/api/ops/health")
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_ops_security_section_counts_lockouts(client, db, admin_headers):
    """An accounts_locked_now > 0 should reflect a locked_until in the future."""
    now = datetime.now(timezone.utc)
    await db.login_attempts.insert_one({
        "email": "locked@example.com",
        "attempted_at": now,
        "locked_until": now + timedelta(minutes=15),
    })
    r = client.get("/api/ops/health", headers=admin_headers)
    body = r.json()
    assert body["security"]["accounts_locked_now"] >= 1


@pytest.mark.asyncio
async def test_ops_data_integrity_finds_orphan_leads(
    client, db, admin_headers,
):
    await db.leads.insert_many([
        {"id": "orphan-1", "first_name": "Or", "last_name": "Phan"},
        {"id": "orphan-2", "first_name": "Or", "last_name": "Phan",
         "agent_id": None},
    ])
    r = client.get("/api/ops/health", headers=admin_headers)
    body = r.json()
    assert body["data_integrity"]["leads_missing_agent"] >= 2


@pytest.mark.asyncio
async def test_ops_data_integrity_finds_dirty_state(
    client, db, admin_headers,
):
    await db.leads.insert_one({
        "id": "dirty-state-1",
        "first_name": "Bad", "last_name": "State",
        "state": "Illinois",   # not 2-char after normalization gap
        "agent_id": "abc",
    })
    r = client.get("/api/ops/health", headers=admin_headers)
    body = r.json()
    assert body["data_integrity"]["leads_dirty_state"] >= 1


@pytest.mark.asyncio
async def test_ops_compliance_includes_baa_flags(client, admin_headers):
    r = client.get("/api/ops/health", headers=admin_headers)
    body = r.json()
    comp = body["compliance"]
    # All three vendors must surface — even if "not_signed" today.
    assert comp["baa_render"] == "not_signed"
    assert comp["baa_mongodb"] == "not_signed"
    assert comp["baa_aws_ses"] == "pending"
    assert comp["hipaa_training_due"] == 0
    assert "audit_log_count" in comp
