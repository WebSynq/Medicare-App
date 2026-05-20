"""
email_service.py
================
Transactional email via Resend.

Every public function is a never-throw, fire-and-forget wrapper around
``resend.Emails.send``: any failure (missing API key, network blip,
Resend 4xx/5xx) is caught, logged, and audit-recorded. The calling
auth flows must not depend on email delivery — a user can still be
invited, registered, or password-reset even if the email blackhole.

Branding: dark navy (#080E1A) chrome with orange (#E85D2F) accents to
match the in-app login screen. Inline styles only — Gmail / Outlook
both strip <style> blocks.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger("gruening.email")


FROM_EMAIL_DEFAULT = "noreply@grueninghw.com"


def _from_email() -> str:
    return (os.environ.get("FROM_EMAIL") or FROM_EMAIL_DEFAULT).strip()


def _frontend_url() -> str:
    return (
        os.environ.get("FRONTEND_URL")
        or "https://medicare-app-sandy-tau.vercel.app"
    ).rstrip("/")


def _resend_client():
    """Return a usable resend module configured with the API key, or
    None when not configured (caller short-circuits to a logged no-op)."""
    api_key = (os.environ.get("RESEND_API_KEY") or "").strip()
    if not api_key:
        return None
    try:
        import resend
        resend.api_key = api_key
        return resend
    except Exception as e:
        logger.warning("resend import failed: %s", e)
        return None


async def _audit_send(db, event_type: str, to_email: str, ok: bool,
                       extra: Optional[Dict[str, Any]] = None) -> None:
    """Best-effort audit row for every send attempt. PHI-safe — we log
    only the recipient address (which the agent / admin sees in the UI
    anyway) and the high-level event type."""
    if db is None:
        return
    try:
        from deps import write_audit
        await write_audit(
            db, event_type,
            target_type="email", target_id=to_email,
            metadata={"ok": ok, **(extra or {})},
        )
    except Exception as e:
        logger.warning("audit_send failed (%s): %s", event_type, e)


def _send_html(subject: str, to_email: str, html: str) -> Dict[str, Any]:
    """Synchronous resend.Emails.send call. Returns a small dict that
    callers can use to differentiate provider-not-configured vs.
    upstream-failed vs. success."""
    client = _resend_client()
    if client is None:
        logger.warning(
            "RESEND_API_KEY not configured — skipping email '%s' to %s",
            subject, to_email,
        )
        return {"ok": False, "reason": "not_configured"}
    try:
        resp = client.Emails.send({
            "from": _from_email(),
            "to": [to_email],
            "subject": subject,
            "html": html,
        })
        logger.info(
            "resend send ok subject=%r to=%s id=%s",
            subject, to_email, (resp or {}).get("id"),
        )
        return {"ok": True, "id": (resp or {}).get("id")}
    except Exception as e:
        # logger.exception writes the full traceback to stderr but we
        # *still* want to return cleanly so the caller doesn't 5xx.
        logger.exception(
            "resend send FAILED subject=%r to=%s: %s",
            subject, to_email, e,
        )
        return {"ok": False, "reason": type(e).__name__}


# ── HTML templating ──────────────────────────────────────────────────────
# Single shared shell so all three emails look like part of the same
# product. Inline styles only — Gmail strips <style> blocks.
_SHELL = """
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#080E1A;font-family:Arial,Helvetica,sans-serif;color:#e2e8f0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"
           width="100%" style="background:#080E1A;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"
                 width="560" style="max-width:560px;background:#0f172a;border-radius:14px;overflow:hidden;border:1px solid rgba(232,93,47,0.18);">
            <tr>
              <td style="padding:28px 32px 16px 32px;border-bottom:1px solid rgba(255,255,255,0.06);">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="background:linear-gradient(135deg,#E85D2F 0%,#c84416 100%);width:40px;height:40px;border-radius:10px;text-align:center;vertical-align:middle;">
                      <span style="color:#fff;font-weight:800;font-size:18px;font-family:Arial,Helvetica,sans-serif;">G</span>
                    </td>
                    <td style="padding-left:12px;vertical-align:middle;">
                      <div style="font-size:15px;font-weight:700;color:#ffffff;">Gruening Health &amp; Wealth</div>
                      <div style="font-size:11px;color:#94a3b8;margin-top:1px;">Agent Portal</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 8px 32px;font-size:14px;line-height:22px;color:#e2e8f0;">
                {BODY}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px 32px;border-top:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:11px;color:#64748b;">
                  Gruening Health &amp; Wealth · HIPAA Compliant · Powered by AWS Bedrock
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


def _button(text: str, href: str) -> str:
    """Inline-styled CTA button. Bulletproof shape — table-based so
    Outlook on Windows renders it correctly."""
    return (
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;">'
        '<tr><td align="center" '
        'style="background:linear-gradient(135deg,#E85D2F 0%,#c84416 100%);'
        'border-radius:10px;">'
        f'<a href="{href}" target="_blank" '
        'style="display:inline-block;padding:12px 22px;color:#ffffff;'
        'text-decoration:none;font-weight:700;font-size:14px;'
        'font-family:Arial,Helvetica,sans-serif;">'
        f'{text}</a></td></tr></table>'
    )


def _shell(body_html: str) -> str:
    return _SHELL.replace("{BODY}", body_html)


# ── Public API ───────────────────────────────────────────────────────────
async def send_invite_email(
    db,
    to_email: str,
    invite_url: str,
    invited_by: str,
    role: str,
    expires_at: str,
) -> Dict[str, Any]:
    subject = "You've been invited to GHW Agent Portal"
    role_label = (role or "agent").replace("_", " ").title()
    body = (
        f"<p>Hi,</p>"
        f"<p><strong style=\"color:#ffffff;\">{invited_by or 'A GHW administrator'}</strong> "
        f"has invited you to join the Gruening Health &amp; Wealth Agent "
        f"Portal as <strong style=\"color:#ffffff;\">{role_label}</strong>.</p>"
        f"{_button('Accept Invitation', invite_url)}"
        f"<p style=\"color:#94a3b8;font-size:12px;\">"
        f"This link expires {expires_at}.</p>"
        f"<p style=\"color:#94a3b8;font-size:12px;\">"
        f"If you didn&rsquo;t expect this, you can safely ignore this email.</p>"
    )
    res = _send_html(subject, to_email, _shell(body))
    await _audit_send(db, "invite_email_sent", to_email, res.get("ok", False),
                      {"role": role, "invited_by": invited_by})
    return res


async def send_password_reset_email(
    db,
    to_email: str,
    reset_url: str,
    full_name: Optional[str] = None,
) -> Dict[str, Any]:
    subject = "Reset your GHW Portal password"
    greeting = f"Hi {full_name}," if full_name else "Hi,"
    body = (
        f"<p>{greeting}</p>"
        "<p>Someone requested a password reset for your Gruening "
        "Health &amp; Wealth Agent Portal account.</p>"
        f"{_button('Reset Password', reset_url)}"
        "<p style=\"color:#94a3b8;font-size:12px;\">"
        "This link expires in 1 hour.</p>"
        "<p style=\"color:#94a3b8;font-size:12px;\">"
        "If you didn&rsquo;t request this, you can safely ignore this email.</p>"
    )
    res = _send_html(subject, to_email, _shell(body))
    await _audit_send(db, "password_reset_email_sent", to_email, res.get("ok", False))
    return res


async def send_welcome_email(
    db,
    to_email: str,
    full_name: Optional[str],
    role: Optional[str],
) -> Dict[str, Any]:
    subject = "Welcome to GHW Agent Portal"
    name = full_name or to_email.split("@")[0]
    role_label = (role or "agent").replace("_", " ").title()
    body = (
        f"<p>Hi <strong style=\"color:#ffffff;\">{name}</strong>,</p>"
        "<p>Your account is ready.</p>"
        f"<p style=\"color:#94a3b8;font-size:13px;\">"
        f"Role: <strong style=\"color:#ffffff;\">{role_label}</strong></p>"
        f"{_button('Sign In Now', _frontend_url() + '/login')}"
        "<p>Welcome to the team.</p>"
    )
    res = _send_html(subject, to_email, _shell(body))
    await _audit_send(db, "welcome_email_sent", to_email, res.get("ok", False),
                      {"role": role})
    return res
