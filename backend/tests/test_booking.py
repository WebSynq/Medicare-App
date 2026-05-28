"""Booking system + automation tests.

Covers:
  - Public /api/book/* endpoints (info, slots, token, create)
  - Slot generation edge cases (working hours, advance notice, conflicts)
  - Slug + agent enablement gates
  - HMAC token issuance + verification
  - Honeypot returns fake success
  - Booking creates the appointment row + flags booked_by_client
  - Email templates render
  - Automations are idempotent (reminder doesn't fire twice; flag set
    prevents re-fire even when window matches)
  - Stale-lead threshold at 30 days

All tests use the in-process TestClient + mongomock-motor (conftest.py
patches `deps.get_db` and `deps.get_phi_db` to the same mongomock DB).
RESEND_API_KEY is unset in conftest so send_email returns False without
hitting the network — automations still write their idempotency flags
and audit rows.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

import booking_router
from booking_router import _generate_slots, _make_token, _current_bucket


# Set a deterministic booking secret so token round-trips are stable
# across tests. Honored by booking_router._booking_secret() since it
# reads the env at call time.
os.environ["BOOKING_SECRET"] = (
    "test-booking-secret-deterministic-fixed-1234567890abcdef"
)


# ── Fixtures ────────────────────────────────────────────────────────────
def _make_agent_with_token(client, admin_headers, email, name,
                            password="Q1pl#aux!7zT"):
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


async def _seed_enabled_agent(db, *, slug="test-agent", duration=30,
                                buffer_minutes=15, advance_notice_hours=0,
                                booking_window_days=60,
                                meeting_types=None,
                                working_hours=None,
                                full_name="Test Agent",
                                email=None):
    """Insert an agent doc directly with booking_settings enabled."""
    if working_hours is None:
        # All weekdays + weekends enabled with wide hours for easy slot tests.
        working_hours = {
            d: {"enabled": True, "start": "09:00", "end": "17:00"}
            for d in ("monday", "tuesday", "wednesday", "thursday",
                       "friday", "saturday", "sunday")
        }
    aid = str(uuid.uuid4())
    email = email or f"{slug}@example.com"
    await db.users.insert_one({
        "id": aid,
        "email": email,
        "full_name": full_name,
        "agent_name": full_name,
        "role": "agent",
        "is_active": True,
        "status": "active",
        "phone": "555-0000",
        "hashed_password": "$2b$12$0123456789abcdef",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "booking_settings": {
            "is_enabled": True,
            "slug": slug,
            "bio": "Helping people make sense of Medicare.",
            "meeting_types": meeting_types or ["phone", "video"],
            "phone_number": "555-1212",
            "video_link": "https://meet.example/test",
            "appointment_duration": duration,
            "buffer_minutes": buffer_minutes,
            "max_per_day": 10,
            "advance_notice_hours": advance_notice_hours,
            "booking_window_days": booking_window_days,
            "working_hours": working_hours,
        },
    })
    return aid


def _future_date(days_ahead: int) -> str:
    return (datetime.now(timezone.utc).date()
             + timedelta(days=days_ahead)).isoformat()


# ── Slot generation (pure function) ─────────────────────────────────────
def test_slots_generated_for_working_day():
    """30-min duration + 15-min buffer = 45-min step. 09:00–17:00 →
    starts at 09:00, 09:45, 10:30, ... last slot must end by 17:00."""
    slots = _generate_slots("09:00", "17:00", 30, 15)
    assert slots[0] == "09:00"
    assert slots[1] == "09:45"
    assert slots[2] == "10:30"
    # No slot may start after 16:30 (would end after 17:00).
    for s in slots:
        hh, mm = (int(p) for p in s.split(":"))
        total = hh * 60 + mm
        assert total + 30 <= 17 * 60, f"slot {s} runs past 17:00"


# ── Info endpoint ───────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_no_slots_on_disabled_day(client, db):
    """An agent with Sunday disabled returns slots=[] + a reason."""
    wh = {
        d: {"enabled": True, "start": "09:00", "end": "17:00"}
        for d in ("monday", "tuesday", "wednesday", "thursday", "friday")
    }
    wh["saturday"] = {"enabled": False, "start": "09:00", "end": "12:00"}
    wh["sunday"] = {"enabled": False, "start": "09:00", "end": "12:00"}
    await _seed_enabled_agent(db, slug="disabled-sun", working_hours=wh)

    # Find the next Sunday.
    today = datetime.now(timezone.utc).date()
    days_to_sunday = (6 - today.weekday()) % 7 or 7
    target = (today + timedelta(days=days_to_sunday)).isoformat()
    r = client.get(f"/api/book/disabled-sun/slots?date={target}")
    assert r.status_code == 200
    body = r.json()
    assert body["slots"] == []
    assert "not a working day" in body["reason"].lower()


@pytest.mark.asyncio
async def test_slots_exclude_existing_appointments(client, db):
    """An existing 30-min appointment at 10:30 removes that slot."""
    aid = await _seed_enabled_agent(db, slug="conflict-agent")
    target = _future_date(5)
    await db.appointments.insert_one({
        "appointment_id": "x1",
        "agent_id": aid,
        "appointment_date": target,
        "appointment_time": "10:30",
        "duration_minutes": 30,
        "status": "scheduled",
    })
    r = client.get(f"/api/book/conflict-agent/slots?date={target}")
    assert r.status_code == 200
    slots = r.json()["slots"]
    assert "10:30" not in slots
    # Surrounding slots should still be there.
    assert "09:45" in slots or "11:15" in slots


@pytest.mark.asyncio
async def test_advance_notice_blocks_too_soon(client, db):
    """48-hour advance notice should drop tomorrow's slots."""
    await _seed_enabled_agent(
        db, slug="advance-agent", advance_notice_hours=48,
    )
    tomorrow = _future_date(1)
    r = client.get(f"/api/book/advance-agent/slots?date={tomorrow}")
    assert r.status_code == 200
    # All slots within the 48h window should be filtered out.
    assert r.json()["slots"] == []


# ── Public booking creation ─────────────────────────────────────────────
def _good_token(slug):
    return _make_token(slug, _current_bucket())


@pytest.mark.asyncio
async def test_public_booking_creates_appointment(client, db):
    slug = "public-book"
    aid = await _seed_enabled_agent(db, slug=slug)
    date = _future_date(3)
    # Pick a slot the slots endpoint actually exposes.
    slots = client.get(f"/api/book/{slug}/slots?date={date}").json()["slots"]
    assert slots, "expected at least one available slot"
    time = slots[0]

    payload = {
        "client_name": "Test Client",
        "client_phone": "5551239876",
        "client_email": "client@example.com",
        "date": date,
        "time": time,
        "meeting_type": "phone",
        "booking_reason": "Plan Review",
        "token": _good_token(slug),
    }
    r = client.post(f"/api/book/{slug}", json=payload)
    assert r.status_code == 201, r.text
    body = r.json()
    # Response is intentionally minimal — no appointment_id, no agent_id.
    assert body["status"] == "confirmed"
    assert body["date"] == date
    assert body["time"] == time
    assert body["meeting_type"] == "phone"
    assert "appointment_id" not in body
    assert "agent_id" not in body

    # And an appointment row was written under the agent's id.
    stored = await db.appointments.find_one({"agent_id": aid}, {"_id": 0})
    assert stored is not None
    assert stored["booked_by_client"] is True
    assert stored["booking_reason"] == "Plan Review"
    assert stored["client_email"] == "client@example.com"


@pytest.mark.asyncio
async def test_booking_unknown_slug_returns_404(client, db):
    payload = {
        "client_name": "Test Client",
        "client_phone": "5551239876",
        "date": _future_date(3),
        "time": "09:00",
        "meeting_type": "phone",
        "booking_reason": "Plan Review",
        "token": _good_token("does-not-exist"),
    }
    r = client.post("/api/book/does-not-exist", json=payload)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_booking_unavailable_slot_returns_409(client, db):
    """Booking a time outside the live slot list returns 409."""
    slug = "conflict-slug"
    await _seed_enabled_agent(db, slug=slug, advance_notice_hours=24)
    payload = {
        "client_name": "Test Client",
        "client_phone": "5551239876",
        "date": _future_date(0),    # today — blocked by 24h advance notice
        "time": "09:00",
        "meeting_type": "phone",
        "booking_reason": "Plan Review",
        "token": _good_token(slug),
    }
    r = client.post(f"/api/book/{slug}", json=payload)
    assert r.status_code == 409


# ── Security: honeypot + token ──────────────────────────────────────────
@pytest.mark.asyncio
async def test_honeypot_returns_fake_success_no_appointment(client, db):
    slug = "honey-agent"
    await _seed_enabled_agent(db, slug=slug)
    date = _future_date(5)
    slots = client.get(f"/api/book/{slug}/slots?date={date}").json()["slots"]
    payload = {
        "client_name": "Bot Bot",
        "client_phone": "5550000000",
        "date": date,
        "time": slots[0],
        "meeting_type": "phone",
        "booking_reason": "Plan Review",
        "token": _good_token(slug),
        "website": "http://bot.example",   # honeypot tripped
    }
    r = client.post(f"/api/book/{slug}", json=payload)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    # Looks like a real confirmation to the bot.
    assert body["status"] == "confirmed"
    # But no appointment was written.
    count = await db.appointments.count_documents({})
    assert count == 0
    # And the attempt was logged.
    attempts = await db.booking_attempts.find({}, {"_id": 0}).to_list(None)
    assert any(a["outcome"] == "honeypot" for a in attempts)


@pytest.mark.asyncio
async def test_booking_rejects_invalid_token(client, db):
    slug = "tok-agent"
    await _seed_enabled_agent(db, slug=slug)
    date = _future_date(5)
    slots = client.get(f"/api/book/{slug}/slots?date={date}").json()["slots"]
    payload = {
        "client_name": "Test Client",
        "client_phone": "5551239876",
        "date": date,
        "time": slots[0],
        "meeting_type": "phone",
        "booking_reason": "Plan Review",
        "token": "f" * 64,   # wrong shape but right length
    }
    r = client.post(f"/api/book/{slug}", json=payload)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_token_endpoint_round_trips(client, db):
    slug = "tok-rt"
    await _seed_enabled_agent(db, slug=slug)
    r = client.get(f"/api/book/{slug}/token")
    assert r.status_code == 200
    body = r.json()
    assert "token" in body
    assert body["expires_in"] >= 60
    # Token issued by the endpoint should validate via our helper.
    from booking_router import _verify_token
    assert _verify_token(slug, body["token"]) is True


@pytest.mark.asyncio
async def test_info_redacts_agent_email_and_phone(client, db):
    slug = "redact-agent"
    await _seed_enabled_agent(db, slug=slug, full_name="Tim Arnold")
    body = client.get(f"/api/book/{slug}/info").json()
    assert body["agent_name"] == "Tim"   # first name only
    assert "agent_id" not in body
    assert "agent_email" not in body
    assert "phone_number" not in body
    assert "video_link" not in body


@pytest.mark.asyncio
async def test_invalid_slug_format_returns_404(client, db):
    r = client.get("/api/book/UPPER_CASE/info")
    assert r.status_code == 404
    r = client.get("/api/book/x/info")  # too short
    assert r.status_code == 404


# ── Automations ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_birthday_automation_finds_window_leads(client, db):
    """Birthday window opens 45 days before DOB → fires for IL leads."""
    from automations import run_birthday_window_automation

    target = (datetime.now(timezone.utc).date() + timedelta(days=45))
    dob_iso = f"1955-{target.month:02d}-{target.day:02d}"

    aid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": aid, "email": "agent@example.com",
        "full_name": "Agent Smith", "role": "agent",
        "is_active": True, "status": "active",
    })
    await db.leads.insert_one({
        "id": "il-lead-1",
        "first_name": "Iris", "last_name": "Birthday",
        "email": "iris@example.com",
        "state": "IL",
        "status": "new",
        "date_of_birth": dob_iso,
        "agent_id": aid,
        # Phase-1 multi-tenant stamp — real lead writes go through
        # leads_router which sets this for us. Direct-DB test fixtures
        # have to stamp it manually now that the scheduler filters by it.
        "agency_id": "ghw_001",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })

    count = await run_birthday_window_automation(db)
    # send_email returns False without RESEND_API_KEY, so `count`
    # reports 0 sends — but the flag must still be stamped so we
    # don't re-attempt forever.
    after = await db.leads.find_one({"id": "il-lead-1"}, {"_id": 0})
    assert after.get("birthday_email_sent") is True
    # Sanity: count returns >=0, never negative.
    assert isinstance(count, int) and count >= 0


@pytest.mark.asyncio
async def test_reminder_48hr_fires_correctly(client, db):
    """An appointment 48h out gets reminder_48hr_sent stamped."""
    from automations import run_appointment_reminders

    aid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": aid, "email": "agent@example.com",
        "full_name": "Agent Smith", "role": "agent",
        "is_active": True, "status": "active",
    })
    target = datetime.now(timezone.utc) + timedelta(hours=48, minutes=10)
    await db.appointments.insert_one({
        "appointment_id": "appt-48",
        "agent_id": aid,
        "agency_id": "ghw_001",
        "client_name": "Time Window",
        "client_email": "tw@example.com",
        "appointment_date": target.date().isoformat(),
        "appointment_time": target.strftime("%H:%M"),
        "duration_minutes": 30,
        "status": "scheduled",
        "meeting_type": "phone",
    })

    await run_appointment_reminders(db)
    stored = await db.appointments.find_one(
        {"appointment_id": "appt-48"}, {"_id": 0},
    )
    assert stored.get("reminder_48hr_sent") is True


@pytest.mark.asyncio
async def test_reminder_not_sent_twice(client, db):
    """Re-running the scheduler with the flag already True must not re-fire."""
    from automations import run_appointment_reminders

    aid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": aid, "email": "agent@example.com",
        "full_name": "Agent Smith", "role": "agent",
        "is_active": True, "status": "active",
    })
    target = datetime.now(timezone.utc) + timedelta(hours=24, minutes=10)
    await db.appointments.insert_one({
        "appointment_id": "appt-dup",
        "agent_id": aid,
        "client_name": "Already Sent",
        "client_email": "dup@example.com",
        "appointment_date": target.date().isoformat(),
        "appointment_time": target.strftime("%H:%M"),
        "duration_minutes": 30,
        "status": "scheduled",
        "meeting_type": "phone",
        # Already marked sent — must not refire.
        "reminder_24hr_sent": True,
    })

    audit_before = await db.audit_logs.count_documents({})
    await run_appointment_reminders(db)
    # The doc keeps its flag and we didn't append a new reminder audit row.
    stored = await db.appointments.find_one(
        {"appointment_id": "appt-dup"}, {"_id": 0},
    )
    assert stored["reminder_24hr_sent"] is True
    audit_after = await db.audit_logs.count_documents({
        "target_id": "appt-dup",
    })
    assert audit_after == 0


@pytest.mark.asyncio
async def test_stale_lead_threshold_30_days(client, db):
    """A lead untouched for 31 days is eligible; 29 days is not."""
    from automations import run_stale_lead_alerts

    aid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": aid, "email": "agent@example.com",
        "full_name": "Agent Smith", "role": "agent",
        "is_active": True, "status": "active",
    })
    now = datetime.now(timezone.utc)
    await db.leads.insert_many([
        {
            "id": "stale-old",
            "first_name": "Old", "last_name": "Lead",
            "agent_id": aid, "agency_id": "ghw_001", "status": "new",
            "updated_at": (now - timedelta(days=31)).isoformat(),
            "created_at": (now - timedelta(days=31)).isoformat(),
        },
        {
            "id": "stale-fresh",
            "first_name": "Fresh", "last_name": "Lead",
            "agent_id": aid, "agency_id": "ghw_001", "status": "new",
            "updated_at": (now - timedelta(days=29)).isoformat(),
            "created_at": (now - timedelta(days=29)).isoformat(),
        },
    ])

    await run_stale_lead_alerts(db)
    old = await db.leads.find_one({"id": "stale-old"}, {"_id": 0})
    fresh = await db.leads.find_one({"id": "stale-fresh"}, {"_id": 0})
    assert old.get("stale_alert_sent") is True
    assert fresh.get("stale_alert_sent") is not True


# ── Email templates render ──────────────────────────────────────────────
def test_booking_confirmation_renders():
    from email_templates import booking_confirmation_client
    html = booking_confirmation_client(
        client_name="Iris Birthday",
        agent_name="Tim Arnold",
        agent_phone="555-1212",
        date_str="Thursday, June 5, 2026",
        time_str="2:00 PM",
        meeting_type="phone",
        meeting_link="555-1212",
        booking_reason="Plan Review",
        cancel_url="#",
    )
    assert "Iris" in html
    assert "Tim Arnold" in html
    assert "Thursday, June 5, 2026" in html
    assert "2:00 PM" in html
    # Should be a complete document.
    assert html.strip().startswith("<!DOCTYPE html>")
    assert "</html>" in html


def test_reminder_email_adapts_to_hours():
    from email_templates import reminder_email
    h48 = reminder_email("Iris", "Tim", "555", "Mon", "10AM",
                          "phone", "555", 48)
    h24 = reminder_email("Iris", "Tim", "555", "Mon", "10AM",
                          "phone", "555", 24)
    h1  = reminder_email("Iris", "Tim", "555", "Mon", "10AM",
                          "phone", "555", 1)
    assert "2 days" in h48
    assert "tomorrow" in h24.lower()
    assert "1 hour" in h1


def test_booking_settings_default_includes_all_weekdays():
    """Sanity check the default working_hours covers all 7 days."""
    from models import BookingSettings
    bs = BookingSettings()
    assert set(bs.working_hours.keys()) == {
        "monday", "tuesday", "wednesday", "thursday",
        "friday", "saturday", "sunday",
    }
