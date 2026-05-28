"""Usage metering — append-only telemetry for every billable action.

Design contract
===============
1. **Fire-and-forget.** `track_*` helpers schedule a background task
   via `asyncio.create_task()` and return synchronously. The caller
   never awaits. A metering failure cannot break a user request.
2. **Idempotent.** Every event carries a UUID `event_id` written to a
   unique index. A retry with the same id is a silent no-op.
3. **No PHI.** Event metadata may include event_type, model, and
   counts. Never the prompt body, never the email content, never the
   document filename.
4. **Cost vs charge.** `cost_usd` is YOUR cost from the upstream
   provider (best-effort estimate). `charge_usd` is what you'd bill
   the agency IF this unit overshoots the plan. The monthly rollup
   does the actual "above plan / below plan" math.
5. **Limit checks are live reads.** They sum the current period's
   `usage_events` against the agency's plan limits. Cached aggregates
   in `agency_usage_summary` are advisory only — the limit check is
   always authoritative.

Wiring guide
============
Wherever you call Claude:

    response = await anthropic_client.messages.create(...)
    track_ai_usage(
        agency_id=user.get("agency_id"),
        agent_id=user.get("id"),
        event_type="cna_analysis",
        tokens_in=response.usage.input_tokens,
        tokens_out=response.usage.output_tokens,
        model="claude-sonnet-4-6",
    )

Wherever you send mail:

    ok = await send_email(...)
    if ok:
        track_email_sent(agency_id=agency_id, agent_id=agent_id)

Before expensive AI ops the caller may gate on the limit:

    allowed = await check_ai_limit(db, agency_id)
    if not allowed:
        raise HTTPException(402, {"message": "AI limit reached", ...})
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Optional

from agency_models import UsageEvent, current_billing_period
from tiers import OVERAGE_RATES, TIER_DEFAULTS


logger = logging.getLogger(__name__)


# ── Cost / charge math ─────────────────────────────────────────────────
# AI token pricing — best-effort estimates against Anthropic's current
# Sonnet rate card. Used only for the internal cost_usd column; the
# customer-facing charge_usd always comes from agency.overage_rates.
# Update on rate-card changes — not safety-critical because billing
# uses the agency's own overage_rates, not these.
_PROVIDER_COST_PER_MTOK = {
    # input_per_million_usd, output_per_million_usd
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-opus-4-7":   (15.0, 75.0),
    "claude-haiku-4-5":  (1.0, 5.0),
}


def _provider_cost_usd(model: Optional[str],
                        tokens_in: int, tokens_out: int) -> float:
    rates = _PROVIDER_COST_PER_MTOK.get(model or "")
    if not rates:
        # Default to Sonnet pricing — conservative midline so we don't
        # under-report cost on an unmapped model.
        rates = _PROVIDER_COST_PER_MTOK["claude-sonnet-4-6"]
    in_rate, out_rate = rates
    return (tokens_in * in_rate + tokens_out * out_rate) / 1_000_000.0


def _agency_charge_usd_ai(tokens_total: int,
                            overage_rate_cents_per_1k: int) -> float:
    """How much we'd charge an agency for `tokens_total` tokens if
    every one were an overage. Used to populate `charge_usd` at write
    time; the rollup decides whether it actually counts as overage."""
    if tokens_total <= 0 or overage_rate_cents_per_1k <= 0:
        return 0.0
    return (tokens_total / 1000.0) * (overage_rate_cents_per_1k / 100.0)


# ── Background-task helper ─────────────────────────────────────────────
def _schedule(coro: Awaitable[Any], label: str) -> None:
    """Wrap a coroutine in `asyncio.create_task` with error logging.

    Safe to call outside an event loop — falls back to running the coro
    synchronously when no loop exists (e.g. CLI scripts / batch jobs).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No loop — caller is sync. Run the coro to completion now.
        try:
            asyncio.run(_wrap(coro, label))
        except Exception as e:                                    # noqa: BLE001
            logger.warning("metering: sync %s failed: %s", label, e)
        return
    task = loop.create_task(_wrap(coro, label))
    # Stash a reference so the task isn't GC'd mid-flight.
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


async def _wrap(coro: Awaitable[Any], label: str) -> None:
    try:
        await coro
    except Exception as e:                                        # noqa: BLE001
        logger.warning("metering: bg %s failed: %s", label, e)


_BG_TASKS: "set[asyncio.Task]" = set()


# ── DB plumbing ────────────────────────────────────────────────────────
# Metering writes go through the regular (non-PHI) Motor client — usage
# events carry no patient data. We pull the client lazily so test code
# that monkey-patches deps.get_db keeps working.

def _db_handle():
    from deps import get_db
    return get_db()


async def _insert_event(event: UsageEvent) -> None:
    """Write a UsageEvent doc to db.usage_events. Idempotent via the
    unique index on event_id — a duplicate insert is logged + swallowed."""
    if not event.agency_id:
        logger.debug("metering: skipped — no agency_id")
        return
    try:
        await _db_handle().usage_events.insert_one(event.model_dump())
    except Exception as e:                                        # noqa: BLE001
        # Most likely a duplicate-key on event_id (idempotent retry).
        # Log at debug so retries stay quiet but a real Mongo error
        # still surfaces at warning via the outer _wrap.
        msg = str(e).lower()
        if "duplicate" in msg or "e11000" in msg:
            logger.debug(
                "metering: duplicate event_id=%s — skipped",
                event.event_id,
            )
            return
        raise


# ── track_* (fire-and-forget) ─────────────────────────────────────────
def track_ai_usage(
    *,
    agency_id: Optional[str],
    agent_id: Optional[str],
    event_type: str,
    tokens_in: int,
    tokens_out: int,
    model: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Record one AI call. Fire-and-forget — never raises.

    agency_id may be None (e.g. an unauthenticated path) in which case
    the call is dropped on the floor; we never write rows with a null
    tenant key because the rollup couldn't attribute them.
    """
    if not agency_id:
        return
    tokens_in = max(0, int(tokens_in or 0))
    tokens_out = max(0, int(tokens_out or 0))
    cost = _provider_cost_usd(model, tokens_in, tokens_out)
    # Charge rate comes from foundation/baseline — every tier currently
    # uses 1¢/1k. Rollup re-applies the agency's own rate.
    charge = _agency_charge_usd_ai(
        tokens_in + tokens_out,
        OVERAGE_RATES["foundation"]["ai_tokens_per_1k"],
    )
    event = UsageEvent(
        agency_id=agency_id,
        agent_id=agent_id,
        billing_period=current_billing_period(),
        event_type=event_type,            # type: ignore[arg-type]
        quantity=float(tokens_in + tokens_out),
        unit="tokens",
        cost_usd=round(cost, 6),
        charge_usd=round(charge, 6),
        model=model,
        metadata={
            **(metadata or {}),
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        },
    )
    _schedule(_insert_event(event), f"ai_usage:{event_type}")


def track_email_sent(
    *,
    agency_id: Optional[str],
    agent_id: Optional[str] = None,
    count: int = 1,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Record one (or more) outbound emails. Fire-and-forget."""
    if not agency_id or count <= 0:
        return
    charge = (count / 1000.0) * (
        OVERAGE_RATES["foundation"]["email_per_1k"] / 100.0
    )
    event = UsageEvent(
        agency_id=agency_id,
        agent_id=agent_id,
        billing_period=current_billing_period(),
        event_type="email_sent",
        quantity=float(count),
        unit="emails",
        cost_usd=0.0,
        charge_usd=round(charge, 6),
        metadata=metadata or {},
    )
    _schedule(_insert_event(event), "email_sent")


def track_storage_write(
    *,
    agency_id: Optional[str],
    bytes_written: int,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Record a storage allocation. Fire-and-forget."""
    if not agency_id or bytes_written <= 0:
        return
    gb = bytes_written / (1024.0 ** 3)
    charge = gb * (OVERAGE_RATES["foundation"]["storage_per_gb"] / 100.0)
    event = UsageEvent(
        agency_id=agency_id,
        billing_period=current_billing_period(),
        event_type="document_stored",
        quantity=gb,
        unit="gb",
        cost_usd=0.0,
        charge_usd=round(charge, 6),
        metadata={**(metadata or {}), "bytes": bytes_written},
    )
    _schedule(_insert_event(event), "storage_write")


def track_app_intake(
    *,
    agency_id: Optional[str],
    agent_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Record one completed AI application intake. Fire-and-forget."""
    if not agency_id:
        return
    charge = OVERAGE_RATES["foundation"]["app_intake_each"] / 100.0
    event = UsageEvent(
        agency_id=agency_id,
        agent_id=agent_id,
        billing_period=current_billing_period(),
        event_type="app_intake",
        quantity=1.0,
        unit="count",
        cost_usd=0.0,
        charge_usd=round(charge, 6),
        metadata=metadata or {},
    )
    _schedule(_insert_event(event), "app_intake")


# ── check_* (synchronous limit gates) ──────────────────────────────────
async def _agency_doc(db, agency_id: str) -> Optional[dict]:
    return await db.agencies.find_one(
        {"agency_id": agency_id}, {"_id": 0},
    )


async def _sum_period(
    db, agency_id: str, event_type: Optional[str] = None,
    unit: Optional[str] = None,
) -> float:
    """Sum quantity for the current billing period. Filters by
    event_type and/or unit when supplied."""
    match: Dict[str, Any] = {
        "agency_id": agency_id,
        "billing_period": current_billing_period(),
    }
    if event_type:
        match["event_type"] = event_type
    if unit:
        match["unit"] = unit
    total = 0.0
    cursor = db.usage_events.find(match, {"_id": 0, "quantity": 1})
    async for row in cursor:
        try:
            total += float(row.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
    return total


def _included(agency: dict, key: str, default: float = 0.0) -> float:
    """Read a plan limit off the agency record with a tier-default
    fallback when the limits sub-doc is missing (defensive — legacy
    agency rows pre-Phase-1 are extinct, but a hand-crafted row from
    a super admin tool might still miss the field)."""
    limits = agency.get("limits") or {}
    if key in limits and limits[key] is not None:
        return float(limits[key])
    tier = (agency.get("tier") or "foundation").lower()
    tdef = TIER_DEFAULTS.get(tier) or TIER_DEFAULTS["foundation"]
    return float(tdef.get(key, default))


def _is_unlimited(value: float) -> bool:
    return value < 0   # -1 sentinel from tier defaults


def _is_super(agency: dict) -> bool:
    return bool(agency.get("super_admin"))


async def check_ai_limit(db, agency_id: str) -> bool:
    """True when the agency is below its AI-call limit for the
    current billing period. Super admins always pass. Missing agency
    row defaults to deny (safer than silently allowing).

    "AI call" is counted as one event per `track_ai_usage` call, not
    per token — matches the customer-facing plan limit ("5,000 AI
    calls / month").
    """
    agency = await _agency_doc(db, agency_id)
    if not agency:
        return False
    if _is_super(agency):
        return True
    limit = _included(agency, "ai_calls_included")
    if _is_unlimited(limit):
        return True
    # Count distinct AI-flavoured events for the period.
    match = {
        "agency_id": agency_id,
        "billing_period": current_billing_period(),
        "event_type": {"$in": [
            "cna_analysis", "daily_brief", "security_analysis",
            "tag_mapping", "ai_client_intelligence",
        ]},
    }
    used = await db.usage_events.count_documents(match)
    return used < int(limit)


async def check_email_limit(db, agency_id: str) -> bool:
    agency = await _agency_doc(db, agency_id)
    if not agency:
        return False
    if _is_super(agency):
        return True
    limit = _included(agency, "emails_included")
    if _is_unlimited(limit):
        return True
    used = await _sum_period(db, agency_id, event_type="email_sent",
                              unit="emails")
    return used < float(limit)


async def check_app_intake_limit(db, agency_id: str) -> bool:
    agency = await _agency_doc(db, agency_id)
    if not agency:
        return False
    if _is_super(agency):
        return True
    limit = _included(agency, "app_intakes_included")
    if _is_unlimited(limit):
        return True
    used = await db.usage_events.count_documents({
        "agency_id": agency_id,
        "billing_period": current_billing_period(),
        "event_type": "app_intake",
    })
    return used < int(limit)


# ── Agency-id resolvers (for callers without context) ─────────────────
async def resolve_agency_id_for_user(db, user_id: Optional[str]) -> Optional[str]:
    """Look up the agency for a user_id. Falls back to GHW ("ghw_001")
    when the user has no stamp (legacy row)."""
    if not user_id:
        return None
    row = await db.users.find_one(
        {"id": user_id}, {"_id": 0, "agency_id": 1},
    )
    if not row:
        return None
    from deps import get_agency_id
    return row.get("agency_id") or get_agency_id()


# ── Monthly rollup ────────────────────────────────────────────────────
async def rollup_period(db, billing_period: str) -> Dict[str, int]:
    """Aggregate usage_events for `billing_period` into
    agency_usage_summary. Idempotent — upserts on (agency_id, period).

    Returns {"agencies_processed": N, "events_aggregated": M}.
    Designed to be called from a scheduler (1st of each month for the
    previous period) or by a super admin manually for an arbitrary
    historical period.
    """
    pipeline = [
        {"$match": {"billing_period": billing_period}},
        {
            "$group": {
                "_id": "$agency_id",
                "ai_calls_total": {
                    "$sum": {
                        "$cond": [
                            {"$in": ["$event_type",
                                      ["cna_analysis", "daily_brief",
                                       "security_analysis", "tag_mapping",
                                       "ai_client_intelligence"]]},
                            1, 0,
                        ]
                    }
                },
                "ai_tokens_total": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$unit", "tokens"]},
                            "$quantity", 0,
                        ]
                    }
                },
                "ai_cost_usd": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$unit", "tokens"]},
                            "$cost_usd", 0,
                        ]
                    }
                },
                "ai_charge_usd": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$unit", "tokens"]},
                            "$charge_usd", 0,
                        ]
                    }
                },
                "emails_sent": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$event_type", "email_sent"]},
                            "$quantity", 0,
                        ]
                    }
                },
                "email_charge_usd": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$event_type", "email_sent"]},
                            "$charge_usd", 0,
                        ]
                    }
                },
                "app_intakes": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$event_type", "app_intake"]},
                            1, 0,
                        ]
                    }
                },
                "intake_charge_usd": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$event_type", "app_intake"]},
                            "$charge_usd", 0,
                        ]
                    }
                },
                "storage_gb": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$unit", "gb"]},
                            "$quantity", 0,
                        ]
                    }
                },
                "storage_charge_usd": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$unit", "gb"]},
                            "$charge_usd", 0,
                        ]
                    }
                },
                "event_count": {"$sum": 1},
            },
        },
    ]
    agencies_processed = 0
    events_aggregated = 0
    now_iso = datetime.now(timezone.utc).isoformat()
    async for group in db.usage_events.aggregate(pipeline):
        agency_id = group.get("_id")
        if not agency_id:
            continue
        agency = await _agency_doc(db, agency_id)
        if not agency:
            # Orphan events — agency was hard-deleted (shouldn't
            # happen given soft-delete-only policy). Skip rather than
            # write a summary against a missing tenant.
            continue
        base_charge = (agency.get("monthly_base_amount") or 0) / 100.0
        # Overage = whatever we tracked minus what the plan included.
        # We charge whichever is greater of zero or (used - included).
        ai_used = float(group.get("ai_calls_total", 0))
        ai_included = float(agency.get("limits", {})
                              .get("ai_calls_included", 0))
        emails_used = float(group.get("emails_sent", 0))
        emails_included = float(agency.get("limits", {})
                                  .get("emails_included", 0))
        intakes_used = float(group.get("app_intakes", 0))
        intakes_included = float(agency.get("limits", {})
                                   .get("app_intakes_included", 0))
        storage_used = float(group.get("storage_gb", 0))
        storage_included = float(agency.get("limits", {})
                                   .get("storage_gb_included", 0))
        rates = agency.get("overage_rates") or {}
        ai_rate_per_1k = rates.get("ai_tokens_per_1k", 1) / 100.0
        email_rate_per_1k = rates.get("email_per_1k", 1) / 100.0
        storage_rate_per_gb = rates.get("storage_per_gb", 10) / 100.0
        intake_rate_each = rates.get("app_intake_each", 25) / 100.0

        ai_overage_tokens = max(
            0.0, float(group.get("ai_tokens_total", 0))
            - ai_included * 1000.0,   # rough: 1k tokens per "call"
        )
        ai_overage_usd = (ai_overage_tokens / 1000.0) * ai_rate_per_1k
        email_overage_usd = max(
            0.0, emails_used - emails_included
        ) / 1000.0 * email_rate_per_1k
        intake_overage_usd = (
            max(0.0, intakes_used - intakes_included) * intake_rate_each
        )
        storage_overage_usd = max(
            0.0, storage_used - storage_included
        ) * storage_rate_per_gb

        total_overage = round(
            ai_overage_usd + email_overage_usd
            + intake_overage_usd + storage_overage_usd,
            2,
        )

        summary = {
            "agency_id": agency_id,
            "billing_period": billing_period,
            "updated_at": now_iso,
            "seats_active": int(agency.get("seats_active", 0)),
            "seats_max": int(agency.get("seats_max", 0)),
            "ai_calls_total": int(ai_used),
            "ai_tokens_input": 0,
            "ai_tokens_output": 0,
            "ai_cost_usd": round(float(group.get("ai_cost_usd", 0)), 4),
            "ai_charge_usd": round(ai_overage_usd, 4),
            "emails_sent": int(emails_used),
            "email_cost_usd": 0.0,
            "email_charge_usd": round(email_overage_usd, 4),
            "app_intakes": int(intakes_used),
            "intake_cost_usd": 0.0,
            "intake_charge_usd": round(intake_overage_usd, 4),
            "storage_gb": round(storage_used, 4),
            "storage_cost_usd": 0.0,
            "storage_charge_usd": round(storage_overage_usd, 4),
            "total_base_charge_usd": round(base_charge, 2),
            "total_overage_usd": total_overage,
            "total_invoice_usd": round(base_charge + total_overage, 2),
            "reported_to_stripe": False,
        }
        await db.agency_usage_summary.update_one(
            {"agency_id": agency_id, "billing_period": billing_period},
            {"$set": summary},
            upsert=True,
        )
        agencies_processed += 1
        events_aggregated += int(group.get("event_count", 0))
    return {
        "agencies_processed": agencies_processed,
        "events_aggregated": events_aggregated,
    }


def previous_billing_period() -> str:
    """YYYY-MM for the month before this one. Used by the 1st-of-month
    rollup job."""
    now = datetime.now(timezone.utc)
    if now.month == 1:
        return f"{now.year - 1:04d}-12"
    return f"{now.year:04d}-{now.month - 1:02d}"


def start_rollup_scheduler(get_db_fn: Callable):
    """1st-of-month CronTrigger that rolls up the previous period.

    Disabled when DISABLE_SCHEDULER=1 (pytest). Run-time is 06:00 UTC
    on day 1 of each month — well after any in-flight 11:59 PM event
    on the last day of the prior month has flushed to disk.
    """
    if (os.getenv("DISABLE_SCHEDULER") or "").strip() == "1":
        logger.info("metering: rollup scheduler disabled via env")
        return None

    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger

    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _tick():
        try:
            period = previous_billing_period()
            db = get_db_fn()
            result = await rollup_period(db, period)
            logger.info(
                "metering: rollup complete period=%s agencies=%d events=%d",
                period, result["agencies_processed"],
                result["events_aggregated"],
            )
        except Exception as e:                                    # noqa: BLE001
            logger.exception("metering: rollup tick failed: %s", e)

    scheduler.add_job(
        _tick,
        trigger=CronTrigger(day=1, hour=6, minute=0, timezone="UTC"),
        id="metering_rollup",
        max_instances=1,
        replace_existing=True,
    )
    scheduler.start()
    logger.info("metering: rollup scheduler started (1st of month, 06:00 UTC)")
    return scheduler
