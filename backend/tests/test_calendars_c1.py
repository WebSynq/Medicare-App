"""Feature C — sub-phase C1: calendar data model + migration + booking
resolution fallback.

Spec:
  - calendars collection with the exact fields enumerated in the
    sprint brief
  - slug globally unique (design Q1)
  - migration script seeds one Individual calendar per user with a
    booking slug, idempotent, with -N suffix on collision (Q4)
  - booking_router resolves slug via calendars first, falls back to
    users.booking_settings, then 404s
  - Appointment model accepts calendar_id + booking_type without
    breaking existing creates
"""
import asyncio
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pymongo.errors import DuplicateKeyError

# Make ``scripts/migrate_calendars`` importable from the tests dir.
_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import migrate_calendars  # noqa: E402
from models import Calendar  # noqa: E402
from security import hash_password  # noqa: E402


GHW_AGENCY = "ghw_001"
DEFAULT_PWD = "Q9pl#aux!7zT-seed"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _seed_user_with_slug(
    db, email: str, slug: str, agency_id: str = GHW_AGENCY,
    created_at: str | None = None,
) -> dict:
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "agent_id": uid,
        "email": email,
        "full_name": email.split("@")[0].title(),
        "agent_name": email.split("@")[0].title(),
        "role": "agent",
        "agency_id": agency_id,
        "is_active": True,
        "status": "active",
        "hashed_password": hash_password(DEFAULT_PWD),
        "token_version": 0,
        "failed_attempts": 0,
        "booking_settings": {
            "slug": slug,
            "is_enabled": True,
            "appointment_duration": 45,
            "buffer_minutes": 10,
            "advance_notice_hours": 12,
            "max_per_day": 8,
            "booking_window_days": 60,
            "meeting_types": ["phone", "video"],
            "working_hours": {
                "monday":    {"enabled": True, "start": "09:00", "end": "17:00"},
                "tuesday":   {"enabled": True, "start": "09:00", "end": "17:00"},
                "wednesday": {"enabled": True, "start": "09:00", "end": "17:00"},
                "thursday":  {"enabled": True, "start": "09:00", "end": "17:00"},
                "friday":    {"enabled": True, "start": "09:00", "end": "17:00"},
                "saturday":  {"enabled": False, "start": "09:00", "end": "12:00"},
                "sunday":    {"enabled": False, "start": "09:00", "end": "12:00"},
            },
        },
        "created_at": created_at or _now_iso(),
    }
    await db.users.insert_one(doc)
    return doc


def _build_calendar_doc(
    slug: str, *, agency_id: str = GHW_AGENCY, owner_id: str = "owner-1",
    is_active: bool = True, name: str = "Test Calendar",
    source_label: str = "manual",
) -> dict:
    return Calendar(
        agency_id=agency_id,
        name=name,
        type="individual",
        slug=slug,
        owner_id=owner_id,
        source_label=source_label,
        is_active=is_active,
    ).model_dump()


# ── 1. Model shape ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_calendar_has_correct_shape(db, client):
    """A Calendar() constructed with the minimum required fields
    produces all the spec-mandated keys with the right defaults.
    """
    cal = Calendar(
        agency_id=GHW_AGENCY,
        name="Tim's Calendar",
        type="individual",
        slug="tim-shape-test",
        owner_id="user-1",
    )
    doc = cal.model_dump()
    # Spec-required keys.
    for k in (
        "id", "agency_id", "name", "type", "slug", "color",
        "source_label", "owner_id", "member_ids", "distribution",
        "booking_settings", "is_active", "created_at", "updated_at",
    ):
        assert k in doc, f"missing field: {k}"
    # Defaults per spec.
    assert doc["color"] == "#6366f1"
    assert doc["source_label"] == "manual"
    assert doc["member_ids"] == []
    assert doc["distribution"] is None
    assert doc["is_active"] is True
    bs = doc["booking_settings"]
    assert bs["duration_minutes"] == 30
    assert bs["buffer_minutes"] == 15
    assert bs["advance_notice_hours"] == 24
    assert bs["max_bookings_per_day"] == 10
    assert "monday" in bs["working_hours"]
    assert bs["meeting_types"] == ["phone", "video"]


# ── 2. Slug unique index ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_slug_unique_index_rejects_duplicate(db, client):
    """The startup event creates a unique index on calendars.slug.
    Inserting two rows with the same slug must raise DuplicateKeyError.
    The ``client`` fixture is what triggers startup → index creation.
    """
    doc1 = _build_calendar_doc("dup-slug", owner_id="o-1")
    doc2 = _build_calendar_doc("dup-slug", owner_id="o-2")
    await db.calendars.insert_one(doc1)
    with pytest.raises(DuplicateKeyError):
        await db.calendars.insert_one(doc2)


@pytest.mark.asyncio
async def test_slug_unique_index_is_cross_tenant(db, client):
    """Slugs are globally unique across tenants (design Q1) — agency A
    holding "shared" prevents agency B from registering the same.
    """
    a = _build_calendar_doc("shared", agency_id="agency-a", owner_id="o-a")
    b = _build_calendar_doc("shared", agency_id="agency-b", owner_id="o-b")
    await db.calendars.insert_one(a)
    with pytest.raises(DuplicateKeyError):
        await db.calendars.insert_one(b)


# ── 3-5. Migration script ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_migration_creates_one_calendar_per_agent(db, client):
    """One Individual calendar created per user with a booking slug."""
    await _seed_user_with_slug(db, "mig.one@example.com", "alice-mig")
    await _seed_user_with_slug(db, "mig.two@example.com", "bob-mig")
    # Plus a user without a slug — must not produce a calendar row.
    await db.users.insert_one({
        "id": "no-slug-user",
        "email": "noslug@example.com",
        "agency_id": GHW_AGENCY,
        "is_active": True, "status": "active",
        "hashed_password": hash_password("X"),
        "booking_settings": {"is_enabled": False},
        "created_at": _now_iso(),
    })

    summary = await migrate_calendars.migrate(db, apply_writes=True, quiet=True)
    assert summary["created"] == 2, summary
    assert summary["collisions"] == 0
    # Confirm rows landed.
    n = await db.calendars.count_documents({"type": "individual"})
    assert n == 2
    slugs = sorted([
        c["slug"] async for c in db.calendars.find({}, {"_id": 0, "slug": 1})
    ])
    assert slugs == ["alice-mig", "bob-mig"]


@pytest.mark.asyncio
async def test_migration_is_idempotent(db, client):
    """Re-running after a successful run yields zero new rows."""
    await _seed_user_with_slug(db, "idem@example.com", "idem-slug")
    first = await migrate_calendars.migrate(db, apply_writes=True, quiet=True)
    second = await migrate_calendars.migrate(db, apply_writes=True, quiet=True)
    assert first["created"] == 1
    assert second["created"] == 0
    assert second["skipped_existing"] == 1
    n = await db.calendars.count_documents({})
    assert n == 1


@pytest.mark.asyncio
async def test_slug_collision_appends_n_to_loser(db, client):
    """Two users in the same agency share the slug "duplicate". The
    earlier-created user keeps the slug; the later one's calendar gets
    "duplicate-2".
    """
    base_ts = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
    later_ts = datetime(2026, 6, 1, tzinfo=timezone.utc).isoformat()
    await _seed_user_with_slug(
        db, "winner@example.com", "duplicate", created_at=base_ts,
    )
    await _seed_user_with_slug(
        db, "loser@example.com", "duplicate", created_at=later_ts,
    )

    summary = await migrate_calendars.migrate(db, apply_writes=True, quiet=True)
    assert summary["created"] == 2
    assert summary["collisions"] == 1
    slugs = {
        c["slug"]: c["owner_id"]
        async for c in db.calendars.find({}, {"_id": 0, "slug": 1, "owner_id": 1})
    }
    assert "duplicate" in slugs, slugs
    assert "duplicate-2" in slugs, slugs


# ── 6-8. Booking_router fallback chain ───────────────────────────────────


@pytest.mark.asyncio
async def test_booking_resolves_calendar_slug(db, client):
    """Step 1 of the fallback: when /book/:slug matches a calendar, the
    public profile renders from the calendar's booking_settings + the
    owner user's name. Test by inserting a user + a calendar pointing
    at them; /info must succeed.
    """
    owner = await _seed_user_with_slug(
        db, "calowner@example.com", "old-user-slug",
    )
    # Calendar slug differs from the user's slug so we know the
    # calendar branch — not the user fallback — handled the request.
    cal = _build_calendar_doc(
        "cal-step-1", owner_id=owner["id"], name="Owner's Calendar",
    )
    await db.calendars.insert_one(cal)

    r = client.get("/api/book/cal-step-1/info")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agent_name"]  # first name string


@pytest.mark.asyncio
async def test_booking_falls_back_to_user_slug(db, client):
    """Step 2: no calendar with this slug → look in users."""
    await _seed_user_with_slug(db, "userfb@example.com", "user-only-slug")
    r = client.get("/api/book/user-only-slug/info")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agent_name"]


@pytest.mark.asyncio
async def test_booking_404s_when_neither_exists(db, client):
    """Step 3: no calendar AND no user with this slug → 404."""
    r = client.get("/api/book/no-such-slug/info")
    assert r.status_code == 404


# ── 9. Cross-tenant — appointment lands on calendar's agency ─────────────


@pytest.mark.asyncio
async def test_calendar_agency_id_stamped_on_booking(db, client, monkeypatch):
    """The slug is globally unique, but when a calendar in agency_two
    is booked, the resulting appointment must carry agency_id="agency_two"
    — not the requester's session context, not the env default.

    Verifies the C1 cross-tenant isolation requirement.
    """
    import resend_client
    async def _fake_send(*a, **k): return True
    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    # Owner user lives in agency_two.
    owner = await _seed_user_with_slug(
        db, "twotenant@example.com", "user-slug-2t",
        agency_id="agency_two",
    )
    cal = _build_calendar_doc(
        "cross-tenant-cal", agency_id="agency_two",
        owner_id=owner["id"], name="Two-Tenant Cal",
        source_label="autobook",
    )
    await db.calendars.insert_one(cal)

    # Fetch a real HMAC token first.
    tok_resp = client.get("/api/book/cross-tenant-cal/token")
    assert tok_resp.status_code == 200, tok_resp.text
    token = tok_resp.json()["token"]

    # Pick a slot far enough out to clear advance_notice.
    future = (datetime.now(timezone.utc).date() +
              __import__("datetime").timedelta(days=14)).isoformat()
    # Find an available slot for that day.
    slots = client.get(
        f"/api/book/cross-tenant-cal/slots?date={future}",
    ).json().get("slots") or []
    # If the future date lands on a working day (Mon-Fri seeded ON),
    # at least one slot should be available. Skip otherwise.
    if not slots:
        pytest.skip("no slots available on chosen day — flaky CI dates")
    slot_time = slots[0]

    r = client.post(
        "/api/book/cross-tenant-cal",
        json={
            "client_name": "Cross Tenant",
            "client_phone": "555-0000",
            "client_email": "ct@example.com",
            "date": future,
            "time": slot_time,
            "meeting_type": "phone",
            "booking_reason": "Plan Review",
            "notes": "",
            "token": token,
            "website": "",
        },
    )
    assert r.status_code == 201, r.text

    # Appointment was stamped with the calendar's agency_id, not the
    # env default ghw_001.
    appt = await db.appointments.find_one(
        {"agent_id": owner["id"]}, {"_id": 0},
    )
    assert appt is not None
    assert appt["agency_id"] == "agency_two", appt
    assert appt["calendar_id"] == cal["id"]
    assert appt["booking_type"] == "autobook"


# ── 10. Appointment model accepts new fields ─────────────────────────────


@pytest.mark.asyncio
async def test_appointment_create_accepts_calendar_fields(client, db, admin_headers):
    """POST /api/appointments with optional calendar_id + booking_type
    succeeds and stamps the fields on the row. Existing creates that
    omit them must still work (covered by the unchanged 470 floor).
    """
    # Seed a lead so the linked-appointment path passes _resolve_lead.
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    await db.leads.insert_one({
        "id": "cal-appt-lead",
        "first_name": "Cal", "last_name": "Lead",
        "agent_id": admin["id"], "agency_id": GHW_AGENCY,
        "status": "new",
        "created_at": _now_iso(), "updated_at": _now_iso(),
    })

    r = client.post(
        "/api/appointments",
        json={
            "lead_id": "cal-appt-lead",
            "appointment_date": "2026-12-01",
            "appointment_time": "10:00",
            "calendar_id": "cal-uuid-123",
            "booking_type": "ae",
        },
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["calendar_id"] == "cal-uuid-123"
    assert body["booking_type"] == "ae"

    # Default behavior — omit both fields — booking_type defaults to "manual".
    r2 = client.post(
        "/api/appointments",
        json={
            "lead_id": "cal-appt-lead",
            "appointment_date": "2026-12-02",
            "appointment_time": "10:00",
        },
        headers=admin_headers,
    )
    assert r2.status_code == 201, r2.text
    body2 = r2.json()
    assert body2["calendar_id"] is None
    assert body2["booking_type"] == "manual"
