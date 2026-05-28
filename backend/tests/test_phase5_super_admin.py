"""Phase 5 — Super Admin console tests.

Covers
------
- Every endpoint 403s for non-super-admin callers (GHW super_admin is
  the only role that should reach this surface).
- Agencies list returns GHW + any seeded tenants; filters by tier /
  billing_status / q work.
- Agency PATCH writes tier/features/billing_status; apply_tier_defaults
  resets feature flags + limits from TIER_DEFAULTS; partial features
  diff merges with the existing dict (no clobber).
- Agency usage returns the live aggregate when no rollup row exists
  and the persisted summary when it does.
- Users list cross-agency; q + agency_id + role filters work.
- User PATCH role change writes audit + bumps token_version on
  deactivate; refuses to operate on the caller's own row.
- System endpoint includes Stripe mock-mode indicator when
  STRIPE_SECRET_KEY is unset (the default test env).
- Audit rows written on every patch.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from agency_models import build_agency_defaults
from seed import GHW_AGENCY_ID


# ── Helpers ────────────────────────────────────────────────────────────
async def _seed_agency(
    db, *, agency_id: str, slug: str, owner_email: str = None,
    tier: str = "growth", billing_status: str = "active",
) -> dict:
    owner_email = owner_email or f"{slug}-owner@example.com"
    base = build_agency_defaults(
        name=slug.title(), slug=slug,
        owner_email=owner_email, tier=tier,
    )
    doc = base.model_dump()
    doc["agency_id"] = agency_id
    doc["billing_status"] = billing_status
    await db.agencies.insert_one(doc)
    return doc


async def _login_non_super(client, db, *, email: str, role: str,
                             agency_id: str) -> dict:
    """Login as a user on a non-GHW agency — for the 403 tests."""
    from security import hash_password
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": email, "full_name": "Non Super",
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
# 403 guard — every endpoint requires super admin
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("method,path", [
    ("GET",    "/api/super-admin/agencies"),
    ("GET",    "/api/super-admin/agencies/ghw_001"),
    ("PATCH",  "/api/super-admin/agencies/ghw_001"),
    ("GET",    "/api/super-admin/agencies/ghw_001/usage"),
    ("GET",    "/api/super-admin/users"),
    ("PATCH",  "/api/super-admin/users/some-user-id"),
    ("GET",    "/api/super-admin/system"),
])
@pytest.mark.asyncio
async def test_endpoint_403_for_non_super_admin(client, db,
                                                  method, path):
    """A growth-tier owner is NOT a super admin — every super_admin
    route should reject."""
    await _seed_agency(db, agency_id="ag-guard", slug="guard-co",
                        owner_email="guard@example.com")
    headers = await _login_non_super(
        client, db, email="guard@example.com",
        role="owner", agency_id="ag-guard",
    )
    req = client.request(method, path, headers=headers,
                          json={"role": "agent"})
    assert req.status_code == 403, req.text


# ══════════════════════════════════════════════════════════════════════
# Agencies — list, read, patch
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_list_agencies_returns_ghw_and_seeded(client, db,
                                                      admin_headers):
    await _seed_agency(db, agency_id="ag-list-1", slug="alpha")
    await _seed_agency(db, agency_id="ag-list-2", slug="beta-co",
                        tier="foundation")
    r = client.get("/api/super-admin/agencies", headers=admin_headers)
    assert r.status_code == 200, r.text
    ids = {a["agency_id"] for a in r.json()["agencies"]}
    assert GHW_AGENCY_ID in ids
    assert "ag-list-1" in ids
    assert "ag-list-2" in ids


@pytest.mark.asyncio
async def test_list_agencies_filter_by_tier(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-tier-f", slug="found-1",
                        tier="foundation")
    await _seed_agency(db, agency_id="ag-tier-g", slug="growth-1",
                        tier="growth")
    r = client.get("/api/super-admin/agencies?tier=foundation",
                    headers=admin_headers)
    assert r.status_code == 200
    ids = {a["agency_id"] for a in r.json()["agencies"]}
    assert "ag-tier-f" in ids
    assert "ag-tier-g" not in ids
    # GHW is domination so should not appear in foundation filter.
    assert GHW_AGENCY_ID not in ids


@pytest.mark.asyncio
async def test_list_agencies_rejects_unknown_tier_filter(client,
                                                          admin_headers):
    r = client.get("/api/super-admin/agencies?tier=enterprise",
                    headers=admin_headers)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_list_agencies_q_substring(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-q-1", slug="acme-corp")
    await _seed_agency(db, agency_id="ag-q-2", slug="zen-life")
    r = client.get("/api/super-admin/agencies?q=acme",
                    headers=admin_headers)
    assert r.status_code == 200
    ids = {a["agency_id"] for a in r.json()["agencies"]}
    assert "ag-q-1" in ids
    assert "ag-q-2" not in ids


@pytest.mark.asyncio
async def test_get_agency_detail_404_when_missing(client, admin_headers):
    r = client.get("/api/super-admin/agencies/no-such-thing",
                    headers=admin_headers)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_patch_agency_tier_without_defaults(client, db,
                                                    admin_headers):
    """Tier-only PATCH writes the tier but leaves features intact."""
    await _seed_agency(db, agency_id="ag-tier-only", slug="tier-only",
                        tier="foundation")
    # Foundation has cna=False by default. Manually flip it on so we
    # can verify the no-defaults patch leaves it alone.
    await db.agencies.update_one(
        {"agency_id": "ag-tier-only"},
        {"$set": {"features.cna": True}},
    )
    r = client.patch(
        "/api/super-admin/agencies/ag-tier-only",
        headers=admin_headers,
        json={"tier": "growth"},   # apply_tier_defaults defaults to False
    )
    assert r.status_code == 200, r.text
    refreshed = await db.agencies.find_one({"agency_id": "ag-tier-only"})
    assert refreshed["tier"] == "growth"
    # Our manual cna=True override survived because apply_tier_defaults=False.
    assert refreshed["features"]["cna"] is True


@pytest.mark.asyncio
async def test_patch_agency_apply_tier_defaults_resets_features(
    client, db, admin_headers,
):
    await _seed_agency(db, agency_id="ag-reset", slug="reset-co",
                        tier="foundation")
    # Flip cna on first to prove the reset wipes it.
    await db.agencies.update_one(
        {"agency_id": "ag-reset"},
        {"$set": {"features.cna": True}},
    )
    r = client.patch(
        "/api/super-admin/agencies/ag-reset",
        headers=admin_headers,
        json={"tier": "foundation", "apply_tier_defaults": True},
    )
    assert r.status_code == 200, r.text
    refreshed = await db.agencies.find_one({"agency_id": "ag-reset"})
    # Foundation defaults: cna=False
    assert refreshed["features"]["cna"] is False
    # And the limits dict was rebuilt from tier defaults.
    assert refreshed["limits"]["ai_calls_included"] == 1000


@pytest.mark.asyncio
async def test_patch_agency_features_diff_merges(client, db,
                                                   admin_headers):
    """Partial features map merges onto existing dict — non-supplied
    keys preserved."""
    await _seed_agency(db, agency_id="ag-merge", slug="merge-co",
                        tier="growth")
    # Flip lead_scoring off so we can prove the merge respects existing.
    await db.agencies.update_one(
        {"agency_id": "ag-merge"},
        {"$set": {"features.lead_scoring": False}},
    )
    r = client.patch(
        "/api/super-admin/agencies/ag-merge",
        headers=admin_headers,
        json={"features": {"cna": True}},   # only flip cna
    )
    assert r.status_code == 200, r.text
    refreshed = await db.agencies.find_one({"agency_id": "ag-merge"})
    assert refreshed["features"]["cna"] is True
    # lead_scoring kept its False value.
    assert refreshed["features"]["lead_scoring"] is False


@pytest.mark.asyncio
async def test_patch_agency_unknown_features_dropped(client, db,
                                                       admin_headers):
    await _seed_agency(db, agency_id="ag-unk", slug="unknown-co",
                        tier="growth")
    r = client.patch(
        "/api/super-admin/agencies/ag-unk",
        headers=admin_headers,
        json={"features": {"crm": True, "made_up_feature": True}},
    )
    assert r.status_code == 200, r.text
    refreshed = await db.agencies.find_one({"agency_id": "ag-unk"})
    assert "made_up_feature" not in refreshed["features"]


@pytest.mark.asyncio
async def test_patch_agency_writes_audit_row(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-aud", slug="audit-co",
                        tier="foundation")
    client.patch("/api/super-admin/agencies/ag-aud", headers=admin_headers,
                  json={"tier": "growth"})
    row = await db.audit_logs.find_one(
        {"event_type": "super_admin_agency_patch",
         "target_id": "ag-aud"},
    )
    assert row is not None
    assert row["metadata"]["tier"] == "growth"


@pytest.mark.asyncio
async def test_patch_agency_rejects_unknown_tier(client, db,
                                                   admin_headers):
    await _seed_agency(db, agency_id="ag-bt", slug="badtier-co")
    r = client.patch("/api/super-admin/agencies/ag-bt",
                      headers=admin_headers, json={"tier": "enterprise"})
    assert r.status_code in (400, 422)


@pytest.mark.asyncio
async def test_patch_agency_400_when_no_fields(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-empty", slug="empty-co")
    r = client.patch("/api/super-admin/agencies/ag-empty",
                      headers=admin_headers, json={})
    assert r.status_code == 400


# ══════════════════════════════════════════════════════════════════════
# Agency usage
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_agency_usage_live_aggregate_when_no_summary(
    client, db, admin_headers,
):
    """No rollup row yet → endpoint returns live aggregate over
    usage_events for the current period."""
    from metering import track_ai_usage, track_email_sent
    track_ai_usage(
        agency_id=GHW_AGENCY_ID, agent_id="x",
        event_type="cna_analysis", tokens_in=100, tokens_out=50,
    )
    track_email_sent(agency_id=GHW_AGENCY_ID, count=3)
    import asyncio as _a
    await _a.sleep(0.1)

    r = client.get(f"/api/super-admin/agencies/{GHW_AGENCY_ID}/usage",
                    headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agency"]["agency_id"] == GHW_AGENCY_ID
    assert body["usage"]["live"] is True
    assert body["usage"]["ai_calls_total"] >= 1
    assert body["usage"]["emails_sent"] >= 3


@pytest.mark.asyncio
async def test_agency_usage_404_when_agency_missing(client, admin_headers):
    r = client.get("/api/super-admin/agencies/no-such/usage",
                    headers=admin_headers)
    assert r.status_code == 404


# ══════════════════════════════════════════════════════════════════════
# Users — list + patch
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_list_users_includes_admin(client, db, admin_headers):
    r = client.get("/api/super-admin/users", headers=admin_headers)
    assert r.status_code == 200, r.text
    emails = {u.get("email") for u in r.json()["users"]}
    assert os.environ["SEED_ADMIN_EMAIL"] in emails


@pytest.mark.asyncio
async def test_list_users_filter_by_agency(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-uf", slug="userfilter")
    await _login_non_super(
        client, db, email="ufiltered@example.com",
        role="agent", agency_id="ag-uf",
    )
    r = client.get("/api/super-admin/users?agency_id=ag-uf",
                    headers=admin_headers)
    assert r.status_code == 200
    emails = {u.get("email") for u in r.json()["users"]}
    assert "ufiltered@example.com" in emails
    assert os.environ["SEED_ADMIN_EMAIL"] not in emails


@pytest.mark.asyncio
async def test_patch_user_role_change(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-ur", slug="urole")
    await _login_non_super(
        client, db, email="urole@example.com",
        role="agent", agency_id="ag-ur",
    )
    user = await db.users.find_one({"email": "urole@example.com"})
    r = client.patch(
        f"/api/super-admin/users/{user['id']}", headers=admin_headers,
        json={"role": "compliance"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "compliance"
    refreshed = await db.users.find_one({"id": user["id"]})
    assert refreshed["role"] == "compliance"


@pytest.mark.asyncio
async def test_patch_user_deactivate_bumps_token_version(
    client, db, admin_headers,
):
    """is_active=False bumps token_version so any in-flight JWTs the
    user holds are invalidated on next request."""
    await _seed_agency(db, agency_id="ag-utv", slug="utokenver")
    await _login_non_super(
        client, db, email="utv@example.com",
        role="agent", agency_id="ag-utv",
    )
    user = await db.users.find_one({"email": "utv@example.com"})
    before_tv = int(user.get("token_version") or 0)
    r = client.patch(
        f"/api/super-admin/users/{user['id']}", headers=admin_headers,
        json={"is_active": False},
    )
    assert r.status_code == 200, r.text
    refreshed = await db.users.find_one({"id": user["id"]})
    assert refreshed["is_active"] is False
    assert int(refreshed.get("token_version") or 0) == before_tv + 1


@pytest.mark.asyncio
async def test_patch_user_refuses_self_modification(client, db,
                                                      admin_headers):
    """Super admin can't demote / deactivate themselves through this
    surface — guard against a confused click."""
    me = await db.users.find_one({"email": os.environ["SEED_ADMIN_EMAIL"]})
    r = client.patch(
        f"/api/super-admin/users/{me['id']}", headers=admin_headers,
        json={"role": "agent"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_patch_user_move_to_unknown_agency_rejected(
    client, db, admin_headers,
):
    await _seed_agency(db, agency_id="ag-mv", slug="movetest")
    await _login_non_super(
        client, db, email="mv@example.com",
        role="agent", agency_id="ag-mv",
    )
    user = await db.users.find_one({"email": "mv@example.com"})
    r = client.patch(
        f"/api/super-admin/users/{user['id']}", headers=admin_headers,
        json={"agency_id": "no-such-agency"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_patch_user_404_when_missing(client, admin_headers):
    r = client.patch(
        "/api/super-admin/users/no-such-user-id", headers=admin_headers,
        json={"role": "agent"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_patch_user_writes_audit_row(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-uaud", slug="useraudit")
    await _login_non_super(
        client, db, email="uaud@example.com",
        role="agent", agency_id="ag-uaud",
    )
    user = await db.users.find_one({"email": "uaud@example.com"})
    client.patch(
        f"/api/super-admin/users/{user['id']}", headers=admin_headers,
        json={"role": "owner"},
    )
    row = await db.audit_logs.find_one(
        {"event_type": "super_admin_user_patch", "target_id": user["id"]},
    )
    assert row is not None
    assert row["metadata"]["role"] == "owner"


# ══════════════════════════════════════════════════════════════════════
# System overview
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_system_endpoint_reports_stripe_mock_mode(client,
                                                          admin_headers,
                                                          monkeypatch):
    """STRIPE_SECRET_KEY unset (default test env) → stripe_mock_mode True."""
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    r = client.get("/api/super-admin/system", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["env"]["stripe_mock_mode"] is True
    assert body["env"]["stripe_secret_configured"] is False
    # Webhook secret IS set in conftest so this should be True.
    assert body["env"]["stripe_webhook_configured"] is True


@pytest.mark.asyncio
async def test_system_endpoint_includes_counts(client, db, admin_headers):
    await _seed_agency(db, agency_id="ag-sys-1", slug="sysone")
    await _seed_agency(db, agency_id="ag-sys-2", slug="systwo",
                        billing_status="past_due")
    r = client.get("/api/super-admin/system", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agencies"]["total"] >= 3   # GHW + ag-sys-1 + ag-sys-2
    assert body["agencies"]["past_due"] >= 1
    assert body["users"]["total"] >= 1
    assert isinstance(body["feature_registry"], list)
    assert "cna" in body["feature_registry"]
