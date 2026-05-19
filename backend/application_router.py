"""Application Submission Router — AI-powered PDF extraction via AWS Bedrock.
PHI HANDLING: PDF bytes never written to disk. Bedrock covered by AWS HIPAA BAA.
All submissions audit-logged. No raw PHI stored in MongoDB.
"""
import os, json, base64, logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from deps import get_db
from auth_router import get_current_user
from ghl_client import GHLClient

logger = logging.getLogger("gruening.applications")
limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/api/applications", tags=["applications"])

BEDROCK_MODEL_ID = "anthropic.claude-sonnet-4-5-20250929-v1:0"
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

def _get_bedrock_client():
    return boto3.client(
        service_name="bedrock-runtime",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )

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
    return {"product_type": product_type, "product_label": PRODUCT_LABELS[product_type],
            "extracted": extracted, "field_count": field_count,
            "fields_available": list(FIELD_MAPS[product_type].keys()),
            "auto_detected": auto}

class SubmitApplicationRequest(BaseModel):
    contact_id: str
    product_type: str
    extracted: Dict[str, Any]
    contact_name: Optional[str] = None

@router.post("/submit")
async def submit_application(
    payload: SubmitApplicationRequest,
    db=Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    if payload.product_type not in FIELD_MAPS:
        raise HTTPException(status_code=400, detail="Unknown product_type.")
    if not payload.contact_id.strip():
        raise HTTPException(status_code=400, detail="contact_id required.")
    custom_fields = _fields_to_ghl_array(payload.extracted)
    if not custom_fields:
        raise HTTPException(status_code=400, detail="No non-null fields to submit.")
    ghl = GHLClient()
    try:
        result = await ghl.update_contact(payload.contact_id, custom_fields)
    except Exception as e:
        logger.error("GHL update failed: %s", e)
        raise HTTPException(status_code=502, detail="GHL sync failed.")
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
