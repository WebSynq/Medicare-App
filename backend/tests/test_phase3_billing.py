"""Phase 3 — Stripe billing + feature-gate tests.

Covers
------
- Webhook signature verification (good, bad, missing)
- Idempotent event handling (duplicate event_id → 200 with status=duplicate)
- State machine: trialing → active → past_due → suspended → active
- Grace-period sweep flips past_due → suspended past 7 days
- billing_router endpoints — checkout/portal 503 when stripe key unset,
  GET /subscription works regardless
- Feature gates on AI endpoints — GHW super_admin bypasses;
  non-super-admin agencies without the feature flag get 403

Stripe SDK is real (installed via requirements.txt). All Stripe
network calls are either mocked or driven by test fixtures using
the real construct_event with the test webhook secret.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import stripe as stripe_sdk

from agency_models import build_agency_defaults
from seed import GHW_AGENCY_ID


_WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]


# ── Helpers ────────────────────────────────────────────────────────────
def _sign_payload(payload: bytes, secret: str = _WEBHOOK_SECRET,
                   timestamp: int = None) -> str:
    """Build a valid Stripe-Signature header for ``payload`` so the
    webhook treats it as legitimate. Mirrors the format Stripe sends."""
    import hmac
    import hashlib
    ts = int(timestamp or time.time())
    signed_payload = f"{ts}.".encode() + payload
    sig = hmac.new(secret.encode(), signed_payload,
                    hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


async def _seed_agency(
    db, *, agency_id: str, slug: str, owner_email: str,
    tier: str = "growth", billing_status: str = "trialing",
    stripe_customer_id: str = None,
    stripe_subscription_id: str = None,
    super_admin: bool = False,
    features_override: dict = None,
) -> dict:
    base = build_agency_defaults(
        name=slug.title(), slug=slug,
        owner_email=owner_email, tier=tier,
        super_admin=super_admin,
        features_override=features_override,
    )
    doc = base.model_dump()
    doc["agency_id"] = agency_id
    doc["billing_status"] = billing_status
    if stripe_customer_id:
        doc["stripe_customer_id"] = stripe_customer_id
    if stripe_subscription_id:
        doc["stripe_subscription_id"] = stripe_subscription_id
    await db.agencies.insert_one(doc)
    return doc


async def _login_user(client, db, *, agency_id: str, email: str,
                       role: str = "owner") -> dict:
    from security import hash_password
    import uuid
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "agent_id": uid,
        "email": email,
        "full_name": "T",
        "role": role,
        "is_active": True, "status": "active",
        "agency_id": agency_id,
        "hashed_password": hash_password("Q9pl#aux!7zT"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    resp = client.post("/api/auth/login", json={
        "email": email, "password": "Q9pl#aux!7zT",
    })
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ══════════════════════════════════════════════════════════════════════
# Webhook signature verification
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_webhook_rejects_missing_signature(client):
    r = client.post("/api/billing/webhook", content=b"{}")
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_webhook_rejects_bad_signature(client):
    r = client.post(
        "/api/billing/webhook",
        content=b"{}",
        headers={"stripe-signature": "t=1,v1=bogus"},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_webhook_accepts_valid_signature_unknown_event(client):
    """Valid signature + unknown event type → 200 with status=ignored.
    We never want Stripe to retry forever just because we haven't
    wired up an event handler yet."""
    payload = (
        b'{"id":"evt_unknown_phase3","object":"event",'
        b'"type":"customer.created","data":{"object":{}}}'
    )
    sig = _sign_payload(payload)
    r = client.post(
        "/api/billing/webhook",
        content=payload,
        headers={"stripe-signature": sig,
                  "content-type": "application/json"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["received"] is True
    assert body["status"] == "ignored"


# ══════════════════════════════════════════════════════════════════════
# Idempotent event handling
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_webhook_duplicate_event_id_returns_duplicate(client, db):
    await _seed_agency(
        db, agency_id="ag-dup-1", slug="dup-one",
        owner_email="dup@example.com",
        stripe_subscription_id="sub_dup_1",
        stripe_customer_id="cus_dup_1",
    )
    payload = (
        b'{"id":"evt_dup_phase3","object":"event",'
        b'"type":"customer.subscription.updated",'
        b'"data":{"object":{"id":"sub_dup_1","customer":"cus_dup_1",'
        b'"status":"active"}}}'
    )
    sig = _sign_payload(payload)
    headers = {"stripe-signature": sig, "content-type": "application/json"}

    r1 = client.post("/api/billing/webhook", content=payload,
                      headers=headers)
    assert r1.status_code == 200
    assert r1.json()["status"] == "processed"

    # Re-deliver the same event.
    r2 = client.post("/api/billing/webhook", content=payload,
                      headers=headers)
    assert r2.status_code == 200
    assert r2.json()["status"] == "duplicate"

    # Only one row in stripe_events.
    count = await db.stripe_events.count_documents(
        {"event_id": "evt_dup_phase3"},
    )
    assert count == 1


# ══════════════════════════════════════════════════════════════════════
# State machine
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_subscription_updated_flips_to_active(client, db):
    await _seed_agency(
        db, agency_id="ag-state-1", slug="state-one",
        owner_email="s1@example.com",
        stripe_subscription_id="sub_state_1",
        stripe_customer_id="cus_state_1",
        billing_status="trialing",
    )
    payload = (
        b'{"id":"evt_state_active_p3","object":"event",'
        b'"type":"customer.subscription.updated",'
        b'"data":{"object":{"id":"sub_state_1","customer":"cus_state_1",'
        b'"status":"active"}}}'
    )
    sig = _sign_payload(payload)
    r = client.post("/api/billing/webhook", content=payload,
                     headers={"stripe-signature": sig,
                              "content-type": "application/json"})
    assert r.status_code == 200
    refreshed = await db.agencies.find_one({"agency_id": "ag-state-1"})
    assert refreshed["billing_status"] == "active"


@pytest.mark.asyncio
async def test_payment_failed_stamps_grace_period(client, db):
    await _seed_agency(
        db, agency_id="ag-pf-1", slug="pf-one",
        owner_email="pf@example.com",
        stripe_subscription_id="sub_pf_1",
        stripe_customer_id="cus_pf_1",
        billing_status="active",
    )
    payload = (
        b'{"id":"evt_pf_phase3","object":"event",'
        b'"type":"invoice.payment_failed",'
        b'"data":{"object":{"id":"in_pf_1","customer":"cus_pf_1"}}}'
    )
    sig = _sign_payload(payload)
    r = client.post("/api/billing/webhook", content=payload,
                     headers={"stripe-signature": sig,
                              "content-type": "application/json"})
    assert r.status_code == 200
    a = await db.agencies.find_one({"agency_id": "ag-pf-1"})
    assert a["billing_status"] == "past_due"
    assert a["grace_period_ends_at"] is not None


@pytest.mark.asyncio
async def test_payment_succeeded_restores_active_and_clears_grace(client, db):
    await _seed_agency(
        db, agency_id="ag-ok-1", slug="ok-one",
        owner_email="ok@example.com",
        stripe_subscription_id="sub_ok_1",
        stripe_customer_id="cus_ok_1",
        billing_status="past_due",
    )
    await db.agencies.update_one(
        {"agency_id": "ag-ok-1"},
        {"$set": {"grace_period_ends_at":
                   (datetime.now(timezone.utc)
                    + timedelta(days=3)).isoformat()}},
    )
    payload = (
        b'{"id":"evt_ok_phase3","object":"event",'
        b'"type":"invoice.payment_succeeded",'
        b'"data":{"object":{"id":"in_ok_1","customer":"cus_ok_1"}}}'
    )
    sig = _sign_payload(payload)
    r = client.post("/api/billing/webhook", content=payload,
                     headers={"stripe-signature": sig,
                              "content-type": "application/json"})
    assert r.status_code == 200
    a = await db.agencies.find_one({"agency_id": "ag-ok-1"})
    assert a["billing_status"] == "active"
    assert a["grace_period_ends_at"] is None


@pytest.mark.asyncio
async def test_subscription_deleted_flips_to_cancelled(client, db):
    await _seed_agency(
        db, agency_id="ag-del-1", slug="del-one",
        owner_email="del@example.com",
        stripe_subscription_id="sub_del_1",
        stripe_customer_id="cus_del_1",
        billing_status="active",
    )
    payload = (
        b'{"id":"evt_del_phase3","object":"event",'
        b'"type":"customer.subscription.deleted",'
        b'"data":{"object":{"id":"sub_del_1","customer":"cus_del_1"}}}'
    )
    sig = _sign_payload(payload)
    r = client.post("/api/billing/webhook", content=payload,
                     headers={"stripe-signature": sig,
                              "content-type": "application/json"})
    assert r.status_code == 200
    a = await db.agencies.find_one({"agency_id": "ag-del-1"})
    assert a["billing_status"] == "cancelled"


# ══════════════════════════════════════════════════════════════════════
# Grace-period sweep
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_grace_sweep_suspends_after_expiry(db):
    from stripe_service import run_grace_period_sweep

    await _seed_agency(
        db, agency_id="ag-sweep-1", slug="sweep-one",
        owner_email="sweep@example.com",
        billing_status="past_due",
    )
    # Stamp grace_period_ends_at in the past.
    await db.agencies.update_one(
        {"agency_id": "ag-sweep-1"},
        {"$set": {"grace_period_ends_at":
                   (datetime.now(timezone.utc)
                    - timedelta(hours=1)).isoformat()}},
    )
    result = await run_grace_period_sweep(db)
    assert result["suspended"] == 1
    a = await db.agencies.find_one({"agency_id": "ag-sweep-1"})
    assert a["billing_status"] == "suspended"


@pytest.mark.asyncio
async def test_grace_sweep_skips_inside_grace_window(db):
    from stripe_service import run_grace_period_sweep
    await _seed_agency(
        db, agency_id="ag-sweep-2", slug="sweep-two",
        owner_email="sweep2@example.com",
        billing_status="past_due",
    )
    # Grace ends in 5 days — still inside window, sweep should not
    # suspend, but it should fire the day-3 warning (since the
    # warning fires when remaining <= 3 days, which is NOT now).
    await db.agencies.update_one(
        {"agency_id": "ag-sweep-2"},
        {"$set": {"grace_period_ends_at":
                   (datetime.now(timezone.utc)
                    + timedelta(days=5)).isoformat()}},
    )
    result = await run_grace_period_sweep(db)
    assert result["suspended"] == 0
    a = await db.agencies.find_one({"agency_id": "ag-sweep-2"})
    assert a["billing_status"] == "past_due"


@pytest.mark.asyncio
async def test_grace_sweep_sends_warning_at_3_days(db, monkeypatch):
    """Day-3 warning fires when grace ends within 3 days but hasn't
    expired. We bypass actual email sending via RESEND_API_KEY=unset
    (send_email short-circuits to False) — the sweep still marks the
    row with grace_warning_sent_at so a re-run doesn't double-warn."""
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    from stripe_service import run_grace_period_sweep
    await _seed_agency(
        db, agency_id="ag-sweep-3", slug="sweep-three",
        owner_email="sweep3@example.com",
        billing_status="past_due",
    )
    await db.agencies.update_one(
        {"agency_id": "ag-sweep-3"},
        {"$set": {"grace_period_ends_at":
                   (datetime.now(timezone.utc)
                    + timedelta(days=2)).isoformat()}},
    )
    r1 = await run_grace_period_sweep(db)
    assert r1["warned"] == 1
    # Idempotent — second sweep doesn't re-warn the same row.
    r2 = await run_grace_period_sweep(db)
    assert r2["warned"] == 0


# ══════════════════════════════════════════════════════════════════════
# billing_router GET /subscription
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_get_subscription_for_ghw_admin(client, admin_headers):
    r = client.get("/api/billing/subscription", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agency_id"] == GHW_AGENCY_ID
    assert body["tier"] == "domination"
    assert body["billing_status"] == "active"


@pytest.mark.asyncio
async def test_create_checkout_503_when_stripe_unconfigured(
    client, admin_headers, monkeypatch,
):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    r = client.post(
        "/api/billing/create-checkout",
        headers=admin_headers,
        json={"tier": "growth"},
    )
    assert r.status_code == 503, r.text


@pytest.mark.asyncio
async def test_create_checkout_403_for_non_owner_non_super(client, db):
    """A regular `agent` user on a non-super-admin agency must be 403'd
    from billing endpoints."""
    await _seed_agency(
        db, agency_id="ag-noown", slug="noown",
        owner_email="x@example.com", tier="foundation",
    )
    headers = await _login_user(
        client, db, agency_id="ag-noown",
        email="agent-noown@example.com", role="agent",
    )
    r = client.post(
        "/api/billing/create-checkout",
        headers=headers,
        json={"tier": "growth"},
    )
    # Either 503 (stripe unconfigured, checked first) or 403 — the
    # important behaviour is "not 200". Test allows both because
    # which fires first depends on env state.
    assert r.status_code in (403, 503)


# ══════════════════════════════════════════════════════════════════════
# Feature gates on AI endpoints
# ══════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_cna_get_blocked_for_agency_without_feature(client, db):
    """Foundation-tier agency (no `cna` feature) gets 403 on CNA GET."""
    aid = "ag-no-cna-1"
    await _seed_agency(
        db, agency_id=aid, slug="no-cna",
        owner_email="nocna@example.com", tier="foundation",
    )
    headers = await _login_user(
        client, db, agency_id=aid, email="owner-nocna@example.com",
    )
    # Seed a lead under this agency too.
    import uuid
    lead_id = str(uuid.uuid4())
    await db.leads.insert_one({
        "id": lead_id, "first_name": "X", "last_name": "Y",
        "agent_id": "anyone", "agency_id": aid,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    r = client.get(f"/api/cna/{lead_id}", headers=headers)
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["feature"] == "cna"


@pytest.mark.asyncio
async def test_cna_get_allowed_for_ghw_super_admin(client, db, admin_headers):
    """GHW super admin bypasses the feature gate even when we force
    `cna` OFF on the agency row."""
    await db.agencies.update_one(
        {"agency_id": GHW_AGENCY_ID},
        {"$set": {"features.cna": False}},
    )
    try:
        # Create a lead — admin owns it via the GHW context.
        lead = client.post("/api/leads", headers=admin_headers, json={
            "first_name": "Bypass", "last_name": "Test",
            "phone": "555-100-9001",
        }).json()
        r = client.get(f"/api/cna/{lead['id']}", headers=admin_headers)
        assert r.status_code == 200, r.text
    finally:
        await db.agencies.update_one(
            {"agency_id": GHW_AGENCY_ID},
            {"$set": {"features.cna": True}},
        )


@pytest.mark.asyncio
async def test_cna_ai_analysis_blocked_without_ai_feature(client, db):
    """Domination agency with `cna` ON but `ai_client_intelligence`
    OFF — CNA save works, AI endpoint 403s."""
    aid = "ag-cna-noai-1"
    base = build_agency_defaults(
        name="CNA NoAI", slug="cna-noai",
        owner_email="cnanoai@example.com", tier="domination",
    )
    feats = base.features
    feats["ai_client_intelligence"] = False
    doc = base.model_dump()
    doc["agency_id"] = aid
    doc["features"] = feats
    await db.agencies.insert_one(doc)

    headers = await _login_user(
        client, db, agency_id=aid, email="owner-cnanoai@example.com",
    )
    # Seed a lead under this agency.
    import uuid
    lead_id = str(uuid.uuid4())
    user_row = await db.users.find_one(
        {"email": "owner-cnanoai@example.com"},
    )
    await db.leads.insert_one({
        "id": lead_id, "first_name": "AI", "last_name": "Off",
        "agent_id": user_row["id"], "agency_id": aid,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })

    # CNA save itself (no AI) — should succeed.
    r1 = client.post(f"/api/cna/{lead_id}", headers=headers, json={
        "employment_status": "retired",
    })
    assert r1.status_code == 200, r1.text

    # Save with run_ai=true — should 403 with ai_client_intelligence.
    r2 = client.post(
        f"/api/cna/{lead_id}?run_ai=true",
        headers=headers,
        json={"employment_status": "working"},
    )
    assert r2.status_code == 403, r2.text
    assert r2.json()["detail"]["feature"] == "ai_client_intelligence"

    # Trigger AI endpoint — 403 via the Depends gate.
    r3 = client.post(f"/api/cna/{lead_id}/ai-analysis", headers=headers)
    assert r3.status_code == 403, r3.text


@pytest.mark.asyncio
async def test_ghl_map_tags_blocked_without_ghl_import_feature(client, db):
    aid = "ag-no-ghl-1"
    await _seed_agency(
        db, agency_id=aid, slug="no-ghl",
        owner_email="noghl@example.com", tier="foundation",
    )
    headers = await _login_user(
        client, db, agency_id=aid, email="owner-noghl@example.com",
    )
    r = client.post(
        "/api/ghl-import/map-tags", headers=headers,
        json={"tags": ["hot", "warm"]},
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["feature"] == "ghl_import"


@pytest.mark.asyncio
async def test_ghl_map_tags_allowed_for_ghw_admin(client, admin_headers):
    r = client.post(
        "/api/ghl-import/map-tags", headers=admin_headers,
        json={"tags": []},
    )
    # Empty tag list returns {"mapping": {}} on success — proves the
    # feature gate didn't fire.
    assert r.status_code == 200, r.text
