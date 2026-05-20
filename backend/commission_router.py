"""
commission_router.py
====================
Calculator endpoints layered on top of ``commission_calculator``.

The legacy ``commissions_router`` (plural) handles uploads + ComTrack
roll-ups, and ``commission_audit_router`` handles the audit + chat
panels. This file owns the rate-quoting surface — kept separate so
each router stays focused.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from deps import get_current_user, get_db, write_audit
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
