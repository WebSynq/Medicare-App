"""Feature A — appointment outcome buttons.

POST /api/appointments/{id}/outcome stamps one of four discrete states
on the appointment row and:
  - audits the event as ``appointment_outcome_set``
  - flips ``status`` to ``no_show`` (for that outcome) or ``completed``
    (for the other three)
  - fires the no-show reschedule email via resend_client when the
    outcome is ``no_show``
  - rejects 422 on any outcome value outside the four-Literal enum

IDOR is enforced via the standard ``_fetch_or_idor`` pattern — a
non-admin agent who hits another agent's appointment_id gets 403
(not 404). The post_appointment_followup automation skips the 24h
generic email when outcome is ``sold`` or ``no_show``.
"""
import uuid
from datetime import datetime, timezone

import pytest

from security import hash_password


GHW_AGENCY = "ghw_001"
DEFAULT_PWD = "Q9pl#aux!7zT-seed"


# ── Helpers ────────────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _seed_agent(db, email: str) -> dict:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid,
        "agent_id": uid,
        "email": email,
        "full_name": email.split("@")[0].title(),
        "agent_name": email.split("@")[0].title(),
        "role": "agent",
        "agency_id": GHW_AGENCY,
        "is_active": True,
        "status": "active",
        "hashed_password": hash_password(DEFAULT_PWD),
        "token_version": 0,
        "failed_attempts": 0,
        "booking_settings": {"slug": f"agent-{email.split('@')[0]}"},
        "created_at": _now_iso(),
    })
    return await db.users.find_one({"id": uid}, {"_id": 0})


def _login(client, email: str) -> dict:
    r = client.post("/api/auth/login", json={"email": email, "password": DEFAULT_PWD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _seed_appointment(
    db, agent_id: str, *, lead_id: str = "lead-x",
    client_email: str = "client@example.com",
) -> str:
    appt_id = str(uuid.uuid4())
    await db.appointments.insert_one({
        "appointment_id": appt_id,
        "agent_id": agent_id,
        "agency_id": GHW_AGENCY,
        "lead_id": lead_id,
        "client_name": "Test Client",
        "client_email": client_email,
        "appointment_date": "2026-06-01",
        "appointment_time": "10:00",
        "duration_minutes": 30,
        "type": "initial_consultation",
        "status": "scheduled",
        "outcome": None,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    })
    return appt_id


# ── Outcome stamping — all four states ────────────────────────────────────


@pytest.mark.parametrize("outcome,expected_status", [
    ("showed", "completed"),
    ("sold", "completed"),
    ("not_sold", "completed"),
    ("no_show", "no_show"),
])
@pytest.mark.asyncio
async def test_outcome_stamps_correctly(
    client, db, admin_headers, outcome, expected_status, monkeypatch,
):
    """Each of the four buttons stamps outcome + flips status. no_show
    flips to status=no_show; the other three flip to status=completed.
    Monkeypatches send_email to a no-op so the no_show test doesn't try
    to actually reach Resend.
    """
    import resend_client

    async def _fake_send(*args, **kwargs):
        return True

    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    appt_id = await _seed_appointment(db, admin["id"])

    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": outcome},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == outcome
    assert body["status"] == expected_status
    assert body["outcome_set_at"] is not None
    assert body["outcome_set_by"] == admin["id"]


# ── Invalid outcome ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invalid_outcome_returns_422(client, db, admin_headers):
    """Anything outside the four-Literal enum is a 422 before the handler runs."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    appt_id = await _seed_appointment(db, admin["id"])

    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": "rescheduled"},
        headers=admin_headers,
    )
    assert r.status_code == 422


# ── No-show fires email ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_show_fires_reschedule_email(
    client, db, admin_headers, monkeypatch,
):
    """Marking an appointment ``no_show`` MUST call resend_client.send_email
    with the no-show subject line. We capture the call args via a fake
    coroutine and assert exactly one fire."""
    import resend_client

    calls = []

    async def _fake_send(*, to, subject, html, **kwargs):
        calls.append({
            "to": to, "subject": subject, "html": html, "kwargs": kwargs,
        })
        return True

    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    appt_id = await _seed_appointment(
        db, admin["id"], client_email="real-client@example.com",
    )

    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": "no_show"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 1, (
        f"expected exactly one no-show email fire, got {len(calls)}"
    )
    call = calls[0]
    assert call["to"] == "real-client@example.com"
    assert "missed you" in call["subject"].lower()


@pytest.mark.asyncio
async def test_sold_does_not_fire_email(
    client, db, admin_headers, monkeypatch,
):
    """Marking ``sold`` is a CRM-only state change; no email goes out."""
    import resend_client

    calls = []

    async def _fake_send(*args, **kwargs):
        calls.append((args, kwargs))
        return True

    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    appt_id = await _seed_appointment(db, admin["id"])

    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": "sold"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 0, "sold must not trigger any email send"


# ── IDOR ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_admin_cannot_set_outcome_on_other_agents_appointment(
    client, db, monkeypatch,
):
    """A regular agent must not be able to mark another agent's
    appointment. Per spec: 403, not 404 — the appointment exists,
    they just don't own it.
    """
    import resend_client

    async def _fake_send(*args, **kwargs):
        return True

    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    agent_a = await _seed_agent(db, "outcome.actor@example.com")
    agent_b = await _seed_agent(db, "outcome.owner@example.com")
    # Appointment belongs to B.
    appt_id = await _seed_appointment(db, agent_b["id"])

    headers_a = _login(client, "outcome.actor@example.com")
    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": "showed"},
        headers=headers_a,
    )
    assert r.status_code == 403, (
        f"expected 403 IDOR, got {r.status_code}: {r.text}"
    )


@pytest.mark.asyncio
async def test_admin_can_set_outcome_on_any_appointment(client, db, admin_headers):
    """Admin role is in FULL_AGENCY_SCOPE_ROLES and can mark any
    agent's appointment within their agency.
    """
    agent = await _seed_agent(db, "outcome.subordinate@example.com")
    appt_id = await _seed_appointment(db, agent["id"])

    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": "showed"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["outcome"] == "showed"


# ── Audit event ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_audit_event_written_on_outcome_set(
    client, db, admin_headers, monkeypatch,
):
    """Every outcome stamp writes exactly one ``appointment_outcome_set``
    audit row with the chosen outcome in the metadata."""
    import resend_client

    async def _fake_send(*args, **kwargs):
        return True

    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    appt_id = await _seed_appointment(db, admin["id"])

    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": "not_sold"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text

    rows = await db.audit_logs.find(
        {"event_type": "appointment_outcome_set",
         "target_id": appt_id}, {"_id": 0},
    ).to_list(length=10)
    assert len(rows) == 1, f"expected 1 audit row, got {len(rows)}"
    assert rows[0]["metadata"]["outcome"] == "not_sold"
    assert rows[0]["metadata"]["lead_id"] == "lead-x"


# ── Sold response carries lead_id for SPA navigation ─────────────────────


@pytest.mark.asyncio
async def test_sold_response_carries_lead_id_for_spa(client, db, admin_headers):
    """SPA navigates to /applications?lead_id=X on "sold". The backend
    response must surface lead_id so the frontend has the value it
    needs to construct the URL (covers the user-visible side of the
    "sold navigates with correct lead_id param" spec line)."""
    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    appt_id = await _seed_appointment(
        db, admin["id"], lead_id="lead-for-sold-nav",
    )

    r = client.post(
        f"/api/appointments/{appt_id}/outcome",
        json={"outcome": "sold"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["lead_id"] == "lead-for-sold-nav"


# ── Automation differentiation ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_automation_skips_followup_for_sold_and_no_show(db, monkeypatch):
    """post_appointment_followup() must skip appointments whose outcome
    is ``sold`` or ``no_show``. The other states (``showed``,
    ``not_sold``, or null) still fire the existing 24h email.
    """
    import resend_client
    from automations import run_post_appointment_followup

    sends = []

    async def _fake_send(*args, **kwargs):
        sends.append(kwargs.get("to"))
        return True

    monkeypatch.setattr(resend_client, "send_email", _fake_send)

    admin = await db.users.find_one({"role": "admin"}, {"_id": 0})
    # All four appointments must be 24h-25h old measured against the
    # automation's own ``datetime.now(timezone.utc)``. Anchor to now
    # directly (not "today at 10:00 UTC") so the hours_ago window
    # check inside the automation passes for the actual run-time.
    from datetime import timedelta
    target = datetime.now(timezone.utc) - timedelta(hours=24, minutes=30)
    appt_date_iso = target.date().isoformat()
    appt_time_iso = target.strftime("%H:%M")

    for tag, outcome in (
        ("a-sold", "sold"),
        ("a-noshow", "no_show"),
        ("a-showed", "showed"),
        ("a-notsold", "not_sold"),
    ):
        await db.appointments.insert_one({
            "appointment_id": tag,
            "agent_id": admin["id"],
            "agency_id": GHW_AGENCY,
            "lead_id": tag,
            "client_name": "Client",
            "client_email": f"{tag}@example.com",
            "appointment_date": appt_date_iso,
            "appointment_time": appt_time_iso,
            "duration_minutes": 30,
            "type": "initial_consultation",
            "status": "completed",
            "outcome": outcome,
            "followup_sent": False,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        })

    await run_post_appointment_followup(db)

    # sold + no_show suppressed; showed + not_sold still receive.
    sent_to = set(sends)
    assert "a-sold@example.com" not in sent_to, (
        "sold outcome must skip the 24h follow-up"
    )
    assert "a-noshow@example.com" not in sent_to, (
        "no_show outcome must skip the 24h follow-up"
    )
    assert "a-showed@example.com" in sent_to, (
        "showed outcome still gets the generic follow-up"
    )
    assert "a-notsold@example.com" in sent_to, (
        "not_sold outcome still gets the generic follow-up"
    )
