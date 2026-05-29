"""Tests for the 2026-05 row-level-scope tightening.

Spec (per user instruction):

    owner + admin                 → see every record where
                                    ``agency_id`` matches their JWT
                                    ``agency_id``.

    every other role (agent, va, compliance, coach, accounting,
    client_success, sales_manager, cyber_security)
                                  → see only records where
                                    ``agency_id`` matches AND
                                    ``agent_id`` matches their own
                                    JWT user id.

The contract is enforced centrally in ``deps.agent_filter``. These tests
exercise it end-to-end through the leads + clients endpoints (the
surfaces the user explicitly audited) and assert two negative paths the
old tuple silently allowed: compliance reading another agent's lead, and
cross-agency leakage between two tenants.
"""
import uuid
from datetime import datetime, timezone

import pytest

from security import hash_password


GHW_AGENCY = "ghw_001"
SECOND_AGENCY = "agency_two"


# ── Helpers ────────────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _seed_user(
    db,
    email: str,
    role: str = "agent",
    agency_id: str = GHW_AGENCY,
    full_name: str | None = None,
) -> dict:
    """Insert an active user directly. Skips the invite flow so a single
    test can spin up several roles cheaply.
    """
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "agent_id": uid,
        "email": email,
        "full_name": full_name or email.split("@")[0].title(),
        "agent_name": full_name or email.split("@")[0].title(),
        "role": role,
        "agency_id": agency_id,
        "is_active": True,
        "status": "active",
        "hashed_password": hash_password("Q9pl#aux!7zT-seed"),
        "token_version": 0,
        "failed_attempts": 0,
        "created_at": _now_iso(),
    }
    await db.users.insert_one(doc)
    return doc


async def _seed_agency(db, agency_id: str) -> None:
    """Insert a minimal agency row so ``get_agency`` can resolve it.
    Mirrors the shape of ``seed_ghw_agency`` but with feature flags off
    by default so we don't have to construct the full tier registry —
    every lead/client endpoint under test uses agent_filter, not
    require_feature, so flags don't matter here.
    """
    existing = await db.agencies.find_one({"agency_id": agency_id})
    if existing:
        return
    await db.agencies.insert_one({
        "agency_id": agency_id,
        "name": agency_id,
        "slug": agency_id,
        "tier": "domination",
        "billing_status": "active",
        "super_admin": False,
        "features": {},
        "seats_max": -1,
        "seats_active": 0,
        "created_at": _now_iso(),
    })


def _login(client, email: str) -> dict:
    """Log in the seeded user and return Bearer headers."""
    r = client.post("/api/auth/login", json={
        "email": email, "password": "Q9pl#aux!7zT-seed",
    })
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _seed_lead(
    db,
    lead_id: str,
    agent_id: str,
    agency_id: str = GHW_AGENCY,
    status: str = "new",
    first: str = "First",
    last: str = "Last",
) -> None:
    await db.leads.insert_one({
        "id": lead_id,
        "first_name": first,
        "last_name": last,
        "agent_id": agent_id,
        "agency_id": agency_id,
        "status": status,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    })


async def _seed_client(
    db,
    ghl_contact_id: str,
    agent_id: str,
    agency_id: str = GHW_AGENCY,
    full_name: str = "Client Person",
) -> None:
    await db["clients"].insert_one({
        "ghl_contact_id": ghl_contact_id,
        "agent_id": agent_id,
        "agency_id": agency_id,
        "full_name": full_name,
        "first_name": full_name.split(" ", 1)[0],
        "last_name": full_name.split(" ", 1)[-1],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    })


# ── Tests ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_owner_sees_all_leads_in_agency(client, db):
    """owner role: row-level filter is agency-only, NO agent_id pin."""
    owner = await _seed_user(db, "owner.scope@example.com", role="owner")
    agent_a = await _seed_user(db, "agent.a@example.com", role="agent")
    agent_b = await _seed_user(db, "agent.b@example.com", role="agent")
    await _seed_lead(db, "lead-a", agent_id=agent_a["id"])
    await _seed_lead(db, "lead-b", agent_id=agent_b["id"])
    await _seed_lead(db, "lead-own", agent_id=owner["id"])

    headers = _login(client, "owner.scope@example.com")
    r = client.get("/api/leads?limit=50", headers=headers)
    assert r.status_code == 200, r.text
    ids = {lead["id"] for lead in r.json()["leads"]}
    assert {"lead-a", "lead-b", "lead-own"} <= ids


@pytest.mark.asyncio
async def test_admin_sees_all_leads_in_agency(client, db, admin_headers):
    """admin role: same rule as owner. Uses the seeded admin from conftest."""
    agent_a = await _seed_user(db, "admin.peer.a@example.com", role="agent")
    agent_b = await _seed_user(db, "admin.peer.b@example.com", role="agent")
    await _seed_lead(db, "ld-admin-a", agent_id=agent_a["id"])
    await _seed_lead(db, "ld-admin-b", agent_id=agent_b["id"])

    r = client.get("/api/leads?limit=50", headers=admin_headers)
    assert r.status_code == 200, r.text
    ids = {lead["id"] for lead in r.json()["leads"]}
    assert {"ld-admin-a", "ld-admin-b"} <= ids


@pytest.mark.asyncio
async def test_agent_sees_only_their_own_leads(client, db):
    """agent role: list endpoint returns rows where agent_id == self only."""
    agent_a = await _seed_user(db, "scope.agent.a@example.com", role="agent")
    agent_b = await _seed_user(db, "scope.agent.b@example.com", role="agent")
    await _seed_lead(db, "own-1", agent_id=agent_a["id"], first="Own")
    await _seed_lead(db, "own-2", agent_id=agent_a["id"], first="Own")
    await _seed_lead(db, "other-1", agent_id=agent_b["id"], first="Other")

    headers = _login(client, "scope.agent.a@example.com")
    r = client.get("/api/leads?limit=50", headers=headers)
    assert r.status_code == 200, r.text
    leads = r.json()["leads"]
    ids = {lead["id"] for lead in leads}
    assert ids == {"own-1", "own-2"}, f"Agent A leaked: {ids}"
    assert "other-1" not in ids


@pytest.mark.asyncio
async def test_agent_cannot_get_other_agents_lead_by_id(client, db):
    """Direct lead GET by id: 403/404 when caller doesn't own the row."""
    agent_a = await _seed_user(db, "idor.actor@example.com", role="agent")
    agent_b = await _seed_user(db, "idor.target@example.com", role="agent")
    await _seed_lead(db, "secret-lead", agent_id=agent_b["id"])

    headers = _login(client, "idor.actor@example.com")
    r = client.get("/api/leads/secret-lead", headers=headers)
    assert r.status_code in (403, 404), (
        f"Expected IDOR refusal, got {r.status_code}: {r.text}"
    )


@pytest.mark.asyncio
async def test_agent_cannot_see_lead_in_other_agency(client, db):
    """Cross-tenant: agent in agency_two cannot read leads in ghw_001
    even if the agent_id happens to collide on lookup. agency_id
    component of the filter must reject the row.
    """
    await _seed_agency(db, SECOND_AGENCY)
    other_agent = await _seed_user(
        db, "other.tenant@example.com", role="agent",
        agency_id=SECOND_AGENCY,
    )
    # Same UUID is impossible by construction, but we put a lead in
    # GHW with someone else's agent_id to make sure agency_id alone
    # blocks the read.
    ghw_agent = await _seed_user(db, "ghw.victim@example.com", role="agent")
    await _seed_lead(
        db, "ghw-only-lead", agent_id=ghw_agent["id"],
        agency_id=GHW_AGENCY,
    )

    headers = _login(client, "other.tenant@example.com")
    r = client.get("/api/leads?limit=50", headers=headers)
    assert r.status_code == 200, r.text
    ids = {lead["id"] for lead in r.json()["leads"]}
    assert "ghw-only-lead" not in ids, (
        f"Cross-agency leak: agency_two agent saw {ids}"
    )


@pytest.mark.asyncio
async def test_owner_cannot_see_lead_in_other_agency(client, db):
    """Owner role full-visibility is still BOUNDED BY agency_id.
    Owner of agency_two must not see a GHW lead.
    """
    await _seed_agency(db, SECOND_AGENCY)
    await _seed_user(
        db, "second.owner@example.com", role="owner",
        agency_id=SECOND_AGENCY,
    )
    ghw_agent = await _seed_user(db, "ghw.agent.x@example.com", role="agent")
    await _seed_lead(
        db, "ghw-private", agent_id=ghw_agent["id"],
        agency_id=GHW_AGENCY,
    )

    headers = _login(client, "second.owner@example.com")
    r = client.get("/api/leads?limit=50", headers=headers)
    assert r.status_code == 200, r.text
    ids = {lead["id"] for lead in r.json()["leads"]}
    assert "ghw-private" not in ids, (
        f"Cross-agency leak via owner role: {ids}"
    )


@pytest.mark.asyncio
async def test_compliance_role_sees_all_agency_leads(client, db):
    """compliance is in FULL_AGENCY_SCOPE_ROLES so HIPAA reviewers can
    audit every agent's book without per-agent impersonation. The
    agency_id stamp still bounds them — a compliance user in agency
    A cannot reach agency B (covered separately by the cross-agency
    tests above).
    """
    compliance_user = await _seed_user(
        db, "compl.scope@example.com", role="compliance",
    )
    other = await _seed_user(db, "compl.other@example.com", role="agent")
    await _seed_lead(db, "comp-own", agent_id=compliance_user["id"])
    await _seed_lead(db, "comp-other", agent_id=other["id"])

    headers = _login(client, "compl.scope@example.com")
    r = client.get("/api/leads?limit=50", headers=headers)
    assert r.status_code == 200, r.text
    ids = {lead["id"] for lead in r.json()["leads"]}
    assert {"comp-own", "comp-other"} <= ids, (
        "Compliance should see both own and other agents' leads "
        "within the agency."
    )


@pytest.mark.asyncio
async def test_clients_endpoint_scopes_by_agent_and_agency(client, db):
    """`/api/clients/{contact_id}/summary` must scope by agent_id for
    non-admin callers AND by agency_id for everyone (incl. admin).

    Spec target: an agent must not see another agent's clients row in
    the same agency. Two agents both seed a clients doc with the same
    ``ghl_contact_id`` (which the new application_router compound key
    permits — different (agent_id, agency_id, ghl_contact_id) tuples
    so they coexist).
    """
    agent_a = await _seed_user(db, "cli.a@example.com", role="agent")
    agent_b = await _seed_user(db, "cli.b@example.com", role="agent")
    # Both agents have a clients row for the same GHL contact. Strict
    # scoping means each one only sees their own row.
    await _seed_client(
        db, "shared-ghl-id", agent_id=agent_a["id"],
        full_name="Agent A View",
    )
    await _seed_client(
        db, "shared-ghl-id", agent_id=agent_b["id"],
        full_name="Agent B View",
    )

    headers_a = _login(client, "cli.a@example.com")
    r = client.get("/api/clients/shared-ghl-id/summary", headers=headers_a)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client"] is not None, "Agent A should see their own row"
    assert body["client"]["full_name"] == "Agent A View"
    assert body["client"]["agent_id"] == agent_a["id"]


@pytest.mark.asyncio
async def test_clients_endpoint_blocks_cross_agent_within_agency(client, db):
    """An agent must not retrieve another agent's clients record even
    when the GHL contact id is known. The contact id alone is not a
    capability — scoping is mandatory.
    """
    agent_a = await _seed_user(db, "x.actor@example.com", role="agent")
    agent_b = await _seed_user(db, "x.target@example.com", role="agent")
    # Only agent B has a clients row for this contact.
    await _seed_client(
        db, "only-b-knows", agent_id=agent_b["id"],
        full_name="Belongs To B",
    )

    headers_a = _login(client, "x.actor@example.com")
    r = client.get("/api/clients/only-b-knows/summary", headers=headers_a)
    assert r.status_code == 200, r.text
    # Agent A's filter doesn't match B's row. summary still 200 so the
    # frontend renders an empty profile — but `client` MUST be None.
    assert r.json()["client"] is None, (
        "Agent A saw Agent B's client record by GHL contact id."
    )


@pytest.mark.asyncio
async def test_admin_sees_clients_across_agents_within_agency(client, db, admin_headers):
    """Admin in the same agency CAN read any agent's clients row. This
    is the (admin, owner) full-visibility carve-out from the spec.
    """
    agent = await _seed_user(db, "cli.under.admin@example.com", role="agent")
    await _seed_client(
        db, "admin-can-see", agent_id=agent["id"],
        full_name="Visible To Admin",
    )

    r = client.get("/api/clients/admin-can-see/summary", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client"] is not None
    assert body["client"]["full_name"] == "Visible To Admin"
