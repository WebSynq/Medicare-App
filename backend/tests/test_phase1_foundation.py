"""Phase 1 — Multi-Tenant Foundation tests.

Covers:
  - tiers.py constants + helpers
  - agency_models.py Pydantic round-trips + validators
  - seed.seed_ghw_agency idempotency + migration backfill
  - deps.require_super_admin / require_feature / require_billing_active
    / check_seat_available / get_agency behavior
  - JWT now carries agency_id / agency_tier / super_admin / features
  - Existing GHW-scoped writes/reads still work end-to-end

These tests prove Phase 1 is additive — every existing endpoint behaves
the same for the seeded GHW admin, and the new tenant primitives are
ready for Phase 2 (metering) to build on.
"""
from __future__ import annotations

import os

import jwt
import pytest
from fastapi import APIRouter, Depends

from agency_models import (
    Agency,
    AgencyLimits,
    AgencyOverageRates,
    Invitation,
    UsageEvent,
    build_agency_defaults,
    current_billing_period,
)
from deps import (
    check_seat_available,
    require_billing_active,
    require_feature,
    require_super_admin,
)
from seed import GHW_AGENCY_ID, seed_ghw_agency, backfill_agency_id_on_users
from tiers import (
    FEATURE_REGISTRY,
    OVERAGE_RATES,
    TIER_DEFAULTS,
    TIER_KEYS,
    is_valid_feature,
    is_valid_tier,
    sanitise_features,
    tier_features,
    tier_limits,
    tier_overage_rates,
)


# ── Test endpoints — mounted ONCE at module import ────────────────────
# Dynamic include_router() inside test bodies works in isolation but
# breaks under full-suite ordering (TestClient's per-test startup
# freezes route resolution). Define every test route up front so the
# router table is stable from the first test in the file onwards.
import server as _server  # noqa: E402

_PHASE1_ROUTER = APIRouter()


@_PHASE1_ROUTER.get("/_phase1/cna-required")
async def _ep_cna_required(agency=Depends(require_feature("cna"))):
    return {"ok": True}


@_PHASE1_ROUTER.get("/_phase1/cna-gated")
async def _ep_cna_gated(agency=Depends(require_feature("cna"))):
    return {"ok": True}


@_PHASE1_ROUTER.post("/_phase1/billed-write")
async def _ep_billed(agency=Depends(require_billing_active())):
    return {"ok": True}


@_PHASE1_ROUTER.post("/_phase1/invite-fake")
async def _ep_invite(agency=Depends(check_seat_available())):
    return {"ok": True}


@_PHASE1_ROUTER.get("/_phase1/super-only")
async def _ep_super_only(agency=Depends(require_super_admin())):
    return {"ok": True, "agency_id": agency.get("agency_id")}


@_PHASE1_ROUTER.get("/_phase1/super-only-ghw")
async def _ep_super_only_ghw(agency=Depends(require_super_admin())):
    return {"ok": True, "agency_id": agency.get("agency_id")}


# Idempotent mount — if pytest re-imports this module (rare but
# possible with --reload-equivalents), the second include doesn't
# duplicate routes because we tag them with a sentinel.
if not getattr(_server.app, "_phase1_routes_mounted", False):
    _server.app.include_router(_PHASE1_ROUTER, prefix="/api")
    _server.app._phase1_routes_mounted = True


# ── tiers.py — constants + helpers ─────────────────────────────────────
def test_tier_keys_present():
    assert set(TIER_KEYS) == {"beta", "foundation", "growth", "domination"}
    for k in TIER_KEYS:
        assert k in TIER_DEFAULTS
        assert k in OVERAGE_RATES


def test_tier_defaults_have_all_features():
    """Every tier's feature dict must contain every registered key —
    keeps the super-admin "Apply Defaults" button safe to use."""
    for tier in TIER_KEYS:
        feats = tier_features(tier)
        for key in FEATURE_REGISTRY:
            assert key in feats, f"tier={tier} missing feature {key}"


def test_foundation_excludes_growth_features():
    feats = tier_features("foundation")
    assert feats["crm"] is True
    assert feats["booking_system"] is False
    assert feats["cna"] is False


def test_growth_includes_growth_excludes_domination():
    feats = tier_features("growth")
    assert feats["booking_system"] is True
    assert feats["ai_application_intake"] is True
    assert feats["cna"] is False
    assert feats["ai_client_intelligence"] is False


def test_domination_includes_domination_excludes_addons():
    feats = tier_features("domination")
    assert feats["cna"] is True
    assert feats["ai_client_intelligence"] is True
    # ops_console is super-admin-only by default — even Domination
    # agencies get it OFF and have to be granted explicitly.
    assert feats["ops_console"] is False
    assert feats["dialer"] is False
    assert feats["api_access"] is False


def test_domination_seats_unlimited():
    assert tier_limits("domination")["seats"] == -1


def test_domination_overage_waives_seats():
    assert tier_overage_rates("domination")["seat_per_month"] == 0
    assert tier_overage_rates("growth")["seat_per_month"] > 0


def test_sanitise_features_drops_unknown_and_coerces():
    raw = {
        "crm": True,
        "leads": "yes",          # truthy non-bool
        "made_up_feature": True,  # unknown — must be dropped
    }
    out = sanitise_features(raw)
    assert out["crm"] is True
    assert out["leads"] is True
    assert "made_up_feature" not in out
    # Every registered key is present (defaulting to False).
    for k in FEATURE_REGISTRY:
        assert k in out


def test_is_valid_helpers():
    assert is_valid_tier("growth")
    assert not is_valid_tier("enterprise")
    assert is_valid_feature("cna")
    assert not is_valid_feature("nope")


# ── agency_models.py — Pydantic ────────────────────────────────────────
def test_build_agency_defaults_growth():
    a = build_agency_defaults(
        name="Smith Insurance",
        slug="smith",
        owner_email="john@smith.com",
        tier="growth",
    )
    assert a.tier == "growth"
    assert a.billing_status == "trialing"   # non-super-admin → trial
    assert a.monthly_base_amount == 49700
    assert a.seats_included == 15
    assert a.features["booking_system"] is True
    assert a.features["cna"] is False
    assert a.limits.ai_calls_included == 5000
    assert a.overage_rates.seat_per_month == 2500


def test_build_agency_defaults_super_admin_active_billing():
    a = build_agency_defaults(
        name="GHW",
        slug="ghw",
        owner_email="tim@ghw.com",
        tier="domination",
        super_admin=True,
    )
    assert a.super_admin is True
    assert a.billing_status == "active"


def test_agency_slug_validation():
    with pytest.raises(ValueError):
        Agency(
            name="X", slug="invalid space",
            owner_email="x@x.com",
            limits=AgencyLimits(seats=1, ai_calls_included=0,
                                 emails_included=0,
                                 storage_gb_included=0,
                                 app_intakes_included=0),
            overage_rates=AgencyOverageRates(
                ai_tokens_per_1k=0, email_per_1k=0,
                storage_per_gb=0, app_intake_each=0,
                seat_per_month=0,
            ),
        )


def test_agency_features_sanitised_on_construct():
    a = build_agency_defaults(
        name="X", slug="x-test", owner_email="x@x.com",
        tier="growth",
    )
    # Foundation feature retained.
    assert "crm" in a.features
    # No unknown keys.
    for k in a.features.keys():
        assert k in FEATURE_REGISTRY


def test_usage_event_round_trip():
    e = UsageEvent(
        agency_id="ghw_001",
        billing_period=current_billing_period(),
        event_type="cna_analysis",
        quantity=1247,
        unit="tokens",
        cost_usd=0.01,
        charge_usd=0.02,
        model="claude-sonnet-4-6",
    )
    d = e.model_dump()
    assert d["event_id"]
    assert d["agency_id"] == "ghw_001"
    assert d["billing_period"] == current_billing_period()


def test_usage_event_rejects_bad_period():
    with pytest.raises(ValueError):
        UsageEvent(
            agency_id="ghw_001",
            billing_period="2026-5",  # not zero-padded
            event_type="cna_analysis",
            quantity=1,
            unit="count",
        )


def test_invitation_construct():
    inv = Invitation(
        agency_id="x",
        invited_email="new@example.com",
        invited_role="agent",
        token_hash="deadbeef" * 8,
        expires_at="2026-12-31T00:00:00+00:00",
    )
    assert inv.status == "pending"
    assert inv.invitation_id


# ── seed.py — GHW migration ────────────────────────────────────────────
@pytest.mark.asyncio
async def test_seed_ghw_agency_creates_row(db):
    """conftest already seeds GHW; verify the row matches expectations."""
    row = await db.agencies.find_one({"agency_id": GHW_AGENCY_ID})
    assert row is not None
    assert row["slug"] == "ghw"
    assert row["super_admin"] is True
    assert row["tier"] == "domination"
    assert row["billing_status"] == "active"
    # Every feature ON for GHW.
    for k in FEATURE_REGISTRY:
        assert row["features"].get(k) is True, f"GHW missing {k}"


@pytest.mark.asyncio
async def test_seed_ghw_agency_is_idempotent(db):
    before = await db.agencies.count_documents({})
    await seed_ghw_agency(db)
    after = await db.agencies.count_documents({})
    assert before == after


@pytest.mark.asyncio
async def test_backfill_agency_id_stamps_legacy_users(db):
    # Insert a legacy user with no agency_id.
    await db.users.insert_one({
        "id": "legacy-123",
        "email": "legacy@example.com",
        "role": "agent",
        "is_active": True,
        "status": "active",
    })
    n = await backfill_agency_id_on_users(db)
    assert n >= 1
    refreshed = await db.users.find_one({"id": "legacy-123"})
    assert refreshed["agency_id"] == GHW_AGENCY_ID

    # Idempotent — running again touches zero rows.
    n2 = await backfill_agency_id_on_users(db)
    assert n2 == 0


# ── JWT additions ──────────────────────────────────────────────────────
def _decode(token: str) -> dict:
    return jwt.decode(
        token, os.environ["JWT_SECRET"],
        algorithms=[os.environ.get("JWT_ALGORITHM", "HS256")],
    )


def test_jwt_includes_agency_context(client):
    resp = client.post("/api/auth/login", json={
        "email": os.environ["SEED_ADMIN_EMAIL"],
        "password": os.environ["SEED_ADMIN_PASSWORD"],
    })
    assert resp.status_code == 200, resp.text
    payload = _decode(resp.json()["access_token"])
    assert payload["agency_id"] == GHW_AGENCY_ID
    assert payload["agency_tier"] == "domination"
    assert payload["super_admin"] is True
    # features is a sorted list of enabled keys.
    assert isinstance(payload["features"], list)
    assert "crm" in payload["features"]
    assert "cna" in payload["features"]


# ── deps — get_agency / require_super_admin / require_feature ──────────
@pytest.mark.asyncio
async def test_get_agency_returns_ghw_for_admin(client, db, admin_headers):
    """Probe the dep via a real endpoint that uses get_current_user.
    Since admin is on ghw_001, /auth/me + the agency lookup should work
    end to end. We assert that we CAN still log in and read /me —
    proving the new agency-resolution path didn't break the standard
    auth chain.
    """
    r = client.get("/api/auth/me", headers=admin_headers)
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["email"] == os.environ["SEED_ADMIN_EMAIL"]


@pytest.mark.asyncio
async def test_require_feature_dep_allows_super_admin_when_off(
    client, db, admin_headers,
):
    """Force a feature OFF on the GHW row and confirm super_admin
    bypass still lets the request through."""
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {"features.cna": False}},
    )
    try:
        r1 = client.get("/api/_phase1/cna-required", headers=admin_headers)
        assert r1.status_code == 200, r1.text
    finally:
        await db.agencies.update_one(
            {"agency_id": GHW_AGENCY_ID},
            {"$set": {"features.cna": True}},
        )


@pytest.mark.asyncio
async def test_require_feature_blocks_non_super_admin(
    client, db, admin_headers,
):
    """A non-GHW agency owner whose tier doesn't include a feature
    must hit 403 with the structured upgrade payload."""
    from agency_models import build_agency_defaults
    from security import hash_password
    import uuid
    from datetime import datetime, timezone

    other_agency_id = "agency-other-001"
    other_agency = build_agency_defaults(
        name="Other Co", slug="other-co",
        owner_email="other@example.com",
        tier="foundation",   # cna OFF on foundation
    )
    doc = other_agency.model_dump()
    doc["agency_id"] = other_agency_id
    await db.agencies.insert_one(doc)

    # Create + login an owner user on that agency.
    user_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": user_id, "agent_id": user_id,
        "email": "other-owner@example.com",
        "full_name": "Other Owner",
        "role": "owner",
        "is_active": True, "status": "active",
        "agency_id": other_agency_id,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    login = client.post("/api/auth/login", json={
        "email": "other-owner@example.com",
        "password": "Q9pl#aux!7zT",
    })
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.get("/api/_phase1/cna-gated", headers=headers)
    assert resp.status_code == 403, resp.text
    detail = resp.json()["detail"]
    assert detail["feature"] == "cna"
    assert "upgrade_url" in detail


@pytest.mark.asyncio
async def test_require_billing_active_blocks_suspended(client, db):
    """A suspended agency hits 402 on a write-gated endpoint."""
    from agency_models import build_agency_defaults
    from security import hash_password
    import uuid
    from datetime import datetime, timezone

    aid = "agency-suspended-001"
    base = build_agency_defaults(
        name="Suspended Co", slug="suspended-co",
        owner_email="sus@example.com", tier="growth",
    )
    doc = base.model_dump()
    doc["agency_id"] = aid
    doc["billing_status"] = "suspended"
    await db.agencies.insert_one(doc)
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": "sus-owner@example.com",
        "full_name": "Sus Owner",
        "role": "owner",
        "is_active": True, "status": "active",
        "agency_id": aid,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    login = client.post("/api/auth/login", json={
        "email": "sus-owner@example.com", "password": "Q9pl#aux!7zT",
    })
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.post("/api/_phase1/billed-write", headers=headers)
    assert resp.status_code == 402, resp.text
    assert resp.json()["detail"]["billing_status"] == "suspended"


@pytest.mark.asyncio
async def test_check_seat_available_blocks_at_cap(client, db):
    from agency_models import build_agency_defaults
    from security import hash_password
    import uuid
    from datetime import datetime, timezone

    aid = "agency-full-001"
    base = build_agency_defaults(
        name="Full Co", slug="full-co",
        owner_email="full@example.com", tier="foundation",
    )
    doc = base.model_dump()
    doc["agency_id"] = aid
    doc["seats_max"] = 5
    doc["seats_active"] = 5   # at cap
    await db.agencies.insert_one(doc)
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": "full-owner@example.com",
        "full_name": "Full Owner", "role": "owner",
        "is_active": True, "status": "active",
        "agency_id": aid,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    login = client.post("/api/auth/login", json={
        "email": "full-owner@example.com", "password": "Q9pl#aux!7zT",
    })
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.post("/api/_phase1/invite-fake", headers=headers)
    assert resp.status_code == 402, resp.text
    body = resp.json()["detail"]
    assert body["seats_active"] == 5
    assert body["seats_max"] == 5


@pytest.mark.asyncio
async def test_require_super_admin_blocks_non_ghw(client, db):
    """Owner of another agency must be 403'd from a super-admin route."""
    from agency_models import build_agency_defaults
    from security import hash_password
    import uuid
    from datetime import datetime, timezone

    aid = "agency-non-su-001"
    base = build_agency_defaults(
        name="Non SU", slug="non-su",
        owner_email="nonsu@example.com", tier="growth",
    )
    doc = base.model_dump()
    doc["agency_id"] = aid
    await db.agencies.insert_one(doc)
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": "nonsu-owner@example.com",
        "full_name": "Non SU Owner", "role": "owner",
        "is_active": True, "status": "active",
        "agency_id": aid,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    login = client.post("/api/auth/login", json={
        "email": "nonsu-owner@example.com", "password": "Q9pl#aux!7zT",
    })
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.get("/api/_phase1/super-only", headers=headers)
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_require_super_admin_allows_ghw_admin(client, admin_headers):
    resp = client.get("/api/_phase1/super-only-ghw", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["agency_id"] == GHW_AGENCY_ID


# ── Existing flows still work end-to-end ───────────────────────────────
@pytest.mark.asyncio
async def test_lead_create_still_works_for_ghw_admin(client, admin_headers):
    """Sanity: the most-touched path on the platform (POST /api/leads)
    is unchanged for the seeded GHW super admin after multi-tenant
    additions. If this regresses, every existing test would too."""
    r = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Phase1", "last_name": "Sanity",
        "phone": "555-100-9999",
    })
    assert r.status_code == 201, r.text
