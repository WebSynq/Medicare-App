"""Feature C — sub-phase C2: calendar CRUD API.

Covers the full surface of /api/calendars:
  - GET list (role-scoped)
  - POST create (admin only, slug-collision 409)
  - GET single (IDOR, admin-only distribution internals)
  - PATCH (admin allow-list vs agent allow-list)
  - DELETE (soft, blocked by upcoming appointments)

Multi-tenant isolation rides on the existing ``get_agency`` dep so
the tests here also cover cross-agency invisibility.
"""
import uuid
from datetime import datetime, timezone

import pytest

from security import hash_password


GHW_AGENCY = "ghw_001"
SECOND_AGENCY = "agency_two"
DEFAULT_PWD = "Q9pl#aux!7zT-seed"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Helpers ────────────────────────────────────────────────────────────────


async def _seed_user(
    db, email: str, role: str = "agent",
    agency_id: str = GHW_AGENCY,
) -> dict:
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "agent_id": uid,
        "email": email,
        "full_name": email.split("@")[0].title(),
        "agent_name": email.split("@")[0].title(),
        "role": role,
        "agency_id": agency_id,
        "is_active": True,
        "status": "active",
        "hashed_password": hash_password(DEFAULT_PWD),
        "token_version": 0,
        "failed_attempts": 0,
        "created_at": _now_iso(),
    }
    await db.users.insert_one(doc)
    return doc


async def _seed_agency(db, agency_id: str) -> None:
    if await db.agencies.find_one({"agency_id": agency_id}):
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
    r = client.post("/api/auth/login", json={
        "email": email, "password": DEFAULT_PWD,
    })
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _ind_payload(slug: str, owner_id: str, **over) -> dict:
    base = {
        "name": f"Calendar {slug}",
        "type": "individual",
        "slug": slug,
        "owner_id": owner_id,
        "source_label": "manual",
    }
    base.update(over)
    return base


def _rr_payload(slug: str, member_ids: list, **over) -> dict:
    base = {
        "name": f"RR {slug}",
        "type": "round_robin",
        "slug": slug,
        "member_ids": member_ids,
        "source_label": "autobook",
    }
    base.update(over)
    return base


# ── List ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_agent_lists_only_own_calendars(client, db, admin_headers):
    """Agent sees calendars they own (Individual) OR are a member of
    (Round Robin / Group). Other Individual calendars hide.
    """
    agent = await _seed_user(db, "cal.list.agent@example.com")
    other = await _seed_user(db, "cal.list.other@example.com")

    # 1) Agent's own Individual — visible.
    client.post("/api/calendars", headers=admin_headers, json=_ind_payload(
        "agent-own-c2", agent["id"], name="Agent Own",
    ))
    # 2) Another agent's Individual — hidden.
    client.post("/api/calendars", headers=admin_headers, json=_ind_payload(
        "other-own-c2", other["id"], name="Other Own",
    ))
    # 3) RR where agent is a member — visible.
    client.post("/api/calendars", headers=admin_headers, json=_rr_payload(
        "rr-with-agent-c2", [agent["id"], other["id"]], name="RR With Agent",
    ))
    # 4) RR without agent — hidden.
    client.post("/api/calendars", headers=admin_headers, json=_rr_payload(
        "rr-without-agent-c2", [other["id"]], name="RR Without Agent",
    ))

    headers = _login(client, "cal.list.agent@example.com")
    r = client.get("/api/calendars", headers=headers)
    assert r.status_code == 200, r.text
    names = sorted(c["name"] for c in r.json()["calendars"])
    assert names == ["Agent Own", "RR With Agent"]


@pytest.mark.asyncio
async def test_admin_lists_all_agency_calendars(client, db, admin_headers):
    """Admin sees every calendar inside their agency."""
    a = await _seed_user(db, "admin.list.a@example.com")
    b = await _seed_user(db, "admin.list.b@example.com")
    for slug, owner in (("admin-listed-a", a["id"]), ("admin-listed-b", b["id"])):
        client.post("/api/calendars", headers=admin_headers,
                    json=_ind_payload(slug, owner))

    r = client.get("/api/calendars", headers=admin_headers)
    assert r.status_code == 200, r.text
    slugs = {c["slug"] for c in r.json()["calendars"]}
    assert {"admin-listed-a", "admin-listed-b"} <= slugs


@pytest.mark.asyncio
async def test_list_does_not_leak_cross_tenant(client, db):
    """A user in agency_two whose agency has a calendar must not see
    agency_one's calendars in the response.
    """
    await _seed_agency(db, SECOND_AGENCY)
    other_admin = await _seed_user(
        db, "tenant2.admin@example.com", role="admin",
        agency_id=SECOND_AGENCY,
    )
    # Drop a calendar directly into agency_one via Mongo (we can't
    # POST as the cross-tenant admin without it landing in their
    # agency).
    await db.calendars.insert_one({
        "id": "ghw-private-cal",
        "agency_id": GHW_AGENCY,
        "name": "GHW Private",
        "type": "individual",
        "slug": "ghw-private-cal",
        "color": "#6366f1",
        "source_label": "manual",
        "owner_id": "ghw-owner",
        "member_ids": [],
        "distribution": None,
        "booking_settings": {},
        "is_active": True,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    })

    headers = _login(client, "tenant2.admin@example.com")
    r = client.get("/api/calendars", headers=headers)
    assert r.status_code == 200, r.text
    slugs = {c["slug"] for c in r.json()["calendars"]}
    assert "ghw-private-cal" not in slugs


@pytest.mark.asyncio
async def test_list_filter_by_type(client, db, admin_headers):
    """?type=individual returns only individual; ?type=round_robin only RR."""
    a = await _seed_user(db, "type.filter.a@example.com")
    client.post("/api/calendars", headers=admin_headers,
                json=_ind_payload("ind-only", a["id"]))
    client.post("/api/calendars", headers=admin_headers,
                json=_rr_payload("rr-only", [a["id"]]))

    r1 = client.get("/api/calendars?type=individual", headers=admin_headers)
    assert {c["slug"] for c in r1.json()["calendars"]} >= {"ind-only"}
    assert "rr-only" not in {c["slug"] for c in r1.json()["calendars"]}
    r2 = client.get("/api/calendars?type=round_robin", headers=admin_headers)
    assert {c["slug"] for c in r2.json()["calendars"]} >= {"rr-only"}
    assert "ind-only" not in {c["slug"] for c in r2.json()["calendars"]}


# ── Create ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_post_creates_with_audit(client, db, admin_headers):
    """POST stamps a calendar and audits ``calendar_created``."""
    agent = await _seed_user(db, "create.target@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("new-create-c2", agent["id"], name="Brand New"),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["slug"] == "new-create-c2"
    assert body["type"] == "individual"
    assert body["owner_id"] == agent["id"]
    assert body["agency_id"] == GHW_AGENCY
    # Audit row exists.
    rows = await db.audit_logs.find(
        {"event_type": "calendar_created", "target_id": body["id"]},
        {"_id": 0},
    ).to_list(length=5)
    assert len(rows) == 1
    assert rows[0]["metadata"]["slug"] == "new-create-c2"


@pytest.mark.asyncio
async def test_post_slug_collision_409(client, db, admin_headers):
    """The slug unique index translates DuplicateKey → 409."""
    agent = await _seed_user(db, "collide.a@example.com")
    agent2 = await _seed_user(db, "collide.b@example.com")
    r1 = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("dup-create-slug", agent["id"]),
    )
    assert r1.status_code == 201, r1.text
    r2 = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("dup-create-slug", agent2["id"]),
    )
    assert r2.status_code == 409, r2.text
    assert "already taken" in r2.json()["detail"].lower()


@pytest.mark.asyncio
async def test_post_individual_requires_owner_id(client, db, admin_headers):
    """Schema rule — individual without owner_id is 422."""
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json={
            "name": "Missing Owner",
            "type": "individual",
            "slug": "no-owner-slug",
            "source_label": "manual",
        },
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_post_rr_requires_members(client, db, admin_headers):
    """Schema rule — round_robin without members is 422."""
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json={
            "name": "Empty RR",
            "type": "round_robin",
            "slug": "empty-rr",
            "source_label": "autobook",
            "member_ids": [],
        },
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_agent_cannot_create_calendar(client, db, admin_headers):
    """Non-admin POST → 403."""
    agent = await _seed_user(db, "create.attempt@example.com")
    headers = _login(client, "create.attempt@example.com")
    r = client.post(
        "/api/calendars", headers=headers,
        json=_ind_payload("agent-create-c2", agent["id"]),
    )
    assert r.status_code == 403


# ── Get single ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_single_agent_sees_own(client, db, admin_headers):
    """Agent reads their own Individual calendar — distribution
    internals stripped (Individual has none anyway, so this is a
    no-op shape check).
    """
    agent = await _seed_user(db, "get.own.agent@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("get-agent-own-c2", agent["id"]),
    )
    cid = r.json()["id"]
    headers = _login(client, "get.own.agent@example.com")
    r2 = client.get(f"/api/calendars/{cid}", headers=headers)
    assert r2.status_code == 200, r2.text
    assert r2.json()["owner_id"] == agent["id"]


@pytest.mark.asyncio
async def test_get_single_agent_403_on_other(client, db, admin_headers):
    """Reading another agent's Individual calendar → 403."""
    a = await _seed_user(db, "get.actor@example.com")
    b = await _seed_user(db, "get.target@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("get-target-c2", b["id"]),
    )
    cid = r.json()["id"]
    headers = _login(client, "get.actor@example.com")
    r2 = client.get(f"/api/calendars/{cid}", headers=headers)
    assert r2.status_code == 403, r2.text


@pytest.mark.asyncio
async def test_admin_sees_distribution_internals(client, db, admin_headers):
    """Admin GET on a round-robin sees the assignment_counts +
    last_assigned_at internals. Agent member sees only weights.
    """
    a = await _seed_user(db, "internals.a@example.com")
    b = await _seed_user(db, "internals.b@example.com")
    rr = client.post(
        "/api/calendars", headers=admin_headers,
        json=_rr_payload("rr-internals", [a["id"], b["id"]]),
    )
    cid = rr.json()["id"]
    # Stamp some bogus ledger numbers so the strip is verifiable.
    await db.calendars.update_one(
        {"id": cid},
        {"$set": {
            "distribution.assignment_counts": {a["id"]: 3, b["id"]: 2},
            "distribution.last_assigned_at": {a["id"]: "2026-05-29T10:00:00Z"},
        }},
    )

    # Admin response — full internals.
    r_admin = client.get(f"/api/calendars/{cid}", headers=admin_headers)
    assert r_admin.status_code == 200, r_admin.text
    admin_dist = r_admin.json()["distribution"]
    assert "assignment_counts" in admin_dist
    assert "last_assigned_at" in admin_dist

    # Member (agent) response — stripped.
    headers_a = _login(client, "internals.a@example.com")
    r_agent = client.get(f"/api/calendars/{cid}", headers=headers_a)
    assert r_agent.status_code == 200, r_agent.text
    dist = r_agent.json()["distribution"]
    assert "weights" in dist
    assert "assignment_counts" not in dist
    assert "last_assigned_at" not in dist


# ── Patch ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_agent_patches_own_calendar(client, db, admin_headers):
    """Agent patches their own Individual calendar's name +
    booking_settings successfully.
    """
    agent = await _seed_user(db, "patch.own@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("patch-own-c2", agent["id"]),
    )
    cid = r.json()["id"]
    headers = _login(client, "patch.own@example.com")
    r2 = client.patch(
        f"/api/calendars/{cid}",
        headers=headers,
        json={
            "name": "My Renamed Calendar",
            "booking_settings": {
                "duration_minutes": 45,
                "buffer_minutes": 10,
                "advance_notice_hours": 12,
                "max_bookings_per_day": 5,
                "working_hours": {},
                "meeting_types": ["phone"],
                "timezone": "America/Chicago",
            },
        },
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["name"] == "My Renamed Calendar"
    assert body["booking_settings"]["duration_minutes"] == 45


@pytest.mark.asyncio
async def test_agent_patch_other_calendar_403(client, db, admin_headers):
    """Agent patching another agent's Individual calendar → 403."""
    a = await _seed_user(db, "patch.actor@example.com")
    b = await _seed_user(db, "patch.target@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("patch-target-c2", b["id"]),
    )
    cid = r.json()["id"]
    headers = _login(client, "patch.actor@example.com")
    r2 = client.patch(
        f"/api/calendars/{cid}", headers=headers, json={"name": "Hack"},
    )
    assert r2.status_code == 403, r2.text


@pytest.mark.asyncio
async def test_agent_cannot_change_type_or_slug(client, db, admin_headers):
    """Agent attempting type / slug / source_label change must have
    those fields silently dropped — name + booking_settings still
    apply, the restricted fields don't.
    """
    agent = await _seed_user(db, "lockdown@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("lockdown-c2", agent["id"]),
    )
    cid = r.json()["id"]
    headers = _login(client, "lockdown@example.com")
    r2 = client.patch(
        f"/api/calendars/{cid}", headers=headers,
        json={
            "name": "Locked Down",
            "slug": "totally-new-slug",
            "type": "round_robin",
            "source_label": "ae",
            "color": "#000000",
        },
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["name"] == "Locked Down"
    assert body["slug"] == "lockdown-c2"
    assert body["type"] == "individual"
    assert body["source_label"] == "manual"
    # color was attempted but agent isn't allowed → kept default.
    assert body["color"] == "#6366f1"


@pytest.mark.asyncio
async def test_admin_patches_any_calendar(client, db, admin_headers):
    """Admin can change everything except id/agency_id/created_at."""
    agent = await _seed_user(db, "admin.patch.target@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("admin-patch-c2", agent["id"]),
    )
    cid = r.json()["id"]
    r2 = client.patch(
        f"/api/calendars/{cid}", headers=admin_headers,
        json={
            "name": "Admin Renamed",
            "color": "#ff0000",
            "source_label": "ae",
        },
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["name"] == "Admin Renamed"
    assert body["color"] == "#ff0000"
    assert body["source_label"] == "ae"


# ── Delete ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_soft_deletes(client, db, admin_headers):
    """DELETE flips is_active=False on the row."""
    agent = await _seed_user(db, "delete.target@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("delete-c2", agent["id"]),
    )
    cid = r.json()["id"]
    r2 = client.delete(f"/api/calendars/{cid}", headers=admin_headers)
    assert r2.status_code == 200, r2.text
    assert r2.json()["is_active"] is False

    rows = await db.audit_logs.find(
        {"event_type": "calendar_deactivated", "target_id": cid},
        {"_id": 0},
    ).to_list(length=5)
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_delete_409_when_upcoming_appointments(
    client, db, admin_headers,
):
    """A calendar with upcoming non-cancelled appointments cannot be
    deactivated. The error surface includes the blocking count.
    """
    agent = await _seed_user(db, "delete.blocked@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("delete-blocked-c2", agent["id"]),
    )
    cid = r.json()["id"]
    future_iso = "2030-01-01"
    await db.appointments.insert_one({
        "appointment_id": "blocker-1",
        "agent_id": agent["id"],
        "agency_id": GHW_AGENCY,
        "calendar_id": cid,
        "appointment_date": future_iso,
        "appointment_time": "10:00",
        "status": "scheduled",
        "client_name": "Future Client",
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    })
    r2 = client.delete(f"/api/calendars/{cid}", headers=admin_headers)
    assert r2.status_code == 409, r2.text
    detail = r2.json()["detail"]
    assert detail["blocking_appointments"] == 1


@pytest.mark.asyncio
async def test_delete_403_for_agent(client, db, admin_headers):
    """Agent calling DELETE → 403, even on their own calendar."""
    agent = await _seed_user(db, "delete.attempt@example.com")
    r = client.post(
        "/api/calendars", headers=admin_headers,
        json=_ind_payload("agent-delete-c2", agent["id"]),
    )
    cid = r.json()["id"]
    headers = _login(client, "delete.attempt@example.com")
    r2 = client.delete(f"/api/calendars/{cid}", headers=headers)
    assert r2.status_code == 403
