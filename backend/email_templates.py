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
