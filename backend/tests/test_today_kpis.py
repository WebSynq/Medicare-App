"""Feature B — Today page KPI cards.

`/api/today/actions` now ships two daily scalars at the top level:
    new_leads_today        — count of leads created today (UTC)
    apps_submitted_today   — count of policies whose submitted_at is today

Scoped through deps.agent_filter, so an agent sees only their own row
counts while admin / owner / compliance see the agency-wide tally.
"""
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from security import hash_password


GHW_AGENCY = "ghw_001"


def _today_iso() -> str:
    # Match today_router's UTC anchor — using local date.today() would
    # mismatch when the test runs in a timezone west of UTC after local
    # midnight (e.g. Pacific evening = next-day UTC).
    return datetime.now(timezone.utc).date().isoformat()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _yesterday_iso() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()


async def _seed_agent(db, email: str) -> dict:
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "agent_id": uid,
        "email": email,
        "full_name": email.split("@")[0].title(),
        "agent_name": email.split("@")[0].title(),
        "role": "agent",
        "agency_id": GHW_AGENCY,
        "is_active": True,
        "status": "active",
        "hashed_password": hash_password("Q9pl#aux!7zT-seed"),
        "token_version": 0,
        "failed_attempts": 0,
        "created_at": _now_iso(),
    }
    await db.users.insert_one(doc)
    return doc


def _login(client, email: str) -> dict:
    r = client.post("/api/auth/login", json={
        "email": email, "password": "Q9pl#aux!7zT-seed",
    })
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _insert_lead(db, lead_id: str, agent_id: str, created_iso: str) -> None:
    await db.leads.insert_one({
        "id": lead_id,
        "first_name": lead_id,
        "last_name": "Lead",
        "agent_id": agent_id,
        "agency_id": GHW_AGENCY,
        "status": "new",
        "created_at": created_iso,
        "updated_at": created_iso,
    })


async def _insert_policy(
    db, policy_id: str, agent_id: str, submitted_iso: str,
) -> None:
    await db.policies.insert_one({
        "id": policy_id,
        "application_id": policy_id,
        "agent_id": agent_id,
        "agency_id": GHW_AGENCY,
        "submitted_at": submitted_iso,
        "ghl_contact_id": f"gc-{policy_id}",
        "contact_name": "Test Client",
        "product_type": "Medicare Supplement",
        "premium": "120.00",
    })


# ── new_leads_today ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_new_leads_today_admin_counts_all_agency(client, db, admin_headers):
    """Admin sees every lead created today across the agency."""
    agent_a = await _seed_agent(db, "kpi.lead.a@example.com")
    agent_b = await _seed_agent(db, "kpi.lead.b@example.com")
    today_iso = _today_iso()
    await _insert_lead(db, "kpi-l-a", agent_a["id"], today_iso)
    await _insert_lead(db, "kpi-l-b", agent_b["id"], today_iso)

    r = client.get("/api/today/actions", headers=admin_headers)
    assert r.status_code == 200, r.text
    # Both leads visible to admin; assert >=2 rather than ==2 because the
    # conftest may seed unrelated leads under "admin-1" in other tests
    # that run in the same DB lifecycle (it doesn't today, but be robust).
    assert r.json()["new_leads_today"] >= 2


@pytest.mark.asyncio
async def test_new_leads_today_agent_sees_only_own(client, db):
    """Agent sees only leads where agent_id matches their own user id."""
    agent_a = await _seed_agent(db, "kpi.scope.a@example.com")
    agent_b = await _seed_agent(db, "kpi.scope.b@example.com")
    today_iso = _today_iso()
    await _insert_lead(db, "scope-mine-1", agent_a["id"], today_iso)
    await _insert_lead(db, "scope-mine-2", agent_a["id"], today_iso)
    await _insert_lead(db, "scope-theirs", agent_b["id"], today_iso)

    headers = _login(client, "kpi.scope.a@example.com")
    r = client.get("/api/today/actions", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["new_leads_today"] == 2


@pytest.mark.asyncio
async def test_new_leads_today_excludes_yesterday(client, db, admin_headers):
    """Leads created yesterday must NOT count toward today's total."""
    yesterday_iso = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    await db.leads.insert_one({
        "id": "stale-yesterday",
        "first_name": "Old", "last_name": "Lead",
        "agent_id": "admin-1",
        "agency_id": GHW_AGENCY,
        "status": "new",
        "created_at": yesterday_iso,
        "updated_at": yesterday_iso,
    })
    r = client.get("/api/today/actions", headers=admin_headers)
    body = r.json()
    # The yesterday-stamped row must not bump the count.
    assert "stale-yesterday" not in {
        "stale-yesterday"
    } or body["new_leads_today"] == 0


# ── apps_submitted_today ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_apps_submitted_today_admin_counts_all_agency(client, db, admin_headers):
    """Admin sees every policy submitted today across the agency."""
    agent_a = await _seed_agent(db, "kpi.app.a@example.com")
    agent_b = await _seed_agent(db, "kpi.app.b@example.com")
    today_iso = _today_iso()
    await _insert_policy(db, "kpi-p-a", agent_a["id"], today_iso)
    await _insert_policy(db, "kpi-p-b", agent_b["id"], today_iso)

    r = client.get("/api/today/actions", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json()["apps_submitted_today"] >= 2


@pytest.mark.asyncio
async def test_apps_submitted_today_agent_sees_only_own(client, db):
    """Agent counts only their own submitted policies."""
    agent_a = await _seed_agent(db, "kpi.app.scope.a@example.com")
    agent_b = await _seed_agent(db, "kpi.app.scope.b@example.com")
    today_iso = _today_iso()
    await _insert_policy(db, "ascope-mine-1", agent_a["id"], today_iso)
    await _insert_policy(db, "ascope-mine-2", agent_a["id"], today_iso)
    await _insert_policy(db, "ascope-theirs", agent_b["id"], today_iso)

    headers = _login(client, "kpi.app.scope.a@example.com")
    r = client.get("/api/today/actions", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["apps_submitted_today"] == 2


@pytest.mark.asyncio
async def test_apps_submitted_today_excludes_yesterday(client, db, admin_headers):
    """Policies submitted yesterday must NOT count."""
    yesterday_iso = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    await _insert_policy(db, "old-app", "admin-1", yesterday_iso)
    r = client.get("/api/today/actions", headers=admin_headers)
    # The yesterday-stamped policy must not contribute. Other tests in
    # this file run in fresh DBs (autouse=True _clean_db), so 0 is exact.
    assert r.json()["apps_submitted_today"] == 0


# ── Cross-agency isolation ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_new_leads_today_does_not_leak_across_agencies(client, db, admin_headers):
    """Stamp a lead in agency_two with today's date — GHW admin must not
    count it. Belt-and-suspenders on the agency_id filter.
    """
    today_iso = _today_iso()
    await db.leads.insert_one({
        "id": "second-tenant-lead",
        "first_name": "Other", "last_name": "Agency",
        "agent_id": "stranger",
        "agency_id": "agency_two",
        "status": "new",
        "created_at": today_iso,
        "updated_at": today_iso,
    })
    r = client.get("/api/today/actions", headers=admin_headers)
    # GHW admin sees 0 new leads (none in their own agency); the
    # agency_two lead is invisible.
    assert r.json()["new_leads_today"] == 0
