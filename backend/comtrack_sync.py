"""
comtrack_sync.py
================
Daily ComTrack reconciliation — pulls every agent's commission rows from
ComTrack, matches them onto production_records by
(carrier, policy_number, agent_name), and writes back revenue_received +
audit_status.

Design notes
------------
- Mock-aware: ComtrackClient is already mock-aware (empty COMTRACK_API_KEY →
  returns canned rows). The sync therefore runs end-to-end in test/dev with
  no upstream calls.
- Classification reuses commission_audit_router._classify_from_amounts so
  the daily writer and the read endpoints stay in lock-step (no drift).
- Same-policy multi-row support: a policy can appear multiple times in
  ComTrack (one row per payment_period). We sum the `commission` field
  across rows that share (carrier, policy_number, agent_name).
- One run record per invocation, written to commission_sync_runs. The
  /sync/status endpoint reads the most recent.
- Scheduler is wired in server.py and gated by DISABLE_SCHEDULER=1 so the
  test suite never starts a background timer.
"""
import logging
import os
from datetime import datetime, timezone

from comtrack_client import ComtrackClient
from commission_audit_router import _classify_from_amounts

logger = logging.getLogger(__name__)


def _to_float(value) -> float:
    """ComTrack returns commission as int, float, or numeric string."""
    if value in (None, ""):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


async def run_sync(db, triggered_by: str = "scheduler") -> dict:
    """Run one ComTrack→production_records reconciliation pass.

    Returns a dict with run stats. Always writes a row to
    commission_sync_runs (even on failure) so /sync/status is informative.
    """
    started_at = datetime.now(timezone.utc)
    client = ComtrackClient()
    mock_mode = client.mock

    stats = {
        "started_at": started_at.isoformat(),
        "triggered_by": triggered_by,
        "mock_mode": mock_mode,
        "agents_processed": 0,
        "rows_fetched": 0,
        "records_updated": 0,
        "records_unmatched": 0,
        "errors": [],
    }

    try:
        cursor = db.users.find(
            {"agent_name": {"$nin": [None, ""]}},
            {"_id": 0, "id": 1, "agent_name": 1, "email": 1, "role": 1},
        )
        agents = [u async for u in cursor]
        logger.info("comtrack_sync: starting for %d agents (mock=%s)",
                    len(agents), mock_mode)

        for agent in agents:
            agent_name = agent["agent_name"]
            try:
                rows = await client.get_rows(agent_name)
            except Exception as e:
                logger.exception("comtrack_sync: get_rows failed for %s: %s",
                                  agent_name, e)
                stats["errors"].append({
                    "agent_name": agent_name,
                    "error_category": type(e).__name__,
                })
                continue

            stats["agents_processed"] += 1
            stats["rows_fetched"] += len(rows)

            # Sum commissions across rows sharing the same policy. ComTrack
            # emits one row per payment_period, so a single policy can have
            # several monthly payouts that all add up to revenue_received.
            totals: dict[tuple, float] = {}
            for row in rows:
                key = (
                    (row.get("carrier") or "").strip(),
                    (row.get("policy_number") or "").strip(),
                    agent_name,
                )
                if not key[1]:
                    continue
                totals[key] = totals.get(key, 0.0) + _to_float(
                    row.get("commission"))

            now_iso = datetime.now(timezone.utc).isoformat()
            for (carrier, policy_number, agent_n), received in totals.items():
                record = await db.production_records.find_one(
                    {"carrier": carrier,
                     "policy_number": policy_number,
                     "agent_name": agent_n},
                    {"_id": 0},
                )
                if not record:
                    stats["records_unmatched"] += 1
                    continue

                # Never overwrite a manually resolved record. Once an admin
                # has signed off on a discrepancy the sync should leave it
                # alone (the resolved row is immutable for accounting purposes).
                if record.get("audit_status") == "resolved":
                    continue

                received_rounded = round(received, 2)
                new_status = _classify_from_amounts(
                    record.get("revenue_expected"), received_rounded)

                update_fields = {
                    "revenue_received": received_rounded,
                    "audit_status": new_status,
                    "updated_at": now_iso,
                    "comtrack_synced_at": now_iso,
                }
                await db.production_records.update_one(
                    {"natural_key": record["natural_key"]},
                    {"$set": update_fields},
                )
                stats["records_updated"] += 1
                logger.info(
                    "comtrack_sync: %s/%s/%s → received=$%.2f status=%s",
                    agent_n, carrier, policy_number,
                    received_rounded, new_status,
                )

        stats["status"] = "ok"
    except Exception as e:
        logger.exception("comtrack_sync: run failed: %s", e)
        stats["status"] = "error"
        stats["errors"].append({"error_category": type(e).__name__,
                                 "message": str(e)[:300]})

    stats["completed_at"] = datetime.now(timezone.utc).isoformat()
    stats["duration_seconds"] = round(
        (datetime.now(timezone.utc) - started_at).total_seconds(), 2)

    try:
        await db.commission_sync_runs.insert_one({**stats})
    except Exception as e:
        # Don't let the bookkeeping failure mask the sync's actual result.
        logger.warning("comtrack_sync: could not log run record: %s", e)

    return stats


def start_scheduler(get_db_fn) -> "AsyncIOScheduler | None":
    """Start the APScheduler daily-at-06:00-UTC job.

    Returns the scheduler instance (kept alive for the app's lifetime), or
    None if DISABLE_SCHEDULER=1 (tests, one-off scripts).
    """
    if os.getenv("DISABLE_SCHEDULER", "").strip() == "1":
        logger.info("comtrack_sync: scheduler disabled via DISABLE_SCHEDULER")
        return None

    # Lazy import so the test suite never imports apscheduler (it isn't
    # needed there and would require its own teardown).
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger

    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _job():
        try:
            await run_sync(get_db_fn(), triggered_by="scheduler")
        except Exception as e:
            logger.exception("comtrack_sync: scheduled run failed: %s", e)

    scheduler.add_job(
        _job,
        trigger=CronTrigger(hour=6, minute=0),
        id="comtrack_daily_sync",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("comtrack_sync: scheduler started (daily 06:00 UTC)")
    return scheduler
