"""
commission_audit_router.py
==========================
Commission audit endpoints — Phase 2 commission intelligence.

Reads the production_records collection seeded by scripts/import_production.py
and surfaces discrepancies between revenue_expected (Plecto) and
revenue_received (AgencyBloc, when present).

Hard rules:
- All endpoints require auth.
- Agents see only their own records (IDOR firewall — match by
  current_user.agent_name).
- 30/hour per user IP rate limit.
- Every access writes an audit event with role + filters + result counts.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import get_client_ip, get_current_user, get_db, require_roles, write_audit


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/commission/audit", tags=["commission-audit"])
limiter = Limiter(key_func=get_remote_address)


# ── Status taxonomy ─────────────────────────────────────────────────────────
# Records start "pending" (no AgencyBloc reconciliation yet). After AB sync
# the calculator transitions them based on the revenue_expected vs
# revenue_received gap. "resolved" is a manual admin override.
ALLOWED_STATUSES = {"underpaid", "missing", "overpaid", "matched",
                     "pending", "resolved"}

# Discrepancy threshold: gaps within this absolute dollar amount count as
# "matched" (rounding, micro-fee diffs). Beyond it, the gap classifies as
# under/overpaid. Externalised here for one-place tuning.
MATCH_TOLERANCE_USD = 1.00


def _period_filter(period: str) -> Optional[dict]:
    """Translate a period token into a Mongo filter on effective_date."""
    if period == "all":
        return None
    now = datetime.now(timezone.utc).date()
    if period == "week":
        start = now - timedelta(days=7)
    elif period == "month":
        start = now - timedelta(days=30)
    else:
        raise HTTPException(status_code=400,
                            detail=f"Unknown period: {period}")
    return {"effective_date": {"$gte": start.isoformat()}}


def _classify(record: dict) -> str:
    """Derive a live status from the expected/received numbers.

    Stored audit_status wins when it's a terminal label ("resolved"); for
    everything else we recompute on read so newly synced received amounts
    don't require a write to reflect.
    """
    if record.get("audit_status") == "resolved":
        return "resolved"
    expected = record.get("revenue_expected")
    received = record.get("revenue_received")
    if received is None:
        return "pending" if expected is None else "missing"
    if expected is None:
        return "overpaid"
    gap = received - expected
    if abs(gap) <= MATCH_TOLERANCE_USD:
        return "matched"
    return "underpaid" if gap < 0 else "overpaid"


def _gap(record: dict) -> float:
    """Signed gap: positive = overpaid, negative = underpaid.
    None on either side defaults to 0 so it sorts to the bottom of the
    discrepancy ranking without taking precedence over real gaps."""
    expected = record.get("revenue_expected") or 0.0
    received = record.get("revenue_received") or 0.0
    return round(received - expected, 2)


def _scope_filter(current_user: dict) -> dict:
    """Mongo filter restricting an agent to their own records.

    We match by agent_name (canonical identity field — see Task 1) and
    fall back to agent_email when agent_name isn't set on the user row,
    so legacy users whose agent_name isn't backfilled still see their
    own data instead of an empty list.
    """
    role = current_user.get("role")
    if role in ("admin", "compliance"):
        return {}
    filters = []
    if current_user.get("agent_name"):
        filters.append({"agent_name": current_user["agent_name"]})
    if current_user.get("email"):
        filters.append({"agent_email": current_user["email"].lower()})
    if not filters:
        # Authenticated user has no matchable identity → see nothing.
        return {"_no_match": True}
    return {"$or": filters} if len(filters) > 1 else filters[0]


# ── GET /commission/audit ──────────────────────────────────────────────────
@router.get("")
@limiter.limit("30/hour")
async def list_audit_records(
    request: Request,
    period: str = Query("month", pattern="^(week|month|all)$"),
    status: str = Query("all"),
    agent_id: Optional[str] = Query(None, max_length=64,
                                     description="Admin-only override"),
    limit: int = Query(200, ge=1, le=1000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Ranked list of records with discrepancies for the calling agent.

    Agents always see only their own rows. The agent_id param is honoured
    only for admin/compliance — agents passing it are silently ignored
    (we still apply their scope_filter on top).
    """
    if status != "all" and status not in ALLOWED_STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"Unknown status: {status}")

    base_filter: dict = {}
    period_f = _period_filter(period)
    if period_f:
        base_filter.update(period_f)

    role = current_user.get("role")
    if role in ("admin", "compliance") and agent_id:
        target = await db.users.find_one({"id": agent_id}, {"_id": 0})
        if not target:
            raise HTTPException(status_code=404, detail="Agent not found")
        target_name = target.get("agent_name")
        target_email = (target.get("email") or "").lower()
        ors = []
        if target_name:
            ors.append({"agent_name": target_name})
        if target_email:
            ors.append({"agent_email": target_email})
        if ors:
            base_filter["$or"] = ors
        else:
            return {"records": [], "total": 0}
    else:
        # Agent scoping (or admin with no agent_id filter — see everyone)
        scope = _scope_filter(current_user)
        if scope.get("_no_match"):
            return {"records": [], "total": 0}
        base_filter.update(scope)

    cursor = db.production_records.find(base_filter, {"_id": 0}).limit(limit)
    rows = [r async for r in cursor]

    # Classify in-memory (cheap; bounded by limit). Filter by status if asked.
    enriched = []
    for r in rows:
        status_now = _classify(r)
        if status != "all" and status_now != status:
            continue
        enriched.append({**r, "status": status_now, "gap": _gap(r)})

    # Rank by absolute gap descending — biggest discrepancies first.
    enriched.sort(key=lambda r: abs(r["gap"]), reverse=True)

    await write_audit(
        db, "commission_audit_listed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={
            "period": period,
            "status_filter": status,
            "agent_id_filter": agent_id,
            "result_count": len(enriched),
            "role": role,
        },
    )

    return {"records": enriched, "total": len(enriched), "period": period}


# ── GET /commission/audit/summary ──────────────────────────────────────────
@router.get("/summary")
@limiter.limit("30/hour")
async def audit_summary(
    request: Request,
    period: str = Query("month", pattern="^(week|month|all)$"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Team-wide totals (admin) or own-only totals (agent).

    We compute in-memory rather than via $aggregate because _classify
    needs the same Python logic the list endpoint uses; keeping it in
    one place avoids drift between summary numbers and detail rows.
    """
    base_filter: dict = {}
    period_f = _period_filter(period)
    if period_f:
        base_filter.update(period_f)

    scope = _scope_filter(current_user)
    if scope.get("_no_match"):
        return {
            "total_expected": 0.0,
            "total_received": 0.0,
            "total_gap": 0.0,
            "count_by_status": {s: 0 for s in ALLOWED_STATUSES},
            "policies": 0,
            "period": period,
        }
    base_filter.update(scope)

    counts = {s: 0 for s in ALLOWED_STATUSES}
    total_expected = 0.0
    total_received = 0.0
    total_gap = 0.0
    policies = 0

    cursor = db.production_records.find(base_filter, {"_id": 0})
    async for r in cursor:
        policies += 1
        counts[_classify(r)] = counts.get(_classify(r), 0) + 1
        if r.get("revenue_expected") is not None:
            total_expected += r["revenue_expected"]
        if r.get("revenue_received") is not None:
            total_received += r["revenue_received"]
        total_gap += _gap(r)

    await write_audit(
        db, "commission_audit_summary_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"period": period, "role": current_user.get("role"),
                   "policies": policies},
    )

    return {
        "total_expected": round(total_expected, 2),
        "total_received": round(total_received, 2),
        "total_gap": round(total_gap, 2),
        "count_by_status": counts,
        "policies": policies,
        "period": period,
    }


# ── POST /commission/audit/mark-resolved/{record_id} ───────────────────────
class MarkResolvedBody(BaseModel):
    notes: str = Field(..., min_length=1, max_length=2000)


@router.post("/mark-resolved/{record_id}")
@limiter.limit("30/hour")
async def mark_resolved(
    record_id: str,
    request: Request,
    body: MarkResolvedBody = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin")),
):
    """Admin-only: flag a record as resolved + attach notes.

    We accept either the document's id field (UUID) or its natural_key
    (sha256) as record_id — the natural_key is what import_production
    surfaces in the UI when no synthetic id has been assigned.
    """
    record = await db.production_records.find_one(
        {"$or": [{"id": record_id}, {"natural_key": record_id}]},
        {"_id": 0},
    )
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")

    now_iso = datetime.now(timezone.utc).isoformat()
    update_filter = {"natural_key": record["natural_key"]}
    await db.production_records.update_one(
        update_filter,
        {"$set": {
            "audit_status": "resolved",
            "audit_notes": body.notes.strip(),
            "resolved_at": now_iso,
            "resolved_by": current_user["id"],
            "updated_at": now_iso,
        }},
    )

    await write_audit(
        db, "commission_audit_resolved",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="production_record",
        target_id=record["natural_key"],
        request=request,
        metadata={"policy_number": record.get("policy_number"),
                   "carrier": record.get("carrier"),
                   "notes_excerpt": body.notes.strip()[:120]},
    )

    fresh = await db.production_records.find_one(update_filter, {"_id": 0})
    return {**fresh, "status": _classify(fresh), "gap": _gap(fresh)}
