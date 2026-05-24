"""Agent feedback → GHL workflow webhook.

One endpoint: POST /api/feedback. Authenticated. Rate-limited. Posts the
feedback to a GHL Workflow Webhook Trigger URL (configured at the GHL
side), and writes an audit row regardless of webhook outcome so feedback
is never lost — if the webhook URL is unset or GHL is down, the audit
log IS the durable record.
"""
import logging
import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import get_db, get_current_user, write_audit


logger = logging.getLogger("gruening.feedback")
limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


class FeedbackRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    # Client supplies the page URL (window.location.pathname + search)
    # so the GHL task tells the team where the agent was. Capped at 500
    # to keep the audit/webhook body lean and resist accidental URL bombs.
    page_url: str = Field(..., max_length=500)


@router.post("", status_code=201)
@limiter.limit("10/hour")
async def submit_feedback(
    request: Request,
    payload: FeedbackRequest,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    webhook_url = os.environ.get("GHL_FEEDBACK_WEBHOOK_URL", "").strip()
    environment = os.environ.get("ENVIRONMENT", "production").lower()
    # Render auto-injects RENDER_GIT_COMMIT with the deployed SHA. Empty
    # in local dev — fall back to "local" so the payload always has a
    # build identifier the team can grep against.
    commit_sha = os.environ.get("RENDER_GIT_COMMIT", "").strip() or "local"
    submitted_at = datetime.now(timezone.utc).isoformat()

    body = {
        "agent_id": current_user.get("id"),
        "agent_email": current_user.get("email"),
        "agent_name": (
            current_user.get("agent_name")
            or current_user.get("full_name")
            or current_user.get("email")
        ),
        "agent_role": current_user.get("role"),
        "message": payload.message,
        "page_url": payload.page_url,
        "environment": environment,
        "commit_sha": commit_sha,
        "submitted_at": submitted_at,
        "source": "ghw_portal",
    }

    webhook_delivered = False
    webhook_error: str | None = None

    if not webhook_url:
        logger.warning(
            "GHL_FEEDBACK_WEBHOOK_URL is not set — feedback from %s "
            "captured to audit log only.",
            body["agent_email"],
        )
    else:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(webhook_url, json=body)
                resp.raise_for_status()
            webhook_delivered = True
        except Exception as e:
            # Never 5xx the user for a webhook hiccup — the audit row is
            # the durable record. Log loudly so ops sees the failure.
            webhook_error = type(e).__name__
            logger.warning(
                "GHL feedback webhook POST failed for %s: %s",
                body["agent_email"], e,
            )

    await write_audit(
        db, "feedback_submitted",
        actor_email=body["agent_email"],
        actor_id=body["agent_id"],
        target_type="feedback",
        target_id=None,
        request=request,
        metadata={
            "page_url": payload.page_url,
            "message_length": len(payload.message),
            "environment": environment,
            "commit_sha": commit_sha,
            "webhook_configured": bool(webhook_url),
            "webhook_delivered": webhook_delivered,
            "webhook_error": webhook_error,
        },
    )

    return {"ok": True, "webhook_delivered": webhook_delivered}
