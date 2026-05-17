"""PDF export of a Medicare intake lead record."""
import io
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
)


PRIMARY_HEX = "#1f3b5c"
MUTED_HEX = "#6b7280"
DIVIDER_HEX = "#e5e7eb"


def _build_styles():
    base = getSampleStyleSheet()
    base.add(ParagraphStyle(
        name="GHWTitle", parent=base["Title"],
        fontSize=18, leading=22, textColor=colors.HexColor(PRIMARY_HEX),
        spaceAfter=2, alignment=0,
    ))
    base.add(ParagraphStyle(
        name="GHWSubtitle", parent=base["Normal"],
        fontSize=9, leading=12, textColor=colors.HexColor(MUTED_HEX),
        spaceAfter=14,
    ))
    base.add(ParagraphStyle(
        name="GHWSection", parent=base["Heading2"],
        fontSize=11, leading=14, textColor=colors.HexColor(PRIMARY_HEX),
        spaceBefore=12, spaceAfter=4,
    ))
    base.add(ParagraphStyle(
        name="GHWBody", parent=base["Normal"],
        fontSize=9.5, leading=13,
    ))
    base.add(ParagraphStyle(
        name="GHWFooter", parent=base["Normal"],
        fontSize=8, leading=10, textColor=colors.HexColor(MUTED_HEX),
        alignment=1,
    ))
    return base


def _fmt(val: Any) -> Optional[str]:
    if val is None or val == "":
        return None
    if isinstance(val, list):
        joined = ", ".join(str(x) for x in val if x is not None and x != "")
        return joined or None
    return str(val)


def _kv_table(rows: List[Tuple[str, Any]], styles) -> Optional[Table]:
    filtered = [(label, _fmt(val)) for label, val in rows]
    filtered = [(label, val) for label, val in filtered if val is not None]
    if not filtered:
        return None
    data = [[Paragraph(f"<b>{label}</b>", styles["GHWBody"]),
             Paragraph(val.replace("\n", "<br/>"), styles["GHWBody"])]
            for label, val in filtered]
    t = Table(data, colWidths=[1.7 * inch, 4.6 * inch], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor(DIVIDER_HEX)),
    ]))
    return t


def generate_lead_pdf(lead: Dict[str, Any],
                      soa: Optional[Dict[str, Any]] = None) -> bytes:
    """Render a single lead's intake record to a PDF byte string."""
    buf = io.BytesIO()
    full_name = f"{lead.get('first_name', '') or ''} {lead.get('last_name', '') or ''}".strip() or "(unnamed)"
    short_id = (lead.get("id") or "")[:8]
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.7 * inch, rightMargin=0.7 * inch,
        topMargin=0.7 * inch, bottomMargin=0.7 * inch,
        title=f"Medicare Intake — {full_name}",
        author="Gruening Health & Wealth",
    )
    styles = _build_styles()
    story: List[Any] = []

    story.append(Paragraph("Gruening Health &amp; Wealth", styles["GHWTitle"]))
    story.append(Paragraph(
        f"Medicare Intake Record &middot; Lead {short_id} &middot; Generated {generated}",
        styles["GHWSubtitle"],
    ))

    # Summary
    story.append(Paragraph("Lead Summary", styles["GHWSection"]))
    summary = _kv_table([
        ("Name", full_name),
        ("Status", (lead.get("status") or "").capitalize() or None),
        ("Lead ID", lead.get("id")),
        ("Created", lead.get("created_at")),
        ("Last updated", lead.get("updated_at")),
    ], styles)
    if summary:
        story.append(summary)

    # Contact
    addr = ", ".join(p for p in [
        lead.get("address_line1"), lead.get("address_line2"),
        lead.get("city"), lead.get("state"), lead.get("zip_code"),
    ] if p)
    story.append(Paragraph("Contact Information", styles["GHWSection"]))
    contact = _kv_table([
        ("Email", lead.get("email")),
        ("Phone", lead.get("phone")),
        ("Date of birth", lead.get("date_of_birth")),
        ("Address", addr or None),
        ("Preferred contact time", lead.get("preferred_contact_time")),
    ], styles)
    if contact:
        story.append(contact)

    # Medicare / coverage
    story.append(Paragraph("Medicare &amp; Coverage", styles["GHWSection"]))
    medicare = _kv_table([
        ("MBI number", lead.get("mbi_number")),
        ("Part A effective", lead.get("medicare_part_a_effective")),
        ("Part B effective", lead.get("medicare_part_b_effective")),
        ("Current carrier", lead.get("current_carrier")),
        ("Current plan", lead.get("current_plan")),
    ], styles)
    if medicare:
        story.append(medicare)

    # Providers / prescriptions
    if lead.get("doctors") or lead.get("prescriptions"):
        story.append(Paragraph("Providers &amp; Prescriptions", styles["GHWSection"]))
        clinical = _kv_table([
            ("Doctors", lead.get("doctors")),
            ("Prescriptions", lead.get("prescriptions")),
        ], styles)
        if clinical:
            story.append(clinical)

    # Notes
    if lead.get("notes"):
        story.append(Paragraph("Notes", styles["GHWSection"]))
        story.append(Paragraph(
            str(lead["notes"]).replace("\n", "<br/>"),
            styles["GHWBody"],
        ))

    # SOA
    story.append(Paragraph("Scope of Appointment (SOA)", styles["GHWSection"]))
    if lead.get("soa_signed"):
        soa_rows: List[Tuple[str, Any]] = [
            ("Status", "Signed"),
            ("Signed at", lead.get("soa_signed_at")),
        ]
        if soa:
            soa_rows.extend([
                ("Beneficiary", soa.get("beneficiary_name")),
                ("Agent", soa.get("agent_name")),
                ("Plan types discussed", soa.get("plan_types_discussed")),
                ("IP at signing", soa.get("ip_address")),
            ])
        t = _kv_table(soa_rows, styles)
        if t:
            story.append(t)
    else:
        story.append(Paragraph("Status: Not signed", styles["GHWBody"]))

    # GHL sync
    story.append(Paragraph("GoHighLevel Sync", styles["GHWSection"]))
    ghl = _kv_table([
        ("Status", (lead.get("ghl_sync_status") or "").capitalize() or None),
        ("Contact ID", lead.get("ghl_contact_id")),
        ("Last synced", lead.get("ghl_synced_at")),
        ("Error", lead.get("ghl_sync_error")),
    ], styles)
    if ghl:
        story.append(ghl)

    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph(
        "CONFIDENTIAL — Contains protected health information (PHI). "
        "Disclosure restricted under the HIPAA Privacy Rule. Access is logged.",
        styles["GHWFooter"],
    ))

    doc.build(story)
    return buf.getvalue()
