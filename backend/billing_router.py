"""Billing router — Stripe checkout, customer portal, webhook ingest.

Endpoint surface
================
Public (no auth, HMAC-verified):
  POST /api/billing/webhook              — Stripe webhook receiver

Owner / super admin only:
  POST /api/billing/create-checkout      — start a Stripe Checkout session
                                            for an agency about to subscribe
  POST /api/billing/portal               — open a Stripe Customer Portal
                                            session for the current agency
  GET  /api/billing/subscription         — read current sub details
  GET  /api/billing/upcoming             — preview next invoice amount

Hard rules
==========
- Webhook endpoint MUST NOT depend on auth. It receives the raw body
  + Stripe-Signature header and verifies via construct_event.
- Webhook returns 200 even on internal processing errors so Stripe
  stops retrying — error details are logged + persisted to
  stripe_events.
- Stripe secret keys (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) are
  read at call time. Never echoed in any response.
- Test-mode safe: if STRIPE_SECRET_KEY is unset, the user-facing
  endpoints 503 with a clear "not configured" message instead of
  trying to call Stripe (which would 401 with a confusing SDK error).
"""
import logging
import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    get_agency,
    get_current_user,
    get_db,
    get_frontend_url,
    write_audit,
)
from stripe_service import (
    StripeWebhookError,
    _stripe_module,
    _stripe_secret,
    dispatch_event,
    verify_and_parse_webhook,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/billing", tags=["billing"])
limiter = Limiter(key_func=get_remote_address)


def _require_stripe_configured() -> None:
    if not _stripe_secret():
        raise HTTPException(
            status_code=503,
            detail=(
                "Stripe is not configured on this environment. "
                "Set STRIPE_SECRET_KEY on Render and redeploy."
            ),
        )


def _is_owner_or_super(user: dict, agency: dict) -> bool:
    role = (user.get("role") or "").strip().lower()
    if role in {"owner", "admin"}:
        return True
    if agency.get("super_admin"):
        return True
    return False


def _require_owner(user: dict, agency: dict) -> None:
    if not _is_owner_or_super(user, agency):
        raise HTTPException(
            status_code=403,
            detail="Only agency owners can manage billing.",
        )


# ── Webhook (public) ───────────────────────────────────────────────────
@router.post("/webhook")
async def stripe_webhook(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Stripe webhook receiver. The route handler always returns 200
    to Stripe unless the signature itself is bad — Stripe's retry
    behavior is helpful for transient outages but counterproductive
    for deterministic handler bugs."""
    payload = await request.body()
    sig = request.headers.get("stripe-signature") or ""
    try:
        event = verify_and_parse_webhook(payload, sig)
    except StripeWebhookError as e:
        logger.warning("stripe: webhook rejected — %s", e)
        # Bad signature / missing secret → 400. Stripe stops retrying
        # on 4xx, which is what we want here (the wrong secret would
        # otherwise loop forever).
        raise HTTPException(status_code=400, detail=str(e))

    result = await dispatch_event(event, db)
    return {"received": True, **result}


# ── Owner-side endpoints ──────────────────────────────────────────────
class CheckoutRequest(BaseModel):
    tier: str = Field(..., description="beta|foundation|growth|domination")
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


_TIER_PRICE_ENV = {
    "beta":        "STRIPE_PRICE_BETA",
    "foundation":  "STRIPE_PRICE_FOUNDATION",
    "growth":      "STRIPE_PRICE_GROWTH",
    "domination":  "STRIPE_PRICE_DOMINATION",
}


def _price_id_for_tier(tier: str) -> str:
    env_key = _TIER_PRICE_ENV.get(tier)
    if not env_key:
        raise HTTPException(400, f"Unknown tier '{tier}'.")
    price_id = (os.environ.get(env_key) or "").strip()
    if not price_id:
        raise HTTPException(
            503,
            f"Stripe price for tier '{tier}' is not configured "
            f"(missing {env_key}).",
        )
    return price_id


@router.post("/create-checkout")
@limiter.limit("20/hour")
async def create_checkout(
    request: Request,
    body: CheckoutRequest = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Start a Stripe Checkout Session for the current agency.

    Returns ``{"url": str}`` — the SPA redirects the browser to this
    URL. On success Stripe redirects to ``success_url`` and the
    subscription event flows back through the webhook.
    """
    _require_stripe_configured()
    _require_owner(current_user, agency)

    price_id = _price_id_for_tier(body.tier)
    stripe = _stripe_module()

    front = get_frontend_url()
    success = body.success_url or f"{front}/settings/billing?stripe=success"
    cancel = body.cancel_url or f"{front}/settings/billing?stripe=cancel"

    try:
        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=success,
            cancel_url=cancel,
            client_reference_id=agency["agency_id"],
            customer=agency.get("stripe_customer_id") or None,
            customer_email=(
                None if agency.get("stripe_customer_id")
                else agency.get("owner_email")
            ),
            metadata={
                "agency_id": agency["agency_id"],
                "tier": body.tier,
            },
        )
    except Exception as e:                                    # noqa: BLE001
        logger.exception(
            "stripe: checkout.create failed agency=%s tier=%s: %s",
            agency.get("agency_id"), body.tier, e,
        )
        raise HTTPException(502, "Stripe checkout creation failed.")

    await write_audit(
        db, "billing_checkout_started",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="agency", target_id=agency["agency_id"],
        request=request,
        metadata={"tier": body.tier, "session_id": session.get("id")},
    )
    return {"url": session.get("url"), "session_id": session.get("id")}


@router.post("/portal")
@limiter.limit("20/hour")
async def open_portal(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Open a Stripe Customer Portal session so the owner can update
    cards, view invoices, or cancel the subscription.
    """
    _require_stripe_configured()
    _require_owner(current_user, agency)

    customer_id = agency.get("stripe_customer_id")
    if not customer_id:
        raise HTTPException(
            400,
            "No Stripe customer on file. Start a checkout session first.",
        )

    stripe = _stripe_module()
    front = get_frontend_url()
    return_url = f"{front}/settings/billing"
    try:
        session = stripe.billing_portal.Session.create(
            customer=customer_id, return_url=return_url,
        )
    except Exception as e:                                    # noqa: BLE001
        logger.exception(
            "stripe: portal.create failed agency=%s: %s",
            agency.get("agency_id"), e,
        )
        raise HTTPException(502, "Stripe portal session creation failed.")

    await write_audit(
        db, "billing_portal_opened",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="agency", target_id=agency["agency_id"],
        request=request,
    )
    return {"url": session.get("url")}


@router.get("/subscription")
async def get_subscription(
    request: Request,
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Read the agency's current billing snapshot. Safe to call even
    without Stripe configured — pulls from our agency record, not from
    Stripe directly."""
    return {
        "agency_id": agency.get("agency_id"),
        "tier": agency.get("tier"),
        "billing_status": agency.get("billing_status"),
        "monthly_base_amount_cents": agency.get("monthly_base_amount"),
        "trial_ends_at": agency.get("trial_ends_at"),
        "current_period_start": agency.get("current_period_start"),
        "current_period_end": agency.get("current_period_end"),
        "grace_period_ends_at": agency.get("grace_period_ends_at"),
        "stripe_configured": bool(_stripe_secret()),
        "has_stripe_customer": bool(agency.get("stripe_customer_id")),
    }


@router.get("/upcoming")
async def upcoming_invoice(
    request: Request,
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Preview the next invoice from Stripe. Returns null totals
    when there's no upcoming invoice (free trial, no payment method,
    cancelled sub)."""
    _require_stripe_configured()
    _require_owner(current_user, agency)

    customer_id = agency.get("stripe_customer_id")
    if not customer_id:
        return {"amount_due_cents": None, "currency": None,
                "period_end": None, "available": False,
                "reason": "no_stripe_customer"}

    stripe = _stripe_module()
    try:
        # Stripe SDK renamed Invoice.upcoming → Invoice.create_preview
        # in newer versions. Try both for forward compatibility.
        if hasattr(stripe.Invoice, "create_preview"):
            inv = stripe.Invoice.create_preview(customer=customer_id)
        else:
            inv = stripe.Invoice.upcoming(customer=customer_id)
    except Exception as e:                                    # noqa: BLE001
        msg = str(e).lower()
        if "no upcoming invoice" in msg or "no_upcoming_invoice" in msg:
            return {"amount_due_cents": None, "currency": None,
                    "period_end": None, "available": False,
                    "reason": "no_upcoming_invoice"}
        logger.warning(
            "stripe: upcoming preview failed agency=%s: %s",
            agency.get("agency_id"), e,
        )
        return {"amount_due_cents": None, "currency": None,
                "period_end": None, "available": False,
                "reason": "stripe_error"}

    return {
        "amount_due_cents": inv.get("amount_due"),
        "currency": inv.get("currency"),
        "period_end": inv.get("period_end"),
        "available": True,
    }
