"""
statement_generator.py
======================
Monthly commission statement PDFs.

A statement is one PDF per agent summarising the prior calendar month's
production records: expected vs received, the gap, and the per-policy
breakdown. Statements live on disk under DOC_STORAGE_PATH (same volume the
encrypted-doc uploads already use) so admins can re-download them after
the fact without re-running the generator.

Scheduling
----------
APScheduler fires `generate_all_for_prior_month()` at 08:00 UTC on the 1st
of each month. Gated by DISABLE_SCHEDULER=1 for tests, same pattern as
comtrack_sync.

Filename / on-disk layout
-------------------------
secure_storage/statements/{slug}_{YYYY_MM}.pdf
where slug = agent_name lowercased with non-alphanumerics → "_".
Filenames are normalised so any agent name (with spaces, hyphens,
apostrophes) maps to a deterministic, filesystem-safe path.
"""
import io
import logging
import os
import re
from calendar import monthrange
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
)

from commission_audit_router import _classify_from_amounts


logger = logging.getLogger(__name__)

PRIMARY_HEX = "#1e2d3d"
ACCENT_HEX = "#e85d2f"
MUTED_HEX = "#6b7280"
DIVIDER_HEX = "#e5e7eb"

# Same volume as document uploads — admins already protect this path.
STORAGE_ROOT = Path(
    os.environ.get("DOC_STORAGE_PATH", "/app/backend/secure_storage")
)
STATEMENTS_DIR = STORAGE_ROOT / "statements"


def _slugify(name: str) -> str:
    """Filesystem-safe slug for an agent name.

    "Tim Dazey" → "tim_dazey"
    "Connor O'Reilly" → "connor_oreilly"
    Guards against empty results so a blank name doesn't yield "" + ".pdf".
    """
    s = (name or "").lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = s.strip("_")
    return s or "agent"


def _month_bounds(year: int, month: int) -> tuple[str, str]:
    """ISO date strings (inclusive start, exclusive next-month start)."""
    if not (1 <= month <= 12):
        raise ValueError(f"Invalid month: {month}")
    last_day = monthrange(year, month)[1]
    start = f"{year:04d}-{month:02d}-01"
    if month == 12:
        end_excl = f"{year + 1:04d}-01-01"
    else:
        end_excl = f"{year:04d}-{month + 1:02d}-01"
    _ = last_day  # kept for readability; not directly needed by callers
    return start, end_excl


def _build_styles():
    base = getSampleStyleSheet()
    base.add(ParagraphStyle(
        name="StTitle", parent=base["Title"],
        fontSize=20, leading=24,
        textColor=colors.HexColor(PRIMARY_HEX), spaceAfter=2,
    ))
    base.add(ParagraphStyle(
        name="StSubtitle", parent=base["Normal"],
        fontSize=10, leading=13,
        textColor=colors.HexColor(MUTED_HEX), spaceAfter=14,
    ))
    base.add(ParagraphStyle(
        name="StSection", parent=base["Heading2"],
        fontSize=12, leading=15,
        textColor=colors.HexColor(PRIMARY_HEX),
        spaceBefore=14, spaceAfter=6,
    ))
    base.add(ParagraphStyle(
        name="StBody", parent=base["Normal"],
        fontSize=9.5, leading=13,
    ))
    base.add(ParagraphStyle(
        name="StFooter", parent=base["Normal"],
        fontSize=8, leading=10,
        textColor=colors.HexColor(MUTED_HEX), alignment=1,
    ))
    return base


def _fmt_money(v: Any) -> str:
    if v is None:
        return "—"
    try:
        return f"${float(v):,.2f}"
    except (TypeError, ValueError):
        return "—"


def _fmt_gap(v: Any) -> str:
    if v is None:
        return "—"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return "—"
    sign = "−" if f < 0 else ("+" if f > 0 else "")
    return f"{sign}${abs(f):,.2f}"


def _records_for_month(records: list[dict], year: int, month: int) -> list[dict]:
    """Filter records whose effective_date falls in the target month."""
    start, end_excl = _month_bounds(year, month)
    out = []
    for r in records:
        ed = r.get("effective_date")
        if not ed:
            continue
        # Tolerate either ISO date strings or datetimes — production_records
        # stores ISO from import_production.
        ed_str = ed.isoformat() if hasattr(ed, "isoformat") else str(ed)
        if start <= ed_str < end_excl:
            out.append(r)
    return out


def build_statement_pdf(agent_name: str, year: int, month: int,
                        records: list[dict]) -> bytes:
    """Render a single agent's monthly statement to PDF bytes."""
    month_label = datetime(year, month, 1).strftime("%B %Y")
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.7 * inch, rightMargin=0.7 * inch,
        topMargin=0.7 * inch, bottomMargin=0.7 * inch,
        title=f"Commission Statement — {agent_name} — {month_label}",
        author="Gruening Health & Wealth",
    )
    styles = _build_styles()
    story: list[Any] = []

    story.append(Paragraph("Gruening Health &amp; Wealth", styles["StTitle"]))
    story.append(Paragraph(
        f"Commission Statement &middot; {agent_name} &middot; {month_label} &middot; "
        f"Generated {generated}",
        styles["StSubtitle"],
    ))

    # Summary totals
    total_expected = 0.0
    total_received = 0.0
    for r in records:
        if r.get("revenue_expected") is not None:
            total_expected += float(r["revenue_expected"])
        if r.get("revenue_received") is not None:
            total_received += float(r["revenue_received"])
    total_gap = total_received - total_expected

    story.append(Paragraph("Summary", styles["StSection"]))
    summary = Table([
        ["Total Expected", "Total Received", "Net Gap", "Policies"],
        [_fmt_money(total_expected), _fmt_money(total_received),
         _fmt_gap(total_gap), str(len(records))],
    ], colWidths=[1.6 * inch] * 4, hAlign="LEFT")
    summary.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor(MUTED_HEX)),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("TEXTCOLOR", (2, 1), (2, 1),
         colors.HexColor("#b91c1c") if total_gap < 0
         else colors.HexColor(PRIMARY_HEX)),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor(DIVIDER_HEX)),
    ]))
    story.append(summary)

    # Per-policy detail
    story.append(Paragraph("Policies", styles["StSection"]))

    if not records:
        story.append(Paragraph("No policies effective this month.",
                                 styles["StBody"]))
    else:
        header = ["Carrier", "Policy", "Effective",
                  "Expected", "Received", "Gap", "Status"]
        data: list[list[Any]] = [header]
        # Sort by absolute gap descending so the biggest discrepancies sit at the top.
        def _gap_for(r):
            exp = r.get("revenue_expected") or 0.0
            rec = r.get("revenue_received") or 0.0
            return rec - exp
        for r in sorted(records, key=lambda r: abs(_gap_for(r)), reverse=True):
            status = _classify_from_amounts(
                r.get("revenue_expected"), r.get("revenue_received")) \
                if r.get("audit_status") != "resolved" else "resolved"
            data.append([
                r.get("carrier") or "—",
                r.get("policy_number") or "—",
                r.get("effective_date") or "—",
                _fmt_money(r.get("revenue_expected")),
                _fmt_money(r.get("revenue_received")),
                _fmt_gap(_gap_for(r)),
                status,
            ])
        t = Table(data, colWidths=[
            1.1 * inch, 1.1 * inch, 0.85 * inch,
            0.95 * inch, 0.95 * inch, 0.85 * inch, 0.9 * inch,
        ], hAlign="LEFT", repeatRows=1)
        t.setStyle(TableStyle([
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor(MUTED_HEX)),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
            ("ALIGN", (3, 1), (5, -1), "RIGHT"),
            ("ALIGN", (6, 1), (6, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25,
             colors.HexColor(DIVIDER_HEX)),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t)

    story.append(Spacer(1, 0.25 * inch))
    story.append(Paragraph(
        "CONFIDENTIAL — Statement generated by Gruening Health &amp; Wealth. "
        "If you believe any line is incorrect, contact accounting before the "
        "month-end close. Access is logged.",
        styles["StFooter"],
    ))

    doc.build(story)
    return buf.getvalue()


def statement_path(agent_name: str, year: int, month: int) -> Path:
    """Deterministic on-disk path for an agent's monthly statement."""
    STATEMENTS_DIR.mkdir(parents=True, exist_ok=True)
    return STATEMENTS_DIR / f"{_slugify(agent_name)}_{year:04d}_{month:02d}.pdf"


async def _records_for_agent(db, agent_name: str,
                              year: int, month: int) -> list[dict]:
    start, end_excl = _month_bounds(year, month)
    cursor = db.production_records.find(
        {"agent_name": agent_name,
         "effective_date": {"$gte": start, "$lt": end_excl}},
        {"_id": 0},
    )
    return [r async for r in cursor]


async def generate_for_agent(db, agent_name: str,
                              year: int, month: int) -> Path:
    """Build (or rebuild) one agent's statement and write to disk.

    Returns the on-disk Path. Idempotent: re-running on the same
    (agent, year, month) overwrites the file in place.
    """
    records = await _records_for_agent(db, agent_name, year, month)
    pdf_bytes = build_statement_pdf(agent_name, year, month, records)
    path = statement_path(agent_name, year, month)
    path.write_bytes(pdf_bytes)

    await db.audit_logs.insert_one({
        "event_type": "statement_generated",
        "actor_email": None,
        "actor_id": None,
        "target_type": "commission_statement",
        "target_id": f"{_slugify(agent_name)}_{year:04d}_{month:02d}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metadata": {
            "agent_name": agent_name,
            "year": year,
            "month": month,
            "policies": len(records),
        },
    })

    return path


async def generate_all_for_prior_month(db) -> dict:
    """Run-all entry point: builds every agent's statement for the prior month."""
    now = datetime.now(timezone.utc)
    if now.month == 1:
        year, month = now.year - 1, 12
    else:
        year, month = now.year, now.month - 1
    return await generate_all_for_month(db, year, month)


async def generate_all_for_month(db, year: int, month: int) -> dict:
    """Build statements for every agent with at least one production record
    in the target month. Returns a dict of counts."""
    started_at = datetime.now(timezone.utc)
    agents: set[str] = set()
    cursor = db.production_records.find(
        {"effective_date": {"$gte": _month_bounds(year, month)[0],
                              "$lt": _month_bounds(year, month)[1]}},
        {"_id": 0, "agent_name": 1},
    )
    async for r in cursor:
        name = r.get("agent_name")
        if name:
            agents.add(name)

    generated: list[str] = []
    errors: list[dict] = []
    for agent_name in sorted(agents):
        try:
            await generate_for_agent(db, agent_name, year, month)
            generated.append(agent_name)
        except Exception as e:
            logger.exception("statement_generator: failed for %s: %s",
                              agent_name, e)
            errors.append({"agent_name": agent_name,
                            "error_category": type(e).__name__})

    return {
        "year": year,
        "month": month,
        "agents": len(agents),
        "generated": generated,
        "errors": errors,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }


def start_scheduler(get_db_fn) -> "AsyncIOScheduler | None":
    """Start the APScheduler job: 1st of each month, 08:00 UTC.

    Returns the scheduler instance (kept alive for the app's lifetime), or
    None if DISABLE_SCHEDULER=1.
    """
    if os.getenv("DISABLE_SCHEDULER", "").strip() == "1":
        logger.info("statement_generator: scheduler disabled via DISABLE_SCHEDULER")
        return None

    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger

    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _job():
        try:
            await generate_all_for_prior_month(get_db_fn())
        except Exception as e:
            logger.exception(
                "statement_generator: scheduled run failed: %s", e)

    scheduler.add_job(
        _job,
        trigger=CronTrigger(day=1, hour=8, minute=0),
        id="commission_monthly_statements",
        replace_existing=True,
    )
    scheduler.start()
    logger.info(
        "statement_generator: scheduler started (1st of month 08:00 UTC)")
    return scheduler
