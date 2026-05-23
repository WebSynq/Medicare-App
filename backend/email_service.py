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


# Default sender. Read from FROM_EMAIL at import time so the constant
# stays inspectable; runtime calls re-read via _from_email() below so
# a misconfigured env doesn't bake the default into the worker for
# the lifetime of the process.
FROM_EMAIL_DEFAULT = os.environ.get("FROM_EMAIL", "").strip()


def _from_email() -> str:
    """Single source of truth for the outbound sender. 100% env-driven —
    a missing FROM_EMAIL logs ERROR (loud in Render) and returns a
    sentinel localhost address so a downstream send still fires (and
    fails) instead of silently no-op'ing under an old hard-coded
    domain. The previous default (noreply@grueninghealthwealth.com)
    was pinned in code and would have papered over a real config gap."""
    addr = (os.environ.get("FROM_EMAIL") or "").strip()
    if not addr:
        logger.error(
            "FROM_EMAIL env var not set — emails will fail. "
            "Set FROM_EMAIL in Render environment.",
        )
        return "noreply@localhost"
    return addr


# One-time visibility on startup so a missing RESEND_API_KEY is obvious
# in Render's deploy logs, instead of only manifesting as silent skips
# on every invite.
if not (os.environ.get("RESEND_API_KEY") or "").strip():
    logger.warning(
        "RESEND_API_KEY is unset — transactional email (invite, "
        "password reset, welcome) will be skipped. Add it in Render → "
        "Environment to enable delivery.",
    )


def _frontend_url() -> str:
    """Thin pass-through to deps.get_frontend_url so existing call
    sites in this module keep their local name. The helper itself is
    the single source of truth (deps.get_frontend_url)."""
    from deps import get_frontend_url
    return get_frontend_url()


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


def _send_html(subject: str, to_email: str, html: str,
               text: Optional[str] = None) -> Dict[str, Any]:
    """Synchronous resend.Emails.send call. Returns a small dict that
    callers can use to differentiate provider-not-configured vs.
    upstream-failed vs. success. ``text`` is the optional plain-text
    fallback — Resend serves it to clients that have HTML disabled
    and uses it as the snippet rendered in some preview panes."""
    client = _resend_client()
    if client is None:
        logger.warning(
            "RESEND_API_KEY not configured — skipping email '%s' to %s",
            subject, to_email,
        )
        return {"ok": False, "reason": "not_configured"}
    from_addr = _from_email()
    payload: Dict[str, Any] = {
        "from": from_addr,
        "to": [to_email],
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text
    try:
        resp = client.Emails.send(payload)
        # Resend's Python SDK historically returns a dict on both success
        # AND certain 4xx responses (e.g. unverified-domain). Treat
        # anything that doesn't carry an `id` as a soft failure so the
        # admin sees a clear reason instead of a silent "no email".
        resp_dict = resp or {}
        msg_id = resp_dict.get("id")
        if not msg_id:
            reason = (
                resp_dict.get("message")
                or resp_dict.get("name")
                or "no_id_in_response"
            )
            logger.error(
                "resend send returned no id subject=%r to=%s from=%s "
                "reason=%s payload=%r",
                subject, to_email, from_addr, reason, resp_dict,
            )
            return {"ok": False, "reason": str(reason)[:120]}
        logger.info(
            "resend send ok subject=%r to=%s from=%s id=%s",
            subject, to_email, from_addr, msg_id,
        )
        return {"ok": True, "id": msg_id}
    except Exception as e:
        # logger.exception writes the full traceback to stderr but we
        # *still* want to return cleanly so the caller doesn't 5xx.
        # Include the from address in the message because the #1 cause
        # of Resend failures is sending from an unverified domain.
        logger.exception(
            "resend send FAILED subject=%r to=%s from=%s: %s",
            subject, to_email, from_addr, e,
        )
        return {"ok": False, "reason": f"{type(e).__name__}: {str(e)[:120]}"}


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


def _format_expires_utc(expires_at: Any) -> Optional[str]:
    """Render a datetime / ISO-string as 'HH:MM UTC' for the email
    footer. Returns None when the input isn't usable so the caller can
    omit the line rather than print 'None UTC'."""
    if not expires_at:
        return None
    try:
        if hasattr(expires_at, "strftime"):
            dt = expires_at
        else:
            from datetime import datetime as _dt
            s = str(expires_at)
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = _dt.fromisoformat(s)
        from datetime import timezone as _tz
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_tz.utc)
        return dt.astimezone(_tz.utc).strftime("%H:%M UTC")
    except Exception:
        return None


async def send_magic_link_email(
    db,
    to_email: str,
    full_name: Optional[str],
    magic_url: str,
    expires_at: Any = None,
) -> Dict[str, Any]:
    """Sign-in link email (Option A, the primary auth path).

    Branded shell + big CTA + copy-the-URL fallback + plain-text
    alternative. Carries zero PHI: only the first name from the user
    row, plus the single-use signed URL the user is about to click.
    No password, no MBI, no PII. The expiry-time line uses the
    deterministic mint datetime from auth_router so the footer matches
    what the verify endpoint actually accepts."""
    subject = "Your GHW Agent Portal Login Link"
    first = (full_name or to_email.split("@")[0] or "there").split(" ")[0]
    expires_line = _format_expires_utc(expires_at)
    expires_html = (
        f"<p style=\"color:#94a3b8;font-size:12px;margin-top:18px;\">"
        f"This link expires at <strong style=\"color:#cbd5e1;\">"
        f"{expires_line}</strong>.</p>"
        if expires_line else ""
    )

    body = (
        f"<p style=\"margin:0 0 8px 0;color:#94a3b8;\">Hi "
        f"<strong style=\"color:#ffffff;\">{first}</strong>,</p>"
        # Large heading — inline font-size so Gmail/Outlook render it.
        f"<h1 style=\"margin:14px 0 6px 0;font-size:22px;line-height:28px;"
        f"font-weight:700;color:#ffffff;font-family:Arial,Helvetica,"
        f"sans-serif;\">Sign in to GHW Agent Portal</h1>"
        f"<p style=\"margin:0 0 4px 0;color:#cbd5e1;\">"
        f"Click the button below to sign in. This link expires in "
        f"15 minutes and can only be used once.</p>"
        f"{_button('Sign In Now', magic_url)}"
        # Plain-text URL fallback for any client that strips buttons.
        f"<p style=\"margin:8px 0 4px 0;font-size:12px;color:#94a3b8;\">"
        f"Or copy this link:</p>"
        f"<p style=\"margin:0;padding:10px 12px;border-radius:8px;"
        f"background:rgba(255,255,255,0.04);border:1px solid "
        f"rgba(255,255,255,0.08);font-family:'Courier New',Consolas,"
        f"monospace;font-size:11px;color:#cbd5e1;word-break:break-all;\">"
        f"{magic_url}</p>"
        f"{expires_html}"
        f"<p style=\"color:#94a3b8;font-size:12px;margin-top:18px;\">"
        f"If you didn&rsquo;t request this link, you can safely ignore "
        f"this email. Your account is secure.</p>"
    )

    text_lines = [
        f"Hi {first},",
        "",
        "Sign in to GHW Agent Portal",
        "",
        "Click the link below to sign in. This link expires in "
        "15 minutes and can only be used once.",
        "",
        magic_url,
        "",
    ]
    if expires_line:
        text_lines.append(f"This link expires at {expires_line}.")
        text_lines.append("")
    text_lines.extend([
        "If you didn't request this link, you can safely ignore this "
        "email. Your account is secure.",
        "",
        "— Gruening Health & Wealth",
    ])
    text = "\n".join(text_lines)

    res = _send_html(subject, to_email, _shell(body), text=text)
    await _audit_send(db, "magic_link_email_sent", to_email,
                      res.get("ok", False))
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
