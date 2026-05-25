"""Tag system: library seeding, CRUD on custom tags, per-lead apply/remove,
?tags=… filter on /api/leads, IDOR + role gating.

Reuses the conftest's in-process TestClient + mongomock and the
``admin_headers`` fixture. The shared ``_make_agent_with_token``
helper from test_backend.py is duplicated locally so this file can run
independently and so test ordering between files doesn't cause one to
depend on internals of the other.
"""
import os
import pytest

from models import normalize_tag_name


# ── Helpers ─────────────────────────────────────────────────────────────────
def _make_agent_with_token(client, admin_headers, email, name,
                            password="Q9pl#aux!7zT"):
    """Invite + register + approve an agent. Returns (id, headers)."""
    inv = client.post("/api/auth/invite", headers=admin_headers, json={
        "email": email, "full_name": name,
        "agency_name": "GHW", "agent_name": name,
    }).json()
    reg = client.post("/api/auth/register", json={
        "email": email, "password": password,
        "full_name": name, "agency_name": "GHW",
        "invite_token": inv["token"],
    })
    assert reg.status_code == 201, reg.text
    uid = reg.json()["id"]
    client.post(f"/api/auth/users/{uid}/approve", headers=admin_headers)
    login = client.post("/api/auth/login", json={
        "email": email, "password": password,
    })
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return uid, headers


# ── Normalization ───────────────────────────────────────────────────────────
def test_normalize_examples():
    assert normalize_tag_name("Hot Lead") == "hot-lead"
    assert normalize_tag_name("  HOT  LEAD  ") == "hot-lead"
    assert normalize_tag_name("ANOC Review-Needed!") == "anoc-review-needed"
    assert normalize_tag_name("Turning 65") == "turning-65"
    assert normalize_tag_name("---") == ""
    assert normalize_tag_name("") == ""


# ── Library seed ────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_library_seeded_on_startup(client, db, admin_headers):
    """The startup hook seeds the Medicare tag library for the current
    agency. Hitting GET /api/tags after boot must surface them all."""
    r = client.get("/api/tags", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    names = {t["name"] for t in body["tags"]}
    # Spot-check a few across categories.
    for expected in (
        "hot-lead", "do-not-call", "mapd-interested",
        "turning-65", "soa-signed", "lost-to-competitor",
    ):
        assert expected in names, f"seed missing {expected}"

    # Every row carries the required display metadata.
    for t in body["tags"]:
        assert t["color"].startswith("#")
        assert t["category"] in {
            "status", "product", "compliance", "custom", "medicare",
        }


@pytest.mark.asyncio
async def test_seed_is_idempotent(client, db, admin_headers):
    """Calling the seeder again is a no-op when the library exists."""
    from tags_router import seed_tag_library
    before = await db.tags.count_documents({})
    inserted = await seed_tag_library(db)
    after = await db.tags.count_documents({})
    assert inserted == 0
    assert before == after


# ── Custom tag creation ─────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_create_custom_tag_admin_only(client, db, admin_headers):
    r = client.post("/api/tags", headers=admin_headers, json={
        "label": "VIP Client", "color": "#ff8800", "category": "custom",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "vip-client"
    assert body["label"] == "VIP Client"
    assert body["color"] == "#ff8800"


@pytest.mark.asyncio
async def test_create_tag_rejects_duplicate(client, db, admin_headers):
    """Duplicate normalized name → 409 (not silently merged)."""
    r1 = client.post("/api/tags", headers=admin_headers, json={
        "label": "Power User", "color": "#123456", "category": "custom",
    })
    assert r1.status_code == 201, r1.text
    r2 = client.post("/api/tags", headers=admin_headers, json={
        "label": "power user", "color": "#abcdef", "category": "custom",
    })
    assert r2.status_code == 409, r2.text


@pytest.mark.asyncio
async def test_create_tag_validates_color(client, db, admin_headers):
    r = client.post("/api/tags", headers=admin_headers, json={
        "label": "Bad Color", "color": "blue", "category": "custom",
    })
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_tag_agent_forbidden(client, db, admin_headers):
    _, a_headers = _make_agent_with_token(
        client, admin_headers, "tag.creator@example.com", "Tag C",
    )
    r = client.post("/api/tags", headers=a_headers, json={
        "label": "Agent Tag", "color": "#222222", "category": "custom",
    })
    assert r.status_code == 403


# ── Apply / remove on a lead ────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_add_remove_tag_on_lead(client, db, admin_headers):
    create = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Tag", "last_name": "Test", "phone": "555-1000",
    })
    assert create.status_code == 201, create.text
    lead_id = create.json()["id"]

    # Add.
    r = client.post(
        f"/api/leads/{lead_id}/tags",
        headers=admin_headers,
        json={"tag": "Hot Lead"},  # mixed case — server should normalize
    )
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == ["hot-lead"]

    # Re-applying is a no-op (idempotent).
    r2 = client.post(
        f"/api/leads/{lead_id}/tags",
        headers=admin_headers,
        json={"tag": "hot-lead"},
    )
    assert r2.status_code == 200
    assert r2.json()["tags"] == ["hot-lead"]

    # Remove via the DELETE endpoint.
    r3 = client.delete(
        f"/api/leads/{lead_id}/tags/hot-lead",
        headers=admin_headers,
    )
    assert r3.status_code == 200, r3.text
    assert r3.json()["tags"] == []


@pytest.mark.asyncio
async def test_add_tag_rejects_unknown_tag(client, db, admin_headers):
    """Tags not in the library can't be applied — prevents junk tag long tail."""
    create = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Junk", "last_name": "Tag", "phone": "555-1001",
    })
    lead_id = create.json()["id"]
    r = client.post(
        f"/api/leads/{lead_id}/tags",
        headers=admin_headers,
        json={"tag": "not-in-library"},
    )
    assert r.status_code == 422
    assert "library" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_add_tag_idor_agents_cant_touch_others_leads(
    client, db, admin_headers,
):
    a_id, _ = _make_agent_with_token(
        client, admin_headers, "tag.alice@example.com", "Alice T",
    )
    _, b_headers = _make_agent_with_token(
        client, admin_headers, "tag.bob@example.com", "Bob T",
        password="Q9pl#aux!7zS",
    )
    await db.leads.insert_one({
        "id": "tag-idor-1",
        "first_name": "Alice's", "last_name": "Lead",
        "agent_id": a_id, "agent_name": "Alice T",
        "status": "new", "tags": [],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    })

    r = client.post(
        "/api/leads/tag-idor-1/tags",
        headers=b_headers,
        json={"tag": "hot-lead"},
    )
    assert r.status_code == 403


# ── Filter ──────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_tags_filter_requires_all_tags(client, db, admin_headers):
    """?tags=a,b returns leads that have BOTH a AND b — not either."""
    # Lead 1: hot + turning-65
    a = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Both", "last_name": "Tags", "phone": "555-2001",
    }).json()
    client.post(f"/api/leads/{a['id']}/tags", headers=admin_headers,
                json={"tag": "hot-lead"})
    client.post(f"/api/leads/{a['id']}/tags", headers=admin_headers,
                json={"tag": "turning-65"})

    # Lead 2: hot only
    b = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Hot", "last_name": "Only", "phone": "555-2002",
    }).json()
    client.post(f"/api/leads/{b['id']}/tags", headers=admin_headers,
                json={"tag": "hot-lead"})

    # Lead 3: no tags at all
    client.post("/api/leads", headers=admin_headers, json={
        "first_name": "No", "last_name": "Tags", "phone": "555-2003",
    })

    # Filter AND on both → only lead 1.
    r = client.get(
        "/api/leads?tags=hot-lead,turning-65",
        headers=admin_headers,
    )
    assert r.status_code == 200
    ids = {ld["id"] for ld in r.json()["leads"]}
    assert ids == {a["id"]}

    # Filter on hot-lead alone → leads 1 + 2.
    r2 = client.get("/api/leads?tags=hot-lead", headers=admin_headers)
    ids2 = {ld["id"] for ld in r2.json()["leads"]}
    assert ids2 == {a["id"], b["id"]}


@pytest.mark.asyncio
async def test_tags_filter_normalizes_input(client, db, admin_headers):
    """?tags=Hot%20Lead works the same as ?tags=hot-lead."""
    a = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "Norm", "last_name": "Filter", "phone": "555-2010",
    }).json()
    client.post(f"/api/leads/{a['id']}/tags", headers=admin_headers,
                json={"tag": "hot-lead"})
    r = client.get("/api/leads?tags=Hot%20Lead", headers=admin_headers)
    assert r.status_code == 200
    ids = {ld["id"] for ld in r.json()["leads"]}
    assert a["id"] in ids


# ── Usage summary ───────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_tag_usage_summary(client, db, admin_headers):
    a = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "S", "last_name": "One", "phone": "555-3001",
    }).json()
    b = client.post("/api/leads", headers=admin_headers, json={
        "first_name": "S", "last_name": "Two", "phone": "555-3002",
    }).json()
    for lid in (a["id"], b["id"]):
        client.post(f"/api/leads/{lid}/tags", headers=admin_headers,
                    json={"tag": "hot-lead"})
    client.post(f"/api/leads/{a['id']}/tags", headers=admin_headers,
                json={"tag": "turning-65"})

    r = client.get("/api/leads/tags/summary", headers=admin_headers)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    by_name = {it["name"]: it["count"] for it in items}
    assert by_name["hot-lead"] == 2
    assert by_name["turning-65"] == 1
    # Tags nobody is wearing still surface in the roll-up with count=0.
    assert by_name["do-not-call"] == 0


@pytest.mark.asyncio
async def test_tag_usage_summary_agent_forbidden(client, db, admin_headers):
    _, a_headers = _make_agent_with_token(
        client, admin_headers, "tag.peek@example.com", "Tag P",
    )
    r = client.get("/api/leads/tags/summary", headers=a_headers)
    assert r.status_code == 403
