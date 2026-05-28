"""GHW Medicare email templates.

Every template returns a complete HTML email string with inline CSS so it
renders consistently across Gmail, Outlook, and Apple Mail (which all
strip <head> styles). All templates share a single shell helper so brand
voice, footer, and accessibility scaffolding (preheader text, semantic
table layout, dark-mode-tolerant colors) stay in one place.

Brand:
  forest-green #1B4332  — primary
  copper       #B5451B  — secondary / CTA
  cream        #FAFAF5  — page background
  charcoal     #1F2937  — body text
"""
from html import escape
from typing import Optional


# ── Brand palette ─────────────────────────────────────────────────────────
_FOREST = "#1B4332"
_COPPER = "#B5451B"
_CREAM = "#FAFAF5"
_CHARCOAL = "#1F2937"
_MUTED = "#6B7280"
_BORDER = "#E5E7EB"


# ── Shell ─────────────────────────────────────────────────────────────────
def _shell(
    preheader: str,
    title: str,
    body_html: str,
    cta: Optional[dict] = None,
) -> str:
    """Wrap body content in the shared GHW email shell.

    cta is an optional {"label": str, "url": str} — when provided we
    render a copper-filled button under the body content.
    """
    cta_html = ""
    if cta and cta.get("url") and cta.get("label"):
        cta_html = f"""
        <tr>
          <td align="center" style="padding:24px 32px 0 32px;">
            <a href="{escape(cta['url'])}" target="_blank" rel="noopener"
               style="background:{_COPPER};color:#ffffff;text-decoration:none;
                      display:inline-block;padding:12px 28px;border-radius:6px;
                      font-weight:600;font-size:15px;">
              {escape(cta['label'])}
            </a>
          </td>
        </tr>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{escape(title)}</title>
</head>
<body style="margin:0;padding:0;background:{_CREAM};font-family:-apple-system,
             BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
             color:{_CHARCOAL};-webkit-text-size-adjust:100%;">
  <span style="display:none!important;visibility:hidden;mso-hide:all;
               font-size:1px;line-height:1px;max-height:0;max-width:0;
               opacity:0;overflow:hidden;">{escape(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         border="0" style="background:{_CREAM};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               border="0" style="width:100%;max-width:600px;background:#ffffff;
                                 border-radius:8px;overflow:hidden;
                                 border:1px solid {_BORDER};">
          <tr>
            <td style="background:{_FOREST};padding:20px 32px;">
              <div style="color:#ffffff;font-size:18px;font-weight:700;
                          letter-spacing:0.4px;">
                Gruening Health &amp; Wealth
              </div>
              <div style="color:#cbd5d0;font-size:12px;margin-top:2px;">
                Medicare guidance for real lives.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 12px 32px;">
              <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;
                          color:{_FOREST};">{escape(title)}</h1>
              <div style="font-size:15px;line-height:1.6;color:{_CHARCOAL};">
                {body_html}
              </div>
            </td>
          </tr>{cta_html}
          <tr>
            <td style="padding:24px 32px 28px 32px;">
              <hr style="border:none;border-top:1px solid {_BORDER};margin:24px 0 16px 0;">
              <p style="margin:0;font-size:12px;color:{_MUTED};line-height:1.5;">
                Gruening Health &amp; Wealth · Licensed insurance agency<br>
                Reply to this email or call your agent directly with any questions.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _detail_table(rows: list[tuple[str, str]]) -> str:
    """Two-column label/value table used inside several emails."""
    body = ""
    for label, value in rows:
        body += f"""
        <tr>
          <td style="padding:6px 12px 6px 0;font-size:13px;color:{_MUTED};
                     vertical-align:top;width:140px;">{escape(label)}</td>
          <td style="padding:6px 0;font-size:14px;color:{_CHARCOAL};
                     font-weight:600;">{escape(value)}</td>
        </tr>"""
    return f"""
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:8px 0 4px 0;border-collapse:collapse;">
        {body}
      </table>"""


def _meeting_line(meeting_type: str, meeting_link: str) -> str:
    """Render the "how we'll meet" line consistent across emails."""
    if (meeting_type or "").lower() == "video":
        return (
            f"Your agent will host a video call. Join link: "
            f"<a href=\"{escape(meeting_link)}\" target=\"_blank\" rel=\"noopener\" "
            f"style=\"color:{_COPPER};\">{escape(meeting_link)}</a>"
        )
    return (
        f"Your agent will call you at the number you provided. "
        f"If you don't recognise the caller ID, the number is "
        f"<strong>{escape(meeting_link)}</strong>."
    )


# ── 1. Booking confirmation (to the client) ──────────────────────────────
def booking_confirmation_client(
    client_name: str,
    agent_name: str,
    agent_phone: str,
    date_str: str,
    time_str: str,
    meeting_type: str,
    meeting_link: str,
    booking_reason: str,
    cancel_url: str,
) -> str:
    first = (client_name or "there").split()[0]
    # For video meetings we render a copper CTA button so the raw join
    # URL never appears as visible text — protects against the client
    # copy-pasting a wrong link, and matches the visual treatment of
    # the other CTAs in this file. Phone meetings keep the shared
    # _meeting_line render so the phone-number callout style stays
    # consistent across confirmation + reminder emails.
    is_video = (meeting_type or "").lower() == "video"
    if is_video and meeting_link:
        meeting_block = f"""
      <p style="margin:16px 0 8px 0;">
        Your agent will host a video call. Use the button below to join
        at the time of your appointment.
      </p>
      <p style="margin:0;">
        <a href="{escape(meeting_link)}" target="_blank" rel="noopener"
           style="background:{_COPPER};color:#ffffff;text-decoration:none;
                  display:inline-block;padding:12px 28px;border-radius:6px;
                  font-weight:600;">
          Join Video Call
        </a>
      </p>"""
    else:
        meeting_block = f"""
      <p style="margin:16px 0 0 0;">
        {_meeting_line(meeting_type, meeting_link)}
      </p>"""
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        You're booked. Here are your appointment details:
      </p>
      {_detail_table([
          ("Date", date_str),
          ("Time", time_str),
          ("Meeting type", meeting_type.title() if meeting_type else "Phone"),
          ("Your agent", agent_name),
          ("Reason", booking_reason),
      ])}
      {meeting_block}
      <p style="margin:16px 0 0 0;color:{_MUTED};font-size:13px;">
        Need to reschedule? Reply to this email or call {escape(agent_phone)}.
      </p>"""
    cta = None
    if cancel_url and cancel_url != "#":
        cta = {"label": "Manage your appointment", "url": cancel_url}
    return _shell(
        preheader=f"You're booked with {agent_name} on {date_str} at {time_str}.",
        title="Your appointment is confirmed",
        body_html=body,
        cta=cta,
    )


# ── 2. Booking notification (to the agent) ───────────────────────────────
def booking_notification_agent(
    agent_name: str,
    client_name: str,
    client_phone: str,
    client_email: str,
    date_str: str,
    time_str: str,
    meeting_type: str,
    booking_reason: str,
    portal_url: str,
) -> str:
    first = (agent_name or "there").split()[0]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        A client just booked time on your calendar.
      </p>
      {_detail_table([
          ("Client", client_name),
          ("Phone", client_phone or "—"),
          ("Email", client_email or "—"),
          ("Date", date_str),
          ("Time", time_str),
          ("Meeting", meeting_type.title() if meeting_type else "Phone"),
          ("Reason", booking_reason or "—"),
      ])}
      <p style="margin:16px 0 0 0;">
        Open the client profile to review notes and prep for the call.
      </p>"""
    return _shell(
        preheader=f"{client_name} booked {date_str} at {time_str}.",
        title="New booking on your calendar",
        body_html=body,
        cta={"label": "Open client profile", "url": portal_url} if portal_url else None,
    )


# ── 3. Reminder email (48 / 24 / 1 hour) ─────────────────────────────────
def reminder_email(
    client_name: str,
    agent_name: str,
    agent_phone: str,
    date_str: str,
    time_str: str,
    meeting_type: str,
    meeting_link: str,
    hours_before: int,
) -> str:
    if hours_before >= 36:
        title = "Your appointment is in 2 days"
        lead = "Just a friendly reminder — we're meeting in two days."
    elif hours_before >= 12:
        title = "Your appointment is tomorrow"
        lead = "Quick reminder — we're meeting tomorrow."
    else:
        title = "Your appointment is in 1 hour"
        lead = "Heads up — your appointment starts in about an hour."

    first = (client_name or "there").split()[0]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">{escape(lead)}</p>
      {_detail_table([
          ("Date", date_str),
          ("Time", time_str),
          ("With", agent_name),
      ])}
      <p style="margin:16px 0 0 0;">
        {_meeting_line(meeting_type, meeting_link)}
      </p>
      <p style="margin:16px 0 0 0;color:{_MUTED};font-size:13px;">
        Need to reschedule? Reply to this email or call {escape(agent_phone)}.
      </p>"""
    return _shell(
        preheader=title,
        title=title,
        body_html=body,
    )


# ── 4. Post-appointment follow-up ────────────────────────────────────────
def post_appointment_followup(
    client_name: str,
    agent_name: str,
    agent_phone: str,
    agent_email: str,
    booking_reason: str,
) -> str:
    first = (client_name or "there").split()[0]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        Thanks for taking the time to talk yesterday — it was great
        connecting. If anything came up after we hung up, or if you'd
        like me to walk through more options around <em>{escape(booking_reason or "your coverage")}</em>,
        just hit reply.
      </p>
      <p style="margin:0 0 14px 0;">
        You can reach me directly at {escape(agent_phone)} or
        <a href="mailto:{escape(agent_email)}"
           style="color:{_COPPER};">{escape(agent_email)}</a>.
      </p>
      <p style="margin:16px 0 0 0;">— {escape(agent_name)}</p>"""
    return _shell(
        preheader="Following up on our call.",
        title="A quick follow-up",
        body_html=body,
    )


# ── 5. Birthday rule window ──────────────────────────────────────────────
def birthday_window_email(
    client_name: str,
    agent_name: str,
    agent_phone: str,
    agent_email: str,
    current_carrier: str,
    current_plan: str,
    booking_url: str,
) -> str:
    first = (client_name or "there").split()[0]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        Your Illinois Medicare Birthday Rule window opens around your
        upcoming birthday. For 63 days after your birthday, you can
        switch Medicare Supplement plans <strong>without medical
        underwriting</strong> — no health questions, no rate-ups.
      </p>
      {_detail_table([
          ("Current carrier", current_carrier or "—"),
          ("Current plan", current_plan or "—"),
      ])}
      <p style="margin:16px 0 0 0;">
        This is the easiest window of the year to make sure you're not
        overpaying. Want me to compare your plan against what's
        available right now? Pick a time below — it takes about 20
        minutes.
      </p>
      <p style="margin:16px 0 0 0;color:{_MUTED};font-size:13px;">
        Or reach me directly at {escape(agent_phone)} /
        <a href="mailto:{escape(agent_email)}"
           style="color:{_COPPER};">{escape(agent_email)}</a>.
      </p>"""
    return _shell(
        preheader="Your Birthday Rule window is opening — switch without underwriting.",
        title="Your Birthday Rule window is opening",
        body_html=body,
        cta={"label": "Schedule a plan review", "url": booking_url}
        if booking_url else None,
    )


# ── 6. Enrolled welcome ──────────────────────────────────────────────────
def enrolled_welcome_email(
    client_name: str,
    agent_name: str,
    agent_phone: str,
    agent_email: str,
    plan_name: str,
    carrier: str,
) -> str:
    first = (client_name or "there").split()[0]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        Welcome aboard — your enrollment is confirmed.
      </p>
      {_detail_table([
          ("Plan", plan_name or "—"),
          ("Carrier", carrier or "—"),
          ("Your agent", agent_name),
      ])}
      <p style="margin:16px 0 0 0;">
        Your carrier will mail your ID cards in the next 7–14 days.
        I'll check in around your effective date to make sure
        everything went smoothly, and I'm your point of contact for
        anything that comes up during the year.
      </p>
      <p style="margin:16px 0 0 0;color:{_MUTED};font-size:13px;">
        Reach me at {escape(agent_phone)} or
        <a href="mailto:{escape(agent_email)}"
           style="color:{_COPPER};">{escape(agent_email)}</a>.
      </p>"""
    return _shell(
        preheader="Welcome — your enrollment is confirmed.",
        title="You're enrolled",
        body_html=body,
    )


# ── 7. New lead notification (to the agent) ──────────────────────────────
def new_lead_agent_notification(
    agent_name: str,
    client_name: str,
    client_phone: str,
    client_email: str,
    product_interest: str,
    portal_url: str,
) -> str:
    first = (agent_name or "there").split()[0]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        A new lead just landed in your book. Speed-to-lead matters —
        the next 15 minutes are your best window.
      </p>
      {_detail_table([
          ("Client", client_name),
          ("Phone", client_phone or "—"),
          ("Email", client_email or "—"),
          ("Interest", product_interest or "—"),
      ])}
      <p style="margin:16px 0 0 0;">Open the lead to start outreach.</p>"""
    return _shell(
        preheader=f"New lead: {client_name}",
        title="New lead assigned to you",
        body_html=body,
        cta={"label": "Open lead", "url": portal_url} if portal_url else None,
    )


# ── 8. Stale lead alert (to the agent) ───────────────────────────────────
def stale_lead_agent_alert(
    agent_name: str,
    client_name: str,
    client_phone: str,
    days_since_contact: int,
    portal_url: str,
) -> str:
    first = (agent_name or "there").split()[0]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        You haven't touched <strong>{escape(client_name)}</strong> in
        {days_since_contact} days. They're still in your pipeline and
        could go cold — worth a quick check-in.
      </p>
      {_detail_table([
          ("Client", client_name),
          ("Phone", client_phone or "—"),
          ("Days since contact", str(days_since_contact)),
      ])}
      <p style="margin:16px 0 0 0;">
        Even a one-line "are you still looking?" email keeps the door
        open for renewal-season conversations.
      </p>"""
    return _shell(
        preheader=f"{client_name} — {days_since_contact} days since contact",
        title="Stale lead — worth a check-in",
        body_html=body,
        cta={"label": "Open lead", "url": portal_url} if portal_url else None,
    )


# ── 9. Security alert (to admin / owner inbox) ───────────────────────────
def security_alert_email(
    threat_level: str,
    narrative: str,
    findings: list,
    banned_ips: list,
    auto_ban_enabled: bool,
    ops_url: str = "https://app.ghwcrm.com/ops",
) -> str:
    """AI-triaged security alert. Plain-language summary + findings
    table + auto-ban readout, with a forest-green CTA to the Ops
    Console for the full report."""
    level = (threat_level or "low").lower()
    badge_bg = {
        "critical": "#7F1D1D",
        "high":     "#B91C1C",
        "medium":   "#B45309",
        "low":      "#15803D",
    }.get(level, "#374151")
    badge_label = {
        "critical": "CRITICAL THREAT",
        "high":     "HIGH THREAT",
        "medium":   "MEDIUM THREAT",
        "low":      "ALL CLEAR",
    }.get(level, level.upper())

    # Findings table.
    findings_html = ""
    if findings:
        rows = ""
        for f in findings:
            sev = (f.get("severity") or "").lower()
            sev_color = {
                "critical": "#B91C1C",
                "high":     "#B45309",
                "medium":   "#92400E",
                "low":      _MUTED,
            }.get(sev, _MUTED)
            ips = ", ".join((f.get("affected_ips") or [])[:5]) or "—"
            rows += f"""
              <tr>
                <td style="padding:6px 10px;font-size:12px;color:{_CHARCOAL};
                           border-top:1px solid {_BORDER};">
                  {escape(f.get('type','—'))}
                </td>
                <td style="padding:6px 10px;font-size:12px;color:{sev_color};
                           font-weight:700;border-top:1px solid {_BORDER};">
                  {escape(sev.upper() or '—')}
                </td>
                <td style="padding:6px 10px;font-size:12px;color:{_CHARCOAL};
                           border-top:1px solid {_BORDER};">
                  {escape((f.get('description') or '')[:200])}
                </td>
                <td style="padding:6px 10px;font-size:12px;color:{_MUTED};
                           border-top:1px solid {_BORDER};">{escape(ips)}</td>
              </tr>"""
        findings_html = f"""
          <h3 style="margin:18px 0 6px 0;color:{_FOREST};font-size:14px;">
            Findings
          </h3>
          <table style="width:100%;border-collapse:collapse;
                        border:1px solid {_BORDER};border-radius:6px;
                        overflow:hidden;">
            <thead>
              <tr style="background:{_CREAM};">
                <th style="text-align:left;padding:8px 10px;font-size:11px;
                           color:{_MUTED};letter-spacing:0.6px;
                           text-transform:uppercase;">Type</th>
                <th style="text-align:left;padding:8px 10px;font-size:11px;
                           color:{_MUTED};letter-spacing:0.6px;
                           text-transform:uppercase;">Severity</th>
                <th style="text-align:left;padding:8px 10px;font-size:11px;
                           color:{_MUTED};letter-spacing:0.6px;
                           text-transform:uppercase;">Description</th>
                <th style="text-align:left;padding:8px 10px;font-size:11px;
                           color:{_MUTED};letter-spacing:0.6px;
                           text-transform:uppercase;">IPs</th>
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>"""

    bans_html = ""
    if banned_ips:
        ban_items = "".join(
            f'<li style="font-family:monospace;font-size:13px;'
            f'color:{_CHARCOAL};">{escape(ip)}</li>'
            for ip in banned_ips
        )
        bans_html = f"""
          <h3 style="margin:18px 0 6px 0;color:{_FOREST};font-size:14px;">
            IPs auto-banned this cycle
          </h3>
          <ul style="margin:0;padding:0 0 0 18px;">{ban_items}</ul>"""

    kill_switch_html = ""
    if not auto_ban_enabled:
        kill_switch_html = f"""
          <div style="margin-top:16px;padding:12px 14px;border-radius:6px;
                      background:#FEF3C7;border-left:4px solid #B45309;">
            <strong style="color:#92400E;font-size:13px;">
              ⚠️ Auto-ban is DISABLED.
            </strong>
            <div style="color:#92400E;font-size:12px;margin-top:4px;">
              Threats will alert but won't auto-block. Re-enable from
              Ops Console &rarr; Security &rarr; Kill switch.
            </div>
          </div>"""

    body = f"""
      <p style="margin:0 0 8px 0;">
        <span style="display:inline-block;background:{badge_bg};
                     color:#ffffff;padding:4px 10px;border-radius:4px;
                     font-size:11px;letter-spacing:1.4px;font-weight:700;">
          {escape(badge_label)}
        </span>
      </p>
      <p style="margin:14px 0 0 0;font-size:15px;line-height:1.6;color:{_CHARCOAL};">
        {escape(narrative or 'No narrative produced.')}
      </p>
      {findings_html}
      {bans_html}
      {kill_switch_html}
      <p style="margin:18px 0 0 0;color:{_MUTED};font-size:12px;">
        Generated automatically by the GHW security intelligence loop.
      </p>"""

    return _shell(
        preheader=f"{badge_label} — GHW security analysis",
        title="Security analysis",
        body_html=body,
        cta={"label": "Open Ops Console", "url": ops_url} if ops_url else None,
    )


# ── Billing emails (Phase 3) ─────────────────────────────────────────────
# All sent to the agency owner (agencies.owner_email). PHI-free —
# templates only mention agency name + dollar amounts + dates.

def _fmt_iso_date(iso: Optional[str]) -> str:
    if not iso:
        return ""
    try:
        from datetime import datetime as _dt
        dt = _dt.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.strftime("%B %d, %Y")
    except Exception:
        return iso


def billing_payment_failed(
    agency_name: str,
    grace_ends_iso: str,
    grace_days: int,
) -> str:
    """Sent immediately on invoice.payment_failed. Tells the owner
    they have N days to restore billing before the account suspends."""
    body = f"""
      <p style="margin:0 0 14px 0;">Hello,</p>
      <p style="margin:0 0 14px 0;">
        We weren't able to process your most recent payment for
        <strong>{escape(agency_name)}</strong>.
      </p>
      <p style="margin:0 0 14px 0;">
        Your account stays fully active for the next
        <strong>{grace_days} days</strong>. If we don't receive a
        successful payment by <strong>{escape(_fmt_iso_date(grace_ends_iso))}</strong>,
        your account will be suspended and the team will lose access
        until billing is restored.
      </p>
      <p style="margin:0 0 14px 0;">
        Update your payment method through the billing portal and the
        retry will run automatically.
      </p>"""
    return _shell(
        preheader="Update your payment method to keep your account active.",
        title="Payment failed",
        body_html=body,
        cta=None,
    )


def billing_grace_warning(
    agency_name: str,
    days_remaining: int,
) -> str:
    """Day-3 nudge while the grace period is still running."""
    body = f"""
      <p style="margin:0 0 14px 0;">Hello,</p>
      <p style="margin:0 0 14px 0;">
        Just a reminder — <strong>{escape(agency_name)}</strong> has
        <strong>{days_remaining} day{'s' if days_remaining != 1 else ''}</strong>
        remaining to restore billing before the account is suspended.
      </p>
      <p style="margin:0 0 14px 0;">
        Update your payment method through the billing portal. The
        retry runs automatically and brings the account back to active
        as soon as it succeeds.
      </p>"""
    return _shell(
        preheader=f"{days_remaining} days remaining — update your payment.",
        title="Update your payment method",
        body_html=body,
    )


def billing_payment_received(agency_name: str) -> str:
    """Sent on invoice.payment_succeeded when the prior status was
    past_due or suspended — recovery confirmation."""
    body = f"""
      <p style="margin:0 0 14px 0;">Hello,</p>
      <p style="margin:0 0 14px 0;">
        Your payment was processed and
        <strong>{escape(agency_name)}</strong> is fully active again.
      </p>
      <p style="margin:0 0 14px 0;">
        Thanks for staying with us — your team has full access
        restored.
      </p>"""
    return _shell(
        preheader="Your payment landed — back to active.",
        title="Payment received",
        body_html=body,
    )


def billing_suspended(agency_name: str) -> str:
    """Sent when the grace period expires and we flip the agency to
    suspended. Note the data-preservation message — agencies under
    HIPAA can never have their records actually deleted."""
    body = f"""
      <p style="margin:0 0 14px 0;">Hello,</p>
      <p style="margin:0 0 14px 0;">
        The grace period has expired and
        <strong>{escape(agency_name)}</strong> has been suspended.
        Your team can no longer create new records or send new
        communications until billing is restored.
      </p>
      <p style="margin:0 0 14px 0;">
        Your data is safe — every lead, document, and audit row is
        preserved. Restoring billing through the portal lifts the
        suspension automatically.
      </p>"""
    return _shell(
        preheader="Account suspended — restore billing to continue.",
        title="Account suspended",
        body_html=body,
    )


def billing_trial_ending(
    agency_name: str,
    trial_end_iso: Optional[str],
) -> str:
    """Stripe fires customer.subscription.trial_will_end ~3 days
    before conversion."""
    end_label = _fmt_iso_date(trial_end_iso) if trial_end_iso else "soon"
    body = f"""
      <p style="margin:0 0 14px 0;">Hello,</p>
      <p style="margin:0 0 14px 0;">
        The free trial for <strong>{escape(agency_name)}</strong> ends
        on <strong>{escape(end_label)}</strong>. We'll automatically
        convert the subscription using the payment method on file —
        no action needed if everything's good.
      </p>
      <p style="margin:0 0 14px 0;">
        If you want to update the payment method or adjust the plan
        before conversion, the billing portal has both.
      </p>"""
    return _shell(
        preheader="Your free trial ends soon — confirm payment details.",
        title="Free trial ending",
        body_html=body,
    )


# ── Helper: urgency-level badge ──────────────────────────────────────────
def _urgency_badge(level: str) -> str:
    """Coloured pill matching the SPA legend (urgent/high/moderate/low)."""
    palette = {
        "urgent":   ("#7F1D1D", "#FEE2E2", "URGENT"),
        "high":     ("#92400E", "#FEF3C7", "HIGH"),
        "moderate": ("#1E40AF", "#DBEAFE", "MODERATE"),
        "low":      ("#374151", "#E5E7EB", "LOW"),
    }
    fg, bg, label = palette.get((level or "low").lower(), palette["low"])
    return (
        f'<span style="background:{bg};color:{fg};padding:2px 8px;'
        f'border-radius:999px;font-size:11px;font-weight:700;'
        f'letter-spacing:0.4px;">{label}</span>'
    )


# ── 11. Daily agent brief (to the agent) ────────────────────────────────
def daily_brief_email(
    agent_name: str,
    date_str: str,
    top_calls: list,
    portal_url: str = "",
) -> str:
    """Morning priority-list email — numbered top calls with reasons.

    ``top_calls`` is a list of dicts from ``build_brief_for_agent``:
    ``{name, phone, score, reason, urgency_level}``. Anything beyond
    the first 10 is silently truncated so the email stays scannable.
    """
    first = (agent_name or "there").split()[0]
    rows = ""
    for idx, call in enumerate(top_calls[:10], start=1):
        name = escape(str(call.get("name", "Unknown")))
        phone = escape(str(call.get("phone") or "—"))
        reason = escape(str(call.get("reason") or "Priority follow-up"))
        score = int(call.get("score") or 0)
        badge = _urgency_badge(call.get("urgency_level") or "low")
        rows += f"""
        <tr>
          <td style="padding:14px 0 14px 0;border-bottom:1px solid {_BORDER};
                     vertical-align:top;">
            <table cellpadding="0" cellspacing="0" border="0"
                   style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="font-size:13px;color:{_MUTED};width:24px;
                           vertical-align:top;padding-top:2px;">
                  {idx}.
                </td>
                <td>
                  <div style="font-size:15px;color:{_CHARCOAL};
                              font-weight:700;">
                    {name}
                    <span style="margin-left:8px;color:{_MUTED};
                                 font-weight:600;font-size:12px;">
                      [{score}]
                    </span>
                    <span style="margin-left:6px;">{badge}</span>
                  </div>
                  <div style="font-size:13px;color:{_CHARCOAL};
                              margin-top:4px;line-height:1.4;">
                    {reason}
                  </div>
                  <div style="font-size:12px;color:{_MUTED};
                              margin-top:2px;">
                    {phone}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>"""

    if not rows:
        rows = f"""
        <tr><td style="padding:14px 0;font-size:14px;color:{_MUTED};">
          No priority calls today — you're caught up. Keep the warm
          touches going.
        </td></tr>"""

    body = f"""
      <p style="margin:0 0 14px 0;">Good morning {escape(first)},</p>
      <p style="margin:0 0 12px 0;">
        Your AI priority list for <strong>{escape(date_str)}</strong>
        is below — the top calls sorted by urgency score. Higher score
        = more reason to call today.
      </p>
      <table cellpadding="0" cellspacing="0" border="0"
             style="width:100%;border-collapse:collapse;margin-top:8px;">
        {rows}
      </table>
      <p style="margin:18px 0 0 0;color:{_MUTED};font-size:13px;">
        Open the portal to see all priority calls, log call notes,
        and drop into each client's profile.
      </p>"""
    return _shell(
        preheader=f"Your priority list for {date_str}.",
        title="Your Medicare priority list",
        body_html=body,
        cta={"label": "Open your portal", "url": portal_url}
        if portal_url else None,
    )


# ── 10. GHL import complete (to the agent) ──────────────────────────────
def ghl_import_complete_email(
    agent_name: str,
    imported: int,
    duplicates: int,
    flagged: int,
    portal_url: str = "",
) -> str:
    """Sent when a per-agent GHL contact import finishes. Imported is
    the count of newly-created leads (flagged rows are counted on top —
    they were imported with key fields missing)."""
    first = (agent_name or "there").split()[0]
    total_added = imported + flagged
    summary_rows = [
        ("Newly imported", str(imported)),
        ("Imported but flagged", str(flagged)),
        ("Duplicates skipped", str(duplicates)),
        ("Total added to portal", str(total_added)),
    ]
    body = f"""
      <p style="margin:0 0 14px 0;">Hi {escape(first)},</p>
      <p style="margin:0 0 14px 0;">
        Your GoHighLevel contact import is done. Here's how it shook out:
      </p>
      {_detail_table(summary_rows)}
      {('<p style="margin:16px 0 0 0;color:' + _MUTED + ';font-size:13px;">' +
        str(flagged) + ' record' + ('s were' if flagged != 1 else ' was') +
        ' imported with missing email or date of birth — they are in your '
        'Clients list under the <strong>flagged</strong> filter so you can '
        'fill them in.</p>') if flagged else ""}
      <p style="margin:16px 0 0 0;">
        Your clients are ready to work in the portal — pipelines,
        tags, and the booking page all connect through the same
        record.
      </p>"""
    return _shell(
        preheader=f"GHL import done — {imported} contacts added.",
        title="Your GHL import is complete",
        body_html=body,
        cta={"label": "View your contacts", "url": portal_url}
        if portal_url else None,
    )
