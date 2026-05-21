"""
extraction_schemas.py
=====================
Per-document Bedrock extraction prompts + canonical-field mapping.

Each supporting-document label (SOA, Election Notice, EFT, PHI Auth, ID
Copy, Prescription List, Agent Attestation, Other, plus the Main
Application) gets its own tuned prompt. Bedrock is instructed to return
two parallel objects:

    {
      "fields": {<schema field name>: <string or null>, ...},
      "confidences": {<schema field name>: <float 0..1>, ...}
    }

so the SPA can colour-code each row by confidence and the cross-
reference detector can compare canonical fields across multiple docs.

PHI / HIPAA: the file bytes ride to Bedrock under AWS' BAA. Extracted
fields land in MongoDB and (selectively) in GHL. Nothing else leaves
this server.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple


# Canonical document-type keys used everywhere downstream. The label
# string from the SPA's dropdown maps onto one of these via
# ``label_to_doc_type``.
DOC_TYPES: Tuple[str, ...] = (
    "main_application",
    "soa",
    "election_notice",
    "eft_form",
    "phi_auth",
    "id_copy",
    "prescriptions",
    "agent_attestation",
    "other",
)


_LABEL_MAP: Dict[str, str] = {
    "Main Application": "main_application",
    "SOA": "soa",
    "Election Notice": "election_notice",
    "EFT Form": "eft_form",
    "PHI Auth": "phi_auth",
    "ID Copy": "id_copy",
    "Prescription List": "prescriptions",
    "Agent Attestation": "agent_attestation",
    "Other": "other",
}


def label_to_doc_type(label: Optional[str]) -> str:
    """Map a UI label to the canonical doc-type key.

    Unknown labels fall through to ``"other"`` — never raise; the agent
    can pick a more specific label later and re-extract."""
    if not label:
        return "other"
    return _LABEL_MAP.get(label.strip(), "other")


# ── Per-doc-type field lists ─────────────────────────────────────────────
#
# Each entry lists *every* canonical field name Bedrock should try to
# pull. Field naming is consistent across doc types where the same
# semantic field appears (e.g. ``carrier`` / ``plan_name`` /
# ``effective_date``) so the cross-reference detector can spot
# disagreement without a per-doc mapping table.

_FIELDS_MAIN: List[str] = [
    "applicant_full_name", "applicant_dob", "applicant_address",
    "applicant_phone", "applicant_email",
    "applicant_medicare_id", "applicant_medicaid_id",
    "applicant_gender", "applicant_tobacco_use",
    "primary_care_physician", "pcp_npi",
    "plan_name", "plan_id", "county", "state",
    "carrier", "policy_id", "premium", "effective_date",
    "enrollment_type", "election_period", "policy_status",
    "term_date", "payment_method", "auto_pay",
    "agent_name", "agent_npn",
    "agent_signature_present", "applicant_signature_present",
    "application_date",
]

_FIELDS_SOA: List[str] = [
    "client_name", "client_dob", "client_address", "client_phone",
    "agent_name", "agent_npn",
    "date_of_appointment", "time_of_appointment",
    "products_discussed",  # comma-separated list, parsed downstream
    "client_signature_present", "agent_signature_present",
    "soa_date_signed", "appointment_type",
]

_FIELDS_ELECTION_NOTICE: List[str] = [
    "plan_name", "plan_id", "carrier", "effective_date",
    "premium", "deductible", "max_out_of_pocket",
    "drug_deductible", "service_area", "county", "state",
    "enrollment_period",
]

_FIELDS_EFT: List[str] = [
    "payment_method", "bank_name", "account_type",
    "routing_number", "account_number",
    "authorization_date", "account_holder_name",
]

_FIELDS_PHI: List[str] = [
    "client_name", "authorization_scope", "authorized_parties",
    "expiry_date", "date_signed", "client_signature_present",
]

_FIELDS_ID: List[str] = [
    "medicare_beneficiary_id",
    "medicare_part_a_effective", "medicare_part_b_effective",
    "full_name", "address",
]

_FIELDS_PRESCRIPTIONS: List[str] = [
    # Special-cased downstream: ``medications`` returns an array of
    # {drug_name, dosage, frequency, prescribing_physician} dicts.
    "medications",
]

_FIELDS_ATTESTATION: List[str] = [
    "agent_name", "agent_npn", "agent_signature_present",
    "attestation_date", "carrier", "plan_name",
]

_FIELDS_OTHER: List[str] = [
    "names_detected", "dates_detected", "ids_detected",
    "policy_numbers_detected", "carriers_detected",
    "plan_names_detected", "premium_amounts_detected",
    "addresses_detected", "phones_detected", "emails_detected",
    "signatures_present_detected",
]


SCHEMA_FIELDS: Dict[str, List[str]] = {
    "main_application": _FIELDS_MAIN,
    "soa": _FIELDS_SOA,
    "election_notice": _FIELDS_ELECTION_NOTICE,
    "eft_form": _FIELDS_EFT,
    "phi_auth": _FIELDS_PHI,
    "id_copy": _FIELDS_ID,
    "prescriptions": _FIELDS_PRESCRIPTIONS,
    "agent_attestation": _FIELDS_ATTESTATION,
    "other": _FIELDS_OTHER,
}


# ── Per-doc-type prompt builder ──────────────────────────────────────────
_PROMPT_HEADER = (
    "You are an expert at extracting structured data from insurance "
    "documents. Read the attached document and extract the requested "
    "fields with high accuracy.\n\n"
    "Return a SINGLE JSON object — no markdown, no commentary — with "
    "exactly two top-level keys:\n"
    "  - \"fields\": object mapping field name to extracted value "
    "(string, boolean, or array as specified). Use null when the field "
    "is not present in the document. Do NOT guess.\n"
    "  - \"confidences\": object mapping the same field names to a "
    "decimal between 0.0 and 1.0 representing your confidence the "
    "extracted value is correct. Use 1.0 only for unambiguous OCR; "
    "0.0 for fields you couldn't find.\n\n"
    "Format conventions:\n"
    "  - Dates: YYYY-MM-DD\n"
    "  - Phone numbers: digits only (no parens, dashes, or spaces)\n"
    "  - Currency: number only, no $ sign or commas\n"
    "  - Booleans: true or false (lowercase)\n"
    "  - Lists / arrays: emit as JSON array (do NOT comma-join into a string)\n"
)


_DOC_GUIDANCE: Dict[str, str] = {
    "main_application": (
        "This is a carrier insurance APPLICATION (Medicare Supplement, "
        "Medicare Advantage, PDP, Cancer, Heart/Stroke, HIP, Recovery "
        "Care, Dental/Vision/Hearing, or Life). Pay extra attention to "
        "applicant identity, plan + premium, election period, agent "
        "credentials, and signature presence."
    ),
    "soa": (
        "This is a Medicare Scope of Appointment (SOA) form. The "
        "products_discussed field MUST be a JSON array of strings; "
        "valid values include: MA, PDP, Med Supp, Ancillary, Life, "
        "Annuity. Only emit values that were actually checked on the "
        "form. appointment_type is one of: in-person, phone, virtual."
    ),
    "election_notice": (
        "This is an Annual Notice of Change (ANOC) or election notice. "
        "Extract plan economics — premium, deductible, max out-of-"
        "pocket, drug deductible — and the service area / county /"
        " state the plan applies to."
    ),
    "eft_form": (
        "This is an EFT or bank authorization form. payment_method is "
        "one of: check, EFT, coupon. account_type is one of: checking, "
        "savings. Capture routing + account numbers verbatim — do NOT "
        "mask or redact digits; downstream code handles encryption."
    ),
    "phi_auth": (
        "This is a HIPAA / PHI authorization form. authorized_parties "
        "MUST be a JSON array of names or organizations the patient "
        "authorized to receive their health information."
    ),
    "id_copy": (
        "This is a Medicare card or government-issued ID copy. Extract "
        "the Medicare Beneficiary Identifier (MBI) verbatim — it is an "
        "11-character alphanumeric code. Capture the Part A and Part B "
        "effective dates if printed on the card."
    ),
    "prescriptions": (
        "This is a prescription / drug list. Return medications as a "
        "JSON array of objects: each object has drug_name (string), "
        "dosage (string), frequency (string), and prescribing_physician "
        "(string or null). Do NOT collapse rows; one entry per line on "
        "the list."
    ),
    "agent_attestation": (
        "This is an agent attestation form (the agent's signed "
        "statement attesting to compliance with CMS sales rules). "
        "Capture agent identity, the carrier + plan they attested to, "
        "and signature presence."
    ),
    "other": (
        "The document type is unknown. Do a GENERAL extraction: emit "
        "lists of any data points that look like names, dates, ID "
        "numbers, policy numbers, carrier names, plan names, premium "
        "amounts, addresses, phone numbers, or email addresses. Each "
        "list field is a JSON array of strings. signatures_present_"
        "detected is a JSON array of role labels (e.g. [\"applicant\","
        " \"agent\"]) that have visible signatures."
    ),
}


def build_prompt(doc_type: str) -> str:
    """Compose the full Bedrock prompt for a given doc type.

    Falls back to the ``other`` template when the doc type is unknown
    rather than raising — the upload UI is intentionally forgiving."""
    if doc_type not in SCHEMA_FIELDS:
        doc_type = "other"
    fields = SCHEMA_FIELDS[doc_type]
    guidance = _DOC_GUIDANCE[doc_type]
    field_list = "\n".join(f"  - {f}" for f in fields)
    return (
        _PROMPT_HEADER
        + f"\nDocument type: {doc_type}\n"
        + f"\n{guidance}\n"
        + "\nExtract these fields:\n"
        + field_list
        + "\n\nReturn the JSON object now."
    )


# ── Canonical-field aliasing for cross-reference detection ───────────────
#
# When the same semantic value (e.g. the applicant's name) appears under
# different keys across doc types, normalise to ONE canonical name so
# the conflict detector can compare apples-to-apples.

_CANONICAL_ALIASES: Dict[str, str] = {
    # Names
    "applicant_full_name": "full_name",
    "client_name": "full_name",
    "account_holder_name": "full_name",
    # DOB
    "applicant_dob": "dob",
    "client_dob": "dob",
    # Address
    "applicant_address": "address",
    "client_address": "address",
    # Phone
    "applicant_phone": "phone",
    "client_phone": "phone",
    # MBI / Medicare id
    "applicant_medicare_id": "medicare_id",
    "medicare_beneficiary_id": "medicare_id",
    # Plan / carrier / policy
    "plan_name": "plan_name",
    "plan_id": "plan_id",
    "carrier": "carrier",
    "policy_id": "policy_id",
    "effective_date": "effective_date",
    "premium": "premium",
    "payment_method": "payment_method",
    "primary_care_physician": "primary_care_physician",
    # Agent
    "agent_name": "agent_name",
    "agent_npn": "agent_npn",
    # SOA date
    "soa_date_signed": "soa_date_signed",
    "date_of_appointment": "soa_date_signed",
    # Signed dates
    "date_signed": "date_signed",
    "application_date": "application_date",
    "attestation_date": "attestation_date",
    "authorization_date": "authorization_date",
}


def canonical_field(name: str) -> str:
    """Return the cross-doc canonical name for a doc-specific field."""
    return _CANONICAL_ALIASES.get(name, name)


# ── Cross-reference conflict detector ────────────────────────────────────
def detect_conflicts(
    extracted_by_doc: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Find canonical fields whose value disagrees across documents.

    ``extracted_by_doc`` is shaped like
    ``{ "main_application": {"applicant_full_name": "Jane Doe", ...},
        "id_copy": {"full_name": "Jane M Doe", ...},
        ... }``.

    Returns a list of conflict records:
    ``[{"canonical": "full_name",
        "values": ["Jane Doe", "Jane M Doe"],
        "sources": [
            {"doc_type": "main_application",
             "field": "applicant_full_name",
             "value": "Jane Doe"},
            {"doc_type": "id_copy",
             "field": "full_name",
             "value": "Jane M Doe"},
        ]}]``

    Empty / None / "" values are ignored. Booleans + arrays are
    compared by their normalised string form so the detector can spot
    e.g. ``true`` vs ``false`` for ``agent_signature_present``.
    """
    by_canonical: Dict[str, List[Dict[str, Any]]] = {}
    for doc_type, fields in (extracted_by_doc or {}).items():
        if not isinstance(fields, dict):
            continue
        for field_name, value in fields.items():
            canonical = canonical_field(field_name)
            norm = _normalise_value(value)
            if norm is None:
                continue
            by_canonical.setdefault(canonical, []).append({
                "doc_type": doc_type,
                "field": field_name,
                "value": value,
                "_norm": norm,
            })

    conflicts: List[Dict[str, Any]] = []
    for canonical, sources in by_canonical.items():
        if len(sources) < 2:
            continue
        norms = {s["_norm"] for s in sources}
        if len(norms) <= 1:
            continue  # all docs agree
        # Strip the internal _norm key from the returned shape.
        cleaned_sources = [
            {k: v for k, v in s.items() if k != "_norm"} for s in sources
        ]
        conflicts.append({
            "canonical": canonical,
            "values": sorted({str(s["value"]) for s in sources}),
            "sources": cleaned_sources,
        })
    return conflicts


def _normalise_value(value: Any) -> Optional[str]:
    """Reduce a field value to a comparable string. None for blank /
    missing values so the conflict detector can ignore them."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        if not value:
            return None
        return ",".join(sorted(_normalise_value(v) or "" for v in value))
    s = str(value).strip()
    if not s:
        return None
    # Aggressive normalisation for free-form text: lowercase, strip
    # punctuation that varies across forms (commas / periods / extra
    # whitespace). This avoids false positives like
    # "123 Main St." vs "123 Main St".
    import re
    return re.sub(r"[\s.,;:]+", " ", s.lower()).strip()


# ── GHL canonical-field push map ─────────────────────────────────────────
#
# Maps canonical extracted fields → GHL custom-field keys. The submit
# handler walks this table to build the second GHL contact update on
# top of whatever the existing /submit flow already pushes.

GHL_FIELD_KEY_MAP: Dict[str, str] = {
    "medicare_id": "medicare_id",
    "dob": "date_of_birth",
    "address": "address1",
    "phone": "phone",
    "primary_care_physician": "primary_care_physician",
    "agent_npn": "agent_npn",
    "agent_name": "agent_name",
    "soa_date_signed": "soa_signed_date",
    "effective_date": "policy_effective_date",
    "payment_method": "payment_method",
    "plan_name": "current_plan",
    "carrier": "current_carrier",
    "policy_id": "policy_number",
    "premium": "policy_premium",
    "application_date": "application_signed_date",
}


def build_ghl_payload(
    extracted_by_doc: Dict[str, Dict[str, Any]],
) -> List[Dict[str, str]]:
    """Reduce the per-doc extraction down to a flat GHL custom-field
    update payload.

    Strategy: walk every canonical key in the map; pick the first
    non-empty value from any document that supplies it. Main
    application is consulted first (most authoritative), then SOA, then
    the rest in declaration order.
    """
    if not extracted_by_doc:
        return []

    preference = (
        "main_application", "soa", "election_notice", "id_copy",
        "eft_form", "agent_attestation", "phi_auth", "prescriptions",
        "other",
    )
    canonical_values: Dict[str, str] = {}
    for doc in preference:
        fields = extracted_by_doc.get(doc) or {}
        if not isinstance(fields, dict):
            continue
        for k, v in fields.items():
            canonical = canonical_field(k)
            if canonical in canonical_values:
                continue  # earlier (higher-priority) doc already won
            norm = _normalise_value(v)
            if norm is None:
                continue
            if isinstance(v, list):
                canonical_values[canonical] = ", ".join(str(x) for x in v if x)
            else:
                canonical_values[canonical] = str(v)

    payload: List[Dict[str, str]] = []
    for canonical, ghl_key in GHL_FIELD_KEY_MAP.items():
        if canonical in canonical_values:
            payload.append({
                "key": ghl_key,
                "field_value": canonical_values[canonical],
            })
    return payload
