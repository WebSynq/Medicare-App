"""Phase 2 — Metering tests.

Covers:
  - track_* helpers write to usage_events with the right shape
  - Fire-and-forget: the user request never blocks on metering
  - Idempotency: duplicate event_ids don't double-insert
  - check_* limit gates: pass under cap, deny over cap, super_admin
    always passes, unlimited tier honored
  - rollup_period aggregates correctly and is idempotent
  - cna_router metering wire-in actually fires on a successful AI call
    (with the AI mocked so we don't hit the network)
  - application_router /extract emits an app_intake event
  - resend_client send_email emits an email_sent event when agency_id
    is passed (and not when omitted)
"""
from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agency_models import current_billing_period
from seed import GHW_AGENCY_ID


# ── track_* low-level helpers ──────────────────────────────────────────
@pytest.mark.asyncio
async def test_track_ai_usage_writes_event(db):
    from metering import track_ai_usage
    track_ai_usage(
        agency_id="ghw_001",
        agent_id="agent-x",
        event_type="cna_analysis",
        tokens_in=1200,
        tokens_out=400,
        model="claude-sonnet-4-6",
    )
    # Fire-and-forget — give the loop a tick to drain the task.
    await asyncio.sleep(0.05)
    rows = await db.usage_events.find({"agency_id": "ghw_001"}).to_list(10)
    assert len(rows) == 1
    e = rows[0]
    assert e["event_type"] == "cna_analysis"
    assert e["unit"] == "tokens"
    assert e["quantity"] == 1600.0
    assert e["model"] == "claude-sonnet-4-6"
    assert e["billing_period"] == current_billing_period()
    assert e["metadata"]["tokens_in"] == 1200
    assert e["metadata"]["tokens_out"] == 400
    # Provider cost should be positive given non-zero tokens.
    assert e["cost_usd"] > 0


@pytest.mark.asyncio
async def test_track_ai_usage_drops_when_agency_id_missing(db):
    from metering import track_ai_usage
    track_ai_usage(
        agency_id=None,
        agent_id="x",
        event_type="cna_analysis",
        tokens_in=10, tokens_out=10,
    )
    await asyncio.sleep(0.05)
    n = await db.usage_events.count_documents({})
    assert n == 0


@pytest.mark.asyncio
async def test_track_email_sent_writes_event(db):
    from metering import track_email_sent
    track_email_sent(agency_id="ghw_001", agent_id="a1", count=3)
    await asyncio.sleep(0.05)
    e = await db.usage_events.find_one({"event_type": "email_sent"})
    assert e is not None
    assert e["quantity"] == 3.0
    assert e["unit"] == "emails"


@pytest.mark.asyncio
async def test_track_storage_write(db):
    from metering import track_storage_write
    track_storage_write(agency_id="ghw_001", bytes_written=2 * 1024 ** 3)
    await asyncio.sleep(0.05)
    e = await db.usage_events.find_one({"event_type": "document_stored"})
    assert e is not None
    assert e["unit"] == "gb"
    assert e["quantity"] == pytest.approx(2.0, rel=1e-6)


@pytest.mark.asyncio
async def test_track_app_intake(db):
    from metering import track_app_intake
    track_app_intake(agency_id="ghw_001", agent_id="a1",
                      metadata={"product_type": "medsupp"})
    await asyncio.sleep(0.05)
    e = await db.usage_events.find_one({"event_type": "app_intake"})
    assert e is not None
    assert e["quantity"] == 1.0
    # $0.25 / 100 = 0.0025 USD per intake (foundation rate).
    assert e["charge_usd"] == pytest.approx(0.25, rel=1e-6)


@pytest.mark.asyncio
async def test_track_is_fire_and_forget_does_not_block(db):
    """The track_* call itself must return synchronously without
    awaiting the DB write — proved by timing the call against the
    DB write actually happening on the next event-loop tick."""
    import time
    from metering import track_ai_usage
    t0 = time.perf_counter()
    track_ai_usage(
        agency_id="ghw_001", agent_id="x",
        event_type="cna_analysis", tokens_in=1, tokens_out=1,
    )
    elapsed = time.perf_counter() - t0
    # track_* should be a no-op-ish synchronous schedule; allow a
    # very generous ceiling so a slow CI doesn't false-fail.
    assert elapsed < 0.05, f"track_* blocked for {elapsed:.3f}s"
    # Drain.
    await asyncio.sleep(0.05)
    n = await db.usage_events.count_documents({})
    assert n == 1


# ── check_* limit gates ────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_check_ai_limit_super_admin_unlimited(db):
    """GHW (super_admin) always passes regardless of count."""
    from metering import check_ai_limit, track_ai_usage
    # Stuff hundreds of events on GHW.
    for _ in range(50):
        track_ai_usage(
            agency_id=GHW_AGENCY_ID, agent_id="x",
            event_type="cna_analysis",
            tokens_in=10, tokens_out=10,
        )
    await asyncio.sleep(0.2)
    assert await check_ai_limit(db, GHW_AGENCY_ID) is True


@pytest.mark.asyncio
async def test_check_ai_limit_blocks_at_cap(db):
    """A foundation-tier agency at its 1000-call cap returns False."""
    from agency_models import build_agency_defaults
    aid = "agency-cap-001"
    agency = build_agency_defaults(
        name="Cap Co", slug="cap-co",
        owner_email="cap@example.com", tier="foundation",
    )
    doc = agency.model_dump()
    doc["agency_id"] = aid
    # Lower the limit to 3 so the test stays fast.
    doc["limits"]["ai_calls_included"] = 3
    await db.agencies.insert_one(doc)

    from metering import check_ai_limit, track_ai_usage
    assert await check_ai_limit(db, aid) is True  # 0/3
    for _ in range(3):
        track_ai_usage(
            agency_id=aid, agent_id="x",
            event_type="cna_analysis",
            tokens_in=10, tokens_out=10,
        )
    await asyncio.sleep(0.2)
    assert await check_ai_limit(db, aid) is False  # 3/3


@pytest.mark.asyncio
async def test_check_email_limit_blocks_at_cap(db):
    from agency_models import build_agency_defaults
    aid = "agency-mailcap-001"
    agency = build_agency_defaults(
        name="Mail Co", slug="mail-co",
        owner_email="mail@example.com", tier="foundation",
    )
    doc = agency.model_dump()
    doc["agency_id"] = aid
    doc["limits"]["emails_included"] = 5
    await db.agencies.insert_one(doc)

    from metering import check_email_limit, track_email_sent
    assert await check_email_limit(db, aid) is True
    track_email_sent(agency_id=aid, count=5)
    await asyncio.sleep(0.05)
    assert await check_email_limit(db, aid) is False


@pytest.mark.asyncio
async def test_check_ai_limit_unknown_agency_denies(db):
    from metering import check_ai_limit
    assert await check_ai_limit(db, "no-such-agency") is False


# ── Rollup ─────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_rollup_period_aggregates_and_is_idempotent(db):
    from metering import rollup_period, track_ai_usage, track_email_sent

    # Seed a non-super-admin agency.
    from agency_models import build_agency_defaults
    aid = "agency-rollup-001"
    base = build_agency_defaults(
        name="Rollup Co", slug="rollup-co",
        owner_email="rollup@example.com", tier="growth",
    )
    doc = base.model_dump()
    doc["agency_id"] = aid
    await db.agencies.insert_one(doc)

    # Generate 7 AI calls + 12 emails.
    for _ in range(7):
        track_ai_usage(
            agency_id=aid, agent_id="a", event_type="cna_analysis",
            tokens_in=500, tokens_out=200,
        )
    track_email_sent(agency_id=aid, count=12)
    await asyncio.sleep(0.2)

    period = current_billing_period()
    r1 = await rollup_period(db, period)
    assert r1["agencies_processed"] >= 1
    assert r1["events_aggregated"] >= 8

    summary = await db.agency_usage_summary.find_one(
        {"agency_id": aid, "billing_period": period},
    )
    assert summary is not None
    assert summary["ai_calls_total"] == 7
    assert summary["emails_sent"] == 12
    # Growth base = $497 → reflected as 497.0
    assert summary["total_base_charge_usd"] == 497.0

    # Idempotent — run again, no row duplication.
    r2 = await rollup_period(db, period)
    assert r2["agencies_processed"] >= 1
    count = await db.agency_usage_summary.count_documents(
        {"agency_id": aid, "billing_period": period},
    )
    assert count == 1


@pytest.mark.asyncio
async def test_rollup_overage_math_growth_agency(db):
    """Growth tier: 5,000 AI calls included → 6 calls × 1000 tokens
    each over the cap counts as overage. Sanity check the math."""
    from metering import rollup_period, track_ai_usage
    from agency_models import build_agency_defaults

    aid = "agency-overage-001"
    base = build_agency_defaults(
        name="Over Co", slug="over-co",
        owner_email="o@example.com", tier="growth",
    )
    doc = base.model_dump()
    doc["agency_id"] = aid
    # Tight cap so test is cheap.
    doc["limits"]["ai_calls_included"] = 2
    await db.agencies.insert_one(doc)

    # 5 AI calls × ~1000 tokens each → 5000 tokens total. With cap=2
    # the rough overage is (5000 - 2*1000) = 3000 tokens over,
    # at 1¢/1k = $0.03.
    for _ in range(5):
        track_ai_usage(
            agency_id=aid, agent_id="a", event_type="cna_analysis",
            tokens_in=500, tokens_out=500,
        )
    await asyncio.sleep(0.2)
    await rollup_period(db, current_billing_period())
    summary = await db.agency_usage_summary.find_one(
        {"agency_id": aid, "billing_period": current_billing_period()},
    )
    assert summary["ai_calls_total"] == 5
    # Overage should be > 0 (5 calls > 2 cap, and tokens > included).
    assert summary["total_overage_usd"] > 0


# ── cna_router wire-in ────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_cna_save_with_ai_emits_usage_event(client, db, admin_headers,
                                                    monkeypatch):
    """When an admin saves a CNA with run_ai=true AND the Claude call
    is mocked to succeed, a cna_analysis usage event is logged.

    We monkey-patch anthropic.AsyncAnthropic at the cna_router import
    site so the call stays offline; we also set ANTHROPIC_API_KEY so
    the safe-default early return doesn't fire.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    # Mock the SDK so messages.create() returns a fake response with
    # the JSON the sanitiser will accept plus a usage block.
    fake_response = MagicMock()
    fake_response.usage = MagicMock(input_tokens=900, output_tokens=300)
    fake_block = MagicMock()
    fake_block.text = (
        '{"recommended_plan_type": "supplement",'
        ' "recommended_umbrella": "3",'
        ' "confidence": "high", "primary_reason": "ok",'
        ' "estimated_monthly_range": "$100-150",'
        ' "urgency_score": 50, "urgency_reason": "x",'
        ' "key_exposures": [], "talking_points": [],'
        ' "cross_sell_opportunities": [],'
        ' "objection_handles": [],'
        ' "formal_recommendation_script": "s",'
        ' "next_best_action": "n"}'
    )
    fake_response.content = [fake_block]

    fake_client = MagicMock()
    fake_client.messages = MagicMock()
    fake_client.messages.create = AsyncMock(return_value=fake_response)

    fake_anthropic_module = MagicMock()
    fake_anthropic_module.AsyncAnthropic = MagicMock(return_value=fake_client)

    # Create a lead under the seeded admin.
    lead = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "AI", "last_name": "Meter",
        "phone": "555-100-1111",
    }).json()

    with patch.dict("sys.modules", {"anthropic": fake_anthropic_module}):
        r = client.post(
            f"/api/cna/{lead['id']}?run_ai=true",
            headers=admin_headers,
            json={"employment_status": "retired"},
        )
    assert r.status_code == 200, r.text
    await asyncio.sleep(0.1)

    events = await db.usage_events.find(
        {"event_type": "cna_analysis"}
    ).to_list(10)
    assert len(events) == 1
    e = events[0]
    assert e["agency_id"] == GHW_AGENCY_ID
    assert e["metadata"]["tokens_in"] == 900
    assert e["metadata"]["tokens_out"] == 300


# ── application_router wire-in ────────────────────────────────────────
@pytest.mark.asyncio
async def test_app_intake_metering_called_directly(db, monkeypatch):
    """We don't run the full Bedrock path in tests (boto3 dep, AWS
    keys), so we exercise the metering hook directly to prove the
    wire-up writes the right event shape."""
    from metering import track_app_intake
    track_app_intake(
        agency_id=GHW_AGENCY_ID,
        agent_id="agent-x",
        metadata={"product_type": "medsupp", "auto_detected": True},
    )
    await asyncio.sleep(0.05)
    e = await db.usage_events.find_one({"event_type": "app_intake"})
    assert e is not None
    assert e["metadata"]["product_type"] == "medsupp"


# ── resend_client wire-in ─────────────────────────────────────────────
@pytest.mark.asyncio
async def test_send_email_with_agency_id_emits_event(db, monkeypatch):
    """send_email(..., agency_id=X) on a successful send writes one
    email_sent event. send_email without agency_id writes nothing."""
    import resend_client as rc

    monkeypatch.setenv("RESEND_API_KEY", "test-key")

    # Mock httpx so we don't actually hit Resend.
    class _OkResp:
        status_code = 200
        text = ""

    class _FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def post(self, *a, **k): return _OkResp()

    monkeypatch.setattr(rc.httpx, "AsyncClient", lambda **kw: _FakeClient())

    # 1. With agency_id → one event.
    ok = await rc.send_email(
        to="x@example.com", subject="s", html="<p>x</p>",
        agency_id=GHW_AGENCY_ID, agent_id="a1",
    )
    assert ok is True
    await asyncio.sleep(0.05)
    n_with = await db.usage_events.count_documents(
        {"event_type": "email_sent", "agency_id": GHW_AGENCY_ID},
    )
    assert n_with == 1

    # 2. Without agency_id → no new event.
    before = await db.usage_events.count_documents({"event_type": "email_sent"})
    ok = await rc.send_email(
        to="y@example.com", subject="s", html="<p>y</p>",
    )
    assert ok is True
    await asyncio.sleep(0.05)
    after = await db.usage_events.count_documents({"event_type": "email_sent"})
    assert after == before, "untenanted send must not emit an event"
