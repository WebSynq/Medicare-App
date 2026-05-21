"""
accounting_router.py
====================
Agency-wide financial command center.

All endpoints require admin or compliance. Data is sourced from
``production_records`` (the authoritative commission ledger from
ComTrack / GHW import) and ``policies`` (one row per submitted
application). Where the two collections disagree we trust
production_records for commission dollars and policies for product /
effective-date metadata.
"""
from __future__ import annotations

import io
import json
import logging
import os
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import boto3
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from deps import (
    COMPLIANCE_ROLES,
    get_current_user,
    get_db,
    require_roles,
    write_audit,
)


logger = logging.getLogger("gruening.accounting")
router = APIRouter(prefix="/accounting", tags=["accounting"])


AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"


# ── Utilities ────────────────────────────────────────────────────────────
def _safe_float(v: Any) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        cleaned = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _period_window(period: str) -> tuple[Optional[datetime], Optional[datetime]]:
    """Translate a period string into a [start, end) tuple (UTC).
    None on either side means "no bound on that side"."""
    now = datetime.now(timezone.utc)
    year = now.year
    if period == "mtd":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return start, None
    if period == "ytd":
        return datetime(year, 1, 1, tzinfo=timezone.utc), None
    if period == "q1":
        return datetime(year, 1, 1, tzinfo=timezone.utc), datetime(year, 4, 1, tzinfo=timezone.utc)
    if period == "q2":
        return datetime(year, 4, 1, tzinfo=timezone.utc), datetime(year, 7, 1, tzinfo=timezone.utc)
    if period == "q3":
        return datetime(year, 7, 1, tzinfo=timezone.utc), datetime(year, 10, 1, tzinfo=timezone.utc)
    if period == "q4":
        return datetime(year, 10, 1, tzinfo=timezone.utc), datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    return None, None  # "all"


def _in_window(dt: Optional[datetime], start: Optional[datetime], end: Optional[datetime]) -> bool:
    if dt is None:
        return False
    if start and dt < start:
        return False
    if end and dt >= end:
        return False
    return True


def _status_from_amounts(expected: float, received: Optional[float]) -> str:
    """Categorise a record based on the expected vs. received delta.

    Mirrors the reconciliation engine's bands so the two surfaces
    classify a payment the same way."""
    if received is None:
        return "pending"
    if expected <= 0:
        return "paid" if received > 0 else "pending"
    if received >= expected * 0.95 and received <= expected * 1.05:
        return "paid"
    if received < expected * 0.95:
        return "gap"
    return "overpaid"


# ── /summary ────────────────────────────────────────────────────────────
@router.get("/summary")
async def accounting_summary(
    period: str = Query("mtd", description="mtd|ytd|q1|q2|q3|q4|all"),
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
) -> Dict[str, Any]:
    """KPI roll-up for the Accounting Overview tab."""
    now = datetime.now(timezone.utc)
    start, end = _period_window(period)
    mtd_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    ytd_start = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    twelve_months_ago = now - timedelta(days=365)

    expected_mtd = received_mtd = 0.0
    expected_ytd = received_ytd = 0.0
    expected_period = received_period = 0.0
    outstanding_total = 0.0
    overpaid_total = 0.0

    by_month: Dict[str, Dict[str, float]] = defaultdict(
        lambda: {"expected": 0.0, "received": 0.0}
    )
    by_carrier: Dict[str, Dict[str, float]] = defaultdict(
        lambda: {"expected": 0.0, "received": 0.0, "policies": 0}
    )
    by_product: Dict[str, Dict[str, float]] = defaultdict(
        lambda: {"expected": 0.0, "received": 0.0, "gap": 0.0}
    )
    by_agent: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"expected": 0.0, "received": 0.0, "policies": 0, "agent_name": ""}
    )
    aging = {"current": 0.0, "days_31_60": 0.0, "days_61_90": 0.0, "days_90_plus": 0.0}

    cursor = db.production_records.find(
        {},
        {
            "_id": 0, "agent_id": 1, "agent_name": 1, "carrier": 1,
            "product_type": 1, "product_label": 1,
            "revenue_expected": 1, "revenue_received": 1,
            "effective_date": 1, "app_date": 1, "payment_date": 1,
        },
    )
    async for r in cursor:
        exp = _safe_float(r.get("revenue_expected"))
        rec_raw = r.get("revenue_received")
        rec = _safe_float(rec_raw) if rec_raw is not None else 0.0
        eff = _parse_iso(r.get("effective_date")) or _parse_iso(r.get("app_date"))
        carrier = (r.get("carrier") or "Unknown").strip() or "Unknown"
        product = (r.get("product_label") or r.get("product_type") or "Other").strip() or "Other"

        # MTD / YTD totals
        if _in_window(eff, mtd_start, None):
            expected_mtd += exp
            received_mtd += rec
        if _in_window(eff, ytd_start, None):
            expected_ytd += exp
            received_ytd += rec
        if _in_window(eff, start, end):
            expected_period += exp
            received_period += rec

        # Outstanding / overpaid totals (period-agnostic — financial truth)
        gap = exp - rec
        if rec_raw is None or gap > 0:
            outstanding_total += max(0.0, gap)
        if rec > exp + 0.01:
            overpaid_total += rec - exp

        # 12-month bars
        if eff and eff >= twelve_months_ago:
            key = eff.strftime("%Y-%m")
            by_month[key]["expected"] += exp
            by_month[key]["received"] += rec

        # Carrier / product / agent rollups (period-scoped)
        if _in_window(eff, start, end):
            by_carrier[carrier]["expected"] += exp
            by_carrier[carrier]["received"] += rec
            by_carrier[carrier]["policies"] += 1
            by_product[product]["expected"] += exp
            by_product[product]["received"] += rec
            by_product[product]["gap"] += max(0.0, exp - rec)
            aid = r.get("agent_id") or "unknown"
            by_agent[aid]["expected"] += exp
            by_agent[aid]["received"] += rec
            by_agent[aid]["policies"] += 1
            by_agent[aid]["agent_name"] = r.get("agent_name") or by_agent[aid]["agent_name"]

        # Aging — only pending rows. Bucket by days since effective_date.
        if rec_raw is None and eff:
            days_old = (now - eff).days
            if days_old <= 30:
                aging["current"] += exp
            elif days_old <= 60:
                aging["days_31_60"] += exp
            elif days_old <= 90:
                aging["days_61_90"] += exp
            else:
                aging["days_90_plus"] += exp

    # Dense 12-month series.
    revenue_by_month: List[Dict[str, Any]] = []
    for i in range(11, -1, -1):
        month_dt = now.replace(day=15) - timedelta(days=30 * i)
        key = month_dt.strftime("%Y-%m")
        entry = by_month.get(key, {"expected": 0.0, "received": 0.0})
        revenue_by_month.append({
            "month": key,
            "expected": round(entry["expected"], 2),
            "received": round(entry["received"], 2),
        })

    # Carrier rows with collection rate.
    revenue_by_carrier = []
    for name, vals in by_carrier.items():
        exp = vals["expected"]
        rec = vals["received"]
        revenue_by_carrier.append({
            "carrier": name,
            "expected": round(exp, 2),
            "received": round(rec, 2),
            "gap": round(max(0.0, exp - rec), 2),
            "policies": vals["policies"],
            "collection_rate": round((rec / exp) * 100, 1) if exp > 0 else 0.0,
        })
    revenue_by_carrier.sort(key=lambda r: r["expected"], reverse=True)

    revenue_by_product = [
        {
            "product": k,
            "expected": round(v["expected"], 2),
            "received": round(v["received"], 2),
            "gap": round(v["gap"], 2),
        }
        for k, v in sorted(by_product.items(), key=lambda kv: -kv[1]["expected"])
    ]

    revenue_by_agent = []
    for aid, v in by_agent.items():
        exp = v["expected"]
        rec = v["received"]
        revenue_by_agent.append({
            "agent_id": aid,
            "agent_name": v["agent_name"] or "(unknown)",
            "expected": round(exp, 2),
            "received": round(rec, 2),
            "gap": round(max(0.0, exp - rec), 2),
            "policy_count": v["policies"],
        })
    revenue_by_agent.sort(key=lambda r: r["expected"], reverse=True)

    coll_rate = (received_ytd / expected_ytd * 100) if expected_ytd > 0 else 0.0
    return {
        "period": period,
        "expected_mtd": round(expected_mtd, 2),
        "received_mtd": round(received_mtd, 2),
        "gap_mtd": round(max(0.0, expected_mtd - received_mtd), 2),
        "expected_ytd": round(expected_ytd, 2),
        "received_ytd": round(received_ytd, 2),
        "gap_ytd": round(max(0.0, expected_ytd - received_ytd), 2),
        "expected_period": round(expected_period, 2),
        "received_period": round(received_period, 2),
        "outstanding_total": round(outstanding_total, 2),
        "overpaid_total": round(overpaid_total, 2),
        "collection_rate_pct": round(coll_rate, 1),
        "revenue_by_month": revenue_by_month,
        "revenue_by_carrier": revenue_by_carrier[:20],
        "revenue_by_product": revenue_by_product,
        "revenue_by_agent": revenue_by_agent[:20],
        "aging": {k: round(v, 2) for k, v in aging.items()},
    }


# ── /ledger ─────────────────────────────────────────────────────────────
@router.get("/ledger")
async def accounting_ledger(
    carrier: Optional[str] = None,
    agent_id: Optional[str] = None,
    product: Optional[str] = None,
    status: Optional[str] = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Paginated commission ledger sourced from production_records."""
    query: Dict[str, Any] = {}
    if carrier:
        query["carrier"] = carrier
    if agent_id:
        query["agent_id"] = agent_id
    if product:
        query["$or"] = [
            {"product_type": {"$regex": product, "$options": "i"}},
            {"product_label": {"$regex": product, "$options": "i"}},
        ]

    rows: List[Dict[str, Any]] = []
    async for r in db.production_records.find(query, {"_id": 0}).sort(
        "app_date", -1,
    ):
        exp = _safe_float(r.get("revenue_expected"))
        rec_raw = r.get("revenue_received")
        rec = _safe_float(rec_raw) if rec_raw is not None else None
        st = _status_from_amounts(exp, rec)
        if status and status != "all" and st != status:
            continue
        rows.append({
            "policy_id": r.get("policy_number") or r.get("natural_key") or r.get("id"),
            "submission_date": r.get("app_date"),
            "effective_date": r.get("effective_date"),
            "payment_date": r.get("payment_date"),
            "agent_name": r.get("agent_name"),
            "client_name": r.get("client_name"),
            "carrier": r.get("carrier"),
            "product_type": r.get("product_label") or r.get("product_type"),
            "monthly_premium": _safe_float(r.get("monthly_premium")),
            "annual_premium": _safe_float(r.get("monthly_premium")) * 12,
            "expected_commission": round(exp, 2),
            "received_commission": round(rec, 2) if rec is not None else None,
            "gap_amount": round(exp - (rec or 0.0), 2) if rec is not None else round(exp, 2),
            "status": st,
        })

    total = len(rows)
    start = (page - 1) * limit
    paged = rows[start:start + limit]
    return {
        "items": paged,
        "page": page,
        "limit": limit,
        "total": total,
        "pages": (total + limit - 1) // limit if limit else 1,
    }


# ── /carriers ───────────────────────────────────────────────────────────
@router.get("/carriers")
async def accounting_carriers(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Per-carrier financial summary for the Carriers tab."""
    now = datetime.now(timezone.utc)
    ytd_start = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    by_carrier: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"policies": 0, "expected": 0.0, "received": 0.0,
                  "last_payment": None, "days_to_pay_sum": 0.0,
                  "days_to_pay_count": 0}
    )
    async for r in db.production_records.find(
        {}, {"_id": 0, "carrier": 1, "revenue_expected": 1,
             "revenue_received": 1, "effective_date": 1, "payment_date": 1},
    ):
        c = (r.get("carrier") or "Unknown").strip() or "Unknown"
        eff = _parse_iso(r.get("effective_date"))
        if not eff or eff < ytd_start:
            continue
        exp = _safe_float(r.get("revenue_expected"))
        rec_raw = r.get("revenue_received")
        rec = _safe_float(rec_raw) if rec_raw is not None else 0.0
        b = by_carrier[c]
        b["policies"] += 1
        b["expected"] += exp
        b["received"] += rec
        pay = _parse_iso(r.get("payment_date"))
        if pay:
            if not b["last_payment"] or pay > b["last_payment"]:
                b["last_payment"] = pay
            if eff:
                b["days_to_pay_sum"] += (pay - eff).days
                b["days_to_pay_count"] += 1
    out = []
    for name, v in by_carrier.items():
        exp = v["expected"]
        rec = v["received"]
        out.append({
            "carrier_name": name,
            "total_policies": v["policies"],
            "expected_ytd": round(exp, 2),
            "received_ytd": round(rec, 2),
            "gap_ytd": round(max(0.0, exp - rec), 2),
            "collection_rate": round((rec / exp) * 100, 1) if exp > 0 else 0.0,
            "last_payment_date": v["last_payment"].isoformat() if v["last_payment"] else None,
            "avg_days_to_pay": (
                round(v["days_to_pay_sum"] / v["days_to_pay_count"], 1)
                if v["days_to_pay_count"] else None
            ),
        })
    out.sort(key=lambda c: c["expected_ytd"], reverse=True)
    return {"carriers": out, "count": len(out)}


# ── /aging ──────────────────────────────────────────────────────────────
@router.get("/aging")
async def accounting_aging(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Aging buckets with the underlying policy lists."""
    now = datetime.now(timezone.utc)
    buckets: Dict[str, Dict[str, Any]] = {
        "current":      {"label": "0-30 days",  "count": 0, "amount": 0.0, "policies": []},
        "days_31_60":   {"label": "31-60 days", "count": 0, "amount": 0.0, "policies": []},
        "days_61_90":   {"label": "61-90 days", "count": 0, "amount": 0.0, "policies": []},
        "days_90_plus": {"label": "90+ days",   "count": 0, "amount": 0.0, "policies": []},
    }
    async for r in db.production_records.find(
        {"$or": [{"revenue_received": None},
                  {"revenue_received": {"$exists": False}}]},
        {"_id": 0, "agent_name": 1, "client_name": 1, "carrier": 1,
         "product_type": 1, "product_label": 1, "policy_number": 1,
         "natural_key": 1, "revenue_expected": 1, "effective_date": 1,
         "app_date": 1},
    ):
        exp = _safe_float(r.get("revenue_expected"))
        if exp <= 0:
            continue
        eff = _parse_iso(r.get("effective_date")) or _parse_iso(r.get("app_date"))
        if not eff:
            continue
        days_old = (now - eff).days
        if days_old <= 30:
            key = "current"
        elif days_old <= 60:
            key = "days_31_60"
        elif days_old <= 90:
            key = "days_61_90"
        else:
            key = "days_90_plus"
        b = buckets[key]
        b["count"] += 1
        b["amount"] += exp
        b["policies"].append({
            "policy_id": r.get("policy_number") or r.get("natural_key"),
            "agent_name": r.get("agent_name"),
            "client_name": r.get("client_name"),
            "carrier": r.get("carrier"),
            "product": r.get("product_label") or r.get("product_type"),
            "expected": round(exp, 2),
            "effective_date": r.get("effective_date") or r.get("app_date"),
            "days_old": days_old,
        })
    for v in buckets.values():
        v["amount"] = round(v["amount"], 2)
        # Cap policy lists at 50 per bucket for the UI; full export
        # lives in /ledger.
        v["policies"] = sorted(v["policies"],
                                key=lambda p: p["days_old"], reverse=True)[:50]
    return {"buckets": buckets, "as_of": now.isoformat()}


# ── /disputes ───────────────────────────────────────────────────────────
class CreateDisputeRequest(BaseModel):
    policy_id: Optional[str] = None
    carrier: str
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    client_name: Optional[str] = None
    amount_disputed: float = Field(0.0, ge=0.0)
    reason: str = ""
    carrier_contact: Optional[str] = None
    notes: Optional[str] = None


class DisputeStatusUpdate(BaseModel):
    status: str  # open | in_progress | resolved | closed
    amount_recovered: Optional[float] = None
    note: Optional[str] = None


_DISPUTE_STATUSES = ("open", "in_progress", "resolved", "closed")


@router.post("/disputes")
async def create_dispute(
    payload: CreateDisputeRequest,
    request: Request,
    current_user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    now = datetime.now(timezone.utc)
    doc = {
        "dispute_id": str(uuid.uuid4()),
        "policy_id": payload.policy_id,
        "carrier": payload.carrier,
        "agent_id": payload.agent_id,
        "agent_name": payload.agent_name,
        "client_name": payload.client_name,
        "amount_disputed": float(payload.amount_disputed or 0.0),
        "amount_recovered": 0.0,
        "reason": payload.reason,
        "carrier_contact": payload.carrier_contact,
        "notes": payload.notes,
        "status": "open",
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        "created_by": current_user.get("email"),
    }
    await db.commission_disputes.insert_one(doc.copy())
    await write_audit(
        db, "dispute_created",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="dispute", target_id=doc["dispute_id"],
        request=request,
        metadata={
            "carrier": payload.carrier,
            "policy_id": payload.policy_id,
            "amount_disputed": payload.amount_disputed,
        },
    )
    return {"dispute_id": doc["dispute_id"], "status": "open"}


@router.get("/disputes")
async def list_disputes(
    status_filter: Optional[str] = Query(None, alias="status"),
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    q: Dict[str, Any] = {}
    if status_filter and status_filter != "all":
        q["status"] = status_filter
    now = datetime.now(timezone.utc)
    items: List[Dict[str, Any]] = []
    async for d in db.commission_disputes.find(q, {"_id": 0}).sort("created_at", -1):
        created = _parse_iso(d.get("created_at")) or now
        d["days_open"] = max(0, (now - created).days)
        items.append(d)
    # Quick header counts.
    counts = {s: 0 for s in _DISPUTE_STATUSES}
    for d in items:
        s = d.get("status") or "open"
        if s in counts:
            counts[s] += 1
    # Recovered this month
    mtd_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    recovered_mtd = 0.0
    for d in items:
        upd = _parse_iso(d.get("updated_at"))
        if d.get("status") == "resolved" and upd and upd >= mtd_start:
            recovered_mtd += _safe_float(d.get("amount_recovered"))
    return {
        "items": items,
        "counts": counts,
        "total_recovered_mtd": round(recovered_mtd, 2),
    }


@router.patch("/disputes/{dispute_id}")
async def update_dispute(
    dispute_id: str,
    payload: DisputeStatusUpdate,
    request: Request,
    current_user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    if payload.status not in _DISPUTE_STATUSES:
        raise HTTPException(400, f"status must be one of {_DISPUTE_STATUSES}")
    existing = await db.commission_disputes.find_one(
        {"dispute_id": dispute_id}, {"_id": 0},
    )
    if not existing:
        raise HTTPException(404, "Dispute not found")
    updates: Dict[str, Any] = {
        "status": payload.status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if payload.amount_recovered is not None:
        updates["amount_recovered"] = float(payload.amount_recovered)
    if payload.note:
        updates["notes"] = (
            f"{existing.get('notes') or ''}\n[{datetime.now(timezone.utc).isoformat()}] "
            f"{payload.note}"
        ).strip()
    await db.commission_disputes.update_one(
        {"dispute_id": dispute_id}, {"$set": updates},
    )
    await write_audit(
        db, "dispute_updated",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="dispute", target_id=dispute_id,
        request=request,
        metadata={"status": payload.status,
                  "amount_recovered": payload.amount_recovered},
    )
    fresh = await db.commission_disputes.find_one(
        {"dispute_id": dispute_id}, {"_id": 0},
    )
    return fresh


def _get_bedrock_client():
    return boto3.client(
        service_name="bedrock-runtime",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def _local_dispute_letter(dispute: Dict[str, Any]) -> str:
    """Deterministic fallback when Bedrock is unavailable. Keeps the
    feature usable in dev / test / outage scenarios."""
    today = datetime.now(timezone.utc).strftime("%B %d, %Y")
    return (
        f"{today}\n\n"
        f"{dispute.get('carrier', 'Carrier')}\n"
        "Commission Accounting Department\n\n"
        f"Re: Commission Dispute — Policy #{dispute.get('policy_id') or '[POLICY]'}\n\n"
        "To Whom It May Concern,\n\n"
        f"We have not received the commission payment for the above "
        f"policy. The expected amount is ${dispute.get('amount_disputed') or 0:,.2f}. "
        f"The policy was sold by "
        f"{dispute.get('agent_name') or 'our licensed agent'} for client "
        f"{dispute.get('client_name') or '[CLIENT]'}.\n\n"
        f"Reason for dispute: {dispute.get('reason') or 'Payment missing'}.\n\n"
        "Please research and remit at your earliest convenience. "
        "Reply to this letter with any documentation needed to expedite.\n\n"
        "Respectfully,\n\n"
        "Gruening Health & Wealth\nAccounting Department\n"
    )


@router.post("/disputes/{dispute_id}/letter")
async def generate_dispute_letter(
    dispute_id: str,
    request: Request,
    current_user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Generate a professional commission-dispute letter.

    Uses Bedrock when configured; falls back to a deterministic
    template otherwise so the feature is usable in dev / outage."""
    dispute = await db.commission_disputes.find_one(
        {"dispute_id": dispute_id}, {"_id": 0},
    )
    if not dispute:
        raise HTTPException(404, "Dispute not found")

    letter = ""
    try:
        bedrock = _get_bedrock_client()
        prompt = (
            "Write a professional, firm, polite commission-dispute letter "
            "on behalf of Gruening Health & Wealth (a Medicare insurance "
            "agency) addressed to the carrier. Tone: business-formal. "
            "Length: 200-300 words. Include the date, a Re: line citing "
            "the policy number, a brief statement of the missing "
            "commission and amount, the agent and client involved, the "
            "reason for the dispute, and a polite request for research "
            "and remittance. Sign off as 'Gruening Health & Wealth, "
            "Accounting Department'. Use ONLY the facts below — do not "
            "invent details.\n\n"
            f"Carrier: {dispute.get('carrier', '')}\n"
            f"Policy #: {dispute.get('policy_id', '')}\n"
            f"Agent:   {dispute.get('agent_name', '')}\n"
            f"Client:  {dispute.get('client_name', '')}\n"
            f"Amount:  ${_safe_float(dispute.get('amount_disputed')):,.2f}\n"
            f"Reason:  {dispute.get('reason', '')}\n"
            f"Notes:   {dispute.get('notes') or '(none)'}\n"
        )
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 700,
            "messages": [{"role": "user", "content": prompt}],
        })
        resp = bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            body=body,
            contentType="application/json",
            accept="application/json",
        )
        raw = resp["body"].read()
        parsed = json.loads(raw) if raw else {}
        for block in parsed.get("content") or []:
            if block.get("type") == "text":
                letter += block.get("text") or ""
    except Exception as e:
        logger.warning("Bedrock dispute letter failed — using fallback: %s", e)

    if not letter.strip():
        letter = _local_dispute_letter(dispute)

    await write_audit(
        db, "dispute_letter_generated",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="dispute", target_id=dispute_id,
        request=request,
        metadata={"carrier": dispute.get("carrier")},
    )

    filename = f"dispute_{dispute.get('carrier', 'carrier').replace(' ', '_')}_{dispute_id[:8]}.txt"
    return StreamingResponse(
        io.BytesIO(letter.encode("utf-8")),
        media_type="text/plain",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
