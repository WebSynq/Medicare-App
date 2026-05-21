"""Batch 5 tests: accounting summary, disputes, dispute letter,
reconciliation upload/match/gap detection, CFO chat context."""
import pytest


# ── /api/accounting/summary ─────────────────────────────────────────────
@pytest.mark.asyncio
async def test_accounting_summary_returns_data(client, db, admin_headers):
    from datetime import datetime as _dt, timezone as _tz
    today = _dt.now(_tz.utc).date().isoformat()
    await db.production_records.insert_many([
        {
            "natural_key": "acc-1", "agent_id": "a1", "agent_name": "Tim",
            "policy_number": "P-001", "carrier": "Aetna",
            "product_label": "Med Supp", "effective_date": today,
            "monthly_premium": 100.0, "revenue_expected": 240.0,
            "revenue_received": 240.0, "payment_date": today,
        },
        {
            "natural_key": "acc-2", "agent_id": "a1", "agent_name": "Tim",
            "policy_number": "P-002", "carrier": "UHC",
            "product_label": "MA", "effective_date": today,
            "monthly_premium": 0.0, "revenue_expected": 313.0,
            "revenue_received": None,
        },
    ])
    r = client.get("/api/accounting/summary?period=mtd", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in (
        "expected_mtd", "received_mtd", "gap_mtd", "expected_ytd",
        "collection_rate_pct", "revenue_by_month", "revenue_by_carrier",
        "revenue_by_product", "revenue_by_agent", "aging",
        "outstanding_total", "overpaid_total",
    ):
        assert key in body, f"missing {key}: {body}"
    assert body["expected_mtd"] == 553.0
    assert body["received_mtd"] == 240.0
    assert body["gap_mtd"] == 313.0
    assert body["outstanding_total"] >= 313.0
    carriers = {row["carrier"] for row in body["revenue_by_carrier"]}
    assert "Aetna" in carriers and "UHC" in carriers


# ── Disputes ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_dispute_creation(client, db, admin_headers):
    r = client.post("/api/accounting/disputes", headers=admin_headers, json={
        "carrier": "Aetna", "policy_id": "P-001",
        "agent_name": "Tim", "client_name": "Test Client",
        "amount_disputed": 200.0, "reason": "Underpaid", "notes": "test",
    })
    assert r.status_code == 200, r.text
    dispute_id = r.json()["dispute_id"]
    assert dispute_id
    listing = client.get("/api/accounting/disputes",
                         headers=admin_headers).json()
    ids = [d["dispute_id"] for d in listing.get("items", [])]
    assert dispute_id in ids

    patch = client.patch(
        f"/api/accounting/disputes/{dispute_id}",
        headers=admin_headers,
        json={"status": "resolved", "amount_recovered": 200.0},
    )
    assert patch.status_code == 200, patch.text
    assert patch.json()["status"] == "resolved"


@pytest.mark.asyncio
async def test_dispute_letter_generation(client, db, admin_headers):
    create = client.post("/api/accounting/disputes", headers=admin_headers,
                         json={
                             "carrier": "Aetna", "policy_id": "P-999",
                             "agent_name": "Tim", "client_name": "Doe",
                             "amount_disputed": 250.0,
                             "reason": "Commission missing",
                         })
    assert create.status_code == 200, create.text
    dispute_id = create.json()["dispute_id"]
    r = client.post(f"/api/accounting/disputes/{dispute_id}/letter",
                    headers=admin_headers)
    assert r.status_code == 200, r.text
    assert "text/plain" in r.headers.get("content-type", "")
    assert "Aetna" in r.text
    assert "250" in r.text


# ── Reconciliation ──────────────────────────────────────────────────────
def test_reconciliation_pdf_upload(client, db, admin_headers, monkeypatch):
    import reconciliation_router as recon
    monkeypatch.setattr(
        recon, "_extract_pdf_via_bedrock",
        lambda _b: [{
            "client_name": "Jane Doe", "policy_number": "P-1",
            "product_type": "Med Supp", "carrier": "Aetna",
            "premium_amount": 1200, "commission_paid": 240,
            "payment_date": "2026-04-15",
            "effective_date": "2026-04-01",
        }],
    )
    pdf_bytes = b"%PDF-1.4\n%test\nfake-pdf-payload\n"
    r = client.post(
        "/api/reconciliation/upload", headers=admin_headers,
        data={"carrier": "Aetna"},
        files={"file": ("statement.pdf", pdf_bytes, "application/pdf")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["statement_id"]
    assert body["extracted_count"] == 1


@pytest.mark.asyncio
async def test_reconciliation_matches_policy(client, db, admin_headers):
    await db.production_records.insert_one({
        "natural_key": "match-1", "agent_id": "a1", "agent_name": "Tim",
        "client_name": "Jane Doe", "policy_number": "POL-MATCH",
        "carrier": "Aetna", "product_type": "Med Supp",
        "product_label": "Med Supp",
        "effective_date": "2026-04-01",
        "monthly_premium": 100.0, "revenue_expected": 240.0,
    })
    csv_body = (
        b"client_name,policy_number,carrier,product,premium,"
        b"commission_paid,effective_date\n"
        b"Jane Doe,POL-MATCH,Aetna,Med Supp,1200,240,2026-04-01\n"
    )
    up = client.post(
        "/api/reconciliation/upload", headers=admin_headers,
        data={"carrier": "Aetna"},
        files={"file": ("stmt.csv", csv_body, "text/csv")},
    )
    assert up.status_code == 200, up.text
    sid = up.json()["statement_id"]
    m = client.post(f"/api/reconciliation/{sid}/match",
                    headers=admin_headers)
    assert m.status_code == 200, m.text
    body = m.json()
    assert body["summary"]["matched"] == 1
    assert body["summary"]["paid"] == 1
    rec = body["records"][0]
    assert rec["match_status"] == "paid"
    assert rec["match_confidence"] >= 0.75


@pytest.mark.asyncio
async def test_reconciliation_flags_gap(client, db, admin_headers):
    await db.production_records.insert_one({
        "natural_key": "gap-1", "agent_id": "a1", "agent_name": "Tim",
        "client_name": "Bob Roe", "policy_number": "POL-GAP",
        "carrier": "Aetna", "product_type": "Med Supp",
        "product_label": "Med Supp",
        "effective_date": "2026-04-01",
        "revenue_expected": 240.0,
    })
    csv_body = (
        b"client_name,policy_number,carrier,product,premium,"
        b"commission_paid,effective_date\n"
        b"Bob Roe,POL-GAP,Aetna,Med Supp,1200,120,2026-04-01\n"
    )
    up = client.post(
        "/api/reconciliation/upload", headers=admin_headers,
        data={"carrier": "Aetna"},
        files={"file": ("stmt.csv", csv_body, "text/csv")},
    )
    sid = up.json()["statement_id"]
    m = client.post(f"/api/reconciliation/{sid}/match",
                    headers=admin_headers)
    body = m.json()
    assert body["summary"]["underpaid"] == 1, body["summary"]
    assert body["summary"]["total_gap"] >= 100.0
    rec = body["records"][0]
    assert rec["match_status"] == "underpaid"
    assert rec["gap"] == 120.0


# ── CFO chat payload aliasing ──────────────────────────────────────────
def test_cfo_chat_accepts_message_field():
    """Direct Pydantic check: ``message`` is normalised through cleanly."""
    from cfo_chat_router import CFOChatRequest
    m = CFOChatRequest(message="hello")
    assert m.message == "hello"


def test_cfo_chat_accepts_query_field_alias():
    """Legacy callers sending ``query`` instead of ``message`` must not 422.
    The pre-validator coalesces ``query`` onto ``message`` for downstream
    code that only knows about ``message``."""
    from cfo_chat_router import CFOChatRequest
    m = CFOChatRequest(query="legacy caller payload")
    assert m.message == "legacy caller payload"


def test_cfo_chat_payload_is_body_not_query():
    """Regression: FastAPI must classify ``payload: CFOChatRequest`` as a
    request-body parameter, not a query-string parameter.

    A previous commit added ``from __future__ import annotations`` to
    this router; combined with the @limiter.limit decorator (which
    wraps via functools.wraps and drops __globals__), FastAPI's
    analyze_param could no longer resolve the forward-ref and silently
    fell through to query-parameter classification — every POST then
    returned 422 with loc=['query','payload']."""
    from cfo_chat_router import router
    post = next(
        r for r in router.routes
        if hasattr(r, "methods") and "POST" in r.methods
        and r.path == "/cfo-chat"
    )
    body_names = [p.name for p in post.dependant.body_params]
    query_names = [p.name for p in post.dependant.query_params]
    assert "payload" in body_names, (
        f"payload must be a body param, got body={body_names} "
        f"query={query_names}"
    )
    assert "payload" not in query_names, (
        f"payload must NOT be a query param, got query={query_names}"
    )


def test_cfo_chat_rejects_empty_payload():
    """Neither field supplied → ValidationError. The route still has a
    runtime guard for whitespace-only after stripping."""
    import pytest as _pt
    from pydantic import ValidationError
    from cfo_chat_router import CFOChatRequest
    with _pt.raises(ValidationError):
        CFOChatRequest()


# ── CFO chat context ────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_cfo_chat_returns_quote(client, db, admin_headers):
    """The CFO context endpoint returns the live agency snapshot used by
    the chat panel and by the system-prompt builder. Verifies the shape
    and that aggregations don't crash on an empty DB."""
    # Bust the 5-min context cache so the empty-DB assertion holds even
    # if a prior test populated production_records on the shared mock.
    from cfo_chat_router import _ctx_cache
    _ctx_cache.pop("global", None)
    r = client.get("/api/cfo-chat/context", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in (
        "revenue_mtd", "revenue_ytd", "total_gaps", "collection_rate",
        "top_carrier_by_gap", "agents_with_most_gaps",
        "open_disputes_count", "largest_outstanding_amount", "as_of",
    ):
        assert key in body, f"missing {key}: {body}"
    assert isinstance(body["agents_with_most_gaps"], list)
