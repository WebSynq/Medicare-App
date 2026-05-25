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
) -> bool:
    """Send an email via Resend. Returns True on success.

    Never raises — the caller always gets a boolean. A missing
    RESEND_API_KEY returns False with a warning so the rest of the
    pipeline (audit log, retry scheduling) can record the skip.
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
