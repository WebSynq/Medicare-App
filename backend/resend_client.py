"""Resend email sender.

Async, never-raise wrapper. Returns a boolean so the caller can audit /
log per send without wrapping each call in its own try/except. Sending
domain is GHW's `noreply@ghwcrm.com`; the RESEND_API_KEY must come from
environment (set on Render — never hardcoded).

When RESEND_API_KEY is not set (local dev, pytest), `send_email`
short-circuits to a no-op that returns False and logs a warning. This
lets the rest of the system run end-to-end without a live API key.
"""
import logging
import os
from typing import Optional

import httpx


logger = logging.getLogger(__name__)


def _api_key() -> str:
    """Read the key at call time so test code can monkey-patch the env."""
    return (os.getenv("RESEND_API_KEY") or "").strip()


FROM_ADDRESS = "GHW Agent Portal <noreply@ghwcrm.com>"
_RESEND_URL = "https://api.resend.com/emails"


async def send_email(
    to: str,
    subject: str,
    html: str,
    reply_to: Optional[str] = None,
    *,
    agency_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> bool:
    """Send an email via Resend. Returns True on success.

    Never raises — the caller always gets a boolean. A missing
    RESEND_API_KEY returns False with a warning so the rest of the
    pipeline (audit log, retry scheduling) can record the skip.

    Metering (Phase 2): when ``agency_id`` is supplied and the send
    succeeds, we emit an ``email_sent`` usage event (fire-and-forget).
    Callers that don't have agency_id handy (legacy paths, automations
    that resolve from a lead) can either pass it or omit it — omission
    means the email isn't billed to any tenant, which is fine for
    platform-owned notifications (e.g. account lockout alerts).
    """
    api_key = _api_key()
    if not api_key:
        logger.warning(
            "resend: RESEND_API_KEY not set — email not sent to %s (%s)",
            to, subject[:80],
        )
        return False
    if not to:
        logger.warning("resend: empty recipient — skipping (%s)", subject[:80])
        return False

    payload: dict = {
        "from": FROM_ADDRESS,
        "to": [to],
        "subject": subject,
        "html": html,
    }
    if reply_to:
        payload["reply_to"] = reply_to

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                _RESEND_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            if r.status_code in (200, 201):
                logger.info(
                    "resend: sent to %s (%s)", to, subject[:80],
                )
                # Metering — only when the send actually succeeded
                # AND the caller passed an agency. Wrapped so a
                # metering bug can never demote a successful send to
                # a False return.
                if agency_id:
                    try:
                        from metering import track_email_sent
                        track_email_sent(
                            agency_id=agency_id,
                            agent_id=agent_id,
                            count=1,
                            metadata={"subject_prefix": subject[:60]},
                        )
                    except Exception as _e:                    # noqa: BLE001
                        logger.debug("resend: metering hook failed: %s", _e)
                return True
            # Resend echoes the recipient on certain errors — truncate the
            # response so a long error blob doesn't flood the log.
            body_preview = (r.text or "")[:300]
            logger.warning(
                "resend: HTTP %s sending to %s — %s",
                r.status_code, to, body_preview,
            )
            return False
    except Exception as e:                                    # noqa: BLE001
        logger.warning("resend: send failed to %s: %s", to, e)
        return False
