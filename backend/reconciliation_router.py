"""
reconciliation_router.py
========================
Carrier statement reconciliation.

Upload a PDF or CSV commission statement; Bedrock vision (for PDFs)
or stdlib csv (for CSVs) extracts payment rows; the matcher fuzzy-
links each row to a production_records / policies entry using
difflib.SequenceMatcher and a 0.75 similarity threshold.

PHI exposure is minimised: only the *name* and policy fields the
carrier already prints on the statement are sent through Bedrock —
nothing else from our DB. The raw upload is archived to S3 with
SSE-AES256 so the disputes desk can always go back to source.
"""
from __future__ import annotations

import base64
import csv
import io
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

import boto3
from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile,
)
from pydantic import BaseModel

from deps import (
    COMPLIANCE_ROLES, get_db, require_roles, write_audit,
)


logger = logging.getLogger("gruening.reconciliation")
router = APIRouter(prefix="/reconciliation", tags=["reconciliation"])


AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
S3_BUCKET = os.environ.get("AWS_S3_BUCKET", "")
BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
MATCH_THRESHOLD = 0.75
COMMISSION_BAND = 0.05  # ±5% counted as paid-in-full

PDF_MAGIC = b"%PDF-"


# ── Utilities ────────────────────────────────────────────────────────────
def _safe_float(v: Any) -> float:
    if v in (None, ""):
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("$", "").replace(",", "")
    try:
        return float(s)
    except ValueError:
        return 0.0


def _parse_date(v: Optional[str]) -> Optional[str]:
    """Coerce any date-ish string to ISO ``YYYY-MM-DD``. Returns None if
    we can't parse it — caller decides how strict to be."""
    if not v or not isinstance(v, str):
        return None
    v = v.strip()
    if not v:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%Y/%m/%d",
                "%m/%d/%y", "%b %d %Y", "%B %d %Y"):
        try:
            return datetime.strptime(v, fmt).date().isoformat()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).date().isoformat()
    except Exception:
        return None


def _similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def _get_s3():
    return boto3.client(
        "s3",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def _get_bedrock_client():
    return boto3.client(
        service_name="bedrock-runtime",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


# ── CSV parser ───────────────────────────────────────────────────────────
_FIELD_ALIASES = {
    "client_name": ["client", "client_name", "insured", "member",
                     "policyholder", "name", "customer"],
    "policy_number": ["policy_number", "policy", "policy_no", "policy #",
                       "contract", "contract_number"],
    "product_type": ["product", "product_type", "plan", "plan_type",
                      "coverage"],
    "carrier": ["carrier", "company", "insurer"],
    "premium_amount": ["premium", "annual_premium", "monthly_premium",
                        "premium_amount", "amount"],
    "commission_paid": ["commission", "commission_paid", "comm",
                         "amount_paid", "payment", "paid"],
    "payment_date": ["payment_date", "paid_date", "check_date",
                      "transaction_date"],
    "effective_date": ["effective_date", "effective", "eff_date",
                        "policy_date", "issue_date"],
}


def _normalize_row(raw: Dict[str, str]) -> Dict[str, Any]:
    """Map a CSV row's columns to our canonical schema."""
    lc = {k.lower().strip(): (v or "").strip() for k, v in raw.items()}
    out: Dict[str, Any] = {}
    for canonical, aliases in _FIELD_ALIASES.items():
        for alias in aliases:
            if alias in lc and lc[alias]:
                out[canonical] = lc[alias]
                break
        out.setdefault(canonical, "")
    out["premium_amount"] = _safe_float(out.get("premium_amount"))
    out["commission_paid"] = _safe_float(out.get("commission_paid"))
    out["payment_date"] = _parse_date(out.get("payment_date")) or out.get("payment_date") or None
    out["effective_date"] = _parse_date(out.get("effective_date")) or out.get("effective_date") or None
    return out


def _parse_csv(data: bytes) -> List[Dict[str, Any]]:
    text = data.decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        norm = _normalize_row(row)
        # Skip totally empty rows (CSVs commonly have blank separators).
        if not (norm.get("client_name") or norm.get("policy_number")):
            continue
        rows.append(norm)
    return rows


# ── PDF extractor via Bedrock vision ─────────────────────────────────────
def _extract_pdf_via_bedrock(pdf_bytes: bytes) -> List[Dict[str, Any]]:
    """Ask Claude (via Bedrock) to extract commission rows from a PDF.

    Returns [] on any failure — callers should fall back to a manual
    upload flow rather than dropping the statement. The model is
    instructed to emit a JSON array only; anything else we ignore."""
    try:
        client = _get_bedrock_client()
    except Exception as e:
        logger.warning("Bedrock client init failed: %s", e)
        return []

    b64 = base64.b64encode(pdf_bytes).decode("ascii")
    prompt = (
        "Extract all commission payment records from this carrier "
        "statement. For each payment return a JSON object with these "
        "exact keys (use empty string if missing):\n"
        "  client_name, policy_number, product_type, carrier,\n"
        "  premium_amount, commission_paid, payment_date, effective_date\n\n"
        "Dates as YYYY-MM-DD. Money as plain numbers (no $ or commas).\n"
        "Return a JSON array of those objects ONLY — no prose, no markdown, "
        "no commentary. If the document is not a commission statement, "
        "return [].\n"
    )
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 4000,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "document",
                 "source": {"type": "base64",
                            "media_type": "application/pdf",
                            "data": b64}},
                {"type": "text", "text": prompt},
            ],
        }],
    })
    try:
        resp = client.invoke_model(
            modelId=BEDROCK_MODEL_ID, body=body,
            contentType="application/json", accept="application/json",
        )
        raw = resp["body"].read()
        data = json.loads(raw) if raw else {}
    except Exception as e:
        logger.warning("Bedrock PDF extract failed: %s", e)
        return []

    text = ""
    for block in data.get("content") or []:
        if block.get("type") == "text":
            text += block.get("text") or ""
    text = text.strip()
    if not text:
        return []
    # Tolerate ```json fences if the model wraps them despite instructions.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        rows = json.loads(text)
    except Exception:
        logger.warning("Bedrock extract returned non-JSON: %r", text[:200])
        return []
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out.append({
            "client_name": str(row.get("client_name") or "").strip(),
            "policy_number": str(row.get("policy_number") or "").strip(),
            "product_type": str(row.get("product_type") or "").strip(),
            "carrier": str(row.get("carrier") or "").strip(),
            "premium_amount": _safe_float(row.get("premium_amount")),
            "commission_paid": _safe_float(row.get("commission_paid")),
            "payment_date": _parse_date(row.get("payment_date")),
            "effective_date": _parse_date(row.get("effective_date")),
        })
    return out


# ── Upload endpoint ─────────────────────────────────────────────────────
@router.post("/upload")
async def upload_statement(
    request: Request,
    file: UploadFile = File(...),
    carrier: str = Form(...),
    current_user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Accept a PDF or CSV carrier statement and queue it for matching."""
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_UPLOAD_BYTES // 1024 // 1024} MB)")
    if not raw:
        raise HTTPException(400, "Empty upload")

    # Magic-byte / content sniff.
    filename = (file.filename or "").lower()
    is_pdf = raw[:5] == PDF_MAGIC or filename.endswith(".pdf")
    if not is_pdf:
        # CSV doesn't have a magic byte — accept by extension or by content
        # being plain-printable. Reject if the body looks binary.
        binary_chars = sum(1 for b in raw[:1024] if b < 9 or (13 < b < 32 and b != 27))
        if binary_chars > 50 and not filename.endswith(".csv"):
            raise HTTPException(400, "Only PDF or CSV statements are accepted")

    extracted: List[Dict[str, Any]]
    if is_pdf:
        if raw[:5] != PDF_MAGIC:
            raise HTTPException(400, "File extension is .pdf but content is not a PDF")
        extracted = _extract_pdf_via_bedrock(raw)
    else:
        try:
            extracted = _parse_csv(raw)
        except Exception as e:
            logger.warning("CSV parse failed: %s", e)
            raise HTTPException(400, "CSV could not be parsed")

    # Stamp the carrier override (statement metadata wins over per-row when
    # the row didn't include it). Also seed missing carrier values.
    for r in extracted:
        if not r.get("carrier"):
            r["carrier"] = carrier

    statement_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    # ── S3 archive (best-effort; statement metadata still records intent) ──
    s3_key = None
    if S3_BUCKET:
        agent_id = current_user.get("id") or current_user.get("email") or "unknown"
        ext = "pdf" if is_pdf else "csv"
        s3_key = (
            f"statements/{agent_id}/{now.strftime('%Y/%m')}/"
            f"{now.strftime('%Y%m%dT%H%M%S')}_{carrier.replace(' ', '_')}.{ext}"
        )
        try:
            s3 = _get_s3()
            s3.put_object(
                Bucket=S3_BUCKET, Key=s3_key, Body=raw,
                ServerSideEncryption="AES256",
                ContentType="application/pdf" if is_pdf else "text/csv",
            )
        except Exception as e:
            logger.warning("S3 statement archive failed: %s", e)
            s3_key = None

    doc = {
        "statement_id": statement_id,
        "agent_id": current_user.get("id"),
        "agent_email": current_user.get("email"),
        "carrier": carrier,
        "filename": file.filename,
        "file_type": "pdf" if is_pdf else "csv",
        "file_s3_key": s3_key,
        "upload_date": now.isoformat(),
        "raw_records": extracted,
        "matched_records": [],
        "status": "processing" if extracted else "extraction_failed",
        "summary": None,
    }
    await db.commission_statements.insert_one(doc.copy())

    await write_audit(
        db, "reconciliation_uploaded",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="statement", target_id=statement_id,
        request=request,
        metadata={"carrier": carrier,
                  "file_type": "pdf" if is_pdf else "csv",
                  "extracted_count": len(extracted),
                  "size_bytes": len(raw)},
    )

    return {
        "statement_id": statement_id,
        "status": doc["status"],
        "extracted_count": len(extracted),
    }


# ── Match endpoint ──────────────────────────────────────────────────────
async def _candidate_pool(db, carrier: str) -> List[Dict[str, Any]]:
    """Pull production_records for this carrier (case-insensitive) + the
    last 18 months. The matcher uses fuzzy name + product equality + a
    date window check, so we don't want the candidate pool to balloon."""
    pool: List[Dict[str, Any]] = []
    q = {"carrier": {"$regex": f"^{carrier}$", "$options": "i"}} if carrier else {}
    async for r in db.production_records.find(q, {"_id": 0}):
        pool.append(r)
    # Also union with policies (in case the carrier statement matches a
    # policy that hasn't yet been ingested into production_records).
    async for p in db.policies.find(q, {"_id": 0}):
        pool.append({
            "agent_id": p.get("agent_id"),
            "agent_name": p.get("agent_name"),
            "client_name": p.get("client_name") or p.get("full_name"),
            "carrier": p.get("carrier"),
            "product_type": p.get("product_type"),
            "policy_number": p.get("policy_number"),
            "monthly_premium": p.get("monthly_premium"),
            "annual_premium": p.get("annual_premium"),
            "effective_date": p.get("effective_date"),
            "revenue_expected": p.get("expected_commission"),
            "_from_policies": True,
        })
    return pool


def _days_apart(a: Optional[str], b: Optional[str]) -> Optional[int]:
    if not a or not b:
        return None
    try:
        da = datetime.fromisoformat(a)
        db_ = datetime.fromisoformat(b)
    except Exception:
        return None
    return abs((da - db_).days)


def _match_row(
    row: Dict[str, Any],
    pool: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Return the best candidate or None.

    Scoring: name similarity is the headline number; product must match
    (loose substring) when both sides have it; effective_date within 30
    days is a hard cutoff when present on both sides. Returns the row
    augmented with ``_score`` so the UI can show confidence."""
    best = None
    best_score = 0.0
    target_name = (row.get("client_name") or "").strip()
    target_product = (row.get("product_type") or "").lower().strip()
    target_eff = row.get("effective_date")
    target_policy = (row.get("policy_number") or "").strip().lower()

    for cand in pool:
        cand_name = (cand.get("client_name") or "").strip()
        if not cand_name:
            continue
        # Exact policy number match is a guaranteed win.
        if target_policy and (
            (cand.get("policy_number") or "").strip().lower() == target_policy
        ):
            return {**cand, "_score": 1.0}
        score = _similarity(target_name, cand_name)
        if score < MATCH_THRESHOLD:
            continue
        # Product check (loose) — penalize if both sides have product_type
        # and they don't share a substring either direction.
        cand_product = (
            (cand.get("product_type") or cand.get("product_label") or "")
            .lower().strip()
        )
        if target_product and cand_product:
            if (target_product not in cand_product
                    and cand_product not in target_product):
                score -= 0.10
        # Date window — 30 days. Cliff if both present and too far apart.
        cand_eff = cand.get("effective_date") or ""
        if isinstance(cand_eff, str) and len(cand_eff) >= 10:
            cand_eff = cand_eff[:10]
        delta = _days_apart(target_eff, cand_eff)
        if delta is not None and delta > 30:
            continue
        if score > best_score:
            best_score = score
            best = {**cand, "_score": round(score, 3)}
    return best


@router.post("/{statement_id}/match")
async def match_statement(
    statement_id: str,
    request: Request,
    current_user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Run the matching algorithm and persist the results."""
    stmt = await db.commission_statements.find_one(
        {"statement_id": statement_id}, {"_id": 0},
    )
    if not stmt:
        raise HTTPException(404, "Statement not found")

    pool = await _candidate_pool(db, stmt.get("carrier") or "")

    matched_rows: List[Dict[str, Any]] = []
    counts = {"paid": 0, "underpaid": 0, "overpaid": 0, "unmatched": 0}
    totals = {"expected": 0.0, "received": 0.0, "gap": 0.0}

    for row in stmt.get("raw_records") or []:
        match = _match_row(row, pool)
        commission_paid = _safe_float(row.get("commission_paid"))
        if match is None:
            counts["unmatched"] += 1
            matched_rows.append({
                **row,
                "match_status": "unmatched",
                "match_confidence": 0.0,
                "expected_commission": 0.0,
                "gap": 0.0,
                "matched_policy_id": None,
                "matched_agent_id": None,
                "matched_agent_name": None,
            })
            continue
        expected = _safe_float(
            match.get("revenue_expected") or match.get("expected_commission")
        )
        gap = expected - commission_paid
        if expected > 0 and commission_paid >= expected * (1 - COMMISSION_BAND):
            if commission_paid > expected * (1 + COMMISSION_BAND):
                status = "overpaid"
            else:
                status = "paid"
        elif expected > 0:
            status = "underpaid"
        else:
            # Expected unknown — call it paid if anything came in, else unmatched.
            status = "paid" if commission_paid > 0 else "unmatched"

        if status in counts:
            counts[status] += 1
        else:
            counts["unmatched"] += 1
        totals["expected"] += expected
        totals["received"] += commission_paid
        if status == "underpaid":
            totals["gap"] += max(0.0, gap)
        matched_rows.append({
            **row,
            "match_status": status,
            "match_confidence": match.get("_score", 0.0),
            "expected_commission": round(expected, 2),
            "gap": round(max(0.0, gap), 2) if status == "underpaid" else 0.0,
            "matched_policy_id": (
                match.get("policy_number") or match.get("natural_key")
            ),
            "matched_agent_id": match.get("agent_id"),
            "matched_agent_name": match.get("agent_name"),
        })

    summary = {
        "total_records": len(matched_rows),
        "matched": counts["paid"] + counts["underpaid"] + counts["overpaid"],
        "unmatched": counts["unmatched"],
        "paid": counts["paid"],
        "underpaid": counts["underpaid"],
        "overpaid": counts["overpaid"],
        "total_expected": round(totals["expected"], 2),
        "total_received": round(totals["received"], 2),
        "total_gap": round(totals["gap"], 2),
    }
    await db.commission_statements.update_one(
        {"statement_id": statement_id},
        {"$set": {
            "matched_records": matched_rows,
            "summary": summary,
            "status": "reconciled",
            "reconciled_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    await write_audit(
        db, "reconciliation_matched",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="statement", target_id=statement_id,
        request=request,
        metadata={"summary": summary},
    )
    return {"statement_id": statement_id, "summary": summary,
            "records": matched_rows}


@router.get("/{statement_id}")
async def get_statement(
    statement_id: str,
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Return the full reconciliation result for a statement."""
    stmt = await db.commission_statements.find_one(
        {"statement_id": statement_id}, {"_id": 0},
    )
    if not stmt:
        raise HTTPException(404, "Statement not found")
    return stmt


class ManualMatchRequest(BaseModel):
    record_index: int
    matched_policy_id: str
    matched_agent_id: Optional[str] = None
    matched_agent_name: Optional[str] = None
    expected_commission: Optional[float] = None


@router.post("/{statement_id}/manual-match")
async def manual_match(
    statement_id: str,
    payload: ManualMatchRequest,
    request: Request,
    current_user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Operator-driven match for rows the algorithm couldn't link."""
    stmt = await db.commission_statements.find_one(
        {"statement_id": statement_id}, {"_id": 0},
    )
    if not stmt:
        raise HTTPException(404, "Statement not found")
    rows = stmt.get("matched_records") or []
    if not (0 <= payload.record_index < len(rows)):
        raise HTTPException(400, "record_index out of range")
    r = rows[payload.record_index]
    r["matched_policy_id"] = payload.matched_policy_id
    r["matched_agent_id"] = payload.matched_agent_id
    r["matched_agent_name"] = payload.matched_agent_name
    if payload.expected_commission is not None:
        r["expected_commission"] = float(payload.expected_commission)
        gap = float(payload.expected_commission) - _safe_float(r.get("commission_paid"))
        r["gap"] = round(max(0.0, gap), 2)
    r["match_status"] = "paid" if (
        r.get("gap", 0) <= 0
    ) else "underpaid"
    r["match_confidence"] = 1.0  # operator override
    rows[payload.record_index] = r
    await db.commission_statements.update_one(
        {"statement_id": statement_id},
        {"$set": {"matched_records": rows}},
    )
    await write_audit(
        db, "reconciliation_manual_match",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="statement", target_id=statement_id,
        request=request,
        metadata={"record_index": payload.record_index,
                  "matched_policy_id": payload.matched_policy_id},
    )
    return r
