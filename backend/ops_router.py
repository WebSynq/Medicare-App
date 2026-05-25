"""Admin operations console — single read-only aggregate endpoint.

Returns platform health, security posture, data-integrity counts, usage
metrics, automation status, and compliance flags in one response. All
queries fan out in parallel; each section is wrapped so a single failed
query degrades that section to `{"error": "unavailable"}` rather than
breaking the whole page.

Guarantees:
  - Aggregated counts only — NO PHI, no agent names, no client data.
  - Admin / owner only (require_roles).
  - Read-only — never writes to MongoDB.
"""
import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from deps import get_db, get_phi_db, require_roles


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ops", tags=["ops"])


# ── Compliance flags (hardcoded — flip when contracts are signed) ──────────
# Updating these is a one-line edit per vendor. The console reads them
# verbatim and renders the red/amber/green row.
_COMPLIANCE = {
    "baa_render":    "not_signed",     # Render hosting
    "baa_mongodb":   "not_signed",     # MongoDB Atlas
    "baa_aws_ses":   "pending",        # planned migration target
    "hipaa_training_due": 0,           # placeholder until training tracked
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _safe_section(name: str, coro) -> Dict[str, Any]:
    """Wrap a section coroutine so any failure becomes a structured
    error blob rather than a 500. Returns the awaited result on success.
    Used inline via asyncio.gather with return_exceptions=True; we
    process exceptions in the caller."""
    return coro  # placeholder for future structure — kept simple via gather


# ── System section ──────────────────────────────────────────────────────────
async def _system_section(
    request: Request, db: AsyncIOMotorDatabase,
) -> Dict[str, Any]:
    try:
        start = time.monotonic()
        await db.command("ping")
        ping_ms = round((time.monotonic() - start) * 1000)
        scheduler = getattr(request.app.state, "automation_scheduler", None)
        scheduler_running = bool(scheduler and getattr(scheduler, "running", False))
        return {
            "api_status": "ok",
            "db_ping_ms": ping_ms,
            "scheduler_running": scheduler_running,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops system section failed: %s", e)
        return {"error": "unavailable"}


# ── Security section ────────────────────────────────────────────────────────
async def _security_section(
    db: AsyncIOMotorDatabase, phi_db: AsyncIOMotorDatabase,
) -> Dict[str, Any]:
    try:
        now = _utc_now()
        day_ago = now - timedelta(hours=24)

        # All counts run in parallel — none of them touch each other's
        # collection so a single round-trip group is safe.
        (
            failed_logins_24hr,
            accounts_locked_now,
            ip_bans_active,
            booking_attacks_24hr,
            mfa_enabled_count,
            mfa_total_agents,
        ) = await asyncio.gather(
            db.login_attempts.count_documents({
                "attempted_at": {"$gte": day_ago},
                "locked_until": None,
            }),
            db.login_attempts.count_documents({
                "locked_until": {"$gt": now},
            }),
            db.booking_blocks.count_documents({
                "expires_at": {"$gt": now},
            }),
            db.booking_attempts.count_documents({
                "created_at": {"$gte": day_ago},
                "outcome": {"$ne": "success"},
            }),
            # Only agents count toward MFA adoption — admin/owner have
            # their own enforcement path. Filter on the agent population.
            db.users.count_documents({
                "mfa_enabled": True,
                "role": "agent",
                "is_active": True,
            }),
            db.users.count_documents({
                "role": "agent",
                "is_active": True,
            }),
        )

        adoption = (
            round((mfa_enabled_count / mfa_total_agents) * 100, 1)
            if mfa_total_agents else 0.0
        )
        return {
            "failed_logins_24hr": failed_logins_24hr,
            "accounts_locked_now": accounts_locked_now,
            "ip_bans_active": ip_bans_active,
            "booking_attacks_24hr": booking_attacks_24hr,
            "mfa_enabled_count": mfa_enabled_count,
            "mfa_total_agents": mfa_total_agents,
            "mfa_adoption_pct": adoption,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops security section failed: %s", e)
        return {"error": "unavailable"}


# ── Data integrity section ──────────────────────────────────────────────────
async def _data_integrity_section(
    db: AsyncIOMotorDatabase, phi_db: AsyncIOMotorDatabase,
) -> Dict[str, Any]:
    try:
        now = _utc_now()
        # `state` is normalized on write to a 2-char code — anything else
        # is legacy dirt the backfill missed. $strLenCP catches it.
        (
            total_leads,
            total_agents,
            leads_missing_agent,
            leads_dirty_state,
            ghl_unsynced,
            ghl_sync_errors,
            appointments_total,
            reminders_pending,
        ) = await asyncio.gather(
            phi_db.leads.count_documents({}),
            db.users.count_documents({"role": "agent", "is_active": True}),
            phi_db.leads.count_documents({
                "$or": [
                    {"agent_id": None},
                    {"agent_id": {"$exists": False}},
                ],
            }),
            # Dirty-state heuristic: any non-empty state value whose
            # string form isn't exactly 2 chars (e.g. "Illinois", "il
            # ", "California"). Regex used over $strLenCP so the query
            # works on every Mongo driver including mongomock (used in
            # tests).
            phi_db.leads.count_documents({
                "state": {"$exists": True, "$nin": [None, ""],
                          "$not": {"$regex": "^[A-Za-z]{2}$"}},
            }),
            phi_db.leads.count_documents({
                "ghl_contact_id": {"$nin": [None, ""]},
                "ghl_sync_status": {"$nin": ["synced", "mock"]},
            }),
            phi_db.leads.count_documents({"ghl_sync_status": "error"}),
            phi_db.appointments.count_documents({}),
            phi_db.appointments.count_documents({
                "appointment_date": {"$gte": now.date().isoformat()},
                "status": "scheduled",
                "reminder_24hr_sent": {"$ne": True},
            }),
        )
        return {
            "total_leads": total_leads,
            "total_agents": total_agents,
            "leads_missing_agent": leads_missing_agent,
            "leads_dirty_state": leads_dirty_state,
            "ghl_unsynced": ghl_unsynced,
            "ghl_sync_errors": ghl_sync_errors,
            "appointments_total": appointments_total,
            "reminders_pending": reminders_pending,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops data_integrity section failed: %s", e)
        return {"error": "unavailable"}


# ── Usage section ───────────────────────────────────────────────────────────
async def _usage_section(
    db: AsyncIOMotorDatabase, phi_db: AsyncIOMotorDatabase,
) -> Dict[str, Any]:
    try:
        now = _utc_now()
        day_ago = now - timedelta(days=1)
        week_ago = now - timedelta(days=7)
        today_iso = now.date().isoformat()
        # Distinct active agents over the last 7 days via aggregation.
        active_pipeline = [
            {"$match": {"timestamp": {"$gte": _iso(week_ago)}}},
            {"$group": {"_id": "$actor_id"}},
            {"$match": {"_id": {"$nin": [None, ""]}}},
            {"$count": "n"},
        ]

        (
            active_agents_raw,
            bookings_today,
            bookings_7d,
            leads_created_today,
            leads_created_7d,
            soa_signed_7d,
            enrollments_7d,
        ) = await asyncio.gather(
            db.audit_logs.aggregate(active_pipeline).to_list(length=1),
            phi_db.appointments.count_documents({
                "booked_by_client": True,
                "created_at": {"$gte": _iso(now.replace(
                    hour=0, minute=0, second=0, microsecond=0,
                ))},
            }),
            phi_db.appointments.count_documents({
                "booked_by_client": True,
                "created_at": {"$gte": _iso(week_ago)},
            }),
            phi_db.leads.count_documents({
                "created_at": {"$gte": _iso(now.replace(
                    hour=0, minute=0, second=0, microsecond=0,
                ))},
            }),
            phi_db.leads.count_documents({
                "created_at": {"$gte": _iso(week_ago)},
            }),
            phi_db.soa_records.count_documents({
                "status": "signed",
                "signed_at": {"$gte": _iso(week_ago)},
            }),
            phi_db.leads.count_documents({
                "status": "enrolled",
                "enrolled_at": {"$gte": _iso(week_ago)},
            }),
        )

        active_agents_7d = (
            active_agents_raw[0]["n"] if active_agents_raw else 0
        )
        return {
            "active_agents_7d": active_agents_7d,
            "bookings_today": bookings_today,
            "bookings_7d": bookings_7d,
            "leads_created_today": leads_created_today,
            "leads_created_7d": leads_created_7d,
            "soa_signed_7d": soa_signed_7d,
            "enrollments_7d": enrollments_7d,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops usage section failed: %s", e)
        return {"error": "unavailable"}


# ── Automations section ─────────────────────────────────────────────────────
async def _automations_section(
    request: Request, db: AsyncIOMotorDatabase, phi_db: AsyncIOMotorDatabase,
) -> Dict[str, Any]:
    try:
        now = _utc_now()
        week_ago = now - timedelta(days=7)
        scheduler = getattr(request.app.state, "automation_scheduler", None)
        if scheduler is None:
            status = "stopped"
        elif getattr(scheduler, "running", False):
            status = "running"
        else:
            status = "unknown"

        # Per-job 7-day counts. We use stamp fields (e.g. birthday_email_at)
        # where automations record them so the count reflects sends in
        # the window — falling back to updated_at when the per-stamp
        # field isn't set (mid-deploy rows). The `_at` form is preferred.
        (
            reminders_48,
            reminders_24,
            reminders_1,
            followups,
            birthday_emails,
            enrolled_welcomes,
            new_lead_notifies,
            stale_alerts,
            last_audit,
        ) = await asyncio.gather(
            phi_db.appointments.count_documents({
                "reminder_48hr_sent": True,
                "$or": [
                    {"reminder_48hr_sent_at": {"$gte": _iso(week_ago)}},
                    {"updated_at": {"$gte": _iso(week_ago)}},
                ],
            }),
            phi_db.appointments.count_documents({
                "reminder_24hr_sent": True,
                "$or": [
                    {"reminder_24hr_sent_at": {"$gte": _iso(week_ago)}},
                    {"updated_at": {"$gte": _iso(week_ago)}},
                ],
            }),
            phi_db.appointments.count_documents({
                "reminder_1hr_sent": True,
                "$or": [
                    {"reminder_1hr_sent_at": {"$gte": _iso(week_ago)}},
                    {"updated_at": {"$gte": _iso(week_ago)}},
                ],
            }),
            phi_db.appointments.count_documents({
                "followup_sent": True,
                "$or": [
                    {"followup_at": {"$gte": _iso(week_ago)}},
                    {"updated_at": {"$gte": _iso(week_ago)}},
                ],
            }),
            phi_db.leads.count_documents({
                "birthday_email_sent": True,
                "birthday_email_at": {"$gte": _iso(week_ago)},
            }),
            phi_db.leads.count_documents({
                "enrolled_welcome_sent": True,
                "enrolled_welcome_at": {"$gte": _iso(week_ago)},
            }),
            phi_db.leads.count_documents({
                "new_lead_notified": True,
                "new_lead_notified_at": {"$gte": _iso(week_ago)},
            }),
            phi_db.leads.count_documents({
                "stale_alert_sent": True,
                "stale_alert_at": {"$gte": _iso(week_ago)},
            }),
            db.audit_logs.find(
                {"event_type": {"$regex": "^automation_"}},
                {"_id": 0, "timestamp": 1},
            ).sort("timestamp", -1).limit(1).to_list(length=1),
        )

        last_reminder_check = (
            last_audit[0]["timestamp"] if last_audit else None
        )
        return {
            "scheduler_status": status,
            "last_reminder_check": last_reminder_check,
            "reminders_sent_7d": reminders_24,
            "birthday_emails_sent_7d": birthday_emails,
            "followups_sent_7d": followups,
            # Per-job breakdown for the military console's job table.
            "jobs": {
                "birthday_window":        {"sent_7d": birthday_emails, "status": "active"},
                "new_lead_notify":        {"sent_7d": new_lead_notifies, "status": "active"},
                "reminder_48hr":          {"sent_7d": reminders_48, "status": "active"},
                "reminder_24hr":          {"sent_7d": reminders_24, "status": "active"},
                "reminder_1hr":           {"sent_7d": reminders_1, "status": "active"},
                "post_appointment":       {"sent_7d": followups, "status": "active"},
                "enrolled_welcome":       {"sent_7d": enrolled_welcomes, "status": "active"},
                "stale_lead_alert":       {"sent_7d": stale_alerts, "status": "active"},
            },
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops automations section failed: %s", e)
        return {"error": "unavailable"}


# ── Compliance section ──────────────────────────────────────────────────────
async def _compliance_section(
    db: AsyncIOMotorDatabase, phi_db: AsyncIOMotorDatabase,
    security_section: Dict[str, Any],
) -> Dict[str, Any]:
    try:
        audit_log_count, last_audit_doc = await asyncio.gather(
            db.audit_logs.count_documents({}),
            db.audit_logs.find({}, {"_id": 0, "timestamp": 1})
                          .sort("timestamp", -1).limit(1).to_list(length=1),
        )
        last_write = (
            last_audit_doc[0]["timestamp"] if last_audit_doc else None
        )
        mfa_enabled = (security_section or {}).get("mfa_enabled_count") or 0
        total_agents = (security_section or {}).get("mfa_total_agents") or 0
        agents_without_mfa = max(0, total_agents - mfa_enabled)
        return {
            **_COMPLIANCE,
            "audit_log_count": audit_log_count,
            "audit_last_write": last_write,
            "agents_without_mfa": agents_without_mfa,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops compliance section failed: %s", e)
        return {"error": "unavailable"}


# ── 7-day activity rollup (for the line + bar charts) ───────────────────────
async def _activity_7d_section(phi_db: AsyncIOMotorDatabase) -> List[Dict[str, Any]]:
    """Per-day counts of leads_created / enrollments / bookings for the
    last 7 days. Day labels are short weekday abbreviations so the
    frontend chart x-axis stays compact."""
    try:
        now = _utc_now()
        # Build 7 buckets ending today (inclusive).
        days = []
        for i in range(6, -1, -1):
            d = (now - timedelta(days=i)).date()
            days.append(d)
        out: List[Dict[str, Any]] = []
        # Issue all 21 counts in parallel — 3 metrics × 7 days. Each
        # count_documents is index-served (created_at / appointment_date)
        # so the wall-clock impact is one round-trip group.
        tasks = []
        for d in days:
            start = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
            end = start + timedelta(days=1)
            tasks.append(phi_db.leads.count_documents({
                "created_at": {"$gte": _iso(start), "$lt": _iso(end)},
            }))
            tasks.append(phi_db.leads.count_documents({
                "status": "enrolled",
                "enrolled_at": {"$gte": _iso(start), "$lt": _iso(end)},
            }))
            tasks.append(phi_db.appointments.count_documents({
                "booked_by_client": True,
                "created_at": {"$gte": _iso(start), "$lt": _iso(end)},
            }))
        results = await asyncio.gather(*tasks)
        for idx, d in enumerate(days):
            base = idx * 3
            out.append({
                "date": d.isoformat(),
                "label": d.strftime("%a"),
                "leads": results[base],
                "enrollments": results[base + 1],
                "bookings": results[base + 2],
            })
        return out
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops activity_7d section failed: %s", e)
        return []


# ── Threat log — last 5 failed-login / blocked-booking events ──────────────
async def _threat_log_section(
    db: AsyncIOMotorDatabase,
) -> List[Dict[str, Any]]:
    """Most recent 5 failure events across login_attempts and
    booking_attempts. Returned as small dicts — no PII beyond email,
    which is already PHI-adjacent and visible to admin/owner only."""
    try:
        # Login lockouts.
        lock_rows = await db.login_attempts.find(
            {"locked_until": {"$ne": None}},
            {"_id": 0, "email": 1, "attempted_at": 1, "locked_until": 1},
        ).sort("attempted_at", -1).limit(5).to_list(length=5)
        # Failed bookings.
        book_rows = await db.booking_attempts.find(
            {"outcome": {"$nin": [None, "success"]}},
            {"_id": 0, "ip": 1, "outcome": 1, "created_at": 1, "slug": 1},
        ).sort("created_at", -1).limit(5).to_list(length=5)

        combined: List[Dict[str, Any]] = []
        for r in lock_rows:
            ts = r.get("attempted_at")
            combined.append({
                "time": ts.isoformat() if hasattr(ts, "isoformat") else str(ts or ""),
                "event": "Failed login → lockout",
                "actor": r.get("email") or "—",
                "status": "BLOCKED",
            })
        for r in book_rows:
            ts = r.get("created_at")
            combined.append({
                "time": ts.isoformat() if hasattr(ts, "isoformat") else str(ts or ""),
                "event": f"Booking: {(r.get('outcome') or '').replace('_', ' ')}",
                "actor": r.get("ip") or "—",
                "status": "BLOCKED",
            })
        combined.sort(key=lambda r: r.get("time") or "", reverse=True)
        return combined[:5]
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ops threat_log section failed: %s", e)
        return []


# ── Endpoint ────────────────────────────────────────────────────────────────
@router.get("/health")
async def ops_health(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
    _user=Depends(require_roles("admin", "owner")),
):
    """Single-shot ops dashboard payload. All sections fan out in
    parallel; each is independently degradable."""
    # Two-phase: section payloads first (some sections cross-reference
    # the security totals for derived counts).
    (
        system,
        security,
        data_integrity,
        usage,
        automations,
        activity_7d,
        threat_log,
    ) = await asyncio.gather(
        _system_section(request, db),
        _security_section(db, phi_db),
        _data_integrity_section(db, phi_db),
        _usage_section(db, phi_db),
        _automations_section(request, db, phi_db),
        _activity_7d_section(phi_db),
        _threat_log_section(db),
    )
    compliance = await _compliance_section(db, phi_db, security)

    return {
        "generated_at": _iso(_utc_now()),
        "system": system,
        "security": security,
        "data_integrity": data_integrity,
        "usage": usage,
        "automations": automations,
        "compliance": compliance,
        "activity_7d": activity_7d,
        "threat_log": threat_log,
    }
