"""
dashboard_aggregator.py
=======================
Pre-computes the expensive aggregations powering the agency dashboard
into a `dashboard_stats` collection, refreshed every 15 minutes by an
APScheduler IntervalTrigger.

Why:
    At 1.5M leads the 6 aggregations in agency_dashboard_router (P1-P5
    in the audit + the alerts stale-leads pipeline) collectively run
    20-30s per admin page load. Pre-computing them moves that cost off
    the request path and reduces dashboard response to a single point-
    lookup on dashboard_stats.

What's pre-computed (per refresh):
    Period-INDEPENDENT (computed once per refresh):
      * agents_last_active   — agent_id → last lead created_at (P3)
      * stale_agent_count    — derived from agents_last_active (P2,
                                no second $group needed)
      * stale_leads_by_agent — top 20 agents with open leads not
                                touched in 7+ days (alerts pipeline)

    Period-KEYED (one entry per period in PERIODS):
      * agents_with_activity — distinct count of agents with new leads
                                in window (P1)
      * leads_by_source      — total + enrolled per source, one
                                aggregation per period via $cond-sum
                                (P4 + P5 combined)

Failure model:
    * Each pipeline runs in its own try/except; partial results write
      with an `errors` list noting which pipelines failed.
    * The scheduler job itself wraps everything in a final try/except so
      a refresh failure logs loudly but never crashes the server.
    * The endpoint read path (agency_dashboard_router._stats_doc) falls
      back to live recompute when the doc is missing or stale — so a
      week-long scheduler outage still serves accurate (if slow) data.

Concurrency:
    * APScheduler `max_instances=1` prevents overlapping refresh runs.
    * No mutex against simultaneous endpoint-triggered live recomputes
      (`?refresh=true` from concurrent admins) — accepted for v1 given
      the small admin user count. Add if monitoring shows storms.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple


logger = logging.getLogger("gruening.dashboard_agg")


# ── Period helpers ─────────────────────────────────────────────────────────
# Self-contained (rather than imported from agency_dashboard_router) to
# avoid a circular import and to keep the aggregator runnable independently
# (one-off scripts, future CLI, etc.). Keep in sync with the router's
# _period_range — they're intentionally identical.

PERIODS: Tuple[str, ...] = ("mtd", "last30", "last90", "ytd", "all")


def _period_range(period: str) -> Tuple[Optional[datetime], datetime]:
    """Return (start, end) UTC datetimes for a period name. start is
    None for 'all' (no lower bound)."""
    now = datetime.now(timezone.utc)
    end = now
    if period == "mtd":
        start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    elif period == "last30":
        start = now - timedelta(days=30)
    elif period == "last90":
        start = now - timedelta(days=90)
    elif period == "ytd":
        start = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    else:
        # "all" or unknown → no lower bound
        start = None
    return start, end


def _iso_range_filter(field: str, start: Optional[datetime],
                        end: datetime) -> Dict[str, Any]:
    """Build a $gte/$lte filter on `field`. Empty dict when start is None."""
    if start is None:
        return {}
    return {field: {"$gte": start.isoformat(), "$lte": end.isoformat()}}


# ── Single-collection aggregation primitives ───────────────────────────────

async def _agents_last_active(db) -> Dict[str, str]:
    """P3 — agent_id → max(created_at). Full collection scan + group.
    Also feeds P2 (stale_agent_count) via the read-side derive."""
    out: Dict[str, str] = {}
    pipeline = [
        {"$match": {"agent_id": {"$ne": None}}},
        {"$group": {"_id": "$agent_id",
                     "last": {"$max": "$created_at"}}},
    ]
    async for row in db.leads.aggregate(pipeline):
        aid = row.get("_id")
        if aid:
            out[aid] = row.get("last")
    return out


def _stale_agent_count_from(agents_last_active: Dict[str, str],
                              cutoff: datetime) -> int:
    """P2 — derived from P3 in Python instead of running a second
    full-collection group. cutoff_iso comparison: lead created_at is
    an ISO string; lexicographic compare on ISO timestamps is order-
    preserving."""
    cutoff_iso = cutoff.isoformat()
    return sum(1 for last in agents_last_active.values()
               if last and last < cutoff_iso)


async def _agents_with_activity(db, start: Optional[datetime],
                                  end: datetime) -> int:
    """P1 — distinct agent_id count of leads created in the window."""
    match: Dict[str, Any] = {"agent_id": {"$ne": None}}
    if start is not None:
        match["created_at"] = {"$gte": start.isoformat(),
                                "$lte": end.isoformat()}
    pipeline = [
        {"$match": match},
        {"$group": {"_id": "$agent_id"}},
        {"$count": "n"},
    ]
    async for row in db.leads.aggregate(pipeline):
        return int(row.get("n", 0))
    return 0


async def _leads_by_source(db, start: Optional[datetime],
                            end: datetime) -> List[Dict[str, Any]]:
    """P4 + P5 combined — total + enrolled per lead_source, in ONE
    aggregation via $cond-sum (cheaper than the router's two-pass)."""
    match: Dict[str, Any] = {"lead_source": {"$ne": None, "$ne": ""}}
    if start is not None:
        match["created_at"] = {"$gte": start.isoformat(),
                                "$lte": end.isoformat()}
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$lead_source",
            "total": {"$sum": 1},
            "enrolled": {"$sum": {
                "$cond": [{"$eq": ["$status", "enrolled"]}, 1, 0],
            }},
        }},
    ]
    rows: List[Dict[str, Any]] = []
    async for r in db.leads.aggregate(pipeline):
        total = int(r.get("total", 0))
        enrolled = int(r.get("enrolled", 0))
        rows.append({
            "source": r.get("_id"),
            "total": total,
            "enrolled": enrolled,
            "conversion_rate": (
                round((enrolled / total) * 100.0, 1) if total else 0.0
            ),
        })
    rows.sort(key=lambda r: r["total"], reverse=True)
    return rows


async def _stale_leads_by_agent(db, cutoff: datetime) -> List[Dict[str, Any]]:
    """Top 20 agents with open leads not touched in 7+ days. Powers the
    alerts panel."""
    open_statuses = ["new", "contacted", "qualified", "appointment_set"]
    pipeline = [
        {"$match": {
            "status": {"$in": open_statuses},
            "agent_id": {"$ne": None},
            "updated_at": {"$lt": cutoff.isoformat()},
        }},
        {"$group": {"_id": "$agent_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 20},
    ]
    out: List[Dict[str, Any]] = []
    async for row in db.leads.aggregate(pipeline):
        out.append({
            "agent_id": row.get("_id"),
            "count": int(row.get("count", 0)),
        })
    return out


# ── Compute + persist ──────────────────────────────────────────────────────

async def compute_dashboard_stats(db) -> Dict[str, Any]:
    """Run every pre-computable aggregation and return the snapshot doc.

    Each pipeline is wrapped in its own try/except via asyncio.gather
    with return_exceptions=True — one failure logs into `errors` and
    that field is set to its safe default (0 / {} / []), so the
    snapshot is always usable even when partial.
    """
    started_at = datetime.now(timezone.utc)
    cutoff_7d = started_at - timedelta(days=7)
    errors: List[Dict[str, Any]] = []

    # ── Period-independent tasks (P3 + alerts) ─────────────────────────────
    base_tasks = {
        "agents_last_active": _agents_last_active(db),
        "stale_leads_by_agent": _stale_leads_by_agent(db, cutoff_7d),
    }
    base_results = await asyncio.gather(
        *base_tasks.values(), return_exceptions=True,
    )
    base = dict(zip(base_tasks.keys(), base_results))
    for name, result in list(base.items()):
        if isinstance(result, Exception):
            logger.warning("dashboard_agg %s failed: %s", name, result)
            errors.append({"pipeline": name, "error": str(result)})
            base[name] = {} if name == "agents_last_active" else []

    agents_last_active: Dict[str, str] = base["agents_last_active"]
    stale_leads_by_agent: List[Dict[str, Any]] = base["stale_leads_by_agent"]

    # P2 derived from P3 in Python — no second full-collection group.
    stale_agent_count = _stale_agent_count_from(agents_last_active, cutoff_7d)

    # ── Per-period tasks (P1 + P4+P5 combined) ─────────────────────────────
    period_tasks: List[Tuple[str, str, Any]] = []   # (period, task_name, coro)
    for p in PERIODS:
        start, end = _period_range(p)
        period_tasks.append((p, "agents_with_activity",
                              _agents_with_activity(db, start, end)))
        period_tasks.append((p, "leads_by_source",
                              _leads_by_source(db, start, end)))

    period_results = await asyncio.gather(
        *(t[2] for t in period_tasks), return_exceptions=True,
    )

    periods: Dict[str, Dict[str, Any]] = {p: {} for p in PERIODS}
    for (p, task_name, _), result in zip(period_tasks, period_results):
        if isinstance(result, Exception):
            logger.warning("dashboard_agg %s[%s] failed: %s",
                            task_name, p, result)
            errors.append({"pipeline": f"{task_name}[{p}]",
                            "error": str(result)})
            periods[p][task_name] = (0 if task_name == "agents_with_activity"
                                       else [])
        else:
            periods[p][task_name] = result

    duration_ms = int(
        (datetime.now(timezone.utc) - started_at).total_seconds() * 1000,
    )

    return {
        "computed_at": started_at.isoformat(),
        "computed_duration_ms": duration_ms,
        "errors": errors,
        "stale_agent_count": stale_agent_count,
        "agents_last_active": agents_last_active,
        "stale_leads_by_agent": stale_leads_by_agent,
        "periods": periods,
    }


async def refresh_dashboard_stats(db, agency_id: str = "ghw_001") -> Dict[str, Any]:
    """Compute the snapshot and upsert into dashboard_stats. Returns
    the new document (including agency_id) for the caller to use
    directly without a follow-up read."""
    doc = await compute_dashboard_stats(db)
    doc["agency_id"] = agency_id
    await db.dashboard_stats.update_one(
        {"agency_id": agency_id},
        {"$set": doc},
        upsert=True,
    )
    logger.info(
        "dashboard_stats refresh ok agency=%s duration_ms=%d errors=%d",
        agency_id, doc["computed_duration_ms"], len(doc["errors"]),
    )
    return doc


# ── Scheduler ──────────────────────────────────────────────────────────────

def start_scheduler(get_db_fn):
    """Hourly = 15-min IntervalTrigger refresh. Matches the pattern of
    comtrack_sync / notifications_router schedulers.

    Skipped entirely when DISABLE_SCHEDULER=1 (tests). max_instances=1
    prevents overlapping runs if a single refresh exceeds 15 min.
    next_run_time=now fires once at boot so the first dashboard load
    after deploy hits a warm cache.
    """
    if os.getenv("DISABLE_SCHEDULER", "").strip() == "1":
        logger.info("dashboard_agg: scheduler disabled via DISABLE_SCHEDULER")
        return None

    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.interval import IntervalTrigger

    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _job():
        try:
            await refresh_dashboard_stats(get_db_fn())
        except Exception as e:                                  # noqa: BLE001
            logger.exception("dashboard_agg: scheduled refresh failed: %s", e)

    scheduler.add_job(
        _job,
        trigger=IntervalTrigger(minutes=15),
        id="dashboard_stats_refresh",
        max_instances=1,
        next_run_time=datetime.now(timezone.utc),  # fire once at boot
        replace_existing=True,
    )
    scheduler.start()
    logger.info("dashboard_agg: scheduler started (every 15 minutes)")
    return scheduler
