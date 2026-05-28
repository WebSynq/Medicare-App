"""Phase 6 — Owner Settings (agency self-service) tests.

Covers
------
- GET /agency/settings: any role on the agency can read (so an agent
  can see "you're on Growth"); response shape is the owner-public
  one (no stripe ids, no super_admin flag, no encrypted GHL token).
- PATCH /agency/settings: only owner/admin can write; name edit
  succeeds; empty / unchanged name 400s; refuses to write tier or
  billing_status (Pydantic drops those keys silently).
- GET /agency/usage: agency-scoped; live aggregate when no rollup;
  limits surfaced for SPA progress bars.
- Cross-agency isolation: owner of A cannot see B's settings or
  usage (no path-based agency_id selection means a forged URL has
  nothing to forge).
- Audit row written on name change.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from agency_models import build_agency_defaults
from seed import GHW_AGENCY_ID


# ── Helpers ────────────────────────────────────────────────────────────
async def _seed_agency(db, *, agency_id, slug, tier="growth",
                        billing_status="active"):
    base = build_agency_defaults(
        name=slug.title(), slug=slug,
        owner_email=f"{slug}-owner@example.com", tier=tier,
    )
    doc = base.model_dump()
    doc["agency_id"] = agency_id
    doc["billing_status"] = billing_status
    await db.agencies.insert_one(doc)
    return doc


async def _login_user_on_agency(client, db, *, agency_id, email,
                                  role="owner"):
    from security import hash_password
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": email, "full_name": f"Test {role}",
        "role": role, "is_active": True, "status": "active",
        "agency_id": agency_id,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    login = client.post("/api/auth/login", json={
        "email": email, "password": "Q9pl#aux!7zT",
    })
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


# ══════════════════════════════════════════════════════════════════════
# GET /agency/settings
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_get_settings_returns_public_shape_for_ghw_admin(
    client, admin_headers,
):
    r = client.get("/api/agency/settings", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agency_id"] == GHW_AGENCY_ID
    assert body["tier"] == "domination"
    # Public shape — no super_admin / stripe ids / encrypted token.
    assert "super_admin" not in body
    assert "stripe_customer_id" not in body
    assert "stripe_subscription_id" not in body
    assert "ghl_token_encrypted" not in body
    # Plan + seat info present.
    assert "seats_active" in body
    assert "seats_max" in body


@pytest.mark.asyncio
async def test_get_settings_agent_can_read_their_own_agency(client, db):
    """A plain agent role on an agency must still be able to read the
    settings shape — the Settings page renders for them too even if
    they can't write."""
    await _seed_agency(db, agency_id="ag-agent-read", slug="agread")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-agent-read",
        email="agread-agent@example.com", role="agent",
    )
    r = client.get("/api/agency/settings", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["agency_id"] == "ag-agent-read"


@pytest.mark.asyncio
async def test_get_settings_returns_seats_active_live(client, db):
    """seats_active is computed live from db.users, not from a stale
    cached counter on the agency doc."""
    await _seed_agency(db, agency_id="ag-seats", slug="seatlive")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-seats",
        email="seats-owner@example.com",
    )
    # Add two more active users.
    for i in range(2):
        await db.users.insert_one({
            "id": f"u-seats-{i}", "agent_id": f"u-seats-{i}",
            "email": f"seats-user-{i}@example.com",
            "role": "agent", "is_active": True, "status": "active",
            "agency_id": "ag-seats",
            "hashed_password": "x",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    r = client.get("/api/agency/settings", headers=headers)
    assert r.status_code == 200
    # Owner + 2 agents = 3.
    assert r.json()["seats_active"] == 3


# ══════════════════════════════════════════════════════════════════════
# PATCH /agency/settings
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_patch_settings_owner_can_change_name(client, db):
    await _seed_agency(db, agency_id="ag-rename", slug="renameco")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-rename",
        email="rename-owner@example.com",
    )
    r = client.patch("/api/agency/settings", headers=headers,
                      json={"name": "Brand New Name LLC"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Brand New Name LLC"
    refreshed = await db.agencies.find_one({"agency_id": "ag-rename"})
    assert refreshed["name"] == "Brand New Name LLC"


@pytest.mark.asyncio
async def test_patch_settings_agent_role_403(client, db):
    """A regular agent on the agency cannot rename it."""
    await _seed_agency(db, agency_id="ag-no-write", slug="nowrite")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-no-write",
        email="agent-nw@example.com", role="agent",
    )
    r = client.patch("/api/agency/settings", headers=headers,
                      json={"name": "Renamed By Agent"})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_patch_settings_rejects_empty_name(client, db):
    await _seed_agency(db, agency_id="ag-empty-name", slug="emptyname")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-empty-name",
        email="emptyname-owner@example.com",
    )
    r = client.patch("/api/agency/settings", headers=headers,
                      json={"name": "   "})
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_patch_settings_400_when_no_fields(client, db):
    await _seed_agency(db, agency_id="ag-nofield", slug="nofield")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-nofield",
        email="nofield-owner@example.com",
    )
    r = client.patch("/api/agency/settings", headers=headers, json={})
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_patch_settings_silently_ignores_tier(client, db):
    """Pydantic v2 ignores unknown keys by default — confirm the tier
    field doesn't leak in even if the SPA sends it."""
    await _seed_agency(db, agency_id="ag-tier-attack", slug="tierattack",
                        tier="foundation")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-tier-attack",
        email="tierattack-owner@example.com",
    )
    # 400 because the only allowed field (name) wasn't supplied —
    # tier was dropped on the floor by AgencySettingsPatch.
    r = client.patch(
        "/api/agency/settings", headers=headers,
        json={"tier": "domination", "billing_status": "active",
              "features": {"cna": True}},
    )
    assert r.status_code == 400, r.text
    refreshed = await db.agencies.find_one({"agency_id": "ag-tier-attack"})
    assert refreshed["tier"] == "foundation"
    assert refreshed["features"]["cna"] is False


@pytest.mark.asyncio
async def test_patch_settings_writes_audit_row(client, db):
    await _seed_agency(db, agency_id="ag-aud-rename", slug="audrename")
    headers = await _login_user_on_agency(
        client, db, agency_id="ag-aud-rename",
        email="audrename-owner@example.com",
    )
    client.patch("/api/agency/settings", headers=headers,
                  json={"name": "Audited Name"})
    row = await db.audit_logs.find_one(
        {"event_type": "agency_settings_patch",
         "target_id": "ag-aud-rename"},
    )
    assert row is not None
    assert row["metadata"]["new_name"] == "Audited Name"


# ══════════════════════════════════════════════════════════════════════
# GET /agency/usage
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_get_usage_live_aggregate(client, db, admin_headers):
    """When the rollup hasn't run yet for the current period we get a
    live aggregate. Tracks one CNA call + two emails and confirms
    they show up."""
    from metering import track_ai_usage, track_email_sent
    track_ai_usage(
        agency_id=GHW_AGENCY_ID, agent_id="x",
        event_type="cna_analysis", tokens_in=100, tokens_out=50,
    )
    track_email_sent(agency_id=GHW_AGENCY_ID, count=2)
    import asyncio as _a
    await _a.sleep(0.1)

    r = client.get("/api/agency/usage", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agency_id"] == GHW_AGENCY_ID
    assert body["usage"]["live"] is True
    assert body["usage"]["ai_calls_total"] >= 1
    assert body["usage"]["emails_sent"] >= 2
    # Limits dict present so the SPA can render progress bars.
    assert "ai_calls_included" in body["limits"]
    assert "emails_included" in body["limits"]


@pytest.mark.asyncio
async def test_get_usage_includes_seats(client, db, admin_headers):
    r = client.get("/api/agency/usage", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    assert "seats" in body
    # Admin user counts as one active seat at minimum.
    assert body["seats"]["active"] >= 1


# ══════════════════════════════════════════════════════════════════════
# Cross-agency isolation
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_each_owner_sees_only_their_own_agency(client, db):
    """No path-based agency_id selection means an A-owner sees A; a
    B-owner sees B. Settings + usage both."""
    await _seed_agency(db, agency_id="ag-x-iso-1", slug="isoone")
    await _seed_agency(db, agency_id="ag-x-iso-2", slug="isotwo",
                        tier="foundation")
    a_headers = await _login_user_on_agency(
        client, db, agency_id="ag-x-iso-1",
        email="iso1-owner@example.com",
    )
    b_headers = await _login_user_on_agency(
        client, db, agency_id="ag-x-iso-2",
        email="iso2-owner@example.com",
    )
    ra = client.get("/api/agency/settings", headers=a_headers)
    rb = client.get("/api/agency/settings", headers=b_headers)
    assert ra.json()["agency_id"] == "ag-x-iso-1"
    assert rb.json()["agency_id"] == "ag-x-iso-2"
    assert ra.json()["tier"] == "growth"
    assert rb.json()["tier"] == "foundation"

    ua = client.get("/api/agency/usage", headers=a_headers)
    ub = client.get("/api/agency/usage", headers=b_headers)
    assert ua.json()["agency_id"] == "ag-x-iso-1"
    assert ub.json()["agency_id"] == "ag-x-iso-2"


# ══════════════════════════════════════════════════════════════════════
# Seats: list + deactivate
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_list_users_on_agency_returns_team(client, db):
    await _seed_agency(db, agency_id="ag-seat-list", slug="seatlist")
    owner_headers = await _login_user_on_agency(
        client, db, agency_id="ag-seat-list",
        email="sl-owner@example.com", role="owner",
    )
    await _login_user_on_agency(
        client, db, agency_id="ag-seat-list",
        email="sl-agent@example.com", role="agent",
    )
    r = client.get("/api/agency/users", headers=owner_headers)
    assert r.status_code == 200, r.text
    emails = {u["email"] for u in r.json()["users"]}
    assert {"sl-owner@example.com", "sl-agent@example.com"} <= emails


@pytest.mark.asyncio
async def test_list_users_excludes_other_agencies(client, db):
    await _seed_agency(db, agency_id="ag-seat-iso-a", slug="seatisoa")
    await _seed_agency(db, agency_id="ag-seat-iso-b", slug="seatisob")
    a_headers = await _login_user_on_agency(
        client, db, agency_id="ag-seat-iso-a",
        email="isoa-owner@example.com", role="owner",
    )
    await _login_user_on_agency(
        client, db, agency_id="ag-seat-iso-b",
        email="isob-owner@example.com", role="owner",
    )
    r = client.get("/api/agency/users", headers=a_headers)
    emails = {u["email"] for u in r.json()["users"]}
    assert "isoa-owner@example.com" in emails
    assert "isob-owner@example.com" not in emails


@pytest.mark.asyncio
async def test_patch_user_deactivate_works(client, db):
    await _seed_agency(db, agency_id="ag-deact", slug="deact")
    owner_headers = await _login_user_on_agency(
        client, db, agency_id="ag-deact",
        email="deact-owner@example.com", role="owner",
    )
    await _login_user_on_agency(
        client, db, agency_id="ag-deact",
        email="deact-target@example.com", role="agent",
    )
    target = await db.users.find_one({"email": "deact-target@example.com"})
    before_tv = int(target.get("token_version") or 0)
    r = client.patch(
        f"/api/agency/users/{target['id']}",
        headers=owner_headers,
        json={"is_active": False},
    )
    assert r.status_code == 200, r.text
    refreshed = await db.users.find_one({"id": target["id"]})
    assert refreshed["is_active"] is False
    # token_version bumped so in-flight JWTs invalidate.
    assert int(refreshed["token_version"]) == before_tv + 1


@pytest.mark.asyncio
async def test_patch_user_self_modification_blocked(client, db):
    await _seed_agency(db, agency_id="ag-self-deact", slug="selfdeact")
    owner_headers = await _login_user_on_agency(
        client, db, agency_id="ag-self-deact",
        email="self-owner@example.com", role="owner",
    )
    me = await db.users.find_one({"email": "self-owner@example.com"})
    r = client.patch(
        f"/api/agency/users/{me['id']}", headers=owner_headers,
        json={"is_active": False},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_patch_user_cross_agency_404(client, db):
    """Owner on A cannot deactivate a user on B — surfaces as 404
    rather than 403 so we don't leak user existence."""
    await _seed_agency(db, agency_id="ag-xa-a", slug="xaa")
    await _seed_agency(db, agency_id="ag-xa-b", slug="xab")
    a_headers = await _login_user_on_agency(
        client, db, agency_id="ag-xa-a",
        email="xa-owner@example.com", role="owner",
    )
    await _login_user_on_agency(
        client, db, agency_id="ag-xa-b",
        email="xa-target@example.com", role="agent",
    )
    target = await db.users.find_one({"email": "xa-target@example.com"})
    r = client.patch(
        f"/api/agency/users/{target['id']}", headers=a_headers,
        json={"is_active": False},
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_patch_user_agent_role_403(client, db):
    """Plain agent on agency cannot deactivate others — owner/admin only."""
    await _seed_agency(db, agency_id="ag-no-deact", slug="nodeact")
    agent_headers = await _login_user_on_agency(
        client, db, agency_id="ag-no-deact",
        email="nd-agent@example.com", role="agent",
    )
    await _login_user_on_agency(
        client, db, agency_id="ag-no-deact",
        email="nd-target@example.com", role="agent",
    )
    target = await db.users.find_one({"email": "nd-target@example.com"})
    r = client.patch(
        f"/api/agency/users/{target['id']}", headers=agent_headers,
        json={"is_active": False},
    )
    assert r.status_code == 403, r.text


# ══════════════════════════════════════════════════════════════════════
# No path-collision with the existing /agency/stats + /agency/activity
# (agency_router.py) — Phase 6 only adds /settings + /usage, but a
# regression here would silently shadow one router with the other.
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_existing_agency_dashboard_still_reachable(client,
                                                          admin_headers):
    """Sanity: /api/agency/stats is unchanged by adding the new router."""
    r = client.get("/api/agency/stats", headers=admin_headers)
    # Old router 401/403/200 depending on role gating — important is
    # that it's NOT a 404 (which would mean we shadowed it).
    assert r.status_code != 404, (
        f"existing /agency/stats lost — phase 6 router shadowed it "
        f"({r.status_code})"
    )
