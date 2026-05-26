"""GHL import smoke tests.

Network calls to GHL or Claude never fire in tests:
  - _validate_ghl_token is monkey-patched per test
  - ai_map_tags returns {} when ANTHROPIC_API_KEY unset

These tests focus on the API contract: auth gate, schema, response
shape, dedup logic, job lifecycle state machine, mapping helpers.
"""
import pytest

from ghl_import_router import (
    _norm_email, _norm_phone, _norm_date, _is_duplicate, map_ghl_contact,
)


# ── Pure mapping helpers ────────────────────────────────────────────────
def test_norm_email_lowercases_and_strips():
    assert _norm_email("  Foo@Example.COM ") == "foo@example.com"
    assert _norm_email("") is None
    assert _norm_email(None) is None
    assert _norm_email("   ") is None


def test_norm_phone_e164():
    assert _norm_phone("(555) 010-1234") == "+15550101234"
    assert _norm_phone("5550101234") == "+15550101234"
    assert _norm_phone("+15550101234") == "+15550101234"
    assert _norm_phone("1-555-010-1234") == "+15550101234"
    assert _norm_phone("") is None
    assert _norm_phone(None) is None


def test_norm_date_tolerant():
    assert _norm_date("1955-04-12") == "1955-04-12"
    assert _norm_date("4/12/1955") == "1955-04-12"
    assert _norm_date("2026-05-25T12:34:56Z")[:10] == "2026-05-25"
    assert _norm_date("not-a-date") is None
    assert _norm_date(None) is None


def test_map_ghl_contact_full():
    agent = {"id": "a1", "email": "agent@example.com",
             "full_name": "Agent One", "agent_name": "Agent One"}
    ghl = {
        "id": "ghl-123",
        "firstName": "Iris",
        "lastName": "Birthday",
        "email": "Iris@Example.com",
        "phone": "555-010-1234",
        "address1": "1 Main",
        "city": "Springfield",
        "state": "il",
        "postalCode": "62701",
        "dateOfBirth": "1955-04-12",
        "source": "Webinar",
        "tags": ["hot lead", "Birthday WDW"],
        "customFields": [
            {"name": "Medicare ID", "value": "1AA2BB3CC44"},
            {"name": "Current Carrier", "value": "BCBS IL"},
        ],
    }
    tag_map = {"hot lead": "hot-lead", "Birthday WDW": "birthday-window"}
    lead = map_ghl_contact(ghl, tag_map, agent, "ghw_001")
    assert lead["first_name"] == "Iris"
    assert lead["last_name"] == "Birthday"
    assert lead["email"] == "iris@example.com"
    assert lead["phone"] == "+15550101234"
    assert lead["state"] == "IL"
    assert lead["mbi_number"] == "1AA2BB3CC44"
    assert lead["current_carrier"] == "BCBS IL"
    assert lead["ghl_contact_id"] == "ghl-123"
    assert lead["imported_from_ghl"] is True
    assert lead["agent_id"] == "a1"
    assert "hot-lead" in lead["tags"]
    assert "birthday-window" in lead["tags"]


def test_map_ghl_contact_skips_unmapped_tags():
    agent = {"id": "a1", "email": "a@x.com"}
    ghl = {
        "id": "ghl-2",
        "firstName": "Iris",
        "tags": ["webinar_2024", "hot lead"],
    }
    tag_map = {"hot lead": "hot-lead", "webinar_2024": None}
    lead = map_ghl_contact(ghl, tag_map, agent, "ghw_001")
    assert lead["tags"] == ["hot-lead"]


# ── Connection endpoint contracts ───────────────────────────────────────
def test_status_unconnected(client, admin_headers):
    r = client.get("/api/ghl-import/status", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"connected": False}


def test_connect_with_invalid_token_400(client, admin_headers, monkeypatch):
    """Real validator returns {valid:False, error:...} → handler 400s."""
    async def fake_validate(_token):
        return {"valid": False, "error": "Token rejected."}
    import ghl_import_router
    monkeypatch.setattr(ghl_import_router, "_validate_ghl_token", fake_validate)
    r = client.post("/api/ghl-import/connect", headers=admin_headers, json={
        "token": "abcdefghijklmnopqrstuvwxyz",
    })
    assert r.status_code == 400
    assert "rejected" in (r.json().get("detail") or "").lower()


def test_connect_then_status_then_disconnect(
    client, db, admin_headers, monkeypatch,
):
    async def fake_validate(_token):
        return {
            "valid": True,
            "location_id": "loc_abc",
            "location_name": "Test Agency",
            "contact_count": 42,
        }
    import ghl_import_router
    monkeypatch.setattr(ghl_import_router, "_validate_ghl_token", fake_validate)

    r1 = client.post("/api/ghl-import/connect", headers=admin_headers, json={
        "token": "abcdefghijklmnopqrstuvwxyz",
    })
    assert r1.status_code == 200, r1.text
    body = r1.json()
    assert body["connected"] is True
    assert body["location_id"] == "loc_abc"
    assert body["location_name"] == "Test Agency"
    assert "token_encrypted" not in body  # token never leaks
    assert "token" not in body

    # status reflects the connection
    r2 = client.get("/api/ghl-import/status", headers=admin_headers)
    assert r2.json()["connected"] is True

    # disconnect
    r3 = client.delete("/api/ghl-import/connect", headers=admin_headers)
    assert r3.status_code == 200
    assert r3.json()["disconnected"] is True
    r4 = client.get("/api/ghl-import/status", headers=admin_headers)
    assert r4.json() == {"connected": False}


# ── /map-tags returns empty when no API key (test env) ──────────────────
def test_map_tags_returns_full_keyset_even_without_ai(client, admin_headers):
    r = client.post("/api/ghl-import/map-tags", headers=admin_headers, json={
        "tags": ["hot lead", "Birthday WDW", "webinar_2024"],
    })
    assert r.status_code == 200
    body = r.json()
    # Every input tag is present in the mapping (null when no AI).
    assert set(body["mapping"].keys()) == {
        "hot lead", "Birthday WDW", "webinar_2024",
    }
    assert "portal_tags" in body and isinstance(body["portal_tags"], list)


# ── Preview / start require connection ──────────────────────────────────
def test_preview_without_connection_400(client, admin_headers):
    r = client.post("/api/ghl-import/preview", headers=admin_headers)
    assert r.status_code == 400


def test_start_without_connection_400(client, admin_headers):
    r = client.post("/api/ghl-import/start", headers=admin_headers, json={
        "tag_mapping": {}, "overwrite_existing": False,
    })
    assert r.status_code == 400


# ── Jobs list (initially empty) ─────────────────────────────────────────
def test_jobs_list_initially_empty(client, admin_headers):
    r = client.get("/api/ghl-import/jobs", headers=admin_headers)
    assert r.status_code == 200
    assert r.json() == {"jobs": [], "count": 0}


def test_jobs_unknown_id_404(client, admin_headers):
    r = client.get("/api/ghl-import/jobs/does-not-exist",
                    headers=admin_headers)
    assert r.status_code == 404


# ── Duplicate detection ─────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_is_duplicate_by_email(db):
    await db.leads.insert_one({
        "id": "lead-1", "agent_id": "a1",
        "email": "dup@example.com", "phone": None,
        "ghl_contact_id": None,
    })
    dup = await _is_duplicate(db, "a1", {"email": "dup@example.com"})
    assert dup is True
    no = await _is_duplicate(db, "a1", {"email": "fresh@example.com"})
    assert no is False


@pytest.mark.asyncio
async def test_is_duplicate_by_ghl_contact_id(db):
    await db.leads.insert_one({
        "id": "lead-1", "agent_id": "a1",
        "ghl_contact_id": "ghl-x",
    })
    dup = await _is_duplicate(db, "a1", {"ghl_contact_id": "ghl-x"})
    assert dup is True


@pytest.mark.asyncio
async def test_is_duplicate_scoped_to_agent(db):
    """A1's lead doesn't count as a dup for A2."""
    await db.leads.insert_one({
        "id": "lead-1", "agent_id": "a1",
        "email": "shared@example.com",
    })
    dup = await _is_duplicate(db, "a2", {"email": "shared@example.com"})
    assert dup is False
