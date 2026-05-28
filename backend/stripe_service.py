"""Stripe integration — webhook verification + state-machine handlers.

Security
========
- STRIPE_SECRET_KEY (required in prod) is read at call time so test
  code can monkey-patch the env. Never logged, never echoed.
- STRIPE_WEBHOOK_SECRET (required in prod) is the only signature
  authority for inbound webhooks. construct_event() raises on a
  signature mismatch and the router translates that to 400.
- Every webhook handler is idempotent. Stripe retries on non-2xx
  responses, and the same event.id can arrive multiple times for
  legitimate operational reasons. We dedupe via
  ``db.stripe_events.insert_one`` on a unique event_id index.

State machine
=============
billing_status transitions driven by Stripe events:

  trialing ──► active           customer.subscription.updated → active
  trialing ──► cancelled        customer.subscription.deleted
  active   ──► past_due         invoice.payment_failed
  past_due ──► active           invoice.payment_succeeded
  past_due ──► suspended        grace_period_ends_at reached
                                (handled by the daily sweep — NOT a
                                Stripe event)
  suspended ──► active          invoice.payment_succeeded
  any      ──► cancelled        customer.subscription.deleted

Stripe never tells us "this account should be suspended" — that's our
business rule (7-day grace period). The sweep that flips past_due →
suspended lives in this module too (``run_grace_period_sweep``) and
is driven by a daily APScheduler tick (see start_grace_period_scheduler).

Emails
======
Every state transition that's visible to the customer fires a
templated email via email_templates.billing_* — best-effort, never
blocks the webhook acknowledgement.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional


logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────
_GRACE_PERIOD_DAYS = 7
_GRACE_WARNING_DAY = 3   # send "X days remaining" warning on day 3


def _stripe_secret() -> str:
    return (os.environ.get("STRIPE_SECRET_KEY") or "").strip()


def _stripe_webhook_secret() -> str:
    return (os.environ.get("STRIPE_WEBHOOK_SECRET") or "").strip()


def _stripe_module():
    """Lazy stripe import — keeps the module importable in test envs
    where the SDK might not be on the path AND avoids the SDK's
    module-level network calls at startup.

    Sets api_key on the imported module from the env each call so
    rotating the key doesn't require a process restart.
    """
    import stripe                                              # noqa: WPS433
    secret = _stripe_secret()
    if secret:
        stripe.api_key = secret
    return stripe


# ── Webhook signature verification ─────────────────────────────────────
class StripeWebhookError(Exception):
    """Raised when the inbound webhook signature is invalid or the
    payload can't be parsed. The router translates this to a 400."""


def verify_and_parse_webhook(payload: bytes, signature_header: str) -> dict:
    """Verify the Stripe signature on a raw webhook body and return
    the parsed event dict.

    Raises StripeWebhookError on:
      - missing STRIPE_WEBHOOK_SECRET env
      - missing/blank Stripe-Signature header
      - bad signature
      - malformed payload
    """
    secret = _stripe_webhook_secret()
    if not secret:
        raise StripeWebhookError(
            "STRIPE_WEBHOOK_SECRET unset — refusing to process webhook"
        )
    if not signature_header:
        raise StripeWebhookError("Stripe-Signature header missing")
    try:
        stripe = _stripe_module()
        event = stripe.Webhook.construct_event(
            payload, signature_header, secret,
        )
    except Exception as e:                                    # noqa: BLE001
        # construct_event raises stripe.error.SignatureVerificationError
        # for bad sigs and ValueError for malformed payloads. Both map
        # to a single 400.
        raise StripeWebhookError(str(e))
    # construct_event returns a stripe.Event (subclass of StripeObject).
    # StripeObject supports dict-style access via .get/.__getitem__ but
    # isinstance(event, dict) returns False. Use to_dict_recursive when
    # available — it produces a plain nested dict that survives
    # downstream JSON serialisation and Mongo writes without surprise.
    if hasattr(event, "to_dict_recursive"):
        return event.to_dict_recursive()
    if hasattr(event, "to_dict"):
        return event.to_dict()
    if isinstance(event, dict):
        return event
    # Last-resort fallback: walk the StripeObject as a mapping.
    return {k: v for k, v in event.items()}


# ── Idempotency helpers ────────────────────────────────────────────────
async def record_event_processed(db, event_id: str,
                                    event_type: Optional[str] = None) -> bool:
    """Atomically insert into db.stripe_events. Returns True when this
    is the first time we've seen the id (caller should process), False
    when it's a duplicate (caller should skip)."""
    if not event_id:
        return False
    try:
        await db.stripe_events.insert_one({
            "event_id": event_id,
            "event_type": event_type,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        })
        return True
    except Exception as e:                                    # noqa: BLE001
        msg = str(e).lower()
        if "duplicate" in msg or "e11000" in msg:
            return False
        # Anything else is a real Mongo problem — surface to caller
        # so the webhook returns 5xx and Stripe retries.
        raise


# ── Agency lookup ──────────────────────────────────────────────────────
async def _find_agency_by_stripe_customer(db, customer_id: str) -> Optional[dict]:
    if not customer_id:
        return None
    return await db.agencies.find_one(
        {"stripe_customer_id": customer_id}, {"_id": 0},
    )


async def _find_agency_by_subscription(db, subscription_id: str) -> Optional[dict]:
    if not subscription_id:
        return None
    return await db.agencies.find_one(
        {"stripe_subscription_id": subscription_id}, {"_id": 0},
    )


# ── State transition helpers ──────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _patch_agency(db, agency_id: str, updates: Dict[str, Any]) -> None:
    if not agency_id:
        return
    updates = {**updates, "last_active_at": _now_iso()}
    await db.agencies.update_one(
        {"agency_id": agency_id}, {"$set": updates},
    )


# ── Webhook event handlers ────────────────────────────────────────────
async def handle_subscription_created(event_obj: dict, db) -> None:
    """Stripe fired customer.subscription.created. Flip the matching
    agency to trialing/active depending on the subscription status."""
    sub_id = event_obj.get("id")
    cust_id = event_obj.get("customer")
    agency = await _find_agency_by_subscription(db, sub_id)
    if not agency:
        agency = await _find_agency_by_stripe_customer(db, cust_id)
    if not agency:
        logger.warning(
            "stripe: subscription.created %s — no matching agency "
            "(customer=%s)", sub_id, cust_id,
        )
        return
    status = (event_obj.get("status") or "").lower()
    billing_status = "trialing" if status == "trialing" else "active"
    updates: Dict[str, Any] = {
        "stripe_subscription_id": sub_id,
        "stripe_customer_id": cust_id,
        "billing_status": billing_status,
    }
    if event_obj.get("trial_end"):
        updates["trial_ends_at"] = datetime.fromtimestamp(
            event_obj["trial_end"], tz=timezone.utc,
        ).isoformat()
    if event_obj.get("current_period_start"):
        updates["current_period_start"] = datetime.fromtimestamp(
            event_obj["current_period_start"], tz=timezone.utc,
        ).isoformat()
    if event_obj.get("current_period_end"):
        updates["current_period_end"] = datetime.fromtimestamp(
            event_obj["current_period_end"], tz=timezone.utc,
        ).isoformat()
    await _patch_agency(db, agency["agency_id"], updates)
    logger.info(
        "stripe: agency=%s subscription_created status=%s",
        agency["agency_id"], billing_status,
    )


async def handle_subscription_updated(event_obj: dict, db) -> None:
    """Subscription state change. Flip billing_status to match Stripe's
    canonical status; clear grace fields if the subscription is healthy
    again."""
    sub_id = event_obj.get("id")
    agency = await _find_agency_by_subscription(db, sub_id)
    if not agency:
        logger.warning(
            "stripe: subscription.updated %s — no matching agency",
            sub_id,
        )
        return
    status = (event_obj.get("status") or "").lower()
    # Stripe statuses we care about:
    #   trialing, active, past_due, canceled, unpaid, incomplete,
    #   incomplete_expired
    # We don't lift "active" -> "suspended" from Stripe; that's our
    # grace-period business rule. Stripe will report "past_due" which
    # is the trigger for the grace period in handle_invoice_payment_failed.
    if status in {"trialing", "active", "past_due"}:
        billing_status = status
    elif status in {"canceled", "unpaid", "incomplete_expired"}:
        billing_status = "cancelled"
    else:
        # incomplete / etc — leave whatever state we have.
        return

    updates: Dict[str, Any] = {"billing_status": billing_status}
    if billing_status == "active":
        # Clear grace fields if we'd previously tripped past_due.
        updates["grace_period_ends_at"] = None
    if event_obj.get("current_period_end"):
        updates["current_period_end"] = datetime.fromtimestamp(
            event_obj["current_period_end"], tz=timezone.utc,
        ).isoformat()
    await _patch_agency(db, agency["agency_id"], updates)
    logger.info(
        "stripe: agency=%s subscription_updated status=%s",
        agency["agency_id"], billing_status,
    )


async def handle_subscription_deleted(event_obj: dict, db) -> None:
    sub_id = event_obj.get("id")
    agency = await _find_agency_by_subscription(db, sub_id)
    if not agency:
        return
    await _patch_agency(db, agency["agency_id"], {
        "billing_status": "cancelled",
        "stripe_subscription_id": None,
        "grace_period_ends_at": None,
    })
    logger.info(
        "stripe: agency=%s subscription_deleted", agency["agency_id"],
    )


async def handle_invoice_payment_failed(event_obj: dict, db) -> None:
    """Card declined / payment failed. Set past_due and stamp a 7-day
    grace_period_ends_at. The sweep flips past_due → suspended at
    grace expiry."""
    cust_id = event_obj.get("customer")
    agency = await _find_agency_by_stripe_customer(db, cust_id)
    if not agency:
        return
    grace_ends = datetime.now(timezone.utc) + timedelta(days=_GRACE_PERIOD_DAYS)
    await _patch_agency(db, agency["agency_id"], {
        "billing_status": "past_due",
        "grace_period_ends_at": grace_ends.isoformat(),
    })
    logger.warning(
        "stripe: agency=%s payment_failed — grace_ends=%s",
        agency["agency_id"], grace_ends.isoformat(),
    )

    # Send "Payment failed" email — best-effort.
    try:
        from email_templates import billing_payment_failed
        from resend_client import send_email
        if agency.get("owner_email"):
            html = billing_payment_failed(
                agency_name=agency.get("name") or "your agency",
                grace_ends_iso=grace_ends.isoformat(),
                grace_days=_GRACE_PERIOD_DAYS,
            )
            await send_email(
                to=agency["owner_email"],
                subject="Payment failed — action required",
                html=html,
                agency_id=agency["agency_id"],
            )
    except Exception as e:                                    # noqa: BLE001
        logger.warning(
            "stripe: payment-failed email skipped agency=%s err=%s",
            agency.get("agency_id"), e,
        )


async def handle_invoice_payment_succeeded(event_obj: dict, db) -> None:
    """Payment landed. Clear grace fields and restore active billing —
    works for both first-of-period charges and the recovery path after
    a past_due/suspended interlude."""
    cust_id = event_obj.get("customer")
    agency = await _find_agency_by_stripe_customer(db, cust_id)
    if not agency:
        return
    was_in_trouble = (agency.get("billing_status") or "") in {
        "past_due", "suspended",
    }
    await _patch_agency(db, agency["agency_id"], {
        "billing_status": "active",
        "grace_period_ends_at": None,
    })
    logger.info(
        "stripe: agency=%s payment_succeeded (prior_status=%s)",
        agency["agency_id"], agency.get("billing_status"),
    )

    if was_in_trouble:
        try:
            from email_templates import billing_payment_received
            from resend_client import send_email
            if agency.get("owner_email"):
                html = billing_payment_received(
                    agency_name=agency.get("name") or "your agency",
                )
                await send_email(
                    to=agency["owner_email"],
                    subject="Payment received — you're back online",
                    html=html,
                    agency_id=agency["agency_id"],
                )
        except Exception as e:                                # noqa: BLE001
            logger.warning(
                "stripe: payment-received email skipped agency=%s err=%s",
                agency.get("agency_id"), e,
            )


async def handle_invoice_upcoming(event_obj: dict, db) -> None:
    """Pre-renewal notice (~7 days before charge). Currently a no-op
    placeholder — surface this on the Billing tab in Phase 6."""
    cust_id = event_obj.get("customer")
    logger.info("stripe: invoice.upcoming for customer=%s", cust_id)


async def handle_trial_will_end(event_obj: dict, db) -> None:
    """Stripe fires this ~3 days before the trial ends. Email the
    owner so they can confirm payment details before the conversion."""
    sub_id = event_obj.get("id")
    agency = await _find_agency_by_subscription(db, sub_id)
    if not agency or not agency.get("owner_email"):
        return
    try:
        from email_templates import billing_trial_ending
        from resend_client import send_email
        trial_end = event_obj.get("trial_end")
        end_iso = (
            datetime.fromtimestamp(trial_end, tz=timezone.utc).isoformat()
            if trial_end else None
        )
        html = billing_trial_ending(
            agency_name=agency.get("name") or "your agency",
            trial_end_iso=end_iso,
        )
        await send_email(
            to=agency["owner_email"],
            subject="Your free trial is ending soon",
            html=html,
            agency_id=agency["agency_id"],
        )
    except Exception as e:                                    # noqa: BLE001
        logger.warning(
            "stripe: trial-ending email skipped agency=%s err=%s",
            agency.get("agency_id"), e,
        )


# ── Event dispatcher ──────────────────────────────────────────────────
_EVENT_HANDLERS: Dict[str, Callable] = {
    "customer.subscription.created": handle_subscription_created,
    "customer.subscription.updated": handle_subscription_updated,
    "customer.subscription.deleted": handle_subscription_deleted,
    "customer.subscription.trial_will_end": handle_trial_will_end,
    "invoice.payment_succeeded": handle_invoice_payment_succeeded,
    "invoice.payment_failed": handle_invoice_payment_failed,
    "invoice.upcoming": handle_invoice_upcoming,
}


async def dispatch_event(event: dict, db) -> Dict[str, Any]:
    """Route a parsed Stripe event to the matching handler. Returns
    a structured result for logging + the webhook response body.

    Idempotency contract: ``record_event_processed`` runs FIRST. If
    the event_id has already been seen, we return early with
    ``{"status": "duplicate"}`` and the caller still ACKs 200 — so
    Stripe stops retrying.
    """
    event_id = event.get("id")
    event_type = event.get("type") or ""
    is_first = await record_event_processed(db, event_id, event_type)
    if not is_first:
        return {"status": "duplicate", "event_id": event_id,
                "event_type": event_type}

    handler = _EVENT_HANDLERS.get(event_type)
    if not handler:
        # Unknown event type — log and ACK. Stripe should not retry
        # for our convenience just because we don't care about an
        # event type yet.
        logger.info("stripe: ignoring event type=%s id=%s",
                     event_type, event_id)
        return {"status": "ignored", "event_id": event_id,
                "event_type": event_type}

    data_object = (event.get("data") or {}).get("object") or {}
    try:
        await handler(data_object, db)
    except Exception as e:                                    # noqa: BLE001
        # Any handler exception is logged BUT we still ACK 200.
        # Re-raising would tell Stripe to retry, which can spiral if
        # the failure is deterministic (e.g. a missing column).
        logger.exception(
            "stripe: handler %s failed id=%s err=%s",
            event_type, event_id, e,
        )
        return {"status": "error", "event_id": event_id,
                "event_type": event_type, "error": str(e)}
    return {"status": "processed", "event_id": event_id,
            "event_type": event_type}


# ── Grace period sweep ────────────────────────────────────────────────
async def run_grace_period_sweep(db) -> Dict[str, int]:
    """Daily tick: enforce the 7-day past_due → suspended business
    rule + send 3-day warning emails.

    Returns counters {"warned": N, "suspended": M}.
    """
    now = datetime.now(timezone.utc)
    warned = 0
    suspended = 0

    # 1. Suspend agencies whose grace_period_ends_at has passed.
    cursor = db.agencies.find({
        "billing_status": "past_due",
        "grace_period_ends_at": {"$ne": None},
    }, {"_id": 0})
    async for agency in cursor:
        try:
            ends = datetime.fromisoformat(
                str(agency["grace_period_ends_at"]).replace("Z", "+00:00"),
            )
            if ends.tzinfo is None:
                ends = ends.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        if ends <= now:
            await _patch_agency(db, agency["agency_id"], {
                "billing_status": "suspended",
            })
            suspended += 1
            logger.warning(
                "stripe: agency=%s suspended (grace expired %s)",
                agency["agency_id"], ends.isoformat(),
            )
            try:
                from email_templates import billing_suspended
                from resend_client import send_email
                if agency.get("owner_email"):
                    html = billing_suspended(
                        agency_name=agency.get("name") or "your agency",
                    )
                    await send_email(
                        to=agency["owner_email"],
                        subject="Account suspended — restore billing to "
                                "continue",
                        html=html,
                        agency_id=agency["agency_id"],
                    )
            except Exception as e:                            # noqa: BLE001
                logger.warning(
                    "stripe: suspension email skipped agency=%s err=%s",
                    agency.get("agency_id"), e,
                )

    # 2. Warn agencies on day _GRACE_WARNING_DAY of their grace period.
    # We compute the "warning instant" as grace_ends - (DAYS -
    # WARNING_DAY) and fire when now is past that instant but the
    # warning hasn't been logged yet.
    warning_window_lead = timedelta(
        days=_GRACE_PERIOD_DAYS - _GRACE_WARNING_DAY,
    )
    cursor = db.agencies.find({
        "billing_status": "past_due",
        "grace_period_ends_at": {"$ne": None},
        "grace_warning_sent_at": {"$exists": False},
    }, {"_id": 0})
    async for agency in cursor:
        try:
            ends = datetime.fromisoformat(
                str(agency["grace_period_ends_at"]).replace("Z", "+00:00"),
            )
            if ends.tzinfo is None:
                ends = ends.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        warning_at = ends - warning_window_lead
        if now < warning_at or ends <= now:
            # Either it's still before the warning point, or we've
            # already crossed the suspension boundary (handled above).
            continue
        days_left = max(0, (ends - now).days)
        try:
            from email_templates import billing_grace_warning
            from resend_client import send_email
            if agency.get("owner_email"):
                html = billing_grace_warning(
                    agency_name=agency.get("name") or "your agency",
                    days_remaining=days_left,
                )
                await send_email(
                    to=agency["owner_email"],
                    subject=f"{days_left} days remaining — update your "
                            "payment method",
                    html=html,
                    agency_id=agency["agency_id"],
                )
        except Exception as e:                                # noqa: BLE001
            logger.warning(
                "stripe: grace-warning email skipped agency=%s err=%s",
                agency.get("agency_id"), e,
            )
            continue
        await db.agencies.update_one(
            {"agency_id": agency["agency_id"]},
            {"$set": {"grace_warning_sent_at": _now_iso()}},
        )
        warned += 1

    return {"warned": warned, "suspended": suspended}


def start_grace_period_scheduler(get_db_fn):
    """Daily CronTrigger at 07:00 UTC running run_grace_period_sweep.
    Disabled when DISABLE_SCHEDULER=1 (pytest)."""
    if (os.getenv("DISABLE_SCHEDULER") or "").strip() == "1":
        logger.info("stripe: grace-period scheduler disabled via env")
        return None

    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger

    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _tick():
        try:
            result = await run_grace_period_sweep(get_db_fn())
            if result["warned"] or result["suspended"]:
                logger.info(
                    "stripe: grace sweep warned=%d suspended=%d",
                    result["warned"], result["suspended"],
                )
        except Exception as e:                                # noqa: BLE001
            logger.exception("stripe: grace sweep failed: %s", e)

    scheduler.add_job(
        _tick,
        trigger=CronTrigger(hour=7, minute=0, timezone="UTC"),
        id="stripe_grace_sweep",
        max_instances=1,
        replace_existing=True,
    )
    scheduler.start()
    logger.info("stripe: grace-period scheduler started (daily 07:00 UTC)")
    return scheduler
