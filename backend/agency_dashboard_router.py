"""
agency_dashboard_router.py
==========================
Agency Command Center aggregation endpoints. All read-only.

Five endpoints power the agency dashboard:
  GET /agency-dashboard/kpis              — top-line counts + trends
  GET /agency-dashboard/agent-performance — sortable agent roster
  GET /agency-dashboard/charts            — chart-ready aggregates
  GET /agency-dashboard/alerts            — stale leads / birthdays / renewals
  GET /agency-dashboard/drilldown/{metric}— paginated detail for a KPI card

Access is restricted to the agency-leadership set:
``owner / admin / coach / sales_manager / compliance / accounting``.
Per-IP 30/hr on every endpoint (slowapi keys on IP by default;
per-user keying would need a custom key_func — left for later).

NOTE: the original Wave spec called the role "sales_director" but
the existing role set uses ``sales_manager``. They map 1:1; treat
the names as synonyms in any reader confusion.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import get_agency_id, get_db, get_phi_db, require_roles, write_audit
from encryption import safe_lead_load
from dashboard_aggregator import refresh_dashboard_stats
# Re-use the birthday helpers so "windows open now" matches what the
# birthday-rule panel shows agents.
from birthday_rule_router import (
    _evaluate_lead as _birthday_eval_lead,
    _today_utc as _birthday_today,
    _EXCLUDED_STATUSES as _BR_EXCLUDED,
)
# Re-use the renewal anniversary math so "due in N days" lines up
# with what the calendar view shows.
from renewal_router import (
    _parse_iso_date as _ren_parse,
    _renewal_date as _ren_anniv,
)


logger = logging.getLogger("gruening.agency_dashboard")
router = APIRouter(prefix="/agency-dashboard", tags=["agency-dashboard"])
limiter = Limiter(key_func=get_remote_address)

# Roles allowed to read the command center. The actual route gate is
# done via ``require_roles(*AGENCY_ROLES)``; centralised here so the
# list can drift in one place.
AGENCY_ROLES = (
    "owner", "admin", "coach",
    "sales_manager",   # spec called it "sales_director"; same role
    "compliance", "accounting",
)


# ── Period helpers ────────────────────────────────────────────────────────

_VALID_PERIODS = ("mtd", "last30", "last90", "ytd", "all")


def _period_range(period: str) -> Tuple[Optional[datetime], datetime]:
    """Return ``(start, end)`` UTC bounds for the named period. ``start``
    is ``None`` for the ``all`` bucket so callers can skip the range
    filter entirely (no $gte clause needed)."""
    now = datetime.now(timezone.utc)
    if period == "all":
        return None, now
    if period == "mtd":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    elif period == "last30":
        start = now - timedelta(days=30)
    elif period == "last90":
        start = now - timedelta(days=90)
    elif period == "ytd":
        start = now.replace(month=1, day=1, hour=0, minute=0,
                             second=0, microsecond=0)
    else:
        # Defensive; route validates via Query pattern below.
        start = now - timedelta(days=30)
    return start, now


def _prior_period(start: datetime, end: datetime) -> Tuple[datetime, datetime]:
    """Equal-length window immediately preceding ``(start, end)``."""
    span = end - start
    return start - span, start


def _trend_pct(current: float, prior: float) -> float:
    """Percentage change current vs prior, capped at sensible bounds.

    Edge cases:
      - prior == 0 and current == 0 → 0.0 (no movement)
      - prior == 0 and current  > 0 → 100.0 (cap; we don't ship inf)
      - both > 0 → signed pct
    """
    if prior == 0:
        return 0.0 if current == 0 else 100.0
    return round(((current - prior) / prior) * 100.0, 1)


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() if d else None


# Lead created_at and policy effective_date are mixed types across
# legacy rows — sometimes ISO strings, sometimes BSON datetimes. We
# always store as ISO going forward; range filters use ISO strings so
# both compare correctly under Mongo's lexicographic ISO ordering.
def _iso_range_filter(field: str, start: Optional[datetime],
                       end: datetime) -> dict:
    """Build a ``{field: {$gte, $lte}}`` clause over ISO date strings.

    Empty when ``start is None`` (the "all time" bucket) so the caller
    can spread it into a query without a no-op condition.
    """
    if start is None:
        return {}
    return {field: {"$gte": start.isoformat(), "$lte": end.isoformat()}}


# ── dashboard_stats cache helper ───────────────────────────────────────────
# Per Fix E: the expensive aggregations (P1-P5 + alerts stale-leads) are
# pre-computed by dashboard_aggregator on a 15-min APScheduler tick. Each
# read endpoint asks _stats_doc() for the snapshot; on miss / stale /
# explicit ?refresh=true, we run a live recompute inline so the dashboard
# is NEVER blank — slow > empty.

_STATS_STALE_SECONDS = 30 * 60   # 30 min — 2x the refresh interval

async def _stats_doc(
    db, force_refresh: bool = False,
) -> Tuple[Dict[str, Any], int]:
    """Returns (snapshot_doc, freshness_seconds).

    On miss / stale / force_refresh → recompute inline + upsert and
    return freshness=0. Never returns None — the live fallback guards
    against a cold cache (first boot before the scheduler tick) and
    against any scheduler outage.
    """
    agency_id = get_agency_id()
    now = datetime.now(timezone.utc)
    if not force_refresh:
        doc = await db.dashboard_stats.find_one({"agency_id": agency_id})
        if doc:
            try:
                computed = datetime.fromisoformat(doc.get("computed_at", ""))
                age = int((now - computed).total_seconds())
                if age <= _STATS_STALE_SECONDS:
                    return doc, age
            except (TypeError, ValueError):
                # computed_at malformed — fall through to live recompute
                pass
    # Miss / stale / forced → live compute. refresh_dashboard_stats
    # upserts into dashboard_stats and returns the new doc.
    doc = await refresh_dashboard_stats(db, agency_id=agency_id)
    return doc, 0


def _stats_meta(doc: Dict[str, Any], freshness_seconds: int) -> Dict[str, Any]:
    """Standard _meta block appended to every endpoint response so the
    SPA can render 'Updated X minutes ago' and decide when to re-fetch."""
    return {
        "computed_at": doc.get("computed_at"),
        "freshness_seconds": freshness_seconds,
        "stale_seconds_threshold": _STATS_STALE_SECONDS,
        "pipeline_errors": len(doc.get("errors") or []),
    }


# ── KPIs ──────────────────────────────────────────────────────────────────

async def _agent_count(db) -> int:
    """Active agency producer count — agents + VAs with status=active.

    Excludes admin / owner / compliance-bucket roles because the
    'active agents' metric is about people who actually source leads,
    not the leadership / back-office.
    """
    return await db.users.count_documents({
        "is_active": True,
        "status": "active",
        "role": {"$in": ["agent", "va"]},
    })


async def _agents_with_activity(db, start: Optional[datetime],
                                  end: datetime) -> int:
    """Distinct agent_id count among leads created in the window."""
    if start is None:
        pipeline = [
            {"$match": {"agent_id": {"$ne": None}}},
            {"$group": {"_id": "$agent_id"}},
            {"$count": "n"},
        ]
    else:
        pipeline = [
            {"$match": {
                "agent_id": {"$ne": None},
                "created_at": {"$gte": start.isoformat(),
                               "$lte": end.isoformat()},
            }},
            {"$group": {"_id": "$agent_id"}},
            {"$count": "n"},
        ]
    async for row in db.leads.aggregate(pipeline):
        row = safe_lead_load(row)
        return int(row.get("n", 0))
    return 0


async def _revenue_sum(db, start: Optional[datetime],
                        end: datetime) -> float:
    """Sum of ``revenue_expected`` on production_records inside the
    window. effective_date is an ISO date string on every row we ship.
    """
    match: dict = {"revenue_expected": {"$ne": None}}
    if start is not None:
        # production_records uses date-only ISO ('YYYY-MM-DD') for
        # effective_date — compare against the date portion of start/end
        # so we don't accidentally drop a same-day row that has no time.
        match["effective_date"] = {
            "$gte": start.date().isoformat(),
            "$lte": end.date().isoformat(),
        }
    pipeline = [{"$match": match},
                {"$group": {"_id": None,
                             "total": {"$sum": "$revenue_expected"}}}]
    async for row in db.production_records.aggregate(pipeline):
        return float(row.get("total") or 0.0)
    return 0.0


async def _stale_agent_count(db) -> int:
    """Agents whose newest lead is 7+ days old (no recent activity).

    Counts every active agent / VA whose ``MAX(leads.created_at) <
    now - 7 days``. Agents with no leads at all are not counted as
    "stale" — they're not actively working a book yet.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    pipeline = [
        {"$match": {"agent_id": {"$ne": None}}},
        {"$group": {"_id": "$agent_id",
                     "last": {"$max": "$created_at"}}},
        {"$match": {"last": {"$lt": cutoff}}},
        {"$count": "n"},
    ]
    async for row in db.leads.aggregate(pipeline):
        row = safe_lead_load(row)
        return int(row.get("n", 0))
    return 0


async def _birthday_open_count(db) -> int:
    """Reuse the IL birthday-rule evaluator on every IL lead in the
    agency. Counts only the 'urgent' bucket (window open today)."""
    today = _birthday_today()
    n = 0
    query = {
        "$or": [{"state": s} for s in
                ("IL", "il", "Il", "Illinois", "illinois")],
        "status": {"$nin": list(_BR_EXCLUDED)},
        "date_of_birth": {"$ne": None},
    }
    proj = {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
            "email": 1, "phone": 1, "date_of_birth": 1,
            "current_carrier": 1, "current_plan": 1, "agent_name": 1}
    async for ld in db.leads.find(query, proj):
        ld = safe_lead_load(ld)
        item = _birthday_eval_lead(ld, today)
        if item and item.get("_bucket") == "urgent":
            n += 1
    return n


async def _renewals_due(db, within_days: int) -> int:
    """Count policies whose 1-year anniversary falls in the next
    ``within_days`` from today. Agency-wide."""
    today = date.today()
    cutoff = today + timedelta(days=within_days)
    n = 0
    proj = {"_id": 0, "effective_date": 1}
    async for p in db.policies.find(
        {"effective_date": {"$ne": None, "$ne": ""}}, proj,
    ):
        eff = _ren_parse(p.get("effective_date"))
        if not eff:
            continue
        anniv = _ren_anniv(eff)
        days_until = (anniv - today).days
        if 0 <= days_until <= within_days:
            n += 1
    return n


@router.get("/kpis")
@limiter.limit("30/hour")
async def kpis(
    request: Request,
    period: str = Query("mtd", pattern="^(mtd|last30|last90|ytd|all)$"),
    refresh: bool = Query(False, description="Force live recompute of "
                          "pre-aggregated stats. AGENCY_ROLES already gates "
                          "access to this whole router."),
    current_user: dict = Depends(require_roles(*AGENCY_ROLES)),
    db=Depends(get_phi_db),
):
    """Top-of-page KPI card data. Window-aware counts plus
    period-over-period trend percentages on the three flow metrics
    (leads, enrolled, revenue).

    Stale-agents, birthday-windows, renewals-due are not period-
    bound — they're "right-now" alerts.

    Fix E: agents_with_activity and stale_agents come from the
    dashboard_stats cache (pre-aggregated every 15min). The
    count_documents calls below stay live — those use indexed fields
    and run in milliseconds.
    """
    start, end = _period_range(period)
    prior_start, prior_end = (
        _prior_period(start, end) if start else (None, end)
    )

    # Pull the pre-aggregated snapshot up front; falls back to live
    # recompute on miss / stale / explicit ?refresh=true.
    stats, freshness = await _stats_doc(db, force_refresh=refresh)
    period_block = (stats.get("periods") or {}).get(period) or {}

    # ── Counts ────────────────────────────────────────────────────────
    total_agents = await _agent_count(db)
    # P1 — from cache when present, live fallback if the period key is
    # missing (e.g. a schema mismatch from a partial refresh).
    active_agents = period_block.get("agents_with_activity")
    if active_agents is None:
        active_agents = await _agents_with_activity(db, start, end)

    total_leads = await db.leads.count_documents({})
    new_leads = await db.leads.count_documents(
        _iso_range_filter("created_at", start, end),
    )
    prior_new_leads = (
        await db.leads.count_documents(
            _iso_range_filter("created_at", prior_start, prior_end),
        ) if start else 0
    )

    total_enrolled = await db.leads.count_documents({"status": "enrolled"})
    new_enrolled = await db.leads.count_documents({
        "status": "enrolled",
        **_iso_range_filter("created_at", start, end),
    })
    prior_new_enrolled = (
        await db.leads.count_documents({
            "status": "enrolled",
            **_iso_range_filter("created_at", prior_start, prior_end),
        }) if start else 0
    )

    revenue_total = await _revenue_sum(db, None, end)
    revenue_period = await _revenue_sum(db, start, end)
    revenue_prior = (
        await _revenue_sum(db, prior_start, prior_end) if start else 0.0
    )

    total_policies = await db.policies.count_documents({})
    policies_period = (
        await db.policies.count_documents(
            _iso_range_filter("submitted_at", start, end),
        ) if start else total_policies
    )
    # Fallback: some policies rows pre-date the submitted_at field. If
    # the period-filtered count comes back zero but the all-time count
    # is positive, fall back to created_at so the dashboard doesn't
    # appear empty on a clean prod DB.
    if start is not None and policies_period == 0 and total_policies > 0:
        policies_period = await db.policies.count_documents(
            _iso_range_filter("created_at", start, end),
        )

    # Distinct carriers carrying production this year — bounded scan
    # rather than the all-time distinct so a single retired carrier
    # doesn't keep inflating the "active" count.
    ytd_start, _ = _period_range("ytd")
    carriers_active = len(
        await db.production_records.distinct(
            "carrier",
            {"carrier": {"$ne": None, "$ne": ""},
             "effective_date": {"$gte": ytd_start.date().isoformat()}},
        )
    )

    birthday_open = await _birthday_open_count(db)
    renewals_30 = await _renewals_due(db, 30)
    # P2 — derived in the aggregator from the agents_last_active map
    # (no second full-collection $group). Cache miss → live fallback.
    stale_agents = stats.get("stale_agent_count")
    if stale_agents is None:
        stale_agents = await _stale_agent_count(db)

    payload = {
        "period": period,
        "date_range": {"start": _iso(start), "end": _iso(end)},
        "agents": {
            "total": total_agents,
            "active_this_period": active_agents,
        },
        "leads": {
            "total": total_leads,
            "new_this_period": new_leads,
            "trend_pct": _trend_pct(new_leads, prior_new_leads),
        },
        "enrolled": {
            "total": total_enrolled,
            "new_this_period": new_enrolled,
            "trend_pct": _trend_pct(new_enrolled, prior_new_enrolled),
        },
        "revenue": {
            "total_estimated": round(revenue_total, 2),
            "this_period": round(revenue_period, 2),
            "trend_pct": _trend_pct(revenue_period, revenue_prior),
        },
        "policies": {
            "total_written": total_policies,
            "this_period": policies_period,
        },
        "carriers": {"active_count": carriers_active},
        "birthday_windows": {"open_now": birthday_open},
        "renewals": {"due_30_days": renewals_30},
        "stale_agents": {"count": stale_agents},
        "_meta": _stats_meta(stats, freshness),
    }

    await write_audit(
        db, "agency_dashboard_kpis_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request, metadata={"period": period, "cache_age_s": freshness},
    )
    return payload


# ── Agent performance ────────────────────────────────────────────────────

def _activity_status(last_active_iso: Optional[str]) -> str:
    """Map last activity timestamp to active / stale / inactive."""
    if not last_active_iso:
        return "inactive"
    try:
        dt = datetime.fromisoformat(last_active_iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except Exception:
        return "inactive"
    age = datetime.now(timezone.utc) - dt
    if age <= timedelta(days=7):
        return "active"
    if age <= timedelta(days=30):
        return "stale"
    return "inactive"


@router.get("/agent-performance")
@limiter.limit("30/hour")
async def agent_performance(
    request: Request,
    period: str = Query("mtd", pattern="^(mtd|last30|last90|ytd|all)$"),
    refresh: bool = Query(False),
    current_user: dict = Depends(require_roles(*AGENCY_ROLES)),
    db=Depends(get_phi_db),
):
    """Sortable agent roster with leads / enrolled / revenue and a
    period-over-period trend on enrolled count.

    Sorted by ``enrolled_count`` desc by default. Frontend can re-
    sort client-side without round-tripping.

    Fix E: last_active per agent comes from the dashboard_stats cache
    (P3 — was a full-collection $group every call). Other aggregations
    in this handler are per-agent indexed and stay live.
    """
    stats, freshness = await _stats_doc(db, force_refresh=refresh)
    start, end = _period_range(period)
    prior_start, prior_end = (
        _prior_period(start, end) if start else (None, end)
    )

    # All agents + VAs — back-office roles aren't producers, exclude.
    users_cursor = db.users.find(
        {"role": {"$in": ["agent", "va"]},
         "is_active": True, "status": "active"},
        {"_id": 0, "id": 1, "full_name": 1, "email": 1, "agent_name": 1,
         "role": 1, "agent_id": 1},
    )
    users = await users_cursor.to_list(length=None)

    # Roll-ups by agent_id in a single round trip each.
    async def _grouped(coll: str, match: dict) -> dict:
        out: dict = {}
        async for row in db[coll].aggregate([
            {"$match": {"agent_id": {"$ne": None}, **match}},
            {"$group": {"_id": "$agent_id", "n": {"$sum": 1}}},
        ]):
            out[row["_id"]] = int(row.get("n", 0))
        return out

    period_match = (
        {"created_at": {"$gte": start.isoformat(),
                        "$lte": end.isoformat()}} if start else {}
    )
    prior_match = (
        {"created_at": {"$gte": prior_start.isoformat(),
                        "$lte": prior_end.isoformat()}}
        if start else {}
    )

    leads_in_period = await _grouped("leads", period_match)
    enrolled_in_period = await _grouped("leads",
                                          {**period_match, "status": "enrolled"})
    enrolled_in_prior = await _grouped("leads",
                                         {**prior_match, "status": "enrolled"})

    # Revenue by agent_id from production_records (period-bound, same
    # convention as _revenue_sum above).
    revenue_match = {"agent_id": {"$ne": None, "$ne": ""}}
    if start is not None:
        revenue_match["effective_date"] = {
            "$gte": start.date().isoformat(),
            "$lte": end.date().isoformat(),
        }
    revenue: dict = {}
    async for row in db.production_records.aggregate([
        {"$match": revenue_match},
        {"$group": {"_id": "$agent_id",
                     "rev": {"$sum": "$revenue_expected"}}},
    ]):
        revenue[row["_id"]] = float(row.get("rev") or 0.0)

    # Last activity per agent (most recent lead they created) — pulled
    # from the dashboard_stats cache (P3 pre-aggregated every 15min).
    # Falls back to live $group if the cache field is missing.
    last_active: dict = stats.get("agents_last_active") or {}
    if not last_active:
        async for row in db.leads.aggregate([
            {"$match": {"agent_id": {"$ne": None}}},
            {"$group": {"_id": "$agent_id",
                         "last": {"$max": "$created_at"}}},
        ]):
            last_active[row["_id"]] = row.get("last")

    # Team-size rollup (users.parent_agent_id == agent.id).
    team_sizes: dict = {}
    async for row in db.users.aggregate([
        {"$match": {"parent_agent_id": {"$ne": None}}},
        {"$group": {"_id": "$parent_agent_id", "n": {"$sum": 1}}},
    ]):
        team_sizes[row["_id"]] = int(row.get("n", 0))

    rows = []
    for u in users:
        uid = u.get("id")
        leads_n = leads_in_period.get(uid, 0)
        enr_n = enrolled_in_period.get(uid, 0)
        prior_enr = enrolled_in_prior.get(uid, 0)
        conv = round((enr_n / leads_n) * 100.0, 1) if leads_n else 0.0
        rows.append({
            "agent_id": uid,
            "agent_name": u.get("agent_name") or u.get("full_name"),
            "email": u.get("email"),
            "leads_count": leads_n,
            "enrolled_count": enr_n,
            "conversion_rate": conv,
            "estimated_revenue": round(revenue.get(uid, 0.0), 2),
            "trend_pct": _trend_pct(enr_n, prior_enr),
            "last_active_at": last_active.get(uid),
            "team_size": team_sizes.get(uid, 0),
            "status": _activity_status(last_active.get(uid)),
        })

    rows.sort(key=lambda r: (r["enrolled_count"], r["estimated_revenue"]),
              reverse=True)

    await write_audit(
        db, "agency_dashboard_agents_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"period": period, "row_count": len(rows),
                   "cache_age_s": freshness},
    )
    return {
        "period": period,
        "agents": rows,
        "count": len(rows),
        "_meta": _stats_meta(stats, freshness),
    }


# ── Charts ────────────────────────────────────────────────────────────────

def _iso_week_label(d: date) -> str:
    """ISO week id like 2026-W21."""
    y, w, _ = d.isocalendar()
    return f"{y:04d}-W{w:02d}"


def _week_floor(d: date) -> date:
    """Monday of the ISO week containing ``d``."""
    return d - timedelta(days=d.weekday())


def _short_week_label(monday: date) -> str:
    """Human label like 'May 19' for the Monday of a week.

    ``%-d`` is glibc-only and crashes on Windows. Strip the leading
    zero manually so the label renders the same on Render (Linux)
    and a dev box (Windows / macOS)."""
    return f"{monday.strftime('%b')} {monday.day}"


@router.get("/charts")
@limiter.limit("30/hour")
async def charts(
    request: Request,
    period: str = Query("mtd", pattern="^(mtd|last30|last90|ytd|all)$"),
    refresh: bool = Query(False),
    current_user: dict = Depends(require_roles(*AGENCY_ROLES)),
    db=Depends(get_phi_db),
):
    """Chart-ready aggregates. ``enrollments_by_week`` is always the
    LAST 12 WEEKS regardless of ``period`` — that chart's purpose is
    sustained-trend, not period summary. ``revenue_by_carrier`` and
    ``leads_by_source`` honour ``period``.

    Fix E: leads_by_source pulled from the dashboard_stats cache (P4+P5
    combined into one $cond-sum aggregation per period in the
    aggregator). enrollments_by_week and revenue_by_carrier stay live —
    the former is bounded to 12 weeks, the latter has date and carrier
    filters that keep it cheap at scale.
    """
    stats, freshness = await _stats_doc(db, force_refresh=refresh)
    start, end = _period_range(period)

    # ── Enrollments by week (last 12 weeks, fixed) ───────────────────
    today = date.today()
    this_monday = _week_floor(today)
    weeks = [this_monday - timedelta(days=7 * i) for i in range(11, -1, -1)]
    week_keys = [_iso_week_label(w) for w in weeks]
    week_index = {k: i for i, k in enumerate(week_keys)}
    week_buckets = [0] * 12

    earliest = weeks[0].isoformat()
    cursor = db.leads.find(
        {"status": "enrolled",
         "created_at": {"$gte": earliest}},
        {"_id": 0, "created_at": 1},
    )
    async for ld in cursor:
        ld = safe_lead_load(ld)
        raw = ld.get("created_at") or ""
        # Tolerant date pull — ISO datetime string or BSON datetime.
        try:
            if hasattr(raw, "date"):
                d = raw.date()
            else:
                d = datetime.fromisoformat(
                    str(raw).replace("Z", "+00:00")
                ).date()
        except Exception:
            continue
        key = _iso_week_label(_week_floor(d))
        if key in week_index:
            week_buckets[week_index[key]] += 1

    enrollments_by_week = [
        {
            "week": week_keys[i],
            "label": _short_week_label(weeks[i]),
            "count": week_buckets[i],
        }
        for i in range(12)
    ]

    # ── Revenue by carrier (top 8, period-bound) ─────────────────────
    rev_match: dict = {"carrier": {"$ne": None, "$ne": ""},
                       "revenue_expected": {"$ne": None}}
    if start is not None:
        rev_match["effective_date"] = {
            "$gte": start.date().isoformat(),
            "$lte": end.date().isoformat(),
        }
    revenue_by_carrier = []
    async for row in db.production_records.aggregate([
        {"$match": rev_match},
        {"$group": {"_id": "$carrier",
                     "revenue": {"$sum": "$revenue_expected"},
                     "count": {"$sum": 1}}},
        {"$sort": {"revenue": -1}},
        {"$limit": 8},
    ]):
        revenue_by_carrier.append({
            "carrier": row["_id"],
            "revenue": round(float(row.get("revenue") or 0.0), 2),
            "count": int(row.get("count", 0)),
        })

    # ── Leads by source ──────────────────────────────────────────────
    # From the dashboard_stats cache (P4+P5 combined per period). On
    # cache miss for this period, fall back to a single-pass live
    # aggregation (the aggregator-shape $cond-sum, not the legacy
    # two-pass that lived here).
    period_block = (stats.get("periods") or {}).get(period) or {}
    leads_by_source = period_block.get("leads_by_source")
    if leads_by_source is None:
        from dashboard_aggregator import _leads_by_source as _live_lbs
        leads_by_source = await _live_lbs(db, start, end)

    await write_audit(
        db, "agency_dashboard_charts_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"period": period, "cache_age_s": freshness},
    )
    return {
        "period": period,
        "enrollments_by_week": enrollments_by_week,
        "revenue_by_carrier": revenue_by_carrier,
        "leads_by_source": leads_by_source,
        "_meta": _stats_meta(stats, freshness),
    }


# ── Alerts ────────────────────────────────────────────────────────────────

@router.get("/alerts")
@limiter.limit("30/hour")
async def alerts(
    request: Request,
    refresh: bool = Query(False),
    current_user: dict = Depends(require_roles(*AGENCY_ROLES)),
    db=Depends(get_phi_db),
):
    """Three alert buckets agency leadership should action right now:
    stale leads (per-agent counts), birthday windows currently open,
    renewals due in the next 7 days.

    Fix E: stale_leads_by_agent pulled from the dashboard_stats cache.
    Birthday + renewals stay live — both filter on indexed/small sets
    and need per-day freshness for the windows-opening-today UX.
    """
    stats, freshness = await _stats_doc(db, force_refresh=refresh)
    today_dt = datetime.now(timezone.utc)
    today = today_dt.date()

    # ── Stale leads per agent ────────────────────────────────────────
    # From the dashboard_stats cache (alerts pipeline pre-aggregated
    # every 15min; the 7-day cutoff is computed at refresh time). On
    # cache miss fall back to a live aggregation via the shared helper
    # in dashboard_aggregator.
    stale_rows = stats.get("stale_leads_by_agent")
    if stale_rows is None:
        from dashboard_aggregator import _stale_leads_by_agent as _live_slba
        cutoff_7 = today_dt - timedelta(days=7)
        stale_rows = await _live_slba(db, cutoff_7)
    else:
        # Shallow copy so we don't mutate the cached doc when we
        # enrich with agent_name below.
        stale_rows = [dict(r) for r in stale_rows]
    # Enrich with agent names — one round trip.
    if stale_rows:
        ids = [r["agent_id"] for r in stale_rows]
        names: Dict[str, str] = {}
        async for u in db.users.find(
            {"id": {"$in": ids}},
            {"_id": 0, "id": 1, "full_name": 1, "agent_name": 1},
        ):
            names[u["id"]] = u.get("agent_name") or u.get("full_name") or "—"
        for r in stale_rows:
            r["agent_name"] = names.get(r["agent_id"], "—")

    # ── Birthday windows currently open ─────────────────────────────
    bday_rows: List[Dict[str, Any]] = []
    query = {
        "$or": [{"state": s} for s in
                ("IL", "il", "Il", "Illinois", "illinois")],
        "status": {"$nin": list(_BR_EXCLUDED)},
        "date_of_birth": {"$ne": None},
    }
    proj = {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
            "email": 1, "phone": 1, "date_of_birth": 1,
            "current_carrier": 1, "current_plan": 1, "agent_name": 1}
    async for ld in db.leads.find(query, proj):
        ld = safe_lead_load(ld)
        item = _birthday_eval_lead(ld, today)
        if not item or item.get("_bucket") != "urgent":
            continue
        bday_rows.append({
            "lead_id": item["lead_id"],
            "client_name": item["full_name"],
            "agent_name": item.get("agent_name") or "Unassigned",
            "days_remaining": item.get("days_remaining_in_window") or 0,
            "carrier": item.get("current_carrier"),
        })
    bday_rows.sort(key=lambda r: r["days_remaining"])

    # ── Renewals due in next 7 days ──────────────────────────────────
    renewal_rows: List[Dict[str, Any]] = []
    async for p in db.policies.find(
        {"effective_date": {"$ne": None, "$ne": ""}},
        {"_id": 0, "policy_id": 1, "lead_id": 1, "contact_name": 1,
         "carrier": 1, "effective_date": 1, "agent_name": 1},
    ):
        eff = _ren_parse(p.get("effective_date"))
        if not eff:
            continue
        anniv = _ren_anniv(eff)
        days = (anniv - today).days
        if 0 <= days <= 7:
            renewal_rows.append({
                "lead_id": p.get("lead_id"),
                "client_name": p.get("contact_name") or "—",
                "agent_name": p.get("agent_name") or "Unassigned",
                "renewal_date": anniv.isoformat(),
                "days_until": days,
                "carrier": p.get("carrier"),
            })
    renewal_rows.sort(key=lambda r: r["days_until"])

    await write_audit(
        db, "agency_dashboard_alerts_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"cache_age_s": freshness},
    )
    return {
        "stale_leads": stale_rows,
        "birthday_windows": bday_rows,
        "renewals_due": renewal_rows,
        "_meta": _stats_meta(stats, freshness),
    }


# ── Drilldown ────────────────────────────────────────────────────────────

_DRILLDOWN_METRICS = (
    "leads", "enrolled", "policies", "revenue",
    "birthday_windows", "renewals", "stale_leads",
)
_PAGE_SIZE = 50


def _paginate(items: List[Any], page: int) -> Dict[str, Any]:
    """Slice ``items`` into a page of ``_PAGE_SIZE`` + envelope."""
    page = max(1, page)
    total = len(items)
    start_idx = (page - 1) * _PAGE_SIZE
    end_idx = start_idx + _PAGE_SIZE
    return {
        "page": page,
        "page_size": _PAGE_SIZE,
        "total": total,
        "total_pages": (total + _PAGE_SIZE - 1) // _PAGE_SIZE if total else 0,
        "rows": items[start_idx:end_idx],
    }


@router.get("/drilldown/{metric}")
@limiter.limit("30/hour")
async def drilldown(
    request: Request,
    metric: str,
    period: str = Query("mtd", pattern="^(mtd|last30|last90|ytd|all)$"),
    agent_id: Optional[str] = Query(None, max_length=64),
    page: int = Query(1, ge=1, le=1000),
    current_user: dict = Depends(require_roles(*AGENCY_ROLES)),
    db=Depends(get_phi_db),
):
    """Paginated detail behind any KPI card.

    Columns shipped per metric vary — the SPA maps each metric to its
    own column set rather than guessing. Records use string-ISO dates
    throughout so the SPA can sort/format them with whatever locale
    it wants.
    """
    if metric not in _DRILLDOWN_METRICS:
        raise HTTPException(400, f"Unknown metric — choose one of "
                                  f"{', '.join(_DRILLDOWN_METRICS)}")
    start, end = _period_range(period)
    today_dt = datetime.now(timezone.utc)
    today = today_dt.date()

    rows: List[Dict[str, Any]] = []

    if metric == "leads":
        match = {**_iso_range_filter("created_at", start, end)}
        if agent_id:
            match["agent_id"] = agent_id
        async for ld in db.leads.find(
            match,
            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
             "agent_name": 1, "status": 1, "lead_source": 1,
             "created_at": 1, "phone": 1, "email": 1},
        ).sort("created_at", -1).limit(_PAGE_SIZE * 50):
            ld = safe_lead_load(ld)
            rows.append({
                "lead_id": ld.get("id"),
                "client_name": f"{ld.get('first_name','')} "
                               f"{ld.get('last_name','')}".strip() or "—",
                "agent_name": ld.get("agent_name") or "Unassigned",
                "status": ld.get("status"),
                "source": ld.get("lead_source"),
                "created_at": ld.get("created_at"),
            })

    elif metric == "enrolled":
        match = {"status": "enrolled",
                 **_iso_range_filter("created_at", start, end)}
        if agent_id:
            match["agent_id"] = agent_id
        async for ld in db.leads.find(
            match,
            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
             "agent_name": 1, "current_carrier": 1, "current_plan": 1,
             "created_at": 1, "plan_type_premium": 1},
        ).sort("created_at", -1).limit(_PAGE_SIZE * 50):
            ld = safe_lead_load(ld)
            rows.append({
                "lead_id": ld.get("id"),
                "client_name": f"{ld.get('first_name','')} "
                               f"{ld.get('last_name','')}".strip() or "—",
                "agent_name": ld.get("agent_name") or "Unassigned",
                "carrier": ld.get("current_carrier"),
                "product": ld.get("current_plan"),
                "date": ld.get("created_at"),
                "premium": ld.get("plan_type_premium"),
            })

    elif metric == "policies":
        match: dict = {}
        if start is not None:
            match["submitted_at"] = {
                "$gte": start.isoformat(), "$lte": end.isoformat(),
            }
        if agent_id:
            match["agent_id"] = agent_id
        async for p in db.policies.find(
            match,
            {"_id": 0, "policy_id": 1, "lead_id": 1, "contact_name": 1,
             "agent_name": 1, "carrier": 1, "product_label": 1,
             "product_type": 1, "premium": 1, "total_premium": 1,
             "submitted_at": 1, "created_at": 1},
        ).sort([("submitted_at", -1), ("created_at", -1)]).limit(_PAGE_SIZE * 50):
            rows.append({
                "policy_id": p.get("policy_id"),
                "lead_id": p.get("lead_id"),
                "client_name": p.get("contact_name") or "—",
                "agent_name": p.get("agent_name") or "Unassigned",
                "carrier": p.get("carrier"),
                "product": p.get("product_label") or p.get("product_type"),
                "premium": p.get("premium") or p.get("total_premium"),
                "written_date": p.get("submitted_at") or p.get("created_at"),
            })

    elif metric == "revenue":
        match: dict = {"revenue_expected": {"$ne": None}}
        if start is not None:
            match["effective_date"] = {
                "$gte": start.date().isoformat(),
                "$lte": end.date().isoformat(),
            }
        if agent_id:
            match["agent_id"] = agent_id
        async for r in db.production_records.aggregate([
            {"$match": match},
            {"$group": {
                "_id": "$agent_id",
                "agent_name": {"$first": "$agent_name"},
                "revenue": {"$sum": "$revenue_expected"},
                "count": {"$sum": 1},
            }},
            {"$sort": {"revenue": -1}},
        ]):
            rows.append({
                "agent_id": r["_id"],
                "agent_name": r.get("agent_name") or "Unassigned",
                "revenue": round(float(r.get("revenue") or 0.0), 2),
                "policy_count": int(r.get("count", 0)),
            })

    elif metric == "birthday_windows":
        query = {
            "$or": [{"state": s} for s in
                    ("IL", "il", "Il", "Illinois", "illinois")],
            "status": {"$nin": list(_BR_EXCLUDED)},
            "date_of_birth": {"$ne": None},
        }
        if agent_id:
            query["agent_id"] = agent_id
        proj = {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
                "email": 1, "phone": 1, "date_of_birth": 1,
                "current_carrier": 1, "current_plan": 1, "agent_name": 1}
        async for ld in db.leads.find(query, proj):
            ld = safe_lead_load(ld)
            item = _birthday_eval_lead(ld, today)
            if not item or item.get("_bucket") != "urgent":
                continue
            rows.append({
                "lead_id": item["lead_id"],
                "client_name": item["full_name"],
                "agent_name": item.get("agent_name") or "Unassigned",
                "date_of_birth": item["date_of_birth"],
                "carrier": item.get("current_carrier"),
                "days_remaining": item.get("days_remaining_in_window") or 0,
            })
        rows.sort(key=lambda r: r["days_remaining"])

    elif metric == "renewals":
        match = {"effective_date": {"$ne": None, "$ne": ""}}
        if agent_id:
            match["agent_id"] = agent_id
        async for p in db.policies.find(
            match,
            {"_id": 0, "policy_id": 1, "lead_id": 1, "contact_name": 1,
             "carrier": 1, "effective_date": 1, "agent_name": 1},
        ):
            eff = _ren_parse(p.get("effective_date"))
            if not eff:
                continue
            anniv = _ren_anniv(eff)
            days = (anniv - today).days
            if 0 <= days <= 90:
                rows.append({
                    "lead_id": p.get("lead_id"),
                    "client_name": p.get("contact_name") or "—",
                    "agent_name": p.get("agent_name") or "Unassigned",
                    "carrier": p.get("carrier"),
                    "anniversary": anniv.isoformat(),
                    "days_until": days,
                })
        rows.sort(key=lambda r: r["days_until"])

    elif metric == "stale_leads":
        cutoff_7 = today_dt - timedelta(days=7)
        match = {
            "status": {"$in": ["new", "contacted", "qualified",
                                "appointment_set"]},
            "updated_at": {"$lt": cutoff_7.isoformat()},
        }
        if agent_id:
            match["agent_id"] = agent_id
        async for ld in db.leads.find(
            match,
            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
             "agent_name": 1, "status": 1, "lead_source": 1,
             "updated_at": 1, "phone": 1},
        ).sort("updated_at", 1).limit(_PAGE_SIZE * 50):
            ld = safe_lead_load(ld)
            last = ld.get("updated_at") or ""
            rows.append({
                "lead_id": ld.get("id"),
                "client_name": f"{ld.get('first_name','')} "
                               f"{ld.get('last_name','')}".strip() or "—",
                "agent_name": ld.get("agent_name") or "Unassigned",
                "status": ld.get("status"),
                "source": ld.get("lead_source"),
                "phone": ld.get("phone"),
                "last_contact": last,
            })

    page_payload = _paginate(rows, page)
    await write_audit(
        db, "agency_dashboard_drilldown_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"metric": metric, "period": period,
                  "agent_id": agent_id, "page": page,
                  "row_count": len(rows)},
    )
    return {
        "metric": metric,
        "period": period,
        "agent_id": agent_id,
        **page_payload,
    }
