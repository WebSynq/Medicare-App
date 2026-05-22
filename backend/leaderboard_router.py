"""
leaderboard_router.py
=====================
GET /api/leaderboard — agency-wide leaderboard from production_records.

This is the canonical replacement for any prior mock leaderboard. Numbers
come straight from the production_records collection seeded by
scripts/import_production.py.

Hard rules:
- Auth required.
- 60/hour per-IP rate limit (slowapi).
- Every access writes a leaderboard_viewed audit event.
- Agents see the full leaderboard for transparency, but their own row is
  flagged via the `is_self` field so the UI can highlight it.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import forbid_roles, get_db, resolve_agent_key, write_audit
# Reuse the same _classify / _gap helpers the audit router uses so the
# leaderboard's "audit_gap" math matches what /commission/audit/summary returns
# for the same user. One classification function, one source of truth.
from commission_audit_router import _classify, _gap


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leaderboard", tags=["leaderboard"])
limiter = Limiter(key_func=get_remote_address)

# Share of the agency revenue that lands with the agent. Plecto's
# revenue_expected is gross-of-split, so the leaderboard must apply this
# rate before showing an agent their own number. revenue_total (the gross)
# is admin/compliance-only.
AGENT_SPLIT_RATE = 0.30


def _period_filter(period: str) -> Optional[dict]:
    if period == "all":
        return None
    now = datetime.now(timezone.utc).date()
    if period == "week":
        start = now - timedelta(days=7)
    elif period == "month":
        start = now - timedelta(days=30)
    elif period == "ytd":
        start = now.replace(month=1, day=1)
    else:
        return None
    return {"effective_date": {"$gte": start.isoformat()}}


@router.get("")
@limiter.limit("60/hour")
async def get_leaderboard(
    request: Request,
    period: str = Query("month", pattern="^(week|month|ytd|all)$"),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    # client_success is blocked from the leaderboard — revenue-shaped data
    # is admin/agent territory only.
    current_user: dict = Depends(forbid_roles("client_success")),
):
    """Agency-wide leaderboard sourced from production_records.

    Each row reports, for the requested period:
      - agent_split      Agent's share of revenue (revenue_total * AGENT_SPLIT_RATE)
      - revenue_total    Agency gross (Plecto truth) — admin/compliance only
      - audit_gap        Sum of unresolved gaps (resolved records contribute 0)
      - policies_count   Row count
    Sorted by agent_split descending.

    Agents never see ``revenue_total`` — the gross is stripped server-side
    so a curious agent can't read it from devtools. ``is_self`` flags the
    calling user's own row when their agent_name matches.
    """
    base_filter: dict = {}
    period_f = _period_filter(period)
    if period_f:
        base_filter.update(period_f)

    # Aggregate by agent_name. We do classification in Python so the rule
    # used here is identical to the rule the audit endpoints use.
    by_agent: dict[str, dict] = {}
    cursor = db.production_records.find(base_filter, {"_id": 0})
    async for r in cursor:
        agent_name = (r.get("agent_name") or "").strip() or "Unassigned"
        bucket = by_agent.setdefault(agent_name, {
            "agent_name": agent_name,
            "revenue_total": 0.0,
            "audit_gap": 0.0,
            "policies_count": 0,
        })
        bucket["policies_count"] += 1
        if r.get("revenue_expected") is not None:
            bucket["revenue_total"] += r["revenue_expected"]
        # Resolved records don't count toward outstanding gap.
        if _classify(r) != "resolved":
            bucket["audit_gap"] += _gap(r)

    # Match self by the same canonical key the rest of the commission
    # endpoints use — agent_name primary, full_name fallback for legacy
    # users whose agent_name hasn't been backfilled.
    my_agent_name = resolve_agent_key(current_user)
    role = current_user.get("role")
    can_see_gross = role in ("admin", "compliance")

    rows = []
    for row in by_agent.values():
        revenue_total = round(row["revenue_total"], 2)
        out = {
            "agent_name": row["agent_name"],
            "agent_split": round(revenue_total * AGENT_SPLIT_RATE, 2),
            "agent_split_pct": AGENT_SPLIT_RATE,
            "audit_gap": round(row["audit_gap"], 2),
            "policies_count": row["policies_count"],
            "is_self": (my_agent_name is not None
                         and row["agent_name"] == my_agent_name),
        }
        if can_see_gross:
            out["revenue_total"] = revenue_total
        rows.append(out)
    rows.sort(key=lambda r: r["agent_split"], reverse=True)
    rows = rows[:limit]
    # Rank after slicing so positions reflect what the client sees.
    for i, r in enumerate(rows, start=1):
        r["rank"] = i

    await write_audit(
        db, "leaderboard_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={
            "period": period,
            "limit": limit,
            "row_count": len(rows),
            "role": current_user.get("role"),
        },
    )

    return {"period": period, "total": len(rows), "rows": rows}
