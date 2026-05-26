"""Application Submission Router — AI-powered PDF extraction via AWS Bedrock.
PHI HANDLING: PDF bytes never written to disk. Bedrock covered by AWS HIPAA BAA.
All submissions audit-logged. No raw PHI stored in MongoDB.
"""
import os, json, base64, logging, asyncio, uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from deps import get_db, get_phi_db, get_effective_agent, agent_filter
from encryption import safe_lead_set, safe_lead_load
from auth_router import get_current_user
from ghl_client import GHLClient
from extraction_schemas import (
    DOC_TYPES,
    SCHEMA_FIELDS,
    build_ghl_payload,
    build_prompt,
    canonical_field,
    detect_conflicts,
    label_to_doc_type,
)

logger = logging.getLogger("gruening.applications")
limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/api/applications", tags=["applications"])

BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
S3_BUCKET = os.environ.get("AWS_S3_BUCKET", "")

# ── Supporting-document upload constants ────────────────────────────────────
# Up to ten files per submission total (primary carrier app + nine supporting),
# 10 MB per file, 50 MB across the batch. PDF / JPG / PNG only; magic-byte
# verified so a renamed binary can't pivot through the upload path.
MAX_FILES_PER_BATCH = 10
MAX_PER_FILE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_TOTAL_BATCH_BYTES = 50 * 1024 * 1024  # 50 MB
SUPPORTING_LABELS = (
    "SOA", "Election Notice", "EFT Form",
    "PHI Auth", "ID Copy",
    "Prescription List", "Agent Attestation", "Other",
)
_PDF_MAGIC = b"%PDF-"
_JPG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_KIND_BY_EXT = {
    ".pdf": "pdf",
    ".jpg": "jpg",
    ".jpeg": "jpg",
    ".png": "png",
}
_CONTENT_TYPE_BY_KIND = {
    "pdf": "application/pdf",
    "jpg": "image/jpeg",
    "png": "image/png",
}


def _sniff_kind(contents: bytes) -> Optional[str]:
    """Return 'pdf' / 'jpg' / 'png' for known magic-byte prefixes, or None."""
    if contents.startswith(_PDF_MAGIC):
        return "pdf"
    if contents.startswith(_JPG_MAGIC):
        return "jpg"
    if contents.startswith(_PNG_MAGIC):
        return "png"
    return None


def _slug_label(label: str) -> str:
    return (
        label.lower()
        .replace(" ", "_")
        .replace("/", "_")
        .replace("\\", "_")
    )

# GHL custom-field keys that accept the S3 URL of the uploaded PDF. Keyed by
# product_type code (not display label) so this can't drift when labels change.
# Annuity intentionally omitted — no file-upload field in the GHL schema.
_GHL_PDF_FIELD_KEYS = {
    "medsupp": "medsupp_file_upload__current_policy",
    "ma": "ma_file_upload__current_policy",
    "pdp": "pdp_file_upload__current_policy",
    "cancer": "cancer_file_upload__current_policy",
    "hs": "hs_file_upload__current_policy",
    "hip": "hip_file_upload__current_policy",
    "rc": "rc_file_upload__current_policy",
    "dvh": "dvh_file_upload__current_policy",
    "life": "final_expense_pdf",
}

def _get_bedrock_client():
    return boto3.client(
        service_name="bedrock-runtime",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def _get_s3_client():
    return boto3.client(
        service_name="s3",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


# ── Bedrock multi-document extraction ───────────────────────────────────
def _strip_json_fences(raw: str) -> str:
    """Trim ```json``` / ``` fences and surrounding whitespace.

    The Bedrock model is told not to emit fences, but we tolerate them
    anyway — the alternative is an empty extraction every time the
    model gets chatty."""
    if not raw:
        return ""
    s = raw.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:].strip()
    return s


def _coerce_extraction_payload(parsed: Any) -> Tuple[Dict[str, Any], Dict[str, float]]:
    """Pull ``fields`` + ``confidences`` out of a model response, being
    defensive about the older format (a flat dict of fields with no
    confidences). Returns ``(fields, confidences)`` — empty dicts if
    the payload is malformed."""
    if not isinstance(parsed, dict):
        return {}, {}
    fields = parsed.get("fields")
    confs = parsed.get("confidences")
    if isinstance(fields, dict):
        if not isinstance(confs, dict):
            confs = {}
        # Coerce confidences to floats 0..1.
        clean_confs: Dict[str, float] = {}
        for k, v in confs.items():
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            clean_confs[k] = max(0.0, min(1.0, f))
        return fields, clean_confs
    # Legacy shape: flat dict of fields. Treat every field as medium
    # confidence so the UI still renders something useful.
    if all(not isinstance(v, dict) for v in parsed.values()):
        return parsed, {k: 0.7 for k in parsed.keys()}
    return {}, {}


def _bedrock_extract_doc(pdf_bytes: bytes, doc_type: str) -> Tuple[Dict[str, Any], Dict[str, float]]:
    """SYNC: invoke Bedrock for one document. Returns ``(fields,
    confidences)``; never raises.

    Async callers should wrap this in ``run_in_executor`` so parallel
    extractions don't block the event loop on each Bedrock round-trip.
    """
    try:
        client = _get_bedrock_client()
    except Exception as e:
        logger.warning("Bedrock client init failed: %s", e)
        return {}, {}

    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")
    prompt = build_prompt(doc_type)
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 3500,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "document",
                 "source": {"type": "base64",
                            "media_type": "application/pdf",
                            "data": pdf_b64}},
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
        outer = json.loads(raw) if raw else {}
    except Exception as e:
        logger.warning("Bedrock invoke failed for doc_type=%s: %s", doc_type, e)
        return {}, {}

    text = ""
    for block in outer.get("content") or []:
        if block.get("type") == "text":
            text += block.get("text") or ""
    text = _strip_json_fences(text)
    if not text:
        return {}, {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.warning(
            "Bedrock returned non-JSON for doc_type=%s: %r",
            doc_type, text[:200],
        )
        return {}, {}
    return _coerce_extraction_payload(parsed)


async def _extract_documents_parallel(
    docs: List[Tuple[bytes, str]],
) -> List[Tuple[Dict[str, Any], Dict[str, float]]]:
    """Run N extractions concurrently and preserve input order.

    Each ``docs`` entry is ``(pdf_bytes, doc_type)``. Bedrock invokes
    via ``run_in_executor`` so the event loop isn't pinned on each
    round-trip; ``asyncio.gather`` collects results in order."""
    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(None, _bedrock_extract_doc, b, dt)
        for b, dt in docs
    ]
    return await asyncio.gather(*tasks)



async def _upload_pdf_to_s3(
    pdf_bytes: bytes,
    contact_id: str,
    product_type: str,
) -> str:
    """Upload PDF to S3. Returns S3 URL or empty string if not configured.

    Graceful: returns "" both when AWS_S3_BUCKET is unset and when boto3
    raises (network, perms, etc.). The caller treats "" as "no PDF stored"
    so the submission path keeps working without S3.
    """
    if not S3_BUCKET:
        return ""
    date_prefix = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    safe_product = product_type.lower().replace(" ", "_").replace("/", "_")
    key = (
        f"applications/{date_prefix}/{contact_id}/"
        f"{safe_product}_{uuid.uuid4().hex[:8]}.pdf"
    )

    def _upload():
        s3 = _get_s3_client()
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=pdf_bytes,
            ContentType="application/pdf",
            ServerSideEncryption="AES256",
            Metadata={
                "contact_id": contact_id,
                "product_type": product_type,
            },
        )
        return f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"

    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _upload)
    except Exception as e:
        logger.warning("S3 upload failed (non-fatal): %s", e)
        return ""


async def _relocate_pdf_to_agent_scope(
    src_url: str, agent_id: str, policy_id: str,
) -> tuple[str, str]:
    """Best-effort: copy a PDF from its /extract-time URL to the canonical
    agent-scoped S3 key ``applications/{agent_id}/{YYYY}/{MM}/{policy_id}_{ts}.pdf``.

    Returns ``(new_key, new_url)`` on success, ``("", "")`` if anything
    fails. The caller logs and proceeds — S3 is never allowed to block a
    submission.

    Why a server-side copy rather than re-upload from the request: at
    /submit time the SPA only sends ``pdf_url`` (a JSON payload), not the
    PDF bytes. Re-uploading would require either a redesigned multipart
    endpoint or a re-download from S3. Copy is cheaper and stays inside
    the same bucket.
    """
    if not S3_BUCKET or not src_url:
        return ("", "")
    # Extract source key from the URL. Expected form:
    # https://{BUCKET}.s3.{REGION}.amazonaws.com/{KEY}
    marker = f"{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/"
    if marker not in src_url:
        return ("", "")
    src_key = src_url.split(marker, 1)[1].split("?")[0]
    if not src_key:
        return ("", "")
    now = datetime.now(timezone.utc)
    new_key = (
        f"applications/{agent_id}/{now.strftime('%Y')}/{now.strftime('%m')}/"
        f"{policy_id}_{now.strftime('%Y%m%dT%H%M%S')}.pdf"
    )

    def _copy():
        s3 = _get_s3_client()
        s3.copy_object(
            Bucket=S3_BUCKET,
            CopySource={"Bucket": S3_BUCKET, "Key": src_key},
            Key=new_key,
            ContentType="application/pdf",
            ServerSideEncryption="AES256",
            Metadata={"agent_id": agent_id, "policy_id": policy_id},
            MetadataDirective="REPLACE",
        )
        return f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{new_key}"

    try:
        loop = asyncio.get_event_loop()
        new_url = await loop.run_in_executor(None, _copy)
        return (new_key, new_url)
    except Exception as e:
        logger.warning(
            "S3 relocate failed (non-fatal) for agent=%s policy=%s: %s",
            agent_id, policy_id, e,
        )
        return ("", "")


async def _upload_supporting_to_s3(
    contents: bytes,
    filename: str,
    kind: str,
    contact_id: str,
    agent_id: str,
    label: str,
) -> tuple[str, str]:
    """Upload a single supporting document to S3 under the canonical
    agent-scoped key. Returns ``(s3_url, s3_key)``; both empty on failure
    so the caller can degrade gracefully (the agent's metadata is still
    captured even if S3 is unavailable).

    Key layout:
      applications/{agent_id}/{YYYY}/{MM}/{contact_id|pending}_supporting_
      {label_slug}_{ts}_{rand}.{ext}

    We bucket by ``agent_id`` first (same as the primary-PDF relocate
    target) so a future per-agent retention rule has one prefix to match.
    """
    if not S3_BUCKET:
        return ("", "")
    now = datetime.now(timezone.utc)
    ext = {"pdf": "pdf", "jpg": "jpg", "png": "png"}[kind]
    safe_label = _slug_label(label or "other")
    key = (
        f"applications/{agent_id}/{now.strftime('%Y')}/{now.strftime('%m')}/"
        f"{contact_id or 'pending'}_supporting_{safe_label}_"
        f"{now.strftime('%Y%m%dT%H%M%S')}_{uuid.uuid4().hex[:8]}.{ext}"
    )
    content_type = _CONTENT_TYPE_BY_KIND[kind]

    def _put():
        s3 = _get_s3_client()
        s3.put_object(
            Bucket=S3_BUCKET, Key=key, Body=contents,
            ContentType=content_type, ServerSideEncryption="AES256",
            Metadata={
                "contact_id": contact_id or "pending",
                "agent_id": agent_id or "",
                "file_label": label or "Other",
                "original_filename": filename[:120],
            },
        )
        return f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"

    try:
        loop = asyncio.get_event_loop()
        url = await loop.run_in_executor(None, _put)
        return (url, key)
    except Exception as e:
        logger.warning(
            "supporting S3 upload failed (non-fatal) for agent=%s label=%s: %s",
            agent_id, label, e,
        )
        return ("", "")


FIELD_MAPS: Dict[str, Dict[str, str]] = {
    "medsupp": {
        "medsupp_carrier": "Insurance carrier name",
        "medsupp_policy_id": "Policy ID or policy number",
        "medsupp_policy_status": "Policy status (Active, Pending, Cancelled, Lapsed)",
        "medsupp_premium": "Monthly premium — number only, no $ sign",
        "medsupp_pay_frequency": "Payment frequency (Monthly, Quarterly, Semi-Annual, Annual)",
        "medsupp_app_submit_date": "Application submission date — YYYY-MM-DD",
        "medsupp_effective_date": "Policy effective date — YYYY-MM-DD",
        "medsupp_renewal_date": "Policy renewal date — YYYY-MM-DD",
        "medsupp_term_date": "Policy termination date — YYYY-MM-DD",
        "medsupp_enrollment_type": "Enrollment type (New, Replacement, Reinstatement)",
        "medsupp_plan": "Plan letter (A, B, C, D, F, G, K, L, M, N)",
    },
    "ma": {
        "ma_carrier": "Insurance carrier name",
        "ma_policy_id": "Policy ID or member ID",
        "ma_policy_status": "Policy status",
        "ma_premium": "Monthly premium — number only",
        "ma_app_submit_date": "Application submission date — YYYY-MM-DD",
        "ma_effective_date": "Policy effective date — YYYY-MM-DD",
        "ma_term_date": "Policy termination date — YYYY-MM-DD",
        "ma_enrollment_type": "Enrollment type",
        "ma_election_period": "Election period (AEP, OEP, SEP, IEP, ICEP)",
    },
    "pdp": {
        "pdp_carrier": "Insurance carrier name",
        "pdp_plan_name": "Plan name",
        "pdp_plan_code": "Plan code or contract number",
        "pdp_policy_id": "Policy ID",
        "pdp_policy_status": "Policy status",
        "pdp_premium": "Monthly premium — number only",
        "pdp_pay_frequency": "Payment frequency",
        "pdp_app_submit_date": "Application submission date — YYYY-MM-DD",
        "pdp_effective_date": "Policy effective date — YYYY-MM-DD",
        "pdp_renewal_date": "Policy renewal date — YYYY-MM-DD",
        "pdp_term_date": "Policy termination date — YYYY-MM-DD",
        "pdp_enrollment_type": "Enrollment type",
        "pdp_election_period": "Election period",
        "pdp_pay_method": "Payment method",
    },
    "cancer": {
        "cancer_carrier": "Insurance carrier name",
        "cancer_policy_id": "Policy ID",
        "cancer_policy_status": "Policy status",
        "cancer_premium": "Monthly premium — number only",
        "cancer_face_amount": "Face/benefit amount — number only",
        "cancer_pay_frequency": "Payment frequency",
        "cancer_app_submit_date": "Application submission date — YYYY-MM-DD",
        "cancer_effective_date": "Policy effective date — YYYY-MM-DD",
        "cancer_renewal_date": "Policy renewal date — YYYY-MM-DD",
        "cancer_term_date": "Policy termination date — YYYY-MM-DD",
    },
    "hs": {
        "hs_carrier": "Insurance carrier name",
        "hs_policy_id": "Policy ID",
        "hs_policy_status": "Policy status",
        "hs_premium": "Monthly premium — number only",
        "hs_face_amount": "Face/benefit amount — number only",
        "hs_pay_frequency": "Payment frequency",
        "hs_app_submit_date": "Application submission date — YYYY-MM-DD",
        "hs_effective_date": "Policy effective date — YYYY-MM-DD",
        "hs_renewal_date": "Policy renewal date — YYYY-MM-DD",
        "hs_term_date": "Policy termination date — YYYY-MM-DD",
    },
    "hip": {
        "hip_carrier": "Insurance carrier name",
        "hip_policy_id": "Policy ID",
        "hip_policy_status": "Policy status",
        "hip_premium": "Monthly premium — number only",
        "hip_pay_frequency": "Payment frequency",
        "hip_app_submit_date": "Application submission date — YYYY-MM-DD",
        "hip_effective_date": "Policy effective date — YYYY-MM-DD",
        "hip_renewal_date": "Policy renewal date — YYYY-MM-DD",
        "hip_term_date": "Policy termination date — YYYY-MM-DD",
    },
    "rc": {
        "rc_policy_id": "Policy ID",
        "rc_carrier": "Insurance carrier name",
        "rc_policy_status": "Policy status",
        "rc_premium": "Monthly premium — number only",
        "rc_pay_frequency": "Payment frequency",
        "rc_app_submit_date": "Application submission date — YYYY-MM-DD",
        "rc_effective_date": "Policy effective date — YYYY-MM-DD",
        "rc_term_date": "Policy termination date — YYYY-MM-DD",
    },
    "dvh": {
        "dvh_policy_id": "Policy ID",
        "dvh_carrier": "Insurance carrier name",
        "dvh_policy_status": "Policy status",
        "dvh_premium": "Monthly premium — number only",
        "dvh_pay_frequency": "Payment frequency",
        "dvh_app_submit_date": "Application submission date — YYYY-MM-DD",
        "dvh_effective_date": "Policy effective date — YYYY-MM-DD",
        "dvh_renewal_date": "Policy renewal date — YYYY-MM-DD",
        "dvh_term_date": "Policy termination date — YYYY-MM-DD",
    },
    "life": {
        "life_carrier": "Insurance carrier name",
        "life_product_name": "Product or plan name",
        "life_product_type": "Product type (Whole Life, Term, Final Expense, Graded)",
        "life_coverage_amount": "Coverage/face amount — number only",
        "life_beneficiary": "Primary beneficiary name",
        "life_policy_number": "Policy number",
        "life_client_premium": "Monthly premium — number only",
        "life_coverage_effective_date": "Policy effective date — YYYY-MM-DD",
        "life_commission_year_1": "Year 1 commission amount — number only",
    },
    "annuity": {
        "notes_for_retirement_call": "Relevant notes from the annuity application",
        "referring_agent_name": "Referring agent name if present",
        "agent_name": "Submitting agent name",
    },
}

PRODUCT_LABELS = {
    "medsupp": "Medicare Supplement", "ma": "Medicare Advantage",
    "pdp": "Prescription Drug Plan", "cancer": "Cancer",
    "hs": "Heart/Stroke", "hip": "Hospital Indemnity",
    "rc": "Recovery Care", "dvh": "Dental/Vision/Hearing",
    "life": "Life / Final Expense", "annuity": "Annuity",
}

def _build_extraction_prompt(product_type: str) -> str:
    field_map = FIELD_MAPS[product_type]
    field_list = "\n".join(f'  "{k}": "{v}"' for k, v in field_map.items())
    null_keys = "\n".join(f'  "{k}": null' for k in field_map.keys())
    return f"""You are an insurance application data extraction specialist.
Analyze the attached PDF and extract data into the JSON format below.
RULES: Return ONLY valid JSON. No explanation, no markdown, no backticks.
Use null for missing fields. Dates in YYYY-MM-DD. Monetary values: numbers only.

Extract these fields from the {PRODUCT_LABELS[product_type]} application:
{{
{field_list}
}}

If nothing found, return:
{{
{null_keys}
}}"""


def _build_auto_extract_prompt() -> str:
    """Single-call classify+extract prompt for the auto-detect flow.

    The model must (1) identify which of the 10 product types the PDF is, then
    (2) extract only that product type's fields. Response shape is constrained
    to {"product_type": "<code>", "extracted": {...}} so the existing /extract
    response contract still holds for the frontend.
    """
    lines = [
        "You are an insurance application data extraction specialist.",
        "Analyze the attached PDF and do TWO things:",
        "1. Identify which product type it is. Choose EXACTLY ONE of these codes:",
    ]
    for code, label in PRODUCT_LABELS.items():
        lines.append(f"   - {code}: {label}")
    lines.append("")
    lines.append("2. Extract that product type's fields from the PDF.")
    lines.append("")
    lines.append("Return ONLY valid JSON in this exact shape (no markdown, no backticks):")
    lines.append('{"product_type": "<one of the codes above>", "extracted": { ...the fields for that type... }}')
    lines.append("")
    lines.append("Use ONLY the field keys for the product type you identified.")
    lines.append("Use null for missing fields. Dates in YYYY-MM-DD. Monetary values: numbers only.")
    lines.append("")
    lines.append("Fields per product type:")
    for code, field_map in FIELD_MAPS.items():
        lines.append(f"\n{code} ({PRODUCT_LABELS[code]}):")
        for fk, fv in field_map.items():
            lines.append(f'  "{fk}": "{fv}"')
    return "\n".join(lines)


def _parse_bedrock_response(response_body) -> dict:
    result = json.loads(response_body.read())
    raw = result["content"][0]["text"].strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())

def _fields_to_ghl_array(extracted: dict) -> list:
    return [{"key": k, "field_value": str(v)} for k, v in extracted.items()
            if v is not None and str(v).strip() != ""]

@router.post("/extract")
async def extract_application(
    file: UploadFile = File(...),
    product_type: Optional[str] = Form(None),
    current_user: dict = Depends(get_current_user),
):
    """Extract insurance application fields from a PDF.

    product_type is optional. When omitted, the model both classifies the
    product type and extracts its fields in one Bedrock call. The response
    shape is identical either way so the frontend can ignore the distinction.
    """
    if product_type is not None and product_type not in FIELD_MAPS:
        raise HTTPException(status_code=400, detail=f"Unknown product_type '{product_type}'.")
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files accepted.")
    contents = await file.read()
    # Hard cap 10 MB (post pen-test — was 20 MB) plus magic-byte check
    # so a renamed JPG can't pivot through the Bedrock extraction path.
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF exceeds 10MB.")
    if not contents.startswith(b"%PDF"):
        raise HTTPException(
            status_code=415,
            detail="File contents are not a valid PDF.",
        )
    pdf_b64 = base64.standard_b64encode(contents).decode("utf-8")

    auto = product_type is None
    prompt = _build_auto_extract_prompt() if auto else _build_extraction_prompt(product_type)
    # Auto-detect needs a bigger budget — it returns the wrapper object plus
    # all extracted fields, and may pick a product type with a wide field map.
    max_tokens = 3000 if auto else 2000

    try:
        bedrock = _get_bedrock_client()
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
                {"type": "text", "text": prompt},
            ]}],
        })
        response = bedrock.invoke_model(modelId=BEDROCK_MODEL_ID, body=body,
                                        contentType="application/json", accept="application/json")
        parsed = _parse_bedrock_response(response["body"])
    except (BotoCoreError, ClientError) as e:
        logger.error("Bedrock error: %s", e)
        raise HTTPException(status_code=502, detail="AI extraction service unavailable.")
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        logger.error("Parse error: %s", e)
        raise HTTPException(status_code=502, detail="Could not parse AI response.")

    if auto:
        product_type = parsed.get("product_type")
        if product_type not in FIELD_MAPS:
            logger.error("Auto-detect returned unknown product_type: %r", product_type)
            raise HTTPException(status_code=502,
                                 detail="Could not identify the application's product type.")
        extracted = parsed.get("extracted") or {}
        if not isinstance(extracted, dict):
            raise HTTPException(status_code=502, detail="Malformed AI response shape.")
    else:
        extracted = parsed

    field_count = sum(1 for v in extracted.values() if v is not None)

    # Upload the raw PDF to S3 for archival + GHL file-field push at submit time.
    # contact_id isn't known at extract time (the wizard sequences contact pick
    # before upload but the endpoint signature doesn't carry it), so we use
    # "pending" as the key segment. Non-fatal — empty URL on any failure.
    pdf_url = await _upload_pdf_to_s3(contents, "pending", product_type)

    # Second pass: full Main Application schema extraction (applicant
    # identity, MBI, PCP, signatures, etc.) so the SPA can drive the
    # cross-document review surface from the same /extract call. Run in
    # a thread so the existing product-type extraction (already done
    # above) doesn't block on this second round-trip. Non-fatal — if
    # the schema pass fails we return empty dicts and the SPA falls
    # back to the legacy fields.
    main_fields: Dict[str, Any] = {}
    main_confidences: Dict[str, float] = {}
    try:
        loop = asyncio.get_event_loop()
        main_fields, main_confidences = await loop.run_in_executor(
            None, _bedrock_extract_doc, contents, "main_application",
        )
    except Exception as e:
        logger.warning("Main-schema extraction failed (non-fatal): %s", e)

    return {"product_type": product_type, "product_label": PRODUCT_LABELS[product_type],
            "extracted": extracted, "field_count": field_count,
            "fields_available": list(FIELD_MAPS[product_type].keys()),
            "auto_detected": auto,
            "pdf_url": pdf_url,
            # New full-schema fields (additive — old callers ignore).
            "main_extracted": main_fields,
            "main_confidences": main_confidences,
            "doc_type": "main_application"}


# ── Supporting-document upload ─────────────────────────────────────────────
@router.post("/upload-supporting")
async def upload_supporting_files(
    files: List[UploadFile] = File(...),
    labels: Optional[str] = Form(None),
    contact_id: Optional[str] = Form(None),
    current_user: dict = Depends(get_current_user),
    effective: dict = Depends(get_effective_agent),
    db=Depends(get_db),
):
    """Upload up to ten supporting documents in one request.

    ``files``     — list of UploadFile; PDF / JPG / PNG only; ≤10 MB each;
                    ≤50 MB across the batch.
    ``labels``    — optional JSON-encoded array of label strings parallel to
                    ``files``. Any label not in ``SUPPORTING_LABELS`` is
                    coerced to ``"Other"``. Missing entries default to
                    ``"Other"``.
    ``contact_id``— GHL contact id when known, else the upload lands under
                    the ``pending`` prefix and the agent's ``/submit`` call
                    is responsible for grouping the docs onto the record.

    Magic-byte validation is enforced AND cross-checked against the file
    extension so a renamed binary can't pivot through the upload path
    (post-pentest hardening — same rule as ``/extract``)."""
    if not files:
        raise HTTPException(400, "At least one file is required.")
    if len(files) > MAX_FILES_PER_BATCH:
        raise HTTPException(
            400, f"At most {MAX_FILES_PER_BATCH} files per upload."
        )

    # Parse the optional labels array. Tolerate missing / malformed input —
    # we fall back to "Other" rather than 400 to keep the upload flow
    # forgiving (the agent can re-label after upload).
    parsed_labels: List[str] = []
    if labels:
        try:
            decoded = json.loads(labels)
        except json.JSONDecodeError:
            raise HTTPException(400, "labels must be a JSON array.")
        if not isinstance(decoded, list):
            raise HTTPException(400, "labels must be a JSON array.")
        parsed_labels = [str(x) if x is not None else "" for x in decoded]

    # Read + validate every file before any S3 call. This way a bad file
    # at index 3 rejects the whole batch instead of leaving half-uploaded
    # orphans in S3.
    staged: List[Dict[str, Any]] = []
    total = 0
    for i, f in enumerate(files):
        filename = (f.filename or f"file_{i+1}").strip()
        ext = os.path.splitext(filename)[1].lower()
        if ext not in _KIND_BY_EXT:
            raise HTTPException(
                415,
                f"'{filename}': unsupported file type. "
                "Accepted formats: PDF, JPG, PNG.",
            )
        contents = await f.read()
        size = len(contents)
        if size == 0:
            raise HTTPException(400, f"'{filename}' is empty.")
        if size > MAX_PER_FILE_BYTES:
            raise HTTPException(
                413,
                f"'{filename}' exceeds the {MAX_PER_FILE_BYTES // (1024*1024)} MB "
                "per-file limit.",
            )
        total += size
        if total > MAX_TOTAL_BATCH_BYTES:
            raise HTTPException(
                413,
                f"Combined upload exceeds the "
                f"{MAX_TOTAL_BATCH_BYTES // (1024*1024)} MB batch limit.",
            )
        kind = _sniff_kind(contents)
        expected_kind = _KIND_BY_EXT[ext]
        if kind is None or kind != expected_kind:
            raise HTTPException(
                415,
                f"'{filename}' content does not match its extension "
                "(magic-byte check failed).",
            )
        raw_label = parsed_labels[i] if i < len(parsed_labels) else ""
        label = raw_label if raw_label in SUPPORTING_LABELS else "Other"
        staged.append({
            "contents": contents,
            "filename": filename,
            "size": size,
            "kind": kind,
            "label": label,
        })

    agent_id = effective.get("id") or "unknown"

    # ── Parallel Bedrock extraction ──
    # Only PDFs can be PDF-extracted (Bedrock's document content block
    # accepts application/pdf). For images we skip extraction — the
    # frontend will still render the file with its label, and the agent
    # can transcribe any fields manually on the review screen.
    extractable: List[Tuple[bytes, str]] = []
    extractable_idx: List[int] = []
    for i, s in enumerate(staged):
        if s["kind"] != "pdf":
            continue
        doc_type = label_to_doc_type(s["label"])
        extractable.append((s["contents"], doc_type))
        extractable_idx.append(i)

    extractions: Dict[int, Tuple[Dict[str, Any], Dict[str, float]]] = {}
    if extractable:
        try:
            results_pairs = await _extract_documents_parallel(extractable)
            for idx, pair in zip(extractable_idx, results_pairs):
                extractions[idx] = pair
        except Exception as e:
            logger.warning(
                "Parallel extraction failed (non-fatal) — proceeding with "
                "uploads only: %s", e,
            )

    results: List[Dict[str, Any]] = []
    for i, s in enumerate(staged):
        s3_url, s3_key = await _upload_supporting_to_s3(
            s["contents"], s["filename"], s["kind"],
            contact_id or "", agent_id, s["label"],
        )
        fields, confidences = extractions.get(i, ({}, {}))
        results.append({
            "file_id": str(uuid.uuid4()),
            "filename": s["filename"],
            "size_bytes": s["size"],
            "content_type": _CONTENT_TYPE_BY_KIND[s["kind"]],
            "file_label": s["label"],
            "doc_type": label_to_doc_type(s["label"]),
            "s3_url": s3_url,
            "s3_key": s3_key,
            "extracted": fields,
            "confidences": confidences,
            "extracted_field_count": sum(
                1 for v in fields.values()
                if v not in (None, "", [], {})
            ),
        })

    try:
        await db["audit_logs"].insert_one({
            "action": "application_supporting_uploaded",
            "agent_email": current_user.get("email"),
            "agent_id": agent_id,
            "contact_id": contact_id or "pending",
            "file_count": len(results),
            "total_bytes": total,
            "labels": [r["file_label"] for r in results],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.warning("supporting upload audit log failed: %s", e)

    return {"files": results, "count": len(results), "total_bytes": total}


class SupportingDoc(BaseModel):
    """Metadata for a supporting document already uploaded via
    /api/applications/upload-supporting. The bytes live in S3 — this is
    only the pointer that the SPA echoes back at submit time so the
    application record can persist the list.

    ``extracted`` + ``confidences`` carry the per-doc Bedrock pass
    results so the submit handler can persist the full extracted
    dataset into ``application_extracted_data`` without re-running
    Bedrock. Empty dicts when extraction failed or the file is an
    image (no PDF extraction path for those)."""
    file_id: Optional[str] = None
    filename: str = ""
    file_label: str = "Other"
    s3_url: str = ""
    s3_key: str = ""
    size_bytes: int = 0
    content_type: str = "application/octet-stream"
    doc_type: Optional[str] = None
    extracted: Dict[str, Any] = {}
    confidences: Dict[str, float] = {}


class SubmitApplicationRequest(BaseModel):
    contact_id: str
    product_type: str
    extracted: Dict[str, Any]
    contact_name: Optional[str] = None
    pdf_url: Optional[str] = None
    # Supporting documents (up to nine) uploaded out-of-band via
    # /api/applications/upload-supporting. AI extraction runs on the
    # primary carrier app (pdf_url) AND on each supporting PDF; these
    # ride along as policy attachments so the agent can keep SOA / EFT
    # / ID copy together with the record.
    supporting_documents: List[SupportingDoc] = []
    # Full-schema extraction for the Main Application itself. The SPA
    # populates this from the second pass of /extract; on submit we
    # merge it with the supporting-document extractions, write the
    # combined dataset into ``application_extracted_data``, and use it
    # to drive the GHL custom-field push.
    main_extracted: Dict[str, Any] = {}
    main_confidences: Dict[str, float] = {}


def _split_name(full_name: Optional[str]) -> tuple[str, str]:
    parts = (full_name or "").split()
    if not parts:
        return ("", "")
    return (parts[0], " ".join(parts[1:]))


# ── Contact extraction from product-specific Bedrock output ──────────────
# Each product uses different field-name prefixes (medsupp_first_name vs
# ma_first_name etc.). When auto-creating a portal lead from an
# application we walk all the obvious variants until something hits.
_CONTACT_FIELD_HINTS = {
    "first_name": (
        "first_name", "firstName",
        "client_first_name", "applicant_first_name",
        "med_supp_first_name", "medsupp_first_name", "ma_first_name",
        "pdp_first_name", "life_first_name", "cancer_first_name",
        "hs_first_name", "hip_first_name", "rc_first_name", "dvh_first_name",
    ),
    "last_name": (
        "last_name", "lastName",
        "client_last_name", "applicant_last_name",
        "med_supp_last_name", "medsupp_last_name", "ma_last_name",
        "pdp_last_name", "life_last_name", "cancer_last_name",
        "hs_last_name", "hip_last_name", "rc_last_name", "dvh_last_name",
    ),
    "email": (
        "email", "client_email", "applicant_email",
        "med_supp_email", "medsupp_email", "ma_email", "pdp_email",
    ),
    "phone": (
        "phone", "phone_number", "client_phone", "applicant_phone",
        "med_supp_phone", "medsupp_phone", "ma_phone", "pdp_phone",
    ),
    "date_of_birth": (
        "date_of_birth", "dob", "birthdate", "birth_date",
        "client_dob", "applicant_dob", "applicant_date_of_birth",
        "med_supp_dob", "medsupp_dob", "ma_dob", "pdp_dob",
    ),
    "address_line1": (
        "address1", "address_line1", "street_address",
        "client_address", "applicant_address",
    ),
    "city": ("city", "client_city", "applicant_city"),
    "state": ("state", "client_state", "applicant_state"),
    "zip_code": (
        "zip_code", "postal_code", "zip",
        "client_zip", "client_postal_code", "applicant_zip",
    ),
}


def _pluck_contact_fields(extracted: Dict[str, Any]) -> Dict[str, Any]:
    """Pull a normalised lead-shaped dict out of the Bedrock extraction.

    Iterates the known per-product field-name variants and takes the
    first non-empty hit. Returns only keys we found values for —
    callers merge this on top of name/contact info already known.
    """
    out: Dict[str, Any] = {}
    for portal_key, candidates in _CONTACT_FIELD_HINTS.items():
        for c in candidates:
            v = extracted.get(c)
            if v not in (None, ""):
                out[portal_key] = v.strip() if isinstance(v, str) else v
                break
    return out


async def _find_or_create_lead_for_submission(
    db,
    payload: "SubmitApplicationRequest",
    effective: dict,
    current_user: dict,
) -> Dict[str, Any]:
    """Locate the portal lead this application belongs to, creating one
    if it doesn't exist yet.

    Lookup order (idempotency guarantee — never duplicates):
      1. ghl_contact_id == payload.contact_id
      2. email match (normalised lowercase)
      3. phone match (raw equality)

    If nothing matches we build a new lead row from the extracted fields,
    status="enrolled" (this *is* an enrollment by definition), Phase-2
    scoping from the effective agent, and ``created_via =
    "application_submission"``. We then best-effort push it to GHL via
    create_contact and stamp the returned id back on the lead.

    Returns a dict the caller can read: ``lead_id``, ``lead_name``,
    ``ghl_contact_id`` (may differ from payload.contact_id if we just
    created the contact in GHL), plus ``created_new: bool``.
    """
    extracted = payload.extracted or {}
    plucked = _pluck_contact_fields(extracted)
    name_first, name_last = _split_name(payload.contact_name)
    if not name_first and plucked.get("first_name"):
        name_first = plucked["first_name"]
    if not name_last and plucked.get("last_name"):
        name_last = plucked["last_name"]
    email = (plucked.get("email") or "").lower().strip() or None
    phone = (plucked.get("phone") or "").strip() or None

    # 1) Find by GHL contact id
    existing = None
    if payload.contact_id:
        existing = safe_lead_load(await db.leads.find_one(
            {"ghl_contact_id": payload.contact_id}, {"_id": 0},
        ))
    # 2) Email
    if not existing and email:
        existing = safe_lead_load(await db.leads.find_one({"email": email}, {"_id": 0}))
    # 3) Phone
    if not existing and phone:
        existing = safe_lead_load(await db.leads.find_one({"phone": phone}, {"_id": 0}))

    now_iso = datetime.now(timezone.utc).isoformat()

    if existing:
        # Promote to "enrolled" if it wasn't already, and backfill
        # ghl_contact_id if the search came from GHL but we missed it.
        updates: Dict[str, Any] = {"updated_at": now_iso}
        if (existing.get("status") or "").lower() != "enrolled":
            updates["status"] = "enrolled"
        if payload.contact_id and not existing.get("ghl_contact_id"):
            updates["ghl_contact_id"] = payload.contact_id
        if len(updates) > 1:  # more than just updated_at
            await db.leads.update_one({"id": existing["id"]}, {"$set": safe_lead_set(updates)})
        return {
            "lead_id": existing["id"],
            "lead_name": (
                f"{existing.get('first_name', '')} {existing.get('last_name', '')}".strip()
                or payload.contact_name
                or "Client"
            ),
            "ghl_contact_id": existing.get("ghl_contact_id") or payload.contact_id,
            "created_new": False,
        }

    # ── Auto-create path ──
    new_lead_id = str(uuid.uuid4())
    lead_doc: Dict[str, Any] = {
        "id": new_lead_id,
        "first_name": name_first or "",
        "last_name": name_last or "",
        "email": email,
        "phone": phone,
        "status": "enrolled",
        "soa_signed": False,
        "document_ids": [],
        # Phase-2 scoping triple
        "agent_id": effective["id"],
        "agent_email": (effective.get("email") or "").lower() or None,
        "agent_name": effective.get("agent_name") or effective.get("full_name"),
        "agent_assigned_id": effective["id"],
        # GHL provenance — populated below after create_contact
        "ghl_contact_id": payload.contact_id or None,
        "ghl_sync_status": "pending",
        # Audit-style provenance
        "created_via": "application_submission",
        "product_interest": payload.product_type,
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    # Fold in the extracted address / DOB / etc.
    for k in ("date_of_birth", "address_line1", "city", "state", "zip_code"):
        if plucked.get(k):
            lead_doc[k] = plucked[k]

    await db.leads.insert_one(safe_lead_set(lead_doc.copy()))

    # Best-effort GHL push when we don't already have a GHL contact id.
    # create_contact is the "never throw" helper from ghl_client — it
    # returns None on failure, which is fine, the lead still exists.
    ghl_id = payload.contact_id or None
    if not ghl_id:
        try:
            ghl = GHLClient()
            ghl_id = await ghl.create_contact(lead_doc)
        except Exception as e:
            logger.warning("GHL create_contact during /submit failed: %s", e)
            ghl_id = None
    if ghl_id and ghl_id != lead_doc.get("ghl_contact_id"):
        await db.leads.update_one(
            {"id": new_lead_id},
            {"$set": safe_lead_set({
                "ghl_contact_id": ghl_id,
                "ghl_sync_status": "synced",
                "ghl_synced_at": now_iso,
            })},
        )

    return {
        "lead_id": new_lead_id,
        "lead_name": f"{name_first} {name_last}".strip() or payload.contact_name or "Client",
        "ghl_contact_id": ghl_id,
        "created_new": True,
    }


@router.post("/submit")
async def submit_application(
    payload: SubmitApplicationRequest,
    db=Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
    effective: dict = Depends(get_effective_agent),
):
    if payload.product_type not in FIELD_MAPS:
        raise HTTPException(status_code=400, detail="Unknown product_type.")
    # contact_id used to be required, but the auto-create path now
    # handles the "agent never picked a GHL contact" case by creating
    # the GHL contact on submit. We still need *something* to identify
    # the client — at minimum a name or extracted contact field.
    has_identity = (
        (payload.contact_id and payload.contact_id.strip())
        or (payload.contact_name and payload.contact_name.strip())
        or any(
            (payload.extracted or {}).get(k)
            for k in ("first_name", "last_name", "email", "phone")
        )
    )
    if not has_identity:
        raise HTTPException(
            status_code=400,
            detail="contact_id, contact_name, or an extracted identity field is required.",
        )
    custom_fields = _fields_to_ghl_array(payload.extracted)
    if not custom_fields:
        raise HTTPException(status_code=400, detail="No non-null fields to submit.")

    # Defence-in-depth: even though /upload-supporting enforces the
    # per-batch cap, a single submission must never carry more than the
    # global limits — caps both file count (10 total = 1 primary + 9
    # supporting) and total byte budget (50 MB).
    supporting = payload.supporting_documents or []
    if len(supporting) > MAX_FILES_PER_BATCH - 1:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Too many supporting documents (max "
                f"{MAX_FILES_PER_BATCH - 1}; primary PDF counts as one)."
            ),
        )
    supporting_bytes = sum(int(d.size_bytes or 0) for d in supporting)
    if supporting_bytes > MAX_TOTAL_BATCH_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Supporting documents exceed the "
                f"{MAX_TOTAL_BATCH_BYTES // (1024*1024)} MB total cap."
            ),
        )

    # Generate the policy_id up front so the S3 key (which references it)
    # and the policy doc agree. UUID4 — distinct from the carrier's policy
    # number which lives inside extracted_fields.
    policy_id = str(uuid.uuid4())
    agent_id = effective["id"]
    agent_email = (effective.get("email") or "").lower().strip() or None
    agent_name = effective.get("agent_name") or effective.get("full_name") or None

    # Resolve (or create) the portal lead for this submission BEFORE we
    # round-trip to GHL. If the contact didn't exist in the portal we
    # create it here and push it to GHL ourselves, then keep using the
    # resolved ghl_contact_id for the field update below.
    lead_resolution = await _find_or_create_lead_for_submission(
        db, payload, effective, current_user,
    )
    lead_id = lead_resolution["lead_id"]
    if lead_resolution.get("ghl_contact_id"):
        # If we just created the contact in GHL, swap the payload contact
        # id so the update_contact + PDF push below target the right id.
        payload.contact_id = lead_resolution["ghl_contact_id"] or payload.contact_id

    ghl = GHLClient()
    # Best-effort GHL sync. Historically this raised a 502 on failure
    # and killed the submission — but the application is already
    # persisted in S3 + Mongo by this point, so a GHL outage shouldn't
    # erase the agent's work. We now stamp `ghl_synced` + `ghl_sync_error`
    # into the response and update the lead row with the sync status so
    # the SPA can surface a "GHL needs attention" banner and ops can
    # retry the push later.
    ghl_synced = False
    ghl_sync_error = None
    result = None
    try:
        result = await ghl.update_contact(payload.contact_id, custom_fields)
        ghl_synced = True
    except Exception as e:
        logger.error("GHL update failed (non-fatal): %s", e)
        ghl_sync_error = str(e)[:300]

    # S3 PDF storage: relocate the /extract-staged object to the canonical
    # agent-scoped key. Best-effort — if it fails we fall back to the
    # original URL so we never block submission on S3.
    final_s3_key = ""
    final_s3_url = payload.pdf_url or ""
    if payload.pdf_url:
        relocated_key, relocated_url = await _relocate_pdf_to_agent_scope(
            payload.pdf_url, agent_id, policy_id,
        )
        if relocated_url:
            final_s3_key = relocated_key
            final_s3_url = relocated_url

    # Second GHL update: push the S3 PDF URL into the product-specific file
    # field. Use the relocated URL so GHL points at the canonical object.
    # Non-fatal — if GHL rejects the field key, log and continue.
    pdf_field_key = _GHL_PDF_FIELD_KEYS.get(payload.product_type)
    if final_s3_url and pdf_field_key:
        try:
            await ghl.update_contact(
                payload.contact_id,
                [{"key": pdf_field_key, "field_value": final_s3_url}],
            )
        except Exception as e:
            logger.warning(
                "GHL PDF field push failed (non-fatal) for %s: %s",
                payload.contact_id, e,
            )

    # `result` may be None when the best-effort GHL update above failed.
    # Use a defensive .get on a dict fallback so the audit row schema
    # stays stable across both paths.
    ghl_mock = bool((result or {}).get("mock", False))
    await db["audit_logs"].insert_one({
        "action": "application_submitted",
        "agent_email": current_user.get("email"),
        "contact_id": payload.contact_id,
        "contact_name": payload.contact_name,
        "product_type": payload.product_type,
        "fields_synced": len(custom_fields),
        "ghl_mock": ghl_mock,
        "ghl_synced": ghl_synced,
        "ghl_sync_error": ghl_sync_error,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    # ── MongoDB persistence ──────────────────────────────────────────────
    # Both writes are non-fatal. The agent has already pushed to GHL, so a
    # local-DB hiccup must not surface as a 5xx — but we still log loudly so
    # ops can backfill.
    now_iso = datetime.now(timezone.utc).isoformat()
    first_name, last_name = _split_name(payload.contact_name)
    try:
        await db["clients"].update_one(
            {"ghl_contact_id": payload.contact_id},
            {
                "$set": {
                    "ghl_contact_id": payload.contact_id,
                    "full_name": payload.contact_name or "",
                    "first_name": first_name,
                    "last_name": last_name,
                    "updated_at": now_iso,
                },
                "$setOnInsert": {
                    "created_at": now_iso,
                    "created_by": current_user.get("email", ""),
                },
            },
            upsert=True,
        )
    except Exception as e:
        logger.warning(
            "clients upsert failed (non-fatal) for %s: %s",
            payload.contact_id, e,
        )

    try:
        extracted = payload.extracted or {}
        await db["policies"].insert_one({
            # Workspace scoping (Phase 2): every policy carries the
            # agent who created it. agent_id is the scoping key used by
            # deps.agent_filter; agent_email/agent_name are denormalized
            # for cheap rollups in /api/agents and the leaderboard.
            "policy_id": policy_id,
            "agent_id": agent_id,
            "agent_email": agent_email,
            "agent_name": agent_name,
            "impersonated_by": effective.get("_impersonated_by"),
            "ghl_contact_id": payload.contact_id,
            "lead_id": lead_id,
            "contact_name": payload.contact_name or lead_resolution.get("lead_name", ""),
            "product_type": payload.product_type,
            "product_label": PRODUCT_LABELS.get(payload.product_type, payload.product_type),
            "carrier": (
                extracted.get("carrier")
                or extracted.get(f"{payload.product_type}_carrier")
                or extracted.get("ma_carrier")
                or extracted.get("pdp_carrier")
                or extracted.get("life_carrier")
                or ""
            ),
            "policy_id": (
                extracted.get("policy_id")
                or extracted.get(f"{payload.product_type}_policy_id")
                or extracted.get("policy_number")
                or extracted.get(f"{payload.product_type}_policy_number")
                or ""
            ),
            "plan": (
                extracted.get("plan_name")
                or extracted.get(f"{payload.product_type}_plan")
                or extracted.get(f"{payload.product_type}_plan_name")
                or extracted.get(f"{payload.product_type}_product_name")
                or extracted.get("med_supp_plan_name")
                or ""
            ),
            "premium": (
                extracted.get("premium")
                or extracted.get("client_premium")
                or extracted.get(f"{payload.product_type}_premium")
                or extracted.get(f"{payload.product_type}_client_premium")
                or ""
            ),
            "effective_date": (
                extracted.get("effective_date")
                or extracted.get(f"{payload.product_type}_effective_date")
                or extracted.get("life_coverage_effective_date")
                or ""
            ),
            "renewal_date": (
                extracted.get("renewal_date")
                or extracted.get(f"{payload.product_type}_renewal_date")
                or ""
            ),
            "term_date": (
                extracted.get("term_date")
                or extracted.get(f"{payload.product_type}_term_date")
                or ""
            ),
            "enrollment_type": (
                extracted.get("enrollment_type")
                or extracted.get(f"{payload.product_type}_enrollment_type")
                or ""
            ),
            "election_period": (
                extracted.get("election_period")
                or extracted.get(f"{payload.product_type}_election_period")
                or ""
            ),
            "policy_status": (
                extracted.get("policy_status")
                or extracted.get(f"{payload.product_type}_policy_status")
                or "Pending"
            ),
            "pay_frequency": (
                extracted.get("pay_frequency")
                or extracted.get(f"{payload.product_type}_pay_frequency")
                or ""
            ),
            # S3 archival. s3_url is the canonical agent-scoped location;
            # pdf_url is kept as a legacy alias of the same value so
            # existing reads don't break.
            "s3_key": final_s3_key,
            "s3_url": final_s3_url,
            "pdf_url": final_s3_url or payload.pdf_url or "",
            "all_fields": extracted,
            # Supporting documents (SOA, EFT form, ID copy, …) uploaded
            # via /api/applications/upload-supporting. Stored as a list
            # of pointer dicts — bytes live in S3.
            "supporting_documents": [
                d.model_dump() for d in (payload.supporting_documents or [])
            ],
            "submitted_by": current_user.get("email", ""),
            "submitted_at": now_iso,
            "ghl_synced": True,
            "ghl_mock": result.get("mock", False),
        })
    except Exception as e:
        logger.warning(
            "policies insert failed (non-fatal) for %s: %s",
            payload.contact_id, e,
        )

    # ── Full extracted-data persistence + cross-reference + GHL push ──
    # Build the per-doc dict that the cross-reference detector + GHL
    # payload builder both consume.
    extracted_by_doc: Dict[str, Dict[str, Any]] = {}
    confidences_by_doc: Dict[str, Dict[str, float]] = {}
    if payload.main_extracted:
        extracted_by_doc["main_application"] = payload.main_extracted
    if payload.main_confidences:
        confidences_by_doc["main_application"] = payload.main_confidences
    for d in payload.supporting_documents or []:
        if not d.extracted:
            continue
        dt = d.doc_type or label_to_doc_type(d.file_label)
        # Multiple files of the same type → merge, last-non-empty wins
        # so a later EFT doesn't blank out an earlier EFT.
        prev = extracted_by_doc.get(dt) or {}
        merged = {**prev}
        for k, v in d.extracted.items():
            if v not in (None, "", [], {}):
                merged[k] = v
        extracted_by_doc[dt] = merged
        if d.confidences:
            prev_c = confidences_by_doc.get(dt) or {}
            confidences_by_doc[dt] = {**prev_c, **d.confidences}

    conflicts = detect_conflicts(extracted_by_doc)

    try:
        await db["application_extracted_data"].insert_one({
            "submission_id": policy_id,
            "lead_id": lead_id,
            "ghl_contact_id": payload.contact_id,
            "agent_id": agent_id,
            "agent_email": agent_email,
            "agent_name": agent_name,
            "product_type": payload.product_type,
            "by_doc": extracted_by_doc,
            "confidences_by_doc": confidences_by_doc,
            "conflicts": conflicts,
            "supporting_summaries": [
                {
                    "file_id": d.file_id,
                    "filename": d.filename,
                    "file_label": d.file_label,
                    "doc_type": d.doc_type
                                  or label_to_doc_type(d.file_label),
                    "s3_url": d.s3_url,
                    "size_bytes": d.size_bytes,
                }
                for d in (payload.supporting_documents or [])
            ],
            "created_at": now_iso,
        })
    except Exception as e:
        logger.warning(
            "application_extracted_data insert failed (non-fatal) for %s: %s",
            payload.contact_id, e,
        )

    # Push the canonical fields to GHL on a best-effort basis. The
    # custom-field keys must already exist in the GHL custom-field
    # registry — anything the carrier rejects is logged and skipped.
    ghl_canonical_payload = build_ghl_payload(extracted_by_doc)
    if ghl_canonical_payload and payload.contact_id:
        try:
            await ghl.update_contact(payload.contact_id, ghl_canonical_payload)
        except Exception as e:
            logger.warning(
                "GHL canonical-field push failed (non-fatal) for %s: %s",
                payload.contact_id, e,
            )

    # Stamp the submit-time GHL sync outcome onto the lead row so the
    # client profile + ops dashboard reflect the same status the
    # response below carries. Best-effort wrapped — a lead update
    # failure here must not turn a successful submission into a 5xx.
    if lead_id:
        try:
            await db.leads.update_one(
                {"id": lead_id},
                {"$set": safe_lead_set({
                    "ghl_sync_status": "synced" if ghl_synced else "error",
                    "ghl_sync_error": None if ghl_synced else ghl_sync_error,
                    "ghl_synced_at": (
                        datetime.now(timezone.utc).isoformat()
                        if ghl_synced else None
                    ),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })},
            )
        except Exception as e:
            logger.warning(
                "leads ghl_sync_status update failed (non-fatal) for %s: %s",
                lead_id, e,
            )

    # Write the application PDF into the documents collection so it
    # surfaces in the client profile's Documents tab alongside any
    # locally-encrypted uploads. storage_type="s3" tells the download
    # endpoint to redirect to ``s3_url`` instead of reading local disk.
    # Best-effort wrapped — a documents-write failure must not 5xx a
    # successful submission. Also push the doc_id onto leads.document_ids
    # so the legacy callsites that iterate that list pick it up.
    if final_s3_url and lead_id:
        try:
            doc_id = str(uuid.uuid4())
            now_iso = datetime.now(timezone.utc).isoformat()
            doc_record = {
                "id": doc_id,
                "lead_id": lead_id,
                "agent_id": agent_id,
                "agent_email": (effective.get("email") or "").lower() or None,
                "filename": (
                    f"application_{payload.product_type}_"
                    f"{policy_id[:8]}.pdf"
                ),
                "content_type": "application/pdf",
                "size_bytes": 0,                # not known at this point
                "doc_type": "application_pdf",
                "encrypted": False,             # S3 object — not Fernet-wrapped
                "storage_type": "s3",
                "s3_url": final_s3_url,
                "s3_key": final_s3_key or None,
                "uploaded_by": current_user.get("id"),
                "uploaded_at": now_iso,
                "source": "application_submission",
                "product_type": payload.product_type,
                "policy_id": policy_id,
            }
            await db.documents.insert_one(doc_record)
            await db.leads.update_one(
                {"id": lead_id},
                {"$push": {"document_ids": doc_id},
                 "$set": safe_lead_set({"updated_at": now_iso})},
            )
        except Exception as e:                                # noqa: BLE001
            logger.warning(
                "documents row insert failed (non-fatal) for lead %s: %s",
                lead_id, e,
            )

    return {
        "success": True,
        "contact_id": payload.contact_id,
        "lead_id": lead_id,
        "lead_name": lead_resolution.get("lead_name"),
        "lead_created": lead_resolution.get("created_new", False),
        "fields_synced": len(custom_fields),
        "ghl_mock": ghl_mock,
        "ghl_synced": ghl_synced,
        "ghl_sync_error": ghl_sync_error,
        "extracted_doc_count": len(extracted_by_doc),
        "conflict_count": len(conflicts),
        "ghl_canonical_pushed": len(ghl_canonical_payload),
    }

async def _import_ghl_contact_to_portal(
    db,
    ghl_contact: Dict[str, Any],
    effective: dict,
) -> Optional[str]:
    """Ensure a GHL search result has a corresponding portal lead.

    Idempotent by ``ghl_contact_id``. Returns the portal lead_id. Never
    raises — on any DB / mapping failure we just return None and let the
    caller continue (the search endpoint will still return the GHL
    contact, just without a portal link).
    """
    ghl_id = ghl_contact.get("id")
    if not ghl_id:
        return None
    try:
        existing = safe_lead_load(await db.leads.find_one(
            {"ghl_contact_id": ghl_id}, {"_id": 0, "id": 1},
        ))
        if existing:
            return existing["id"]
        now_iso = datetime.now(timezone.utc).isoformat()
        new_id = str(uuid.uuid4())
        lead_doc = {
            "id": new_id,
            "first_name": (ghl_contact.get("firstName") or "").strip(),
            "last_name": (ghl_contact.get("lastName") or "").strip(),
            "email": (ghl_contact.get("email") or "").lower().strip() or None,
            "phone": (ghl_contact.get("phone") or "").strip() or None,
            "date_of_birth": ghl_contact.get("dateOfBirth") or None,
            "address_line1": ghl_contact.get("address1") or None,
            "city": ghl_contact.get("city") or None,
            "state": ghl_contact.get("state") or None,
            "zip_code": ghl_contact.get("postalCode") or None,
            "status": "new",
            "soa_signed": False,
            "document_ids": [],
            # Phase-2 scoping triple
            "agent_id": effective["id"],
            "agent_email": (effective.get("email") or "").lower() or None,
            "agent_name": effective.get("agent_name") or effective.get("full_name"),
            "agent_assigned_id": effective["id"],
            "ghl_contact_id": ghl_id,
            "ghl_sync_status": "synced",
            "ghl_synced_at": now_iso,
            "created_via": "ghl_search_import",
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        await db.leads.insert_one(safe_lead_set(lead_doc.copy()))
        return new_id
    except Exception as e:
        logger.warning("Auto-import GHL contact to portal failed: %s", e)
        return None


@router.get("/extracted-data/{lead_id}")
async def get_extracted_data(
    lead_id: str,
    db=Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Return the most recent ``application_extracted_data`` document
    for a lead.

    Used by the client profile's Application Data tab to render the
    full per-doc extraction. Returns ``{by_doc: {}, conflicts: []}``
    when no application has been submitted yet so the SPA can render
    an empty state without special-casing 404."""
    # IDOR: agents only see their own leads (admins / compliance see
    # everything). Cheapest check is to compare ``agent_id`` on the
    # extracted-data row against the caller's id.
    role = (current_user.get("role") or "").lower()
    base_query: Dict[str, Any] = {"lead_id": lead_id}
    if role not in ("admin", "compliance", "cyber_security", "sales_manager"):
        base_query["agent_id"] = current_user.get("id")
    doc = await db["application_extracted_data"].find_one(
        base_query,
        sort=[("created_at", -1)],
    )
    if not doc:
        return {
            "lead_id": lead_id,
            "by_doc": {},
            "confidences_by_doc": {},
            "conflicts": [],
            "supporting_summaries": [],
            "empty": True,
        }
    doc.pop("_id", None)
    doc["empty"] = False
    return doc


@router.get("/search-contacts")
async def search_contacts(
    query: str,
    db=Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
    effective: dict = Depends(get_effective_agent),
):
    """Search the GHL location for matching contacts. Each result is
    side-effect-imported into the portal's ``leads`` collection if it
    doesn't already exist, so picking a contact in the UI never lands
    on a stub that can't be opened in /clients."""
    if len(query.strip()) < 2:
        raise HTTPException(status_code=400,
            detail="Query must be 2+ characters.")
    ghl = GHLClient()
    try:
        # Primary search
        contacts = await ghl.search_contacts(query.strip())
        # If empty, try name-based fallback
        if not contacts:
            contacts = await ghl.search_contacts_by_name(query.strip())
    except Exception as e:
        logger.error("Contact search failed: %s", e)
        raise HTTPException(status_code=502,
            detail=f"Contact search unavailable: {str(e)}")

    # Auto-import every result. lead_id is attached inline so the
    # frontend can deep-link to /clients/{lead_id} without a second
    # round-trip.
    enriched: List[Dict[str, Any]] = []
    for c in contacts or []:
        if not isinstance(c, dict):
            continue
        lead_id = await _import_ghl_contact_to_portal(db, c, effective)
        enriched.append({**c, "lead_id": lead_id})

    return {"contacts": enriched}


# The policy-PDF presign endpoint moved to backend/policies_router.py
# so it lives at /api/policies/{id}/pdf (matching the spec) rather than
# under the /api/applications prefix.
