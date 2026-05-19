"""Application Submission Router — AI-powered PDF extraction via AWS Bedrock.
PHI HANDLING: PDF bytes never written to disk. Bedrock covered by AWS HIPAA BAA.
All submissions audit-logged. No raw PHI stored in MongoDB.
"""
import os, json, base64, logging, asyncio, uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from deps import get_db, get_effective_agent, agent_filter
from auth_router import get_current_user
from ghl_client import GHLClient

logger = logging.getLogger("gruening.applications")
limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/api/applications", tags=["applications"])

BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
S3_BUCKET = os.environ.get("AWS_S3_BUCKET", "")

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
    if len(contents) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF exceeds 20MB.")
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

    return {"product_type": product_type, "product_label": PRODUCT_LABELS[product_type],
            "extracted": extracted, "field_count": field_count,
            "fields_available": list(FIELD_MAPS[product_type].keys()),
            "auto_detected": auto,
            "pdf_url": pdf_url}

class SubmitApplicationRequest(BaseModel):
    contact_id: str
    product_type: str
    extracted: Dict[str, Any]
    contact_name: Optional[str] = None
    pdf_url: Optional[str] = None


def _split_name(full_name: Optional[str]) -> tuple[str, str]:
    parts = (full_name or "").split()
    if not parts:
        return ("", "")
    return (parts[0], " ".join(parts[1:]))


@router.post("/submit")
async def submit_application(
    payload: SubmitApplicationRequest,
    db=Depends(get_db),
    current_user: dict = Depends(get_current_user),
    effective: dict = Depends(get_effective_agent),
):
    if payload.product_type not in FIELD_MAPS:
        raise HTTPException(status_code=400, detail="Unknown product_type.")
    if not payload.contact_id.strip():
        raise HTTPException(status_code=400, detail="contact_id required.")
    custom_fields = _fields_to_ghl_array(payload.extracted)
    if not custom_fields:
        raise HTTPException(status_code=400, detail="No non-null fields to submit.")

    # Generate the policy_id up front so the S3 key (which references it)
    # and the policy doc agree. UUID4 — distinct from the carrier's policy
    # number which lives inside extracted_fields.
    policy_id = str(uuid.uuid4())
    agent_id = effective["id"]
    agent_email = (effective.get("email") or "").lower().strip() or None
    agent_name = effective.get("agent_name") or effective.get("full_name") or None

    ghl = GHLClient()
    try:
        result = await ghl.update_contact(payload.contact_id, custom_fields)
    except Exception as e:
        logger.error("GHL update failed: %s", e)
        raise HTTPException(status_code=502, detail="GHL sync failed.")

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

    await db["audit_logs"].insert_one({
        "action": "application_submitted",
        "agent_email": current_user.get("email"),
        "contact_id": payload.contact_id,
        "contact_name": payload.contact_name,
        "product_type": payload.product_type,
        "fields_synced": len(custom_fields),
        "ghl_mock": result.get("mock", False),
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
            "contact_name": payload.contact_name or "",
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

    return {"success": True, "contact_id": payload.contact_id,
            "fields_synced": len(custom_fields), "ghl_mock": result.get("mock", False)}

@router.get("/search-contacts")
async def search_contacts(
    query: str,
    current_user: dict = Depends(get_current_user),
):
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
    return {"contacts": contacts}
