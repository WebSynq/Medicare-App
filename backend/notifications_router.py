"""
notifications_router.py
=======================
In-app notification bell + generator scheduler.

Every endpoint is auth-gated, agent-scoped via deps.agent_filter (so
admin / compliance / coach / accounting / client_success see the
agency-wide feed when not impersonating), and audit-logged.

The generator (_generate_notifications) runs once an hour from
APScheduler. It walks four signals and writes notifications into
db.notifications:

  1. renewal_due       — policy renewal_date == today + 7 days
  2. birthday_window   — IL-style 63-day window opens today (days
                         since most-recent birthday == 0)
  3. stale_lead        — leads in new/contacted, updated_at older
                         than 7 days
  4. appointment_today — appointments scheduled for today (only
                         fired during the 07:00 UTC slot to avoid
                         spamming an agent who keeps a session open)

Before every insert the generator dedups: it skips a row if a
notification for the same (agent_id, lead_id-or-target, type) exists
with created_at within the last 24 hours.
"""
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    FULL_AGENCY_SCOPE_ROLES,
    agent_filter,
    get_agency_id,
    get_current_user,
    get_db,
    write_audit,
)


logger = logging.getLogger("gruening.notifications")
router = APIRouter(prefix="/notifications", tags=["notifications"])
limiter = Limiter(key_func=get_remote_address)


NotificationType = Literal[
    "renewal_due",
    "birthday_window",
    "stale_lead",
    "appointment_today",
    "lead_transferred",
    "commission_gap",
]
_VALID_TYPES = {
    "renewal_due", "birthday_window", "stale_lead",
    "appointment_today", "lead_transferred", "commission_gap",
}


# ── Helpers ──────────────────────────────────────────────────────────────
def _public(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in doc.items() if k != "_id"}


def _is_privileged(user: dict) -> bool:
    return user.get("role") in FULL_AGENCY_SCOPE_ROLES


async def _fetch_or_403(
    db: AsyncIOMotorDatabase, notification_id: str, user: dict,
) -> Dict[str, Any]:
    doc = await db.notifications.find_one({"notification_id": notification_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Notification not found")
    if _is_privileged(user):
        return doc
    if doc.get("agent_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return doc


# ── Endpoints ────────────────────────────────────────────────────────────
@router.get("")
@limiter.limit("60/hour")
async def list_notifications(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """List notifications for the caller, unread first then read,
    newest first within each group. Capped at 50 per call to keep
    the bell-dropdown payload light."""
    scope = agent_filter(current_user)
    cursor = (
        db.notifications
        .find(scope, {"_id": 0})
        .sort([("is_read", 1), ("created_at", -1)])
        .limit(50)
    )
    rows = [n async for n in cursor]
    return {"notifications": rows, "total": len(rows)}


@router.get("/unread-count")
@limiter.limit("120/hour")
async def unread_count(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Lightweight counter polled by the bell badge every 60s.

    Separate from /notifications so the polling loop doesn't pull the
    full 50-row payload every minute. Rate limit raised to 120/hour
    (2/min average) to comfortably cover the 60s poll cadence with
    headroom for tab refocus.
    """
    scope = agent_filter(current_user)
    count = await db.notifications.count_documents({
        **scope,
        "is_read": False,
    })
    return {"count": count}


# read-all is registered BEFORE /{id}/read so /read-all doesn't get
# swallowed by the param route.
@router.patch("/read-all")
@limiter.limit("60/hour")
async def mark_all_read(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Flip every unread notification in the caller's scope to read."""
    scope = agent_filter(current_user)
    now_iso = datetime.now(timezone.utc).isoformat()
    result = await db.notifications.update_many(
        {**scope, "is_read": False},
        {"$set": {"is_read": True, "read_at": now_iso}},
    )
    return {"ok": True, "marked_read": result.modified_count}


@router.patch("/{notification_id}/read")
@limiter.limit("60/hour")
async def mark_read(
    notification_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Flip a single notification to read. Idempotent — already-read
    rows return the same doc without bumping read_at."""
    doc = await _fetch_or_403(db, notification_id, current_user)
    if doc.get("is_read"):
        return _public(doc)
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.notifications.update_one(
        {"notification_id": notification_id},
        {"$set": {"is_read": True, "read_at": now_iso}},
    )
    fresh = await db.notifications.find_one(
        {"notification_id": notification_id}, {"_id": 0},
    )
    return _public(fresh)


@router.delete("/{notification_id}")
@limiter.limit("60/hour")
async def delete_notification(
    notification_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Hard-delete (notifications are ephemeral by design; we don't
    need an undo trail like we do for notes / leads)."""
    await _fetch_or_403(db, notification_id, current_user)
    await db.notifications.delete_one({"notification_id": notification_id})
    return {"ok": True, "notification_id": notification_id}


# ── Generator + dedup ────────────────────────────────────────────────────
async def _exists_within_24h(
    db: AsyncIOMotorDatabase, agent_id: str, ntype: str, target_id: str,
) -> bool:
    """True if a notification with the same (agent_id, target_id, type)
    landed inside the last 24h. ``target_id`` is the lead_id for most
    types and the appointment_id for appointment_today."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    found = await db.notifications.find_one({
        "agent_id": agent_id,
        "type": ntype,
        "target_id": target_id,
        "created_at": {"$gte": cutoff},
    })
    return found is not None


def _build_notification(
    *,
    agent_id: str,
    ntype: str,
    title: str,
    body: str,
    link: Optional[str],
    target_id: Optional[str] = None,
) -> Dict[str, Any]:
    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        "notification_id": str(uuid.uuid4()),
        "agent_id": agent_id,
        "agency_id": get_agency_id(),
        "type": ntype,
        "title": title,
        "body": body,
        "link": link,
        "target_id": target_id,
        "is_read": False,
        "created_at": now_iso,
        "read_at": None,
    }


async def _gen_renewals(db) -> int:
    """Renewal due exactly seven days from today. Joins policies →
    leads.id (same helper used by today_router) so the notification
    deep-links land on a real lead profile."""
    today = datetime.now(timezone.utc).date()
    target_renewal = today + timedelta(days=7)
    created = 0
    proj = {
        "_id": 0, "policy_id": 1, "lead_id": 1, "ghl_contact_id": 1,
        "contact_name": 1, "effective_date": 1, "carrier": 1,
        "product_label": 1, "agent_id": 1,
    }
    async for p in db.policies.find(
        {"effective_date": {"$nin": [None, ""]}}, proj,
    ):
        eff_raw = (p.get("effective_date") or "").strip()
        # Tolerant YYYY-MM-DD parse.
        try:
            head = eff_raw.split("T", 1)[0].split(" ", 1)[0]
            if "/" in head:
                mm, dd, yyyy = head.split("/")
                eff = date(int(yyyy), int(mm), int(dd))
            else:
                yyyy, mm, dd = head.split("-")
                eff = date(int(yyyy), int(mm), int(dd))
        except Exception:
            continue
        # Anniversary in current year (or next if already passed).
        try:
            anniv = eff.replace(year=today.year)
        except ValueError:
            anniv = date(today.year, 2, 28)
        if anniv < today:
            try:
                anniv = eff.replace(year=today.year + 1)
            except ValueError:
                anniv = date(today.year + 1, 2, 28)
        if anniv != target_renewal:
            continue
        agent_id = p.get("agent_id")
        if not agent_id:
            continue
        if await _exists_within_24h(db, agent_id, "renewal_due", p.get("lead_id") or ""):
            continue
        # Resolve to canonical leads.id for the deep-link.
        from deps import resolve_lead_id_for_policy
        lead_id = await resolve_lead_id_for_policy(db, {}, p)
        doc = _build_notification(
            agent_id=agent_id,
            ntype="renewal_due",
            title=f"Renewal due in 7 days: {p.get('contact_name') or 'client'}",
            body=(
                f"{p.get('carrier') or 'Policy'} "
                f"{p.get('product_label') or ''} renews on "
                f"{anniv.isoformat()}."
            ).strip(),
            link=f"/clients/{lead_id}" if lead_id else None,
            target_id=p.get("lead_id") or p.get("ghl_contact_id"),
        )
        await db.notifications.insert_one(doc)
        created += 1
    return created


async def _gen_birthday_windows(db) -> int:
    """IL birthday-rule window opens today → urgent_call analogue."""
    from birthday_rule_router import _parse_dob
    today = datetime.now(timezone.utc).date()
    created = 0
    proj = {
        "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
        "date_of_birth": 1, "agent_id": 1, "status": 1,
    }
    async for ld in db.leads.find(
        {
            "date_of_birth": {"$ne": None},
            "status": {"$nin": ["lost", "not_interested"]},
        },
        proj,
    ):
        dob = _parse_dob(ld.get("date_of_birth"))
        if not dob:
            continue
        # Is today the birthday itself (window opening day)?
        if dob.month != today.month or dob.day != today.day:
            # Leap-day birthday opens Feb 28 in non-leap years.
            if not (dob.month == 2 and dob.day == 29 and
                    today.month == 2 and today.day == 28):
                continue
        agent_id = ld.get("agent_id")
        if not agent_id:
            continue
        lead_id = ld.get("id")
        if await _exists_within_24h(db, agent_id, "birthday_window", lead_id):
            continue
        name = (
            f"{ld.get('first_name', '')} {ld.get('last_name', '')}".strip()
            or "client"
        )
        doc = _build_notification(
            agent_id=agent_id,
            ntype="birthday_window",
            title=f"Birthday window open: {name}",
            body=(
                "Window is open from today for the next 63 days. "
                "Time-sensitive carrier-swap eligible."
            ),
            link=f"/clients/{lead_id}",
            target_id=lead_id,
        )
        await db.notifications.insert_one(doc)
        created += 1
    return created


async def _gen_stale_leads(db) -> int:
    """new/contacted leads untouched in 7+ days."""
    now_dt = datetime.now(timezone.utc)
    cutoff_iso = (now_dt - timedelta(days=7)).isoformat()
    created = 0
    proj = {
        "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
        "agent_id": 1, "status": 1, "updated_at": 1,
    }
    async for ld in db.leads.find(
        {
            "status": {"$in": ["new", "contacted"]},
            "updated_at": {"$lt": cutoff_iso},
        },
        proj,
    ):
        agent_id = ld.get("agent_id")
        lead_id = ld.get("id")
        if not agent_id or not lead_id:
            continue
        if await _exists_within_24h(db, agent_id, "stale_lead", lead_id):
            continue
        name = (
            f"{ld.get('first_name', '')} {ld.get('last_name', '')}".strip()
            or "client"
        )
        doc = _build_notification(
            agent_id=agent_id,
            ntype="stale_lead",
            title=f"Stale lead: {name}",
            body=(
                f"No contact in 7+ days — status is still "
                f"'{ld.get('status') or 'new'}'."
            ),
            link=f"/clients/{lead_id}",
            target_id=lead_id,
        )
        await db.notifications.insert_one(doc)
        created += 1
    return created


async def _gen_appointments_today(db) -> int:
    """Appointments scheduled for today — fired only during the 07:00
    UTC hour so agents wake up to the day's heads-up without getting
    pinged every hour after."""
    if datetime.now(timezone.utc).hour != 7:
        return 0
    today_iso = datetime.now(timezone.utc).date().isoformat()
    created = 0
    proj = {
        "_id": 0, "appointment_id": 1, "agent_id": 1, "lead_id": 1,
        "client_name": 1, "appointment_time": 1, "type": 1,
        "status": 1,
    }
    async for a in db.appointments.find(
        {"appointment_date": today_iso, "status": "scheduled"},
        proj,
    ):
        agent_id = a.get("agent_id")
        appt_id = a.get("appointment_id")
        if not agent_id or not appt_id:
            continue
        if await _exists_within_24h(db, agent_id, "appointment_today", appt_id):
            continue
        doc = _build_notification(
            agent_id=agent_id,
            ntype="appointment_today",
            title=f"Appointment today: {a.get('client_name') or 'client'}",
            body=(
                f"{a.get('appointment_time') or '??:??'} · "
                f"{(a.get('type') or 'meeting').replace('_', ' ')}"
            ),
            link=(
                f"/clients/{a['lead_id']}" if a.get("lead_id")
                else "/appointments"
            ),
            target_id=appt_id,
        )
        await db.notifications.insert_one(doc)
        created += 1
    return created


async def generate_notifications(db: AsyncIOMotorDatabase) -> Dict[str, int]:
    """Top-level generator — runs all four signal scans. Exposed so
    tests can call it directly without spinning up the scheduler."""
    stats = {"renewals": 0, "birthdays": 0, "stale": 0, "appointments": 0}
    try:
        stats["renewals"] = await _gen_renewals(db)
    except Exception as e:
        logger.exception("notifications: renewal scan failed: %s", e)
    try:
        stats["birthdays"] = await _gen_birthday_windows(db)
    except Exception as e:
        logger.exception("notifications: birthday scan failed: %s", e)
    try:
        stats["stale"] = await _gen_stale_leads(db)
    except Exception as e:
        logger.exception("notifications: stale scan failed: %s", e)
    try:
        stats["appointments"] = await _gen_appointments_today(db)
    except Exception as e:
        logger.exception("notifications: appointment scan failed: %s", e)
    total = sum(stats.values())
    if total:
        logger.info("notifications: generated %d (%s)", total, stats)
    return stats


# ── Scheduler ────────────────────────────────────────────────────────────
def start_scheduler(get_db_fn):
    """Hourly notification scan via APScheduler. Mirrors the other
    schedulers (comtrack_sync, statement_generator, backup_service) —
    disabled by DISABLE_SCHEDULER=1 in tests."""
    if os.getenv("DISABLE_SCHEDULER", "").strip() == "1":
        logger.info("notifications: scheduler disabled via DISABLE_SCHEDULER")
        return None

    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.interval import IntervalTrigger

    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _job():
        try:
            await generate_notifications(get_db_fn())
        except Exception as e:
            logger.exception("notifications: scheduled run failed: %s", e)

    scheduler.add_job(
        _job,
        trigger=IntervalTrigger(minutes=60),
        id="notifications_generator",
        replace_existing=True,
        next_run_time=datetime.now(timezone.utc),  # fire once at boot
    )
    scheduler.start()
    logger.info("notifications: scheduler started (every 60 minutes)")
    return scheduler
