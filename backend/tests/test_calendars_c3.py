"""Feature C — sub-phase C3: round-robin distribution engine + weight
management API + booking-router integration.

Covers:
  - deficit-weighted member selection
  - working-hours availability filter
  - atomicity (sequential picks → different members)
  - GET /calendars/{id}/distribution
  - PATCH /calendars/{id}/distribution (weight validation)
  - POST /calendars/{id}/distribution/reset
  - POST /book/{rr_slug} runs the engine and stamps the picked agent
  - Individual calendars unchanged (no distribution path runs)
  - Multi-tenant isolation
"""
import asyncio
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from security import hash_password


GHW_AGENCY = "ghw_001"
SECOND_AGENCY = "agency_two"
DEFAULT_PWD = "Q9pl#aux!7zT-seed"

# Always-on weekly working hours so test members are available every
# weekday/weekend slot. Keeps the engine's working_hours filter from
# rejecting test members at unpredictable wall-clock times.
_ALL_DAY_HOURS = {
    "monday":    {"enabled": True, "start": "00:00", "end": "23:59"},
    "tuesday":   {"enabled": True, "start": "00:00", "end": "23:59"},
    "wednesday": {"enabled": True, "start": "00:00", "end": "23:59"},
    "thursday":  {"enabled": True, "start": "00:00", "end": "23:59"},
    "friday":    {"enabled": True, "start": "00:00", "end": "23:59"},
    "saturday":  {"enabled": True, "start": "00:00", "end": "23:59"},
    "sunday":    {"enabled": True, "start": "00:00", "end": "23:59"},
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _seed_user(
    db, email: str, role: str = "agent",
    agency_id: str = GHW_AGENCY,
    working_hours: dict | None = None,
    is_active: bool = True,
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
        "is_active": is_active,
        "status": "active" if is_active else "inactive",
        "hashed_password": hash_password(DEFAULT_PWD),
        "token_version": 0,
        "failed_attempts": 0,
        "booking_settings": {
            "is_enabled": True,
            "working_hours": working_hours or dict(_ALL_DAY_HOURS),
        },
        "created_at": _now_iso(),
    }
    await db.users.insert_one(doc)
    return doc


async def _seed_agency(db, agency_id: str) -> None:
    if await db.agencies.find_one({"agency_id": agency_id}):
        return
    await db.agencies.insert_one({
        "agency_id": agency_id,
        "name": agency_id, "slug": agency_id,
        "tier": "domination", "billing_status": "active",
        "super_admin": False, "features": {},
        "seats_max": -1, "seats_active": 0,
        "created_at": _now_iso(),
    })


def _login(client, email: str) -> dict:
    r = client.post("/api/auth/login", json={
        "email": email, "password": DEFAULT_PWD,
    })
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _seed_rr_calendar(
    db, *, slug: str, member_ids: list[str],
    agency_id: str = GHW_AGENCY,
    weights: dict | None = None,
    source_label: str = "autobook",
) -> dict:
    cal = {
        "id": str(uuid.uuid4()),
        "agency_id": agency_id,
        "name": f"RR {slug}",
        "type": "round_robin",
        "slug": slug,
        "color": "#10b981",
        "source_label": source_label,
        "owner_id": None,
        "member_ids": member_ids,
        "distribution": {
            "weights": weights or {uid: 1 for uid in member_ids},
            "assignment_counts": {uid: 0 for uid in member_ids},
            "last_assigned_at": {},
        },
        "booking_settings": {
            "duration_minutes": 30,
            "buffer_minutes": 0,
            "advance_notice_hours": 0,
            "max_bookings_per_day": 100,
            "working_hours": dict(_ALL_DAY_HOURS),
            "meeting_types": ["phone", "video"],
            "timezone": "America/Chicago",
        },
        "is_active": True,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    await db.calendars.insert_one(cal)
    return cal


# ── Algorithm — equal weights ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_equal_weights_distribute_evenly(db, client):
    """Three members, equal weights, nine sequential picks → each
    picked exactly three times."""
    from calendars_router import pick_and_record_round_robin

    members = []
    for i in range(3):
        u = await _seed_user(db, f"eq.{i}@example.com")
        members.append(u["id"])
    cal = await _seed_rr_calendar(db, slug="eq-weights", member_ids=members)

    counts = {uid: 0 for uid in members}
    for _ in range(9):
        fresh = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
        chosen, _ = await pick_and_record_round_robin(db, fresh)
        assert chosen is not None
        counts[chosen["id"]] += 1

    assert counts == {uid: 3 for uid in members}, counts


@pytest.mark.asyncio
async def test_unequal_weights_track_target_share(db, client):
    """Weights (1, 2, 3), six picks → A=1, B=2, C=3 exactly. The
    deficit pick converges on the target share when total picks
    equal the total weight.
    """
    from calendars_router import pick_and_record_round_robin

    a = await _seed_user(db, "weight.a@example.com")
    b = await _seed_user(db, "weight.b@example.com")
    c = await _seed_user(db, "weight.c@example.com")
    cal = await _seed_rr_calendar(
        db, slug="unequal-weights",
        member_ids=[a["id"], b["id"], c["id"]],
        weights={a["id"]: 1, b["id"]: 2, c["id"]: 3},
    )

    picks = []
    for _ in range(6):
        fresh = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
        chosen, _ = await pick_and_record_round_robin(db, fresh)
        picks.append(chosen["id"])

    from collections import Counter
    counts = Counter(picks)
    assert counts[a["id"]] == 1, counts
    assert counts[b["id"]] == 2, counts
    assert counts[c["id"]] == 3, counts


# ── Algorithm — availability filter ──────────────────────────────────────


@pytest.mark.asyncio
async def test_member_outside_working_hours_excluded(db, client):
    """Member B has Monday DISABLED in their working_hours. A pick
    against a Monday slot must skip B and pick A (the only available
    member when there are only two)."""
    from calendars_router import pick_and_record_round_robin

    a_hours = dict(_ALL_DAY_HOURS)
    b_hours = {**dict(_ALL_DAY_HOURS),
               "monday": {"enabled": False, "start": "09:00", "end": "17:00"}}
    a = await _seed_user(db, "wh.a@example.com", working_hours=a_hours)
    b = await _seed_user(db, "wh.b@example.com", working_hours=b_hours)
    cal = await _seed_rr_calendar(db, slug="wh-filter",
                                   member_ids=[a["id"], b["id"]])

    # Construct a Monday slot at 10:00 UTC explicitly.
    today = datetime.now(timezone.utc)
    days_ahead = (0 - today.weekday()) % 7 or 7   # next Monday
    next_mon = today + timedelta(days=days_ahead)
    slot_dt = next_mon.replace(hour=10, minute=0, second=0, microsecond=0)

    chosen, _ = await pick_and_record_round_robin(db, cal, slot_dt)
    assert chosen is not None
    assert chosen["id"] == a["id"]


@pytest.mark.asyncio
async def test_all_unavailable_returns_none(db, client):
    """Every member has Monday disabled → picker returns None."""
    from calendars_router import pick_and_record_round_robin

    hours = {**dict(_ALL_DAY_HOURS),
             "monday": {"enabled": False, "start": "09:00", "end": "17:00"}}
    a = await _seed_user(db, "noavail.a@example.com", working_hours=hours)
    b = await _seed_user(db, "noavail.b@example.com", working_hours=hours)
    cal = await _seed_rr_calendar(
        db, slug="all-unavailable", member_ids=[a["id"], b["id"]],
    )

    today = datetime.now(timezone.utc)
    days_ahead = (0 - today.weekday()) % 7 or 7
    next_mon = today + timedelta(days=days_ahead)
    slot_dt = next_mon.replace(hour=10, minute=0, second=0, microsecond=0)

    chosen, _ = await pick_and_record_round_robin(db, cal, slot_dt)
    assert chosen is None


# ── Algorithm — deficit + tie-break ──────────────────────────────────────


@pytest.mark.asyncio
async def test_deficit_favors_member_below_target(db, client):
    """Equal weights. A has count=5, B has count=0 → B has the
    larger deficit and gets picked next.
    """
    from calendars_router import pick_and_record_round_robin

    a = await _seed_user(db, "deficit.a@example.com")
    b = await _seed_user(db, "deficit.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="deficit", member_ids=[a["id"], b["id"]],
    )
    await db.calendars.update_one(
        {"id": cal["id"]},
        {"$set": {"distribution.assignment_counts": {a["id"]: 5, b["id"]: 0}}},
    )
    fresh = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
    chosen, _ = await pick_and_record_round_robin(db, fresh)
    assert chosen["id"] == b["id"]


@pytest.mark.asyncio
async def test_tie_break_oldest_last_assigned_wins(db, client):
    """Equal counts + equal weights → equal deficits. The member with
    the older last_assigned_at wins."""
    from calendars_router import pick_and_record_round_robin

    a = await _seed_user(db, "tie.a@example.com")
    b = await _seed_user(db, "tie.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="tie-break", member_ids=[a["id"], b["id"]],
    )
    await db.calendars.update_one(
        {"id": cal["id"]},
        {"$set": {
            "distribution.assignment_counts": {a["id"]: 1, b["id"]: 1},
            "distribution.last_assigned_at": {
                a["id"]: "2026-05-29T00:00:00+00:00",
                b["id"]: "2026-05-28T00:00:00+00:00",  # older — wins
            },
        }},
    )
    fresh = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
    chosen, _ = await pick_and_record_round_robin(db, fresh)
    assert chosen["id"] == b["id"]


# ── Atomicity — sequential picks differ when even ────────────────────────


@pytest.mark.asyncio
async def test_sequential_picks_alternate_with_equal_weights(db, client):
    """Two sequential calls with two equal-weight available members
    must produce different agents — the ledger update from call 1
    makes call 2's deficit math prefer the other member.
    """
    from calendars_router import pick_and_record_round_robin

    a = await _seed_user(db, "atomic.a@example.com")
    b = await _seed_user(db, "atomic.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="atomic", member_ids=[a["id"], b["id"]],
    )

    fresh1 = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
    chosen1, _ = await pick_and_record_round_robin(db, fresh1)
    fresh2 = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
    chosen2, _ = await pick_and_record_round_robin(db, fresh2)

    assert chosen1["id"] != chosen2["id"], (
        f"Both calls picked {chosen1['id']!r} — atomicity broke."
    )


# ── GET /distribution ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_distribution_shape(client, db, admin_headers):
    """Endpoint returns per-member breakdown with deficit + is_available_now."""
    a = await _seed_user(db, "dist.get.a@example.com")
    b = await _seed_user(db, "dist.get.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="dist-shape", member_ids=[a["id"], b["id"]],
    )

    r = client.get(
        f"/api/calendars/{cal['id']}/distribution", headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["calendar_id"] == cal["id"]
    assert body["type"] == "round_robin"
    assert len(body["members"]) == 2
    for m in body["members"]:
        for k in (
            "user_id", "full_name", "weight", "assignment_count",
            "last_assigned_at", "deficit", "is_available_now",
        ):
            assert k in m


@pytest.mark.asyncio
async def test_get_distribution_404_for_individual(client, db, admin_headers):
    """Distribution is round_robin-only; individual calendars 404."""
    agent = await _seed_user(db, "dist.individual@example.com")
    r = client.post("/api/calendars", headers=admin_headers, json={
        "name": "Individual not RR",
        "type": "individual",
        "slug": "ind-dist",
        "source_label": "manual",
        "owner_id": agent["id"],
    })
    cid = r.json()["id"]
    r2 = client.get(
        f"/api/calendars/{cid}/distribution", headers=admin_headers,
    )
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_get_distribution_403_for_agent(client, db):
    """Non-admin GET → 403."""
    a = await _seed_user(db, "dist.403@example.com")
    b = await _seed_user(db, "dist.403.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="dist-403", member_ids=[a["id"], b["id"]],
    )
    headers = _login(client, "dist.403@example.com")
    r = client.get(
        f"/api/calendars/{cal['id']}/distribution", headers=headers,
    )
    assert r.status_code == 403


# ── PATCH /distribution ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_distribution_partial(client, db, admin_headers):
    """Supplying weight only for member A leaves B's weight untouched."""
    a = await _seed_user(db, "patch.dist.a@example.com")
    b = await _seed_user(db, "patch.dist.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="patch-partial", member_ids=[a["id"], b["id"]],
        weights={a["id"]: 1, b["id"]: 4},
    )
    r = client.patch(
        f"/api/calendars/{cal['id']}/distribution",
        headers=admin_headers,
        json={"weights": {a["id"]: 3}},
    )
    assert r.status_code == 200, r.text
    fresh = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
    weights = fresh["distribution"]["weights"]
    assert weights[a["id"]] == 3
    assert weights[b["id"]] == 4, weights


@pytest.mark.asyncio
async def test_patch_distribution_rejects_out_of_range(client, db, admin_headers):
    """Weights must be 1-5; 0 / 6 / negative all reject 422."""
    a = await _seed_user(db, "patch.range.a@example.com")
    b = await _seed_user(db, "patch.range.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="patch-range", member_ids=[a["id"], b["id"]],
    )
    for bad in (0, 6, -1):
        r = client.patch(
            f"/api/calendars/{cal['id']}/distribution",
            headers=admin_headers,
            json={"weights": {a["id"]: bad}},
        )
        assert r.status_code == 422, (bad, r.status_code, r.text)


@pytest.mark.asyncio
async def test_patch_distribution_rejects_non_member(client, db, admin_headers):
    """user_id not in calendar.member_ids → 400."""
    a = await _seed_user(db, "patch.nonmember.a@example.com")
    cal = await _seed_rr_calendar(
        db, slug="patch-nonmember", member_ids=[a["id"]],
    )
    r = client.patch(
        f"/api/calendars/{cal['id']}/distribution",
        headers=admin_headers,
        json={"weights": {"stranger": 3}},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_patch_distribution_403_for_agent(client, db):
    """Non-admin PATCH → 403."""
    a = await _seed_user(db, "patch.403@example.com")
    b = await _seed_user(db, "patch.403.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="patch-403", member_ids=[a["id"], b["id"]],
    )
    headers = _login(client, "patch.403@example.com")
    r = client.patch(
        f"/api/calendars/{cal['id']}/distribution",
        headers=headers,
        json={"weights": {a["id"]: 2}},
    )
    assert r.status_code == 403


# ── POST /distribution/reset ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reset_zeros_counts_preserves_weights(client, db, admin_headers):
    """Reset zeros assignment_counts + clears last_assigned_at; weights
    untouched."""
    a = await _seed_user(db, "reset.a@example.com")
    b = await _seed_user(db, "reset.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="reset-shape", member_ids=[a["id"], b["id"]],
        weights={a["id"]: 2, b["id"]: 5},
    )
    await db.calendars.update_one(
        {"id": cal["id"]},
        {"$set": {
            "distribution.assignment_counts": {a["id"]: 7, b["id"]: 12},
            "distribution.last_assigned_at": {a["id"]: "2026-05-29T00:00:00+00:00"},
        }},
    )
    r = client.post(
        f"/api/calendars/{cal['id']}/distribution/reset",
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    fresh = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
    assert fresh["distribution"]["assignment_counts"] == {a["id"]: 0, b["id"]: 0}
    assert fresh["distribution"]["last_assigned_at"] == {}
    assert fresh["distribution"]["weights"] == {a["id"]: 2, b["id"]: 5}


@pytest.mark.asyncio
async def test_reset_403_for_agent(client, db):
    """Non-admin reset → 403."""
    a = await _seed_user(db, "reset.403@example.com")
    b = await _seed_user(db, "reset.403.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="reset-403", member_ids=[a["id"], b["id"]],
    )
    headers = _login(client, "reset.403@example.com")
    r = client.post(
        f"/api/calendars/{cal['id']}/distribution/reset",
        headers=headers,
    )
    assert r.status_code == 403


# ── Booking router — round-robin ─────────────────────────────────────────


def _future_weekday(days_offset_from_today: int = 14) -> str:
    """Return ISO date for a weekday (Mon-Fri) at least N days out."""
    target = date.today() + timedelta(days=days_offset_from_today)
    while target.weekday() >= 5:  # 5=Sat, 6=Sun
        target += timedelta(days=1)
    return target.isoformat()


@pytest.mark.asyncio
async def test_book_rr_slug_selects_and_stamps(client, db, monkeypatch):
    """POST /book/{rr_slug} runs the engine and stamps calendar_id +
    booking_type + the selected member's identity on the appointment.
    """
    import resend_client
    async def _fake_send(*a, **k): return True
    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    a = await _seed_user(db, "rr.book.a@example.com")
    b = await _seed_user(db, "rr.book.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="rr-book-c3", member_ids=[a["id"], b["id"]],
        source_label="autobook",
    )

    tok = client.get(f"/api/book/{cal['slug']}/token").json()["token"]
    book_date = _future_weekday()
    slots = client.get(
        f"/api/book/{cal['slug']}/slots?date={book_date}"
    ).json().get("slots") or []
    if not slots:
        pytest.skip("no candidate slots for the chosen day")

    r = client.post(
        f"/api/book/{cal['slug']}",
        json={
            "client_name": "Round Robin Client",
            "client_phone": "555-0000",
            "client_email": "rr@example.com",
            "date": book_date,
            "time": slots[0],
            "meeting_type": "phone",
            "booking_reason": "Plan Review",
            "notes": "",
            "token": tok,
            "website": "",
        },
    )
    assert r.status_code == 201, r.text

    appt = await db.appointments.find_one(
        {"calendar_id": cal["id"]}, {"_id": 0},
    )
    assert appt is not None
    assert appt["calendar_id"] == cal["id"]
    assert appt["booking_type"] == "autobook"
    assert appt["agent_id"] in (a["id"], b["id"])


@pytest.mark.asyncio
async def test_book_rr_increments_assignment_count(client, db, monkeypatch):
    """Two sequential bookings on the same RR calendar bump two
    different members' assignment_count to 1 each (equal weights)."""
    import resend_client
    async def _fake_send(*a, **k): return True
    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    a = await _seed_user(db, "rr.inc.a@example.com")
    b = await _seed_user(db, "rr.inc.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="rr-increments", member_ids=[a["id"], b["id"]],
    )

    tok = client.get(f"/api/book/{cal['slug']}/token").json()["token"]
    book_date = _future_weekday()
    slots = client.get(
        f"/api/book/{cal['slug']}/slots?date={book_date}"
    ).json().get("slots") or []
    if len(slots) < 2:
        pytest.skip("need two slots on the chosen day")

    for idx, slot_time in enumerate(slots[:2]):
        r = client.post(
            f"/api/book/{cal['slug']}",
            json={
                "client_name": "RR Test",
                "client_phone": "555-1111",
                "client_email": f"rr-{idx}@example.com",
                "date": book_date,
                "time": slot_time,
                "meeting_type": "phone",
                "booking_reason": "Plan Review",
                "notes": "",
                "token": tok,
                "website": "",
            },
        )
        assert r.status_code == 201, r.text

    fresh = await db.calendars.find_one({"id": cal["id"]}, {"_id": 0})
    counts = fresh["distribution"]["assignment_counts"]
    assert counts == {a["id"]: 1, b["id"]: 1}, counts


@pytest.mark.asyncio
async def test_book_individual_slug_no_distribution(client, db, monkeypatch):
    """Individual-calendar booking still routes straight to the owner —
    the distribution branch must NOT execute for individual calendars.
    """
    import resend_client
    async def _fake_send(*a, **k): return True
    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    owner = await _seed_user(db, "ind.book.owner@example.com")
    cal = {
        "id": str(uuid.uuid4()),
        "agency_id": GHW_AGENCY,
        "name": "Individual Book",
        "type": "individual",
        "slug": "ind-book-c3",
        "color": "#6366f1",
        "source_label": "manual",
        "owner_id": owner["id"],
        "member_ids": [],
        "distribution": None,
        "booking_settings": {
            "duration_minutes": 30,
            "buffer_minutes": 0,
            "advance_notice_hours": 0,
            "max_bookings_per_day": 100,
            "working_hours": dict(_ALL_DAY_HOURS),
            "meeting_types": ["phone", "video"],
            "timezone": "America/Chicago",
        },
        "is_active": True,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    await db.calendars.insert_one(cal)

    tok = client.get(f"/api/book/{cal['slug']}/token").json()["token"]
    book_date = _future_weekday()
    slots = client.get(
        f"/api/book/{cal['slug']}/slots?date={book_date}"
    ).json().get("slots") or []
    if not slots:
        pytest.skip("no slots for chosen date")

    r = client.post(
        f"/api/book/{cal['slug']}",
        json={
            "client_name": "Individual Path",
            "client_phone": "555-2222",
            "date": book_date,
            "time": slots[0],
            "meeting_type": "phone",
            "booking_reason": "Plan Review",
            "notes": "",
            "token": tok,
            "website": "",
        },
    )
    assert r.status_code == 201, r.text

    appt = await db.appointments.find_one(
        {"calendar_id": cal["id"]}, {"_id": 0},
    )
    assert appt is not None
    assert appt["agent_id"] == owner["id"]
    # Source label "manual" → booking_type "manual"
    assert appt["booking_type"] == "manual"


# ── Multi-tenant ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cross_tenant_distribution_404(client, db):
    """Admin of agency_two cannot reach agency_one's distribution —
    404, not 403, so cross-agency probing yields no signal.
    """
    a = await _seed_user(db, "tenant1.mem@example.com")
    b = await _seed_user(db, "tenant1.mem.b@example.com")
    cal = await _seed_rr_calendar(
        db, slug="tenant1-private-c3", member_ids=[a["id"], b["id"]],
    )

    await _seed_agency(db, SECOND_AGENCY)
    await _seed_user(
        db, "tenant2.admin@example.com", role="admin",
        agency_id=SECOND_AGENCY,
    )
    headers = _login(client, "tenant2.admin@example.com")
    r = client.get(
        f"/api/calendars/{cal['id']}/distribution", headers=headers,
    )
    assert r.status_code == 404
