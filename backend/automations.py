"""Automation jobs.

Eight idempotent async jobs that fire transactional emails based on
state in MongoDB. Each job stamps a flag on the row it just emailed,
so a re-run on the same dataset is a no-op. The four time-windowed
jobs (reminders, birthday window, enrolled welcome, stale lead alert)
are also driven by an APScheduler that ticks every 15 minutes.

Hooks for "fire on event" jobs:
  - run_new_lead_notification(db, lead_id)  — call from leads_router
    after a successful insert
  - run_soa_signed_notification(db, soa_id) — call from soa_router
    when a public SOA flips to signed

Idempotency: every email-sending path writes a flag (`*_sent` /
`*_notified`) BEFORE sending. If the write fails, the email isn't
sent. If the email fails, the flag stays set — we accept missed
emails over duplicate emails (the audit log captures the failure).
"""
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from encryption import safe_lead_load


logger = logging.getLogger(__name__)


# ── Shared helpers ───────────────────────────────────────────────────────
async def _agent_for(db, agent_id: Optional[str]) -> Optional[dict]:
    if not agent_id:
        return None
    return await db.users.find_one({"id": agent_id}, {"_id": 0})


def _frontend_url() -> str:
    from deps import get_frontend_url
    return get_frontend_url()


def _agent_phone(agent: dict) -> str:
    bs = agent.get("booking_settings") or {}
    return bs.get("phone_number") or agent.get("phone") or ""


def _booking_url(agent: dict) -> str:
    bs = agent.get("booking_settings") or {}
    slug = bs.get("slug")
    if not slug or not bs.get("is_enabled"):
        return ""
    return f"{_frontend_url()}/book/{slug}"


def _meeting_link(agent: dict, meeting_type: Optional[str]) -> str:
    bs = agent.get("booking_settings") or {}
    if (meeting_type or "").lower() == "video":
        return bs.get("video_link") or ""
    return _agent_phone(agent)


async def _audit(db, event: str, **fields):
    """Write an audit row. Never raises."""
    try:
        from deps import write_audit
        await write_audit(db, event, **fields)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("automation audit failed (%s): %s", event, e)


# ── 1. Birthday rule window ──────────────────────────────────────────────
async def run_birthday_window_automation(db) -> int:
    """Find IL leads whose birthday is exactly 45 days from today and
    fire the birthday-window email. Stamps `birthday_email_sent=True`
    so re-runs within the same window don't re-fire.

    Only fires for the current calendar year's birthday — the flag
    isn't cleared annually here; the next year's send is handled by
    a separate reset (or by clearing the flag manually). Acceptable
    tradeoff for the first version.
    """
    from email_templates import birthday_window_email
    from resend_client import send_email

    today = datetime.now(timezone.utc).date()
    window_start = today + timedelta(days=45)

    # Match leads whose DOB month+day equals window_start's month+day.
    # We don't have an indexed birthday field — scan IL leads and filter
    # in Python. IL is the only state with a birthday rule today so the
    # scan stays small.
    sent = 0
    cursor = db.leads.find({
        "state": "IL",
        "email": {"$nin": [None, ""]},
        "birthday_email_sent": {"$ne": True},
        "status": {"$nin": ["lost", "do_not_contact"]},
    }, {"_id": 0})

    async for raw in cursor:
        lead = safe_lead_load(raw)
        dob = lead.get("date_of_birth")
        if not dob or not isinstance(dob, str):
            continue
        try:
            head = dob.split("T", 1)[0]
            parts = head.split("-")
            if len(parts) != 3:
                continue
            month, day = int(parts[1]), int(parts[2])
        except (ValueError, IndexError):
            continue
        if month != window_start.month or day != window_start.day:
            continue

        agent = await _agent_for(db, lead.get("agent_id"))
        if not agent:
            continue
        client_email = (lead.get("email") or "").strip()
        if not client_email:
            continue

        # Flag-first idempotency: stamp BEFORE sending so a crashed
        # send can't loop and re-spam. Cost: a failed send means the
        # client never gets the email and never will (until the flag
        # is cleared manually). For a marketing nudge, this is the
        # right tradeoff.
        result = await db.leads.update_one(
            {"id": lead["id"], "birthday_email_sent": {"$ne": True}},
            {"$set": {"birthday_email_sent": True,
                      "birthday_email_at": datetime.now(timezone.utc).isoformat()}},
        )
        if result.modified_count == 0:
            continue   # racing tick beat us to it

        html = birthday_window_email(
            client_name=f"{lead.get('first_name','')} {lead.get('last_name','')}".strip()
                        or client_email,
            agent_name=agent.get("full_name") or "Your agent",
            agent_phone=_agent_phone(agent),
            agent_email=agent.get("email") or "",
            current_carrier=lead.get("current_carrier") or "",
            current_plan=lead.get("current_plan") or "",
            booking_url=_booking_url(agent),
        )
        ok = await send_email(
            to=client_email,
            subject="Your Medicare Birthday Rule window is opening",
            html=html,
            reply_to=agent.get("email"),
        )
        if ok:
            sent += 1
        await _audit(
            db, "automation_birthday_window_sent" if ok
            else "automation_birthday_window_failed",
            actor_email=agent.get("email"),
            actor_id=agent.get("id"),
            target_type="lead",
            target_id=lead["id"],
        )
    return sent


# ── 2. Enrolled welcome ──────────────────────────────────────────────────
async def run_enrolled_welcome_automation(db) -> int:
    """Find leads where status == 'enrolled' and welcome hasn't fired."""
    from email_templates import enrolled_welcome_email
    from resend_client import send_email

    sent = 0
    cursor = db.leads.find({
        "status": "enrolled",
        "email": {"$nin": [None, ""]},
        "enrolled_welcome_sent": {"$ne": True},
    }, {"_id": 0})

    async for raw in cursor:
        lead = safe_lead_load(raw)
        agent = await _agent_for(db, lead.get("agent_id"))
        if not agent:
            continue
        client_email = (lead.get("email") or "").strip()
        if not client_email:
            continue

        result = await db.leads.update_one(
            {"id": lead["id"], "enrolled_welcome_sent": {"$ne": True}},
            {"$set": {"enrolled_welcome_sent": True,
                      "enrolled_welcome_at": datetime.now(timezone.utc).isoformat()}},
        )
        if result.modified_count == 0:
            continue

        html = enrolled_welcome_email(
            client_name=f"{lead.get('first_name','')} {lead.get('last_name','')}".strip()
                        or client_email,
            agent_name=agent.get("full_name") or "Your agent",
            agent_phone=_agent_phone(agent),
            agent_email=agent.get("email") or "",
            plan_name=lead.get("current_plan") or lead.get("plan_type_premium") or "",
            carrier=lead.get("current_carrier") or "",
        )
        ok = await send_email(
            to=client_email,
            subject="Welcome — your enrollment is confirmed",
            html=html,
            reply_to=agent.get("email"),
        )
        if ok:
            sent += 1
        await _audit(
            db, "automation_enrolled_welcome_sent" if ok
            else "automation_enrolled_welcome_failed",
            actor_email=agent.get("email"),
            actor_id=agent.get("id"),
            target_type="lead", target_id=lead["id"],
        )
    return sent


# ── 3. New lead notification (event-driven) ──────────────────────────────
async def run_new_lead_notification(db, lead_id: str) -> bool:
    """Fire once per new lead. Called from leads_router after insert.

    Best-effort. Returns True on send, False on any failure path.
    """
    from email_templates import new_lead_agent_notification
    from resend_client import send_email

    if not lead_id:
        return False

    raw = await db.leads.find_one(
        {"id": lead_id, "new_lead_notified": {"$ne": True}},
        {"_id": 0},
    )
    if not raw:
        return False
    lead = safe_lead_load(raw)
    agent = await _agent_for(db, lead.get("agent_id"))
    if not agent or not agent.get("email"):
        return False

    # Flag-first idempotency.
    result = await db.leads.update_one(
        {"id": lead_id, "new_lead_notified": {"$ne": True}},
        {"$set": {"new_lead_notified": True,
                  "new_lead_notified_at": datetime.now(timezone.utc).isoformat()}},
    )
    if result.modified_count == 0:
        return False

    portal_url = f"{_frontend_url()}/clients/{lead_id}"
    html = new_lead_agent_notification(
        agent_name=agent.get("full_name") or "Agent",
        client_name=f"{lead.get('first_name','')} {lead.get('last_name','')}".strip()
                    or (lead.get("email") or "New lead"),
        client_phone=lead.get("phone") or "",
        client_email=lead.get("email") or "",
        product_interest=lead.get("product_interest") or "",
        portal_url=portal_url,
    )
    ok = await send_email(
        to=agent["email"],
        subject=f"New lead: {lead.get('first_name') or ''} {lead.get('last_name') or ''}".strip()
                or "New lead in your book",
        html=html,
    )
    await _audit(
        db, "automation_new_lead_notification_sent" if ok
        else "automation_new_lead_notification_failed",
        actor_email=agent.get("email"),
        actor_id=agent.get("id"),
        target_type="lead", target_id=lead_id,
    )
    return ok


# ── 4. Stale lead alerts ────────────────────────────────────────────────
_STALE_THRESHOLD_DAYS = 30
_STALE_CLOSED_STATUSES = {"enrolled", "lost", "do_not_contact", "not_interested"}


async def run_stale_lead_alerts(db) -> int:
    """One alert per agent per stale lead. 30-day threshold by default.

    Threshold is measured against `updated_at`. Closed statuses
    (enrolled, lost, etc.) are skipped.
    """
    from email_templates import stale_lead_agent_alert
    from resend_client import send_email

    cutoff = datetime.now(timezone.utc) - timedelta(days=_STALE_THRESHOLD_DAYS)
    cutoff_iso = cutoff.isoformat()

    sent = 0
    cursor = db.leads.find({
        "stale_alert_sent": {"$ne": True},
        "updated_at": {"$lte": cutoff_iso},
        "status": {"$nin": list(_STALE_CLOSED_STATUSES)},
        "agent_id": {"$nin": [None, ""]},
    }, {"_id": 0})

    async for raw in cursor:
        lead = safe_lead_load(raw)
        agent = await _agent_for(db, lead.get("agent_id"))
        if not agent or not agent.get("email"):
            continue

        # Calculate days since contact for the email copy.
        try:
            updated_at = datetime.fromisoformat(
                (lead.get("updated_at") or "").replace("Z", "+00:00"),
            )
            if updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=timezone.utc)
            days = (datetime.now(timezone.utc) - updated_at).days
        except Exception:
            days = _STALE_THRESHOLD_DAYS

        result = await db.leads.update_one(
            {"id": lead["id"], "stale_alert_sent": {"$ne": True}},
            {"$set": {"stale_alert_sent": True,
                      "stale_alert_at": datetime.now(timezone.utc).isoformat()}},
        )
        if result.modified_count == 0:
            continue

        portal_url = f"{_frontend_url()}/clients/{lead['id']}"
        html = stale_lead_agent_alert(
            agent_name=agent.get("full_name") or "Agent",
            client_name=f"{lead.get('first_name','')} {lead.get('last_name','')}".strip()
                        or (lead.get("email") or "Lead"),
            client_phone=lead.get("phone") or "",
            days_since_contact=max(days, _STALE_THRESHOLD_DAYS),
            portal_url=portal_url,
        )
        ok = await send_email(
            to=agent["email"],
            subject=f"Stale lead reminder: {lead.get('first_name','')} "
                    f"{lead.get('last_name','')}".strip()
                    or "Stale lead in your book",
            html=html,
        )
        if ok:
            sent += 1
        await _audit(
            db, "automation_stale_lead_sent" if ok else "automation_stale_lead_failed",
            actor_email=agent.get("email"),
            actor_id=agent.get("id"),
            target_type="lead", target_id=lead["id"],
        )
    return sent


# ── 5. Appointment reminders (48 / 24 / 1 hour) ──────────────────────────
async def _send_reminder(db, appt: dict, hours_before: int,
                          flag_field: str) -> bool:
    """Shared per-reminder send. Flag-first idempotency on the
    appointment row."""
    from email_templates import reminder_email
    from resend_client import send_email

    client_email = (appt.get("client_email") or "").strip()
    if not client_email:
        # Nothing to send — stamp so we don't recheck on every tick.
        await db.appointments.update_one(
            {"appointment_id": appt["appointment_id"]},
            {"$set": {flag_field: True}},
        )
        return False

    agent = await _agent_for(db, appt.get("agent_id"))
    if not agent:
        return False

    result = await db.appointments.update_one(
        {"appointment_id": appt["appointment_id"], flag_field: {"$ne": True}},
        {"$set": {flag_field: True,
                  f"{flag_field}_at": datetime.now(timezone.utc).isoformat()}},
    )
    if result.modified_count == 0:
        return False

    from booking_router import _format_date, _format_time
    html = reminder_email(
        client_name=appt.get("client_name") or "there",
        agent_name=agent.get("full_name") or "Your agent",
        agent_phone=_agent_phone(agent),
        date_str=_format_date(appt["appointment_date"]),
        time_str=_format_time(appt["appointment_time"]),
        meeting_type=appt.get("meeting_type") or "phone",
        meeting_link=_meeting_link(agent, appt.get("meeting_type")),
        hours_before=hours_before,
    )
    subject = (
        "Your appointment is in 1 hour" if hours_before < 12
        else "Your appointment is tomorrow" if hours_before < 36
        else "Your appointment is in 2 days"
    )
    ok = await send_email(
        to=client_email,
        subject=subject,
        html=html,
        reply_to=agent.get("email"),
    )
    await _audit(
        db, f"automation_reminder_{hours_before}h_sent" if ok
        else f"automation_reminder_{hours_before}h_failed",
        actor_email=agent.get("email"),
        actor_id=agent.get("id"),
        target_type="appointment", target_id=appt["appointment_id"],
    )
    return ok


def _appt_datetime(appt: dict) -> Optional[datetime]:
    try:
        y, mo, d = (int(p) for p in appt["appointment_date"].split("-"))
        hh, mm = (int(p) for p in appt["appointment_time"].split(":"))
        return datetime(y, mo, d, hh, mm, tzinfo=timezone.utc)
    except Exception:
        return None


async def run_appointment_reminders(db) -> int:
    """Check upcoming appointments and fire any reminder that's due.

    Windows:
      - 48-hour: appt is 47.5–49h from now, reminder_48hr_sent=False
      - 24-hour: appt is 23.5–25h from now, reminder_24hr_sent=False
      - 1-hour:  appt is 0.5–1.5h from now, reminder_1hr_sent=False

    The windows are slightly wider than the spec headline so a 15-min
    scheduler tick always catches the appointment exactly once.
    """
    sent = 0
    now = datetime.now(timezone.utc)
    # Look at any future appointment in the next ~50 hours.
    upcoming_cutoff = now + timedelta(hours=50)

    cursor = db.appointments.find({
        "status": "scheduled",
        "appointment_date": {
            "$gte": now.date().isoformat(),
            "$lte": upcoming_cutoff.date().isoformat(),
        },
    }, {"_id": 0})

    async for appt in cursor:
        dt = _appt_datetime(appt)
        if not dt:
            continue
        delta_hours = (dt - now).total_seconds() / 3600.0
        if delta_hours <= 0:
            continue
        # 48hr window
        if 47.5 <= delta_hours <= 49.0 and not appt.get("reminder_48hr_sent"):
            if await _send_reminder(db, appt, 48, "reminder_48hr_sent"):
                sent += 1
        # 24hr window
        elif 23.5 <= delta_hours <= 25.0 and not appt.get("reminder_24hr_sent"):
            if await _send_reminder(db, appt, 24, "reminder_24hr_sent"):
                sent += 1
        # 1hr window
        elif 0.5 <= delta_hours <= 1.5 and not appt.get("reminder_1hr_sent"):
            if await _send_reminder(db, appt, 1, "reminder_1hr_sent"):
                sent += 1
    return sent


# ── 6. Post-appointment follow-up ────────────────────────────────────────
async def run_post_appointment_followup(db) -> int:
    """Send a follow-up email 24h after the appointment time.

    Includes both `status=completed` and appointments whose scheduled
    time is 24-25 hours in the past (catches no-shows where the agent
    forgot to mark status).
    """
    from email_templates import post_appointment_followup
    from resend_client import send_email

    sent = 0
    now = datetime.now(timezone.utc)
    cutoff_start = now - timedelta(hours=25)
    cutoff_end = now - timedelta(hours=24)

    cursor = db.appointments.find({
        "followup_sent": {"$ne": True},
        "client_email": {"$nin": [None, ""]},
        "appointment_date": {
            "$gte": cutoff_start.date().isoformat(),
            "$lte": cutoff_end.date().isoformat(),
        },
    }, {"_id": 0})

    async for appt in cursor:
        dt = _appt_datetime(appt)
        if not dt:
            continue
        hours_ago = (now - dt).total_seconds() / 3600.0
        if not (24.0 <= hours_ago <= 25.0):
            continue
        # Exclude cancelled — completed and no_show are valid for follow-up.
        if appt.get("status") == "cancelled":
            continue

        agent = await _agent_for(db, appt.get("agent_id"))
        if not agent:
            continue

        result = await db.appointments.update_one(
            {"appointment_id": appt["appointment_id"], "followup_sent": {"$ne": True}},
            {"$set": {"followup_sent": True,
                      "followup_at": now.isoformat()}},
        )
        if result.modified_count == 0:
            continue

        html = post_appointment_followup(
            client_name=appt.get("client_name") or "there",
            agent_name=agent.get("full_name") or "Your agent",
            agent_phone=_agent_phone(agent),
            agent_email=agent.get("email") or "",
            booking_reason=appt.get("booking_reason") or "",
        )
        ok = await send_email(
            to=appt["client_email"],
            subject="Following up on our call",
            html=html,
            reply_to=agent.get("email"),
        )
        if ok:
            sent += 1
        await _audit(
            db, "automation_followup_sent" if ok else "automation_followup_failed",
            actor_email=agent.get("email"),
            actor_id=agent.get("id"),
            target_type="appointment", target_id=appt["appointment_id"],
        )
    return sent


# ── 7. SOA signed notification (event-driven) ────────────────────────────
async def run_soa_signed_notification(db, soa_id: str) -> bool:
    """Notify the agent the client just signed their SOA.

    Best-effort, one-time fire per soa row. Stamps
    `soa_agent_notified=True` so re-runs skip.
    """
    from resend_client import send_email

    if not soa_id:
        return False

    soa = await db.soa_records.find_one(
        {"id": soa_id, "soa_agent_notified": {"$ne": True}},
        {"_id": 0},
    )
    if not soa:
        return False
    if soa.get("status") != "signed":
        return False

    agent = await _agent_for(db, soa.get("agent_id"))
    if not agent or not agent.get("email"):
        return False

    result = await db.soa_records.update_one(
        {"id": soa_id, "soa_agent_notified": {"$ne": True}},
        {"$set": {"soa_agent_notified": True,
                  "soa_agent_notified_at": datetime.now(timezone.utc).isoformat()}},
    )
    if result.modified_count == 0:
        return False

    signed_name = soa.get("signed_name") or "Your client"
    portal_url = f"{_frontend_url()}/clients/{soa.get('lead_id') or ''}"
    # Lightweight inline html — this one isn't part of the 8 template
    # functions because it's an internal-facing one-liner.
    html = f"""
      <p>Hi {agent.get('full_name', 'there')},</p>
      <p><strong>{signed_name}</strong> just signed their Scope of
         Appointment. You're cleared to discuss the products listed
         on the SOA.</p>
      <p><a href="{portal_url}">Open client profile</a></p>
    """
    ok = await send_email(
        to=agent["email"],
        subject=f"SOA signed: {signed_name}",
        html=html,
    )
    await _audit(
        db, "automation_soa_signed_sent" if ok else "automation_soa_signed_failed",
        actor_email=agent.get("email"),
        actor_id=agent.get("id"),
        target_type="soa", target_id=soa_id,
    )
    return ok


# ── 8. Daily agent brief (AI priority list) ─────────────────────────────
# Heuristic urgency model. Each rule adds points; the final score is
# clamped to 0-100 and stamped onto the lead row as `ai_score` so the
# Clients list can sort by it without re-running this loop.

_BRIEF_SKIP_STATUSES = {"enrolled", "lost", "do_not_contact",
                         "not_interested", "inactive", "dnc"}
_AEP_START = (10, 15)   # Oct 15
_AEP_END = (12, 7)      # Dec 7
_TOP_N = 10


def _parse_lead_dob(s):
    """Tolerant DOB → date. Returns None on any failure."""
    if not s or not isinstance(s, str):
        return None
    try:
        head = s.split("T", 1)[0].split(" ", 1)[0]
        if "/" in head:
            mm, dd, yyyy = head.split("/")
            return datetime(int(yyyy), int(mm), int(dd)).date()
        parts = head.split("-")
        if len(parts) == 3:
            return datetime(int(parts[0]), int(parts[1]), int(parts[2])).date()
    except Exception:
        return None
    return None


def _parse_lead_updated(s):
    if not s or not isinstance(s, str):
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _in_aep(today) -> bool:
    """True when today is inside AEP (Oct 15 – Dec 7)."""
    m, d = today.month, today.day
    if (m, d) < _AEP_START:
        return False
    if (m, d) > _AEP_END:
        return False
    return True


def _next_birthday(dob, today):
    try:
        candidate = dob.replace(year=today.year)
    except ValueError:
        candidate = datetime(today.year, 2, 28).date()
    if candidate < today:
        try:
            candidate = dob.replace(year=today.year + 1)
        except ValueError:
            candidate = datetime(today.year + 1, 2, 28).date()
    return candidate


def compute_lead_urgency(lead: dict, today=None) -> dict:
    """Return ``{score, reasons, urgency_level, primary_reason}`` for a
    single lead. Pure function — no IO — so it can be unit tested and
    re-used by both the daily brief and the nightly ``ai_score`` stamp.

    ``urgency_level`` is one of: urgent (75+), high (50-74),
    moderate (25-49), low (<25).
    """
    if today is None:
        today = datetime.now(timezone.utc).date()

    score = 0
    reasons = []

    dob = _parse_lead_dob(lead.get("date_of_birth"))
    state = (lead.get("state") or "").upper()
    tags = set(lead.get("tags") or [])
    status = (lead.get("status") or "").lower()
    updated = _parse_lead_updated(lead.get("updated_at"))
    created = _parse_lead_updated(lead.get("created_at"))
    contacted_at = _parse_lead_updated(lead.get("last_contacted_at"))

    # Birthday window — IL is the only state that runs the rule today.
    if dob and state == "IL":
        try:
            this_year_bday = dob.replace(year=today.year)
        except ValueError:
            this_year_bday = datetime(today.year, 2, 28).date()
        # Window open: today is within 63 days of this year's birthday.
        days_into_window = (today - this_year_bday).days
        if 0 <= days_into_window <= 63:
            score += 40
            reasons.append("Birthday window OPEN — call today")
        else:
            nb = _next_birthday(dob, today)
            days_until = (nb - today).days
            if 0 < days_until <= 30:
                score += 25
                reasons.append(
                    f"Birthday window opens in {days_until} days",
                )

    # AEP
    if _in_aep(today):
        score += 20
        reasons.append("AEP open enrollment season")

    # Contact recency — compare against the ``today`` argument so the
    # function is fully deterministic for unit tests + for the daily-
    # brief tick that pins a single "today" across the agent's run.
    last_touch = contacted_at or updated
    today_dt = datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
    if last_touch:
        days_since = (today_dt - last_touch).days
        if days_since > 60:
            score += 25
            reasons.append(f"{days_since} days since contact — going cold")
        elif days_since > 30:
            score += 15
            reasons.append(f"{days_since} days since contact")
    if not contacted_at and not updated and created:
        score += 30
        reasons.append("Never contacted")
    elif not last_touch:
        score += 30
        reasons.append("No contact record")

    # Turning 65 in 90 days
    if dob:
        try:
            sixty_fifth = dob.replace(year=dob.year + 65)
            days_to_65 = (sixty_fifth - today).days
            if 0 <= days_to_65 <= 90:
                score += 30
                reasons.append(f"Turning 65 in {days_to_65} days")
        except ValueError:
            pass

    # Employer transition tag
    transition_tags = {
        "employer-transition", "leaving-employer", "retiring-soon",
        "cobra-ending",
    }
    if tags & transition_tags:
        score += 25
        reasons.append("Transitioning from employer coverage")

    # CNA completed (signals ready for formal recommendation)
    if lead.get("_cna_completed"):
        score += 10
        reasons.append("CNA on file — ready to recommend")

    # SOA signed but not enrolled
    if lead.get("soa_signed") and status not in ("enrolled",):
        score += 25
        reasons.append("SOA signed — awaiting enrollment")

    score = max(0, min(100, score))
    if score >= 75:
        level = "urgent"
    elif score >= 50:
        level = "high"
    elif score >= 25:
        level = "moderate"
    else:
        level = "low"
    primary = reasons[0] if reasons else "Routine follow-up"
    return {
        "score": score,
        "reasons": reasons,
        "urgency_level": level,
        "primary_reason": primary,
    }


async def _agent_lead_cursor(db, agent_id: str):
    """Iterate over an agent's open leads (status not closed)."""
    return db.leads.find({
        "agent_id": agent_id,
        "status": {"$nin": list(_BRIEF_SKIP_STATUSES)},
    }, {"_id": 0})


async def _completed_cna_lead_ids(db, agent_id: str) -> set:
    """Set of lead_ids where the agent has a saved CNA. Used to add
    the "+10 CNA completed" bonus without an N+1 lookup per lead."""
    out = set()
    try:
        cursor = db.cna_assessments.find(
            {"agent_id": agent_id, "completed_at": {"$exists": True}},
            {"_id": 0, "lead_id": 1},
        )
        async for row in cursor:
            lid = row.get("lead_id")
            if lid:
                out.add(lid)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("brief: cna lookup failed: %s", e)
    return out


async def build_brief_for_agent(
    db, agent: dict, persist: bool = True,
) -> dict:
    """Compute today's prioritized call list for a single agent.

    Returns the brief dict (also written to ``db.agent_daily_briefs``
    when ``persist=True``). Each lead's score is also stamped onto
    the lead itself as ``ai_score`` + ``ai_score_reason`` +
    ``ai_score_updated`` so the Clients list can sort by it.
    """
    today = datetime.now(timezone.utc).date()
    today_str = today.strftime("%Y-%m-%d")

    cna_lead_ids = await _completed_cna_lead_ids(db, agent["id"])

    scored: list = []
    cursor = await _agent_lead_cursor(db, agent["id"])
    now_iso = datetime.now(timezone.utc).isoformat()
    async for raw in cursor:
        lead = safe_lead_load(raw)
        lead["_cna_completed"] = lead.get("id") in cna_lead_ids
        verdict = compute_lead_urgency(lead, today=today)
        # Stamp the score on the lead row so the Clients list can sort
        # by it without re-running the heuristic per request.
        try:
            await db.leads.update_one(
                {"id": lead["id"]},
                {"$set": {
                    "ai_score": verdict["score"],
                    "ai_score_reason": verdict["primary_reason"],
                    "ai_score_updated": now_iso,
                }},
            )
        except Exception as e:                                # noqa: BLE001
            logger.warning("brief: ai_score stamp failed: %s", e)
        if verdict["score"] <= 0:
            continue
        full_name = (
            f"{lead.get('first_name', '')} {lead.get('last_name', '')}".strip()
            or lead.get("email") or "Unknown"
        )
        scored.append({
            "lead_id": lead.get("id"),
            "name": full_name,
            "phone": lead.get("phone") or "",
            "email": lead.get("email") or "",
            "score": verdict["score"],
            "urgency_level": verdict["urgency_level"],
            "reason": verdict["primary_reason"],
            "reasons": verdict["reasons"][:4],
        })

    scored.sort(key=lambda r: r["score"], reverse=True)
    top = scored[:_TOP_N]
    total_urgent = sum(1 for r in scored if r["urgency_level"] == "urgent")
    total_priority = sum(1 for r in scored if r["score"] >= 50)

    brief = {
        "agent_id": agent["id"],
        "date": today_str,
        "generated_at": now_iso,
        "top_calls": top,
        "total_urgent": total_urgent,
        "total_priority": total_priority,
    }

    if persist:
        try:
            await db.agent_daily_briefs.update_one(
                {"agent_id": agent["id"], "date": today_str},
                {"$set": brief},
                upsert=True,
            )
        except Exception as e:                                # noqa: BLE001
            logger.warning("brief: persist failed: %s", e)

    return brief


async def run_daily_agent_brief(db) -> int:
    """Build today's brief for every active agent and email the top
    calls. Returns the number of briefs generated."""
    from email_templates import daily_brief_email
    from resend_client import send_email

    portal_url = _frontend_url()
    generated = 0
    cursor = db.users.find({
        "is_active": True,
        "status": "active",
        "role": {"$in": ["agent", "admin", "owner"]},
    }, {"_id": 0})

    async for agent in cursor:
        try:
            brief = await build_brief_for_agent(db, agent, persist=True)
        except Exception as e:                                # noqa: BLE001
            logger.exception("brief: build failed for %s: %s",
                              agent.get("email"), e)
            continue
        generated += 1

        # Email when the agent has any priority calls (50+). Empty
        # briefs are kept in the DB but not emailed — agents don't
        # need a "you're caught up" daily nag.
        if not brief["top_calls"]:
            continue
        if not agent.get("email"):
            continue

        try:
            html = daily_brief_email(
                agent_name=agent.get("full_name") or "Agent",
                date_str=brief["date"],
                top_calls=brief["top_calls"],
                portal_url=portal_url,
            )
            ok = await send_email(
                to=agent["email"],
                subject=f"Your Medicare Priority List — {brief['date']}",
                html=html,
                agency_id=agent.get("agency_id"),
                agent_id=agent.get("id"),
            )
            await _audit(
                db, "automation_daily_brief_sent" if ok
                else "automation_daily_brief_failed",
                actor_email=agent.get("email"),
                actor_id=agent.get("id"),
                target_type="user", target_id=agent.get("id"),
                metadata={"top_count": len(brief["top_calls"]),
                          "urgent": brief["total_urgent"]},
            )
        except Exception as e:                                # noqa: BLE001
            logger.warning("brief: email failed for %s: %s",
                            agent.get("email"), e)
    return generated


# ── Scheduler ────────────────────────────────────────────────────────────
# The daily brief job runs at 12:00 UTC (7am CT) every day. We use a
# dedicated CronTrigger rather than piggy-backing on the 15-min tick so
# the brief fires exactly once per day even after a scheduler restart.

def start_automation_scheduler(get_db_fn):
    """15-min IntervalTrigger that runs the time-windowed jobs + a
    daily CronTrigger at 12:00 UTC for the agent brief.

    Disabled when DISABLE_SCHEDULER=1 (set in conftest.py so pytest
    never starts background timers). max_instances=1 prevents
    overlapping runs if a single tick exceeds 15 minutes.
    """
    if os.getenv("DISABLE_SCHEDULER", "").strip() == "1":
        logger.info("automations: scheduler disabled via DISABLE_SCHEDULER")
        return None

    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger

    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _tick():
        db = get_db_fn()
        for name, fn in (
            ("appointment_reminders", run_appointment_reminders),
            ("birthday_window", run_birthday_window_automation),
            ("enrolled_welcome", run_enrolled_welcome_automation),
            ("stale_lead_alerts", run_stale_lead_alerts),
            ("post_appointment_followup", run_post_appointment_followup),
        ):
            try:
                count = await fn(db)
                if count:
                    logger.info("automation %s sent %d", name, count)
            except Exception as e:                            # noqa: BLE001
                logger.exception("automation %s failed: %s", name, e)

        # AI security loop. Lazy-imported so an import-time failure in
        # security_intelligence (e.g. a missing optional dep) can't break
        # the marketing/reminder automations above. Always wrapped — the
        # function is documented as never-raises but defense in depth.
        try:
            from security_intelligence import run_ai_security_analysis
            summary = await run_ai_security_analysis(db, db)
            if summary and summary.get("threat_level") not in (None, "low", "unknown"):
                logger.info(
                    "ai_security tick: threat=%s findings=%d auto_actions=%d",
                    summary.get("threat_level"),
                    summary.get("findings_count", 0),
                    len(summary.get("auto_actions") or []),
                )
        except Exception as e:                                # noqa: BLE001
            logger.exception("ai_security tick failed: %s", e)

    async def _daily_brief_tick():
        try:
            count = await run_daily_agent_brief(get_db_fn())
            logger.info("automation daily_brief generated %d", count)
        except Exception as e:                                # noqa: BLE001
            logger.exception("automation daily_brief failed: %s", e)

    scheduler.add_job(
        _tick,
        trigger=IntervalTrigger(minutes=15),
        id="automations_tick",
        max_instances=1,
        next_run_time=datetime.now(timezone.utc),
        replace_existing=True,
    )
    # 12:00 UTC = 7:00 AM Central (standard time). MVP runs at a single
    # cron time for all agents; per-timezone splits can come later when
    # the team is more than one US time zone.
    scheduler.add_job(
        _daily_brief_tick,
        trigger=CronTrigger(hour=12, minute=0, timezone="UTC"),
        id="daily_agent_brief",
        max_instances=1,
        replace_existing=True,
    )
    scheduler.start()
    logger.info("automations: scheduler started (15-min interval + daily brief 12:00 UTC)")
    return scheduler
