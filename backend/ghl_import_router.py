"""Per-agent GoHighLevel connection + bulk contact import.

Each agent connects their own GHL sub-account by pasting a Private
Integration Token in Settings → Integrations. The token is validated
against GHL, encrypted with the existing PHI_FIELD_KEY (Fernet), and
stored in ``db.ghl_integrations`` keyed by agent_id.

Imports run as ``BackgroundTasks``. The handler returns a job_id
immediately; the frontend polls ``GET /api/ghl-import/jobs/{id}``
every few seconds for live progress. Mid-flight cancellation is
honored — the import loop checks job.status on every page boundary.

Security
========
- Token NEVER returned in any response after the initial connect call.
- Token NEVER logged — even on validation failure we log the GHL
  HTTP status only, never the bearer string.
- Imports scoped to ``effective_agent.id`` — an agent can't import
  into another agent's book even with a leaked endpoint.
- AI tag mapping is best-effort; an Anthropic outage returns an empty
  mapping so the agent can map manually.
"""
import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from cryptography.fernet import Fernet
from fastapi import (
    APIRouter, BackgroundTasks, Body, Depends, HTTPException, Request,
)
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from deps import (
    get_agency_id, get_current_user, get_db, get_phi_db,
    get_effective_agent, write_audit,
)
from encryption import safe_lead_set
from models import normalize_state_field


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ghl-import", tags=["ghl-import"])


# ── GHL API constants ─────────────────────────────────────────────────────
_GHL_BASE = os.environ.get(
    "GHL_BASE_URL", "https://services.leadconnectorhq.com",
).rstrip("/")
_GHL_VERSION = os.environ.get("GHL_API_VERSION", "2021-07-28")
_GHL_TIMEOUT = 15.0
_GHL_PAGE_SIZE = 100
_GHL_PAGE_DELAY_SEC = 0.1


def _ghl_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Version": _GHL_VERSION,
        "Accept": "application/json",
    }


# ── Token encryption (Fernet via existing PHI_FIELD_KEY) ─────────────────
def _fernet() -> Optional[Fernet]:
    key = (os.environ.get("PHI_FIELD_KEY") or "").strip()
    if not key:
        return None
    try:
        return Fernet(key.encode())
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ghl_import: PHI_FIELD_KEY invalid: %s", e)
        return None


def _encrypt_token(token: str) -> str:
    f = _fernet()
    if not f:
        logger.warning("ghl_import: PHI_FIELD_KEY unset — token stored plaintext (DEV)")
        return token
    return f.encrypt(token.encode("utf-8")).decode("utf-8")


def _decrypt_token(encrypted: str) -> str:
    f = _fernet()
    if not f:
        return encrypted
    try:
        return f.decrypt(encrypted.encode("utf-8")).decode("utf-8")
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ghl_import: token decrypt failed: %s", e)
        return ""


# ── GHL HTTP helpers ──────────────────────────────────────────────────────
async def _validate_ghl_token(token: str) -> Dict[str, Any]:
    """Hit /locations/search to confirm the token is valid AND grab
    the sub-account info. Returns a dict — never raises."""
    if not token or len(token) < 20:
        return {"valid": False, "error": "Token looks too short."}
    try:
        async with httpx.AsyncClient(timeout=_GHL_TIMEOUT) as c:
            r = await c.get(
                f"{_GHL_BASE}/locations/search",
                headers=_ghl_headers(token),
                params={"limit": 1},
            )
        if r.status_code in (401, 403):
            return {"valid": False, "error": "Token rejected by GHL."}
        if r.status_code >= 400:
            return {"valid": False, "error": f"GHL returned HTTP {r.status_code}."}
        body = r.json() or {}
        locations = body.get("locations") or body.get("data") or []
        if not locations:
            return {"valid": False, "error": "Token authenticates but no locations are accessible."}
        loc = locations[0] or {}
        location_id = loc.get("id") or loc.get("_id") or ""
        location_name = loc.get("name") or "Unknown location"
        contact_count = await _get_contact_count(token, location_id)
        return {
            "valid": True,
            "location_id": location_id,
            "location_name": location_name,
            "contact_count": contact_count,
        }
    except Exception as e:                                    # noqa: BLE001
        # Never include the token in the log line.
        logger.warning("ghl_import: validate failed: %s", e)
        return {"valid": False, "error": "Could not reach GHL — please try again."}


async def _get_contact_count(token: str, location_id: str) -> int:
    """Cheap total-count fetch — pages limit=1 just to read the meta."""
    if not location_id:
        return 0
    try:
        async with httpx.AsyncClient(timeout=_GHL_TIMEOUT) as c:
            r = await c.get(
                f"{_GHL_BASE}/contacts/",
                headers=_ghl_headers(token),
                params={"locationId": location_id, "limit": 1, "page": 1},
            )
        if r.status_code >= 400:
            return 0
        body = r.json() or {}
        meta = body.get("meta") or {}
        return int(meta.get("total") or body.get("total") or 0)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ghl_import: contact count failed: %s", e)
        return 0


async def _fetch_ghl_contacts_page(
    token: str, location_id: str, page: int = 1,
    limit: int = _GHL_PAGE_SIZE,
) -> Dict[str, Any]:
    """One page of contacts. Returns ``{contacts, total, has_more}``.
    Never raises."""
    try:
        async with httpx.AsyncClient(timeout=_GHL_TIMEOUT) as c:
            r = await c.get(
                f"{_GHL_BASE}/contacts/",
                headers=_ghl_headers(token),
                params={"locationId": location_id, "page": page, "limit": limit},
            )
        if r.status_code >= 400:
            return {"contacts": [], "total": 0, "has_more": False,
                    "error": f"HTTP {r.status_code}"}
        body = r.json() or {}
        contacts = body.get("contacts") or body.get("data") or []
        meta = body.get("meta") or {}
        total = int(meta.get("total") or body.get("total") or 0)
        has_more = bool(meta.get("nextPage") or len(contacts) == limit)
        return {"contacts": contacts, "total": total, "has_more": has_more}
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ghl_import: fetch page %s failed: %s", page, e)
        return {"contacts": [], "total": 0, "has_more": False, "error": "exception"}


# ── Field mapping ─────────────────────────────────────────────────────────
GHL_FIELD_MAP = {
    "firstName": "first_name",
    "lastName": "last_name",
    "email": "email",
    "phone": "phone",
    "address1": "address_line1",
    "city": "city",
    "state": "state",
    "postalCode": "zip_code",
    "dateOfBirth": "date_of_birth",
    "source": "lead_source",
}

# Custom-field name hints (lowercased) → portal column.
_CUSTOM_FIELD_HINTS = {
    "medicare_id": "mbi_number",
    "medicare id": "mbi_number",
    "mbi": "mbi_number",
    "medicare_number": "mbi_number",
    "medicare number": "mbi_number",
    "part_a_date": "medicare_part_a_effective",
    "part a date": "medicare_part_a_effective",
    "part_a_effective": "medicare_part_a_effective",
    "part_b_date": "medicare_part_b_effective",
    "part b date": "medicare_part_b_effective",
    "part_b_effective": "medicare_part_b_effective",
    "current_carrier": "current_carrier",
    "current carrier": "current_carrier",
    "carrier": "current_carrier",
    "current_plan": "current_plan",
    "current plan": "current_plan",
    "plan": "current_plan",
}

_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%Y/%m/%d",
                  "%d/%m/%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%fZ")


def _norm_phone(raw: Optional[str]) -> Optional[str]:
    if not raw or not isinstance(raw, str):
        return None
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return None
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if digits.startswith("+"):
        return digits
    return f"+{digits}" if len(digits) > 10 else None


def _norm_email(raw: Optional[str]) -> Optional[str]:
    if not raw or not isinstance(raw, str):
        return None
    e = raw.strip().lower()
    return e or None


def _norm_date(raw: Optional[str]) -> Optional[str]:
    """ISO YYYY-MM-DD. Tolerant of common shapes."""
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s[:len(datetime.now().strftime(fmt))], fmt).date().isoformat()
        except Exception:
            continue
    # last-ditch: maybe the first 10 chars are already ISO
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return None


def _extract_custom_fields(ghl_contact: Dict[str, Any]) -> Dict[str, Any]:
    """Walk customFields array → flat dict keyed by portal column.

    GHL's customFields is heterogeneous — some entries have `name`,
    some `key`, some `fieldKey`. We try every key we know about,
    lowercased, against the hint table.
    """
    out: Dict[str, Any] = {}
    raw_list = ghl_contact.get("customFields") or []
    if not isinstance(raw_list, list):
        return out
    for field in raw_list:
        if not isinstance(field, dict):
            continue
        candidate_keys = [
            (field.get("name") or "").strip().lower(),
            (field.get("key") or "").strip().lower(),
            (field.get("fieldKey") or "").strip().lower(),
            (field.get("id") or "").strip().lower(),
        ]
        portal_col = None
        for k in candidate_keys:
            if k and k in _CUSTOM_FIELD_HINTS:
                portal_col = _CUSTOM_FIELD_HINTS[k]
                break
        if not portal_col:
            continue
        value = field.get("value") or field.get("fieldValue")
        if value is not None and str(value).strip():
            out[portal_col] = str(value).strip()
    return out


def map_ghl_contact(
    ghl_contact: Dict[str, Any],
    tag_mapping: Dict[str, str],
    agent: Dict[str, Any],
    agency_id: str,
) -> Dict[str, Any]:
    """Convert a GHL contact dict to a portal lead document.

    Returns a dict ready for ``db.leads.insert_one(safe_lead_set(...))``.
    """
    now_iso = datetime.now(timezone.utc).isoformat()

    # Standard fields.
    lead: Dict[str, Any] = {}
    for ghl_key, portal_key in GHL_FIELD_MAP.items():
        value = ghl_contact.get(ghl_key)
        if value is not None and str(value).strip():
            lead[portal_key] = value

    # Custom-field hints.
    lead.update(_extract_custom_fields(ghl_contact))

    # Normalize.
    lead["email"] = _norm_email(lead.get("email"))
    lead["phone"] = _norm_phone(lead.get("phone"))
    lead["state"] = normalize_state_field(lead.get("state"))
    if lead.get("date_of_birth"):
        lead["date_of_birth"] = _norm_date(lead.get("date_of_birth"))
    for k in ("medicare_part_a_effective", "medicare_part_b_effective"):
        if lead.get(k):
            lead[k] = _norm_date(lead.get(k))

    # Tags.
    ghl_tags = ghl_contact.get("tags") or []
    if isinstance(ghl_tags, list):
        mapped_tags: List[str] = []
        for t in ghl_tags:
            if not isinstance(t, str):
                continue
            mapped = tag_mapping.get(t)
            if mapped and mapped != "null" and mapped != "— skip —":
                mapped_tags.append(mapped)
        if mapped_tags:
            lead["tags"] = sorted(set(mapped_tags))

    # Required scoping + provenance.
    lead["id"] = str(uuid.uuid4())
    lead["agent_id"] = agent["id"]
    lead["agent_email"] = (agent.get("email") or "").lower() or None
    lead["agent_name"] = (
        agent.get("agent_name") or agent.get("full_name") or None
    )
    lead["agent_assigned_id"] = agent["id"]
    lead["agency_id"] = agency_id
    lead["status"] = lead.get("status") or "new"
    lead["soa_signed"] = False
    lead["document_ids"] = []
    lead["ghl_contact_id"] = ghl_contact.get("id") or ghl_contact.get("contactId")
    lead["ghl_sync_status"] = "synced"
    lead["ghl_synced_at"] = now_iso
    lead["imported_from_ghl"] = True
    lead["imported_at"] = now_iso
    lead["created_via"] = "ghl_import"
    lead["created_at"] = now_iso
    lead["updated_at"] = now_iso
    # Ensure first/last_name not blank.
    lead["first_name"] = (lead.get("first_name") or "").strip() or "Unknown"
    lead["last_name"] = (lead.get("last_name") or "").strip() or ""
    return lead


# ── Duplicate detection ───────────────────────────────────────────────────
async def _is_duplicate(phi_db, agent_id: str, lead: Dict[str, Any]) -> bool:
    """True iff a lead under this agent already matches by ghl_contact_id,
    email, or phone."""
    ghl_id = lead.get("ghl_contact_id")
    email = lead.get("email")
    phone = lead.get("phone")
    or_clauses: List[Dict[str, Any]] = []
    if ghl_id:
        or_clauses.append({"ghl_contact_id": ghl_id})
    if email:
        or_clauses.append({"email": email})
    if phone:
        or_clauses.append({"phone": phone})
    if not or_clauses:
        return False
    try:
        existing = await phi_db.leads.find_one(
            {"agent_id": agent_id, "$or": or_clauses},
            {"_id": 0, "id": 1},
        )
        return existing is not None
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ghl_import: dup check failed: %s", e)
        return False


# ── AI tag mapping (best-effort) ──────────────────────────────────────────
PORTAL_TAGS = [
    "hot-lead", "warm-lead", "cold-lead",
    "birthday-window", "aep-priority", "oep-eligible",
    "new-to-medicare", "turning-65", "employer-transition",
    "enrolled-ma", "enrolled-med-supp", "enrolled-pdp",
    "enrolled-ancillary", "soa-signed", "soa-pending",
    "call-scheduled", "appointment-set", "left-voicemail",
    "needs-review", "re-shop", "policy-lapsing",
    "do-not-contact", "referred",
]


async def ai_map_tags(ghl_tags: List[str]) -> Dict[str, Optional[str]]:
    """Best-effort tag mapping via Claude. Returns empty dict on any
    failure — caller falls back to manual mapping."""
    if not ghl_tags:
        return {}
    api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not api_key:
        return {}
    try:
        import json
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=api_key)
        system = (
            "You are a Medicare insurance CRM data specialist. Map "
            "GHL tags to portal taxonomy tags. Return ONLY valid JSON, "
            "no preamble. For tags with no clear match, use null. "
            "JSON format: {\"ghl_tag\": \"portal_tag_or_null\"}"
        )
        user = (
            f"GHL tags: {json.dumps(ghl_tags)}\n"
            f"Portal tags: {json.dumps(PORTAL_TAGS)}"
        )
        resp = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1000,
            system=[{"type": "text", "text": system,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(getattr(b, "text", "") for b in (resp.content or []))
        text = text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        try:
            parsed = json.loads(text)
        except Exception:
            return {}
        out: Dict[str, Optional[str]] = {}
        for k, v in (parsed or {}).items():
            if not isinstance(k, str):
                continue
            if v in PORTAL_TAGS or v is None:
                out[k] = v
            elif isinstance(v, str) and v.strip() == "":
                out[k] = None
        return out
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ghl_import: ai tag mapping failed: %s", e)
        return {}


# ── Connection endpoints ──────────────────────────────────────────────────
class ConnectRequest(BaseModel):
    token: str = Field(..., min_length=10, max_length=512)


def _public_integration(doc: Optional[dict]) -> Dict[str, Any]:
    """Strip the token + Mongo id before returning."""
    if not doc:
        return {"connected": False}
    out = {k: v for k, v in doc.items()
           if k not in ("_id", "token_encrypted")}
    out["connected"] = doc.get("status") == "connected"
    return out


@router.post("/connect")
async def connect_ghl(
    body: ConnectRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    validation = await _validate_ghl_token(body.token)
    if not validation.get("valid"):
        await write_audit(
            db, "ghl_connect_failed",
            actor_email=effective.get("email"), actor_id=effective.get("id"),
            request=request,
            metadata={"reason": validation.get("error") or "unknown"},
        )
        raise HTTPException(
            status_code=400,
            detail=validation.get("error") or "Token rejected.",
        )
    now = datetime.now(timezone.utc)
    doc = {
        "agent_id": effective["id"],
        "location_id": validation["location_id"],
        "location_name": validation["location_name"],
        "token_encrypted": _encrypt_token(body.token),
        "connected_at": now,
        "last_validated_at": now,
        "contact_count_ghl": validation.get("contact_count") or 0,
        "contact_count_portal": 0,
        "last_sync_at": None,
        "status": "connected",
    }
    await db.ghl_integrations.update_one(
        {"agent_id": effective["id"]},
        {"$set": doc},
        upsert=True,
    )
    await write_audit(
        db, "ghl_connected",
        actor_email=effective.get("email"), actor_id=effective.get("id"),
        request=request,
        metadata={
            "location_id": validation["location_id"],
            "location_name": validation["location_name"],
            "contact_count": validation.get("contact_count") or 0,
        },
    )
    return _public_integration(doc)


@router.delete("/connect")
async def disconnect_ghl(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    await db.ghl_integrations.delete_one({"agent_id": effective["id"]})
    await write_audit(
        db, "ghl_disconnected",
        actor_email=effective.get("email"), actor_id=effective.get("id"),
        request=request,
    )
    return {"disconnected": True}


@router.get("/status")
async def status(
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    doc = await db.ghl_integrations.find_one(
        {"agent_id": effective["id"]}, {"_id": 0},
    )
    return _public_integration(doc)


# ── Preview ───────────────────────────────────────────────────────────────
async def _require_connected(
    db, agent_id: str,
) -> Dict[str, Any]:
    doc = await db.ghl_integrations.find_one({"agent_id": agent_id})
    if not doc or doc.get("status") != "connected":
        raise HTTPException(
            status_code=400,
            detail="GHL is not connected. Connect a token first.",
        )
    return doc


@router.post("/preview")
async def preview(
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
):
    integ = await _require_connected(db, effective["id"])
    token = _decrypt_token(integ["token_encrypted"])
    page = await _fetch_ghl_contacts_page(token, integ["location_id"], page=1)
    contacts = page.get("contacts") or []
    total = page.get("total") or len(contacts)

    # Field + tag analysis on the sample.
    sample_fields: set = set()
    unique_tags: set = set()
    missing_email = 0
    missing_dob = 0
    for c in contacts:
        for k in (c.keys() if isinstance(c, dict) else []):
            sample_fields.add(k)
        for t in (c.get("tags") or []):
            if isinstance(t, str):
                unique_tags.add(t)
        if not (c.get("email") or "").strip():
            missing_email += 1
        if not (c.get("dateOfBirth") or "").strip():
            missing_dob += 1

    # Cheap dup-estimate: count sampled emails/phones already in our DB.
    est_dupes = 0
    if contacts:
        for c in contacts:
            email = _norm_email(c.get("email"))
            phone = _norm_phone(c.get("phone"))
            or_clauses: List[Dict[str, Any]] = []
            if email:
                or_clauses.append({"email": email})
            if phone:
                or_clauses.append({"phone": phone})
            or_clauses.append({"ghl_contact_id": c.get("id")})
            try:
                hit = await phi_db.leads.find_one(
                    {"agent_id": effective["id"], "$or": or_clauses},
                    {"_id": 0, "id": 1},
                )
                if hit:
                    est_dupes += 1
            except Exception:
                pass

    sample_size = max(len(contacts), 1)
    return {
        "total_contacts": total,
        "sample_size": len(contacts),
        "sample_fields": sorted(sample_fields),
        "unique_tags": sorted(unique_tags),
        "estimated_duplicates": est_dupes,
        "missing_email_pct": round(missing_email * 100 / sample_size, 1),
        "missing_dob_pct": round(missing_dob * 100 / sample_size, 1),
    }


# ── AI tag mapping endpoint ───────────────────────────────────────────────
class MapTagsRequest(BaseModel):
    tags: List[str] = Field(default_factory=list)


@router.post("/map-tags")
async def map_tags(
    body: MapTagsRequest,
    effective: dict = Depends(get_effective_agent),
):
    tags = [t for t in (body.tags or []) if isinstance(t, str) and t.strip()]
    if not tags:
        return {"mapping": {}}
    mapping = await ai_map_tags(tags[:200])  # cap prompt size
    # Ensure every input tag has an entry (null for unmatched).
    for t in tags:
        mapping.setdefault(t, None)
    return {"mapping": mapping, "portal_tags": PORTAL_TAGS}


# ── Start import (background task) ────────────────────────────────────────
class StartImportRequest(BaseModel):
    tag_mapping: Dict[str, Optional[str]] = Field(default_factory=dict)
    overwrite_existing: bool = False


@router.post("/start")
async def start_import(
    body: StartImportRequest,
    background: BackgroundTasks,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    phi_db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
):
    integ = await _require_connected(db, effective["id"])
    # Refuse if there's already a running job for this agent.
    in_flight = await db.import_jobs.find_one({
        "agent_id": effective["id"],
        "status": {"$in": ["pending", "running"]},
    }, {"_id": 0, "job_id": 1})
    if in_flight:
        raise HTTPException(
            status_code=409,
            detail=f"An import is already running ({in_flight['job_id']}).",
        )

    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    job_doc = {
        "job_id": job_id,
        "agent_id": effective["id"],
        "agency_id": get_agency_id(),
        "started_at": now,
        "completed_at": None,
        "status": "pending",
        "total_contacts": int(integ.get("contact_count_ghl") or 0),
        "processed": 0,
        "imported": 0,
        "duplicates": 0,
        "flagged": 0,
        "failed": 0,
        "tag_mapping": body.tag_mapping or {},
        "error_log": [],
        "current_page": 0,
        "overwrite_existing": bool(body.overwrite_existing),
    }
    await db.import_jobs.insert_one(job_doc)
    await write_audit(
        db, "ghl_import_started",
        actor_email=effective.get("email"), actor_id=effective.get("id"),
        request=request, metadata={"job_id": job_id},
    )
    # Snapshot agent dict — we can't depend-inject into the bg task.
    agent_snapshot = {
        "id": effective["id"],
        "email": effective.get("email"),
        "full_name": effective.get("full_name"),
        "agent_name": effective.get("agent_name"),
    }
    background.add_task(
        run_import_job, job_id, agent_snapshot,
        get_agency_id(), integ["token_encrypted"], integ["location_id"],
        body.tag_mapping or {},
    )
    return {"job_id": job_id, "status": "pending"}


# ── Jobs read/cancel/report ───────────────────────────────────────────────
@router.get("/jobs")
async def list_jobs(
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    cursor = db.import_jobs.find(
        {"agent_id": effective["id"]}, {"_id": 0},
    ).sort("started_at", -1).limit(10)
    rows = [r async for r in cursor]
    # Strip noisy fields from list view.
    for r in rows:
        r.pop("error_log", None)
        r.pop("tag_mapping", None)
    return {"jobs": rows, "count": len(rows)}


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    job = await db.import_jobs.find_one(
        {"job_id": job_id, "agent_id": effective["id"]}, {"_id": 0},
    )
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    res = await db.import_jobs.update_one(
        {"job_id": job_id, "agent_id": effective["id"],
         "status": {"$in": ["pending", "running"]}},
        {"$set": {"status": "cancelled",
                  "completed_at": datetime.now(timezone.utc)}},
    )
    if res.modified_count == 0:
        raise HTTPException(status_code=404,
                            detail="Job not found or already finished.")
    await write_audit(
        db, "ghl_import_cancelled",
        actor_email=effective.get("email"), actor_id=effective.get("id"),
        request=request, metadata={"job_id": job_id},
    )
    return {"cancelled": True, "job_id": job_id}


@router.get("/jobs/{job_id}/report")
async def get_report(
    job_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    effective: dict = Depends(get_effective_agent),
):
    job = await db.import_jobs.find_one(
        {"job_id": job_id, "agent_id": effective["id"]}, {"_id": 0},
    )
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "job_id": job.get("job_id"),
        "started_at": job.get("started_at"),
        "completed_at": job.get("completed_at"),
        "status": job.get("status"),
        "counts": {
            "total": job.get("total_contacts"),
            "processed": job.get("processed"),
            "imported": job.get("imported"),
            "duplicates": job.get("duplicates"),
            "flagged": job.get("flagged"),
            "failed": job.get("failed"),
        },
        "tag_mapping": job.get("tag_mapping") or {},
        "error_count": len(job.get("error_log") or []),
        "error_log": (job.get("error_log") or [])[:50],
    }


# ── Background import engine ──────────────────────────────────────────────
async def run_import_job(
    job_id: str,
    agent: Dict[str, Any],
    agency_id: str,
    token_encrypted: str,
    location_id: str,
    tag_mapping: Dict[str, Optional[str]],
) -> None:
    """The actual import loop. Runs in FastAPI BackgroundTasks (same
    process). Never raises — any unhandled failure flips the job to
    "failed" and logs to job.error_log."""
    # We can't import FastAPI deps inside a background task — open
    # fresh Mongo clients via deps helpers.
    from deps import get_db, get_phi_db
    db = get_db()
    phi_db = get_phi_db()
    token = _decrypt_token(token_encrypted)
    if not token:
        await db.import_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "failed",
                      "completed_at": datetime.now(timezone.utc)},
             "$push": {"error_log": "Token could not be decrypted."}},
        )
        return

    try:
        await db.import_jobs.update_one(
            {"job_id": job_id}, {"$set": {"status": "running"}},
        )
        page = 1
        # Re-read total in case it changed since /start was called.
        first = await _fetch_ghl_contacts_page(token, location_id, page=page)
        total = int(first.get("total") or 0)
        if total:
            await db.import_jobs.update_one(
                {"job_id": job_id}, {"$set": {"total_contacts": total}},
            )
        first_contacts = first.get("contacts") or []

        async def _process_batch(contacts: List[Dict[str, Any]]) -> Dict[str, int]:
            counts = {"imported": 0, "duplicates": 0, "flagged": 0,
                      "failed": 0, "processed": 0}
            errors: List[str] = []
            for c in contacts:
                counts["processed"] += 1
                try:
                    lead = map_ghl_contact(c, tag_mapping or {}, agent, agency_id)
                    if await _is_duplicate(phi_db, agent["id"], lead):
                        counts["duplicates"] += 1
                        continue
                    await phi_db.leads.insert_one(safe_lead_set(lead))
                    is_flagged = (
                        not lead.get("email") or not lead.get("date_of_birth")
                    )
                    if is_flagged:
                        counts["flagged"] += 1
                    else:
                        counts["imported"] += 1
                except Exception as e:                        # noqa: BLE001
                    counts["failed"] += 1
                    errors.append(f"{c.get('id','?')}: {type(e).__name__}: {str(e)[:120]}")
                    if len(errors) >= 5:
                        break
            update: Dict[str, Any] = {
                "$inc": {
                    "processed": counts["processed"],
                    "imported": counts["imported"],
                    "duplicates": counts["duplicates"],
                    "flagged": counts["flagged"],
                    "failed": counts["failed"],
                },
                "$set": {"current_page": page},
            }
            if errors:
                update["$push"] = {
                    "error_log": {"$each": errors, "$slice": -50},
                }
            await db.import_jobs.update_one({"job_id": job_id}, update)
            return counts

        await _process_batch(first_contacts)

        # Loop remaining pages.
        has_more = first.get("has_more")
        while has_more:
            # Cancellation check on every page boundary.
            current = await db.import_jobs.find_one(
                {"job_id": job_id}, {"_id": 0, "status": 1},
            )
            if not current or current.get("status") == "cancelled":
                logger.info("ghl_import: job %s cancelled mid-flight", job_id)
                return
            await asyncio.sleep(_GHL_PAGE_DELAY_SEC)
            page += 1
            resp = await _fetch_ghl_contacts_page(token, location_id, page=page)
            page_contacts = resp.get("contacts") or []
            if not page_contacts:
                break
            await _process_batch(page_contacts)
            has_more = resp.get("has_more")

        # Mark done + sync count to integration row.
        now = datetime.now(timezone.utc)
        final = await db.import_jobs.find_one({"job_id": job_id}, {"_id": 0})
        await db.import_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "complete", "completed_at": now}},
        )
        await db.ghl_integrations.update_one(
            {"agent_id": agent["id"]},
            {"$set": {
                "contact_count_portal": int(final.get("imported", 0)
                                              + final.get("flagged", 0)),
                "last_sync_at": now,
            }},
        )
        await _send_import_complete_email(agent, final or {})
    except Exception as e:                                    # noqa: BLE001
        logger.exception("ghl_import: job %s failed: %s", job_id, e)
        try:
            await db.import_jobs.update_one(
                {"job_id": job_id},
                {"$set": {"status": "failed",
                          "completed_at": datetime.now(timezone.utc)},
                 "$push": {"error_log":
                            f"Unhandled: {type(e).__name__}: {str(e)[:200]}"}},
            )
        except Exception:
            pass


async def _send_import_complete_email(
    agent: Dict[str, Any], job: Dict[str, Any],
) -> None:
    """Best-effort notification — RESEND_API_KEY missing is fine."""
    if not agent.get("email"):
        return
    try:
        from email_templates import ghl_import_complete_email
        from resend_client import send_email
        from deps import get_frontend_url
        portal_url = f"{get_frontend_url()}/clients"
        imported = int(job.get("imported", 0))
        html = ghl_import_complete_email(
            agent_name=agent.get("full_name") or "Agent",
            imported=imported,
            duplicates=int(job.get("duplicates", 0)),
            flagged=int(job.get("flagged", 0)),
            portal_url=portal_url,
        )
        await send_email(
            to=agent["email"],
            subject=f"Your GHL import is complete — {imported} contacts added",
            html=html,
        )
    except Exception as e:                                    # noqa: BLE001
        logger.warning("ghl_import: completion email failed: %s", e)
