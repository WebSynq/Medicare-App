"""Lead create + bulk-import stamp agency_id from the caller's JWT,
not from the process-wide ``AGENCY_ID`` env var.

Regression guard: prior to this fix, both ``POST /api/leads`` and
``POST /api/leads/import`` called ``deps.get_agency_id()`` — which only
reads the env var and defaults to ``ghw_001``. Any future tenant
creating a lead would silently have their writes filed under GHW.
"""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone

import pytest

from agency_models import build_agency_defaults
from security import hash_password


OTHER_AGENCY_ID = "agency-scoping-test-001"
OTHER_OWNER_EMAIL = "scoping-owner@example.com"
OTHER_OWNER_PASSWORD = "Q9pl#aux!7zT-scoping"


async def _seed_other_agency(db) -> str:
    base = build_agency_defaults(
        name="Scoping Co",
        slug="scoping-co",
        owner_email=OTHER_OWNER_EMAIL,
        tier="growth",
    )
    doc = base.model_dump()
    doc["agency_id"] = OTHER_AGENCY_ID
    await db.agencies.insert_one(doc)

    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid,
        "agent_id": uid,
        "email": OTHER_OWNER_EMAIL,
        "full_name": "Scoping Owner",
        "agent_name": "Scoping Owner",
        "role": "owner",
        "is_active": True,
        "status": "active",
        "agency_id": OTHER_AGENCY_ID,
        "hashed_password": hash_password(OTHER_OWNER_PASSWORD),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return OTHER_AGENCY_ID


def _login_other(client) -> dict:
    resp = client.post("/api/auth/login", json={
        "email": OTHER_OWNER_EMAIL,
        "password": OTHER_OWNER_PASSWORD,
    })
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.mark.asyncio
async def test_create_lead_stamps_callers_agency_id(client, db):
    """A non-GHW agency owner POSTing /api/leads must land their lead
    under their own agency_id, not the env-driven default."""
    await _seed_other_agency(db)
    headers = _login_other(client)

    resp = client.post("/api/leads", headers=headers, json={
        "first_name": "Cross",
        "last_name": "Tenant",
        "phone": "555-200-1111",
    })
    assert resp.status_code == 201, resp.text

    stored = await db.leads.find_one({"id": resp.json()["id"]}, {"_id": 0})
    assert stored is not None, "lead not persisted"
    assert stored["agency_id"] == OTHER_AGENCY_ID, (
        f"expected agency_id={OTHER_AGENCY_ID!r}, "
        f"got {stored.get('agency_id')!r} — leak from env default"
    )


@pytest.mark.asyncio
async def test_auto_soa_stamps_lead_agency_id(client, db):
    """The auto-SOA helper, fired on Medicare-product leads, must
    stamp the SOA row with the lead's agency_id — not the env default.
    Otherwise the SOA row would be filed under GHW for any tenant."""
    await _seed_other_agency(db)
    headers = _login_other(client)

    resp = client.post("/api/leads", headers=headers, json={
        "first_name": "SOA",
        "last_name": "Tenant",
        "phone": "555-200-4444",
        "product_interest": "Medicare Supplement",
    })
    assert resp.status_code == 201, resp.text
    lead_id = resp.json()["id"]

    soa = await db.soa_records.find_one({"lead_id": lead_id}, {"_id": 0})
    assert soa is not None, "auto-SOA was not minted for a Medicare lead"
    assert soa["agency_id"] == OTHER_AGENCY_ID, (
        f"auto-SOA leaked agency_id={soa.get('agency_id')!r} "
        f"instead of {OTHER_AGENCY_ID!r}"
    )


@pytest.mark.asyncio
async def test_import_leads_csv_stamps_callers_agency_id(client, db):
    """Same guarantee for the bulk CSV import path."""
    await _seed_other_agency(db)
    headers = _login_other(client)

    csv_payload = (
        "first_name,last_name,phone,email\n"
        "Bulk,One,555-200-2222,bulk-one@example.com\n"
        "Bulk,Two,555-200-3333,bulk-two@example.com\n"
    ).encode("utf-8")

    resp = client.post(
        "/api/leads/import",
        headers=headers,
        files={"csv_file": ("import.csv", io.BytesIO(csv_payload), "text/csv")},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["imported"] == 2, body

    rows = [r async for r in db.leads.find({}, {"_id": 0, "agency_id": 1, "email": 1})]
    imported_rows = [r for r in rows if (r.get("email") or "").endswith("@example.com")]
    assert len(imported_rows) == 2, imported_rows
    for r in imported_rows:
        assert r["agency_id"] == OTHER_AGENCY_ID, (
            f"bulk import leaked agency_id={r.get('agency_id')!r} "
            f"instead of {OTHER_AGENCY_ID!r}"
        )
