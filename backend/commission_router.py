"""
commission_router.py
====================
Calculator endpoints layered on top of ``commission_calculator``.

The legacy ``commissions_router`` (plural) handles uploads + ComTrack
roll-ups, and ``commission_audit_router`` handles the audit + chat
panels. This file owns the rate-quoting surface — kept separate so
each router stays focused.
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from deps import agent_filter, get_current_user, get_db, write_audit
from commission_calculator import (
    CARRIERS_BY_PRODUCT,
    PLAN_OPTIONS_BY_PRODUCT,
    PRODUCT_TYPES,
    calculate_commission,
)


router = APIRouter(prefix="/commission", tags=["commission-calculator"])


class CalculateRequest(BaseModel):
    product_type: str = Field(..., description="med_supp, ma, pdp, hip, …")
    carrier: Optional[str] = ""
    state: Optional[str] = ""
    plan_type: Optional[str] = None
    monthly_premium: float = 0.0
    client_age: int = 65
    scope_completed: bool = False
    # Optional context — purely informational; doesn't affect the math
    # but lets the audit log distinguish lead-driven quotes from
    # exploratory ones.
    lead_source: Optional[str] = None
    lead_id: Optional[str] = None


@router.post("/calculate")
async def calculate(
    payload: CalculateRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> Dict[str, Any]:
    """Quote the agency revenue + agent split for a hypothetical policy.

    Always 200 — even when a rate isn't found, the response carries
    ``carrier_rate: null`` and a human ``notes`` string so the UI can
    surface "no rate configured for this combo" without a network
    error. Audit-logs every quote (metadata-only, no PHI in payload).
    """
    result = calculate_commission(
        product_type=payload.product_type,
        carrier=payload.carrier or "",
        state=payload.state or "",
        plan_type=payload.plan_type,
        monthly_premium=payload.monthly_premium,
        client_age=payload.client_age,
        scope_completed=payload.scope_completed,
    )

    # Audit: nothing in this payload is PHI, but we still keep the
    # metadata tight — agent id + non-identifying inputs only.
    await write_audit(
        db,
        "commission_calculated",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="commission_quote",
        target_id=payload.lead_id or None,
        request=request,
        metadata={
            "product_type": payload.product_type,
            "carrier": payload.carrier,
            "state": (payload.state or "").upper(),
            "plan_type": payload.plan_type,
            "client_age": payload.client_age,
            "scope_completed": payload.scope_completed,
            "annual_premium": result["annual_premium"],
            "agency_revenue": result["agency_revenue"],
            "agent_commission": result["agent_commission"],
            "rate_type": result["rate_type"],
            "lead_source": payload.lead_source,
        },
    )
    return result


@router.get("/carriers")
async def carriers(
    _user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """Static dropdown helper for the calculator UI.

    Returns the carrier list per product family + the available plan
    options. Sourced from the rate-engine module so the UI never lists
    a carrier that has no rates configured.
    """
    return {
        "product_types": PRODUCT_TYPES,
        "carriers_by_product": CARRIERS_BY_PRODUCT,
        "plan_options_by_product": PLAN_OPTIONS_BY_PRODUCT,
    }


# ── Earnings rollup ──────────────────────────────────────────────────────
VALID_EARNINGS_PERIODS = ("mtd", "ytd", "last30", "last90", "all")


def _earnings_period_start(period: str) -> Optional[datetime]:
    now = datetime.now(timezone.utc)
    if period == "mtd":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if period == "ytd":
        return now.replace(month=1, day=1, hour=0, minute=0, second=0,
                            microsecond=0)
    if period == "last30":
        return now - timedelta(days=30)
    if period == "last90":
        return now - timedelta(days=90)
    return None  # "all"


def _parse_iso_safe(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        cleaned = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _safe_float(v: Any) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


@router.get("/earnings")
async def earnings(
    period: str = Query("mtd", description="mtd|ytd|last30|last90|all"),
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> Dict[str, Any]:
    """Per-agent earnings rollup powering the 'My Earnings' tab.

    Sums ``revenue_expected`` / ``revenue_received`` from
    ``production_records`` for the active period. Always scoped by
    ``agent_filter`` — agents see their own numbers, admin/compliance
    see agency-wide totals. ``monthly`` always returns 6 dense buckets
    so the bar chart isn't sparse on a fresh agent.
    """
    if period not in VALID_EARNINGS_PERIODS:
        period = "mtd"
    scope = agent_filter(current_user)
    start = _earnings_period_start(period)
    six_months_ago = datetime.now(timezone.utc) - timedelta(days=180)

    expected_total = 0.0
    received_total = 0.0
    monthly_buckets: Dict[str, float] = defaultdict(float)

    cursor = db["production_records"].find(
        scope,
        {"_id": 0, "app_date": 1, "revenue_expected": 1,
         "revenue_received": 1},
    )
    async for r in cursor:
        amt_exp = _safe_float(r.get("revenue_expected"))
        amt_rec = _safe_float(r.get("revenue_received"))
        app_dt = _parse_iso_safe(r.get("app_date"))
        if not app_dt:
            continue
        in_period = (start is None) or (app_dt >= start)
        if in_period:
            expected_total += amt_exp
            received_total += amt_rec
        if app_dt >= six_months_ago:
            monthly_buckets[app_dt.strftime("%Y-%m")] += amt_exp

    # 6-month dense series for the bar chart.
    now = datetime.now(timezone.utc)
    monthly = []
    for i in range(5, -1, -1):
        month_dt = now.replace(day=15) - timedelta(days=30 * i)
        key = month_dt.strftime("%Y-%m")
        monthly.append({
            "month": key,
            "expected": round(monthly_buckets.get(key, 0.0), 2),
        })

    gap = round(expected_total - received_total, 2)
    return {
        "period": period,
        "scope": "agency" if "agent_id" not in scope else "agent",
        "expected": round(expected_total, 2),
        "received": round(received_total, 2),
        "gap": gap,
        "monthly": monthly,
    }
