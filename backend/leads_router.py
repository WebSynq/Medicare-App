"""Lead CRUD + GHL sync."""
import io
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from models import Lead, LeadCreate, LeadUpdate
from deps import (
    get_db,
    get_current_user,
    get_effective_agent,
    agent_filter,
    get_agency_id,
    get_client_ip,
    require_roles,
    write_audit,
    FULL_AGENCY_SCOPE_ROLES,
)
from ghl_client import GHLClient
from pdf_export import generate_lead_pdf


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leads", tags=["leads"])
limiter = Limiter(key_func=get_remote_address)


def _short_hash(s: Optional[str]) -> Optional[str]:
    """Short SHA-256 fingerprint of a string, for audit metadata.

    We don't want to log the verbatim TCPA consent text on every audit
    row (it's the same paragraph for every lead — pure noise) but we do
    want a deterministic identifier so compliance can prove the text
    hasn't drifted between rows.
    """
    if not s:
        return None
    import hashlib
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:12]


# ── Auto-SOA on Medicare leads ───────────────────────────────────────────
# CMS rules require an SOA before discussing Medicare products. Ancillary
# / life / annuity / final-expense products don't trigger one. The
# product_interest string can arrive in many shapes (lowercase code,
# title-case label, short abbreviation) — we normalise here and match a
# fixed set of Medicare keywords.
_MEDICARE_PRODUCT_KEYWORDS = (
    "medicare supplement", "med supp", "medsupp",
    "medicare advantage", "ma", "ma_",
    "pdp", "prescription drug",
    "medicare",
)


def _is_medicare_product(product_interest: Optional[str]) -> bool:
    if not product_interest:
        return False
    norm = product_interest.strip().lower()
    return any(kw in norm for kw in _MEDICARE_PRODUCT_KEYWORDS)


async def _auto_create_soa_for_medicare_lead(
    db, lead: dict, effective: dict, request: Request,
) -> Optional[str]:
    """If the lead's product_interest is Medicare-related, mint a single-
    use SOA token, store the pending record, push tags to GHL, and
    return the public e-sign URL. Never raises — caller logs and moves on.

    The CSRF-exempt ``/api/soa/public/{token}`` route consumes the token.
    """
    if not _is_medicare_product(lead.get("product_interest")):
        return None
    try:
        token = uuid.uuid4().hex
        now = datetime.now(timezone.utc)
        soa_doc = {
            "id": str(uuid.uuid4()),
            "lead_id": lead["id"],
            "agent_id": effective["id"],
            "agent_name": effective.get("agent_name") or effective.get("full_name"),
            "token": token,
            "status": "pending",
            "products_to_discuss": [lead.get("product_interest")],
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(days=30)).isoformat(),
            "signed_at": None,
            "signed_name": None,
            "signed_ip": None,
            "plan_types_discussed": [],
            "agency_id": get_agency_id(),
        }
        await db.soa_records.insert_one(soa_doc.copy())

        frontend = (
            os.environ.get("FRONTEND_URL")
            or "https://medicare-app-sandy-tau.vercel.app"
        ).rstrip("/")
        soa_link = f"{frontend}/soa/{token}"

        # Best-effort GHL push — tag + custom note so the workflow can
        # fire SMS / email outside the portal. Field-id mapping for
        # native "SOA Status" custom field is per-location; tag is the
        # universal signal that works without custom-field setup.
        if lead.get("ghl_contact_id"):
            try:
                ghl = GHLClient()
                if not ghl.mock_mode:
                    await ghl.add_tags(lead["ghl_contact_id"], ["SOA-Pending"])
            except Exception as e:
                logger.warning("SOA tag push to GHL failed: %s", e)

        await write_audit(
            db, "soa_auto_generated",
            actor_email=effective.get("email"),
            actor_id=effective.get("id"),
            target_type="soa", target_id=soa_doc["id"],
            request=request,
            metadata={
                "lead_id": lead["id"],
                "product": lead.get("product_interest"),
                "expires_at": soa_doc["expires_at"],
            },
        )
        return soa_link
    except Exception as e:
        logger.warning("auto-SOA generation failed for lead %s: %s",
                       lead.get("id"), e)
        return None


def _idor_or_403(doc: Optional[dict], current_user: dict) -> dict:
    """Phase 2 ownership check. Returns the doc when access is allowed,
    raises 404 if the doc doesn't exist, and 403 if it exists but the
    caller doesn't own it (and isn't admin/compliance).

    Using 403 instead of 404-for-not-yours is a deliberate tradeoff: it's
    more accurate for legitimate callers but does leak that the resource
    exists. The route-level filter still hides scoped lists, so the only
    way to surface 403 is to know the id already.
    """
    if not doc:
        raise HTTPException(status_code=404, detail="Lead not found")
    role = current_user.get("role")
    if role in FULL_AGENCY_SCOPE_ROLES:
        return doc
    if doc.get("agent_id") != current_user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return doc


async def _sync_lead_to_ghl(
    db: AsyncIOMotorDatabase,
    lead_id: str,
    request: Request,
    actor_email: Optional[str],
    actor_id: Optional[str],
) -> None:
    """Push a lead to GHL and persist sync state.

    On success: updates ghl_contact_id / ghl_sync_status / ghl_synced_at and writes
    a ghl_sync audit event. On failure: updates ghl_sync_status="error" with the
    error message, writes a ghl_sync_failed audit event, and re-raises so the
    caller can choose how to respond.
    """
    doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Lead not found")

    client = GHLClient()
    try:
        resp = await client.upsert_contact(doc)
        contact = resp.get("contact") or resp.get("data", {}).get("contact") or {}
        contact_id = contact.get("id")
        tags_to_add = []
        if doc.get("soa_signed"):
            tags_to_add.append("SOA-Signed")
        if doc.get("document_ids"):
            tags_to_add.append("Docs-Uploaded")
        if doc.get("tcpa_consent"):
            # Tag-based signal until we wire location-specific custom
            # field IDs for tcpa_consent_timestamp / tcpa_consent_ip.
            tags_to_add.append("TCPA-Consented")
        if contact_id and tags_to_add and not client.mock_mode:
            try:
                await client.add_tags(contact_id, tags_to_add)
            except Exception:
                pass
        if contact_id and not client.mock_mode and client.pipeline_id:
            try:
                await client.create_opportunity(
                    contact_id,
                    f"Medicare Lead: {doc.get('first_name','')} {doc.get('last_name','')}".strip(),
                )
            except Exception:
                pass

        sync_status = "mock" if client.mock_mode else "synced"
        now_iso = datetime.now(timezone.utc).isoformat()
        await db.leads.update_one(
            {"id": lead_id},
            {"$set": {
                "ghl_contact_id": contact_id,
                "ghl_sync_status": sync_status,
                "ghl_sync_error": None,
                "ghl_synced_at": now_iso,
                "updated_at": now_iso,
            }},
        )
        await write_audit(db, "ghl_sync", actor_email=actor_email,
                          actor_id=actor_id, target_type="lead", target_id=lead_id,
                          request=request, metadata={"status": sync_status, "contact_id": contact_id})
    except Exception as e:
        # Don't persist raw upstream error text — it can leak GHL response
        # bodies, auth headers, or PHI we just sent. Log the full error
        # server-side, but write only a categorical label to the DB + audit.
        logger.warning("GHL sync failed for lead %s: %s", lead_id, e, exc_info=False)
        error_category = type(e).__name__
        await db.leads.update_one(
            {"id": lead_id},
            {"$set": {"ghl_sync_status": "error",
                      "ghl_sync_error": f"upstream_{error_category}",
                      "updated_at": datetime.now(timezone.utc).isoformat()}},
        )
        await write_audit(db, "ghl_sync_failed", actor_email=actor_email,
                          actor_id=actor_id, target_type="lead", target_id=lead_id,
                          request=request, metadata={"error_category": error_category})
        raise


@router.post("", status_code=201)
@limiter.limit("30/hour")
async def create_lead(
    payload: LeadCreate,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    effective: dict = Depends(get_effective_agent),
):
    """Create a lead from the (authenticated) intake wizard.

    The wizard route is gated behind <Protected> on the client, but historically
    this endpoint was anonymous — so anyone could POST arbitrary Medicare PHI
    (MBI, DOB, prescriptions) into the database. Now requires a valid JWT.

    Ownership stamping (Phase 2):
      - agent_id / agent_email / agent_name come from get_effective_agent,
        so admins doing "view as agent" via X-Agent-ID create the lead under
        the impersonated agent's scope rather than their own.
      - agent_assigned_id is also stamped for agent callers to preserve the
        legacy assignment field while we transition reads to agent_id.
    """
    lead_data = payload.model_dump()
    effective_id = effective["id"]
    lead_data["agent_id"] = effective_id
    lead_data["agent_email"] = (effective.get("email") or "").lower().strip() or None
    lead_data["agent_name"] = (
        effective.get("agent_name") or effective.get("full_name") or None
    )
    if current_user.get("role") == "agent":
        lead_data["agent_assigned_id"] = current_user["id"]

    # TCPA consent — stamp timestamp + IP server-side ONLY when the
    # client supplied the boolean. The verbatim consent text comes in
    # the payload (LeadBase.tcpa_consent_text) so we store exactly what
    # the user agreed to; timestamp/IP are non-negotiable server-stamped
    # provenance for CMS / TCPA audits.
    if lead_data.get("tcpa_consent"):
        lead_data["tcpa_consent_timestamp"] = datetime.now(timezone.utc).isoformat()
        lead_data["tcpa_consent_ip"] = get_client_ip(request)

    lead = Lead(**lead_data)
    doc = lead.model_dump()
    # Passive agency_id stamp — see deps.get_agency_id docstring.
    # Single-tenant today; flips the multi-tenant cut into a filter
    # change rather than a schema rebuild.
    doc["agency_id"] = get_agency_id()
    await db.leads.insert_one(doc.copy())
    await write_audit(db, "lead_created", actor_email=current_user.get("email"),
                      actor_id=current_user.get("id"),
                      target_type="lead", target_id=lead.id, request=request,
                      metadata={"source": "authenticated_intake",
                                "actor_role": current_user.get("role"),
                                "agent_id": effective_id,
                                "impersonated_by": effective.get("_impersonated_by")})

    # Separate audit row for the consent itself so the compliance
    # export can pull a clean record per consent event.
    if doc.get("tcpa_consent"):
        await write_audit(
            db, "tcpa_consent_recorded",
            actor_email=current_user.get("email"),
            actor_id=current_user.get("id"),
            target_type="lead", target_id=lead.id, request=request,
            metadata={
                "tcpa_consent_timestamp": doc.get("tcpa_consent_timestamp"),
                "tcpa_consent_ip": doc.get("tcpa_consent_ip"),
                "tcpa_consent_text_hash": _short_hash(doc.get("tcpa_consent_text")),
            },
        )

    # Auto-sync to GHL. Failures must not block the intake response — the helper
    # has already persisted ghl_sync_status="error" + the audit event by the time
    # we get here.
    try:
        await _sync_lead_to_ghl(db, lead.id, request,
                                actor_email=current_user.get("email"),
                                actor_id=current_user.get("id"))
    except Exception as e:
        logger.warning("Auto GHL sync failed for lead %s: %s", lead.id, e)

    # Auto-create SOA for Medicare-product leads. Never blocks — returns
    # None on non-Medicare leads or any internal failure.
    fresh = await db.leads.find_one({"id": lead.id}, {"_id": 0})
    soa_link = await _auto_create_soa_for_medicare_lead(
        db, fresh, effective, request,
    )

    # Speed-to-lead SMS. Only fires when:
    #   - TCPA consent is on file (federal requirement),
    #   - the lead has a phone number,
    #   - GHL gave us a contact id back from the sync above.
    # Any other case audit-logs a "skipped" event with the reason so
    # the compliance team can demonstrate due diligence.
    await _fire_speed_to_lead_sms(db, fresh, effective, request)

    lead_out = Lead(**fresh).model_dump()
    lead_out["soa_link"] = soa_link
    return lead_out


async def _fire_speed_to_lead_sms(
    db: AsyncIOMotorDatabase,
    lead: dict,
    effective: dict,
    request: Request,
) -> None:
    """Best-effort speed-to-lead SMS via GHL Conversations API.

    Hard preconditions (any miss → audit + return):
      1. lead.tcpa_consent must be True.
      2. lead.phone must be a non-empty string.
      3. lead.ghl_contact_id must be set (the SMS targets the GHL
         contact, not a raw phone).
    """
    reasons = []
    if not lead.get("tcpa_consent"):
        reasons.append("no_tcpa_consent")
    if not (lead.get("phone") or "").strip():
        reasons.append("no_phone")
    if not lead.get("ghl_contact_id"):
        reasons.append("no_ghl_contact_id")

    if reasons:
        await write_audit(
            db, "speed_to_lead_sms_skipped",
            actor_email=effective.get("email"),
            actor_id=effective.get("id"),
            target_type="lead", target_id=lead.get("id"),
            request=request,
            metadata={"reason": ",".join(reasons)},
        )
        return

    first_name = (lead.get("first_name") or "there").strip() or "there"
    agent_name = (
        effective.get("agent_name")
        or effective.get("full_name")
        or "your GHW agent"
    )
    msg = (
        f"Hi {first_name}, this is {agent_name} with Gruening Health & "
        "Wealth. I'd love to help you with your Medicare options. When "
        "is a good time to chat? Reply STOP to opt out."
    )

    try:
        client = GHLClient()
        if client.mock_mode:
            await write_audit(
                db, "speed_to_lead_sms_skipped",
                actor_email=effective.get("email"),
                actor_id=effective.get("id"),
                target_type="lead", target_id=lead.get("id"),
                request=request,
                metadata={"reason": "ghl_mock_mode"},
            )
            return
        result = await client.send_sms(lead["ghl_contact_id"], msg)
        ok = result is not None
        await write_audit(
            db,
            "speed_to_lead_sms_sent" if ok else "speed_to_lead_sms_failed",
            actor_email=effective.get("email"),
            actor_id=effective.get("id"),
            target_type="lead", target_id=lead.get("id"),
            request=request,
            metadata={"ghl_contact_id": lead.get("ghl_contact_id")},
        )
    except Exception as e:
        logger.warning("speed-to-lead SMS failed for %s: %s",
                       lead.get("id"), e)


@router.get("", response_model=List[Lead])
async def list_leads(
    status: Optional[str] = None,
    q: Optional[str] = Query(None, description="Search first/last/email", max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    query: dict = {**agent_filter(current_user)}
    if status:
        query["status"] = status
    if q:
        # Escape regex metacharacters — prior behaviour passed user input
        # straight into MongoDB $regex, exposing the API to ReDoS via patterns
        # like (a+)+$ and to result leakage via PCRE feature abuse.
        safe = re.escape(q.strip())
        query["$or"] = [
            {"first_name": {"$regex": safe, "$options": "i"}},
            {"last_name": {"$regex": safe, "$options": "i"}},
            {"email": {"$regex": safe, "$options": "i"}},
            {"phone": {"$regex": safe, "$options": "i"}},
        ]
    cursor = db.leads.find(query, {"_id": 0}).sort("created_at", -1).limit(500)
    return [Lead(**doc) async for doc in cursor]


@router.get("/{lead_id}", response_model=Lead)
async def get_lead(
    lead_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    # Fetch first, then IDOR-check. Admin/compliance bypass; agents 403 on
    # another agent's lead, 404 on missing.
    doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    doc = _idor_or_403(doc, current_user)
    return Lead(**doc)


# Portal lead status → GHL pipeline stage name. The right-hand strings are
# matched case-insensitively against the stage names in the pipeline
# identified by GHL_PIPELINE_ID. "Won" / "Lost" are GHL's terminal labels.
_STATUS_TO_GHL_STAGE = {
    "new": "New",
    "contacted": "Contacted",
    "qualified": "Qualified",
    "appointment_set": "Appointment Set",
    "enrolled": "Won",
    "not_interested": "Lost",
    "lost": "Lost",
}


# Subset of portal Lead fields we mirror to GHL on PATCH. Notes, mbi_number,
# documents, policies, agent_* are deliberately excluded — they're either
# PHI we don't push or portal-only state.
_LEAD_FIELDS_PUSHED_TO_GHL = (
    "first_name",
    "last_name",
    "email",
    "phone",
    "address_line1",
    "city",
    "state",
    "zip_code",
    "date_of_birth",
    "lead_source",
)


async def _push_lead_update_to_ghl(
    db: AsyncIOMotorDatabase,
    lead_id: str,
    updates: dict,
    request: Request,
    actor_email: Optional[str],
    actor_id: Optional[str],
) -> None:
    """Best-effort outbound: mirror a PATCH onto the GHL contact.

    Never raises. On any error the lead's ``ghl_sync_status`` is flipped
    to ``"error"`` and an audit row is written. Stamps ``ghl_synced_at``
    on success. Status changes also drive a pipeline-stage move when
    ``GHL_PIPELINE_ID`` is configured.
    """
    doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not doc or not doc.get("ghl_contact_id"):
        return
    contact_id = doc["ghl_contact_id"]
    client = GHLClient()
    if client.mock_mode:
        return

    fields = {k: doc.get(k) for k in _LEAD_FIELDS_PUSHED_TO_GHL
              if k in updates and doc.get(k) is not None}

    field_result = None
    if fields:
        field_result = await client.update_contact_fields(contact_id, fields)

    stage_result = None
    if "status" in updates:
        stage_name = _STATUS_TO_GHL_STAGE.get(updates["status"])
        if stage_name:
            stage_result = await client.move_opportunity_stage(
                contact_id, stage_name,
            )

    now_iso = datetime.now(timezone.utc).isoformat()
    # update_contact_fields / move_opportunity_stage return None on failure.
    # If we tried at least one and both failed, mark error; otherwise mark
    # synced. We avoid touching ghl_sync_status when there was nothing to do.
    tried_any = bool(fields) or "status" in updates
    if not tried_any:
        return
    succeeded = (field_result is not None) if fields else True
    succeeded = succeeded and ((stage_result is not None) if "status" in updates and _STATUS_TO_GHL_STAGE.get(updates["status"]) else True)
    await db.leads.update_one(
        {"id": lead_id},
        {"$set": {
            "ghl_synced_at": now_iso,
            "ghl_sync_status": "synced" if succeeded else "error",
        }},
    )
    await write_audit(
        db,
        "ghl_lead_pushed" if succeeded else "ghl_lead_push_failed",
        actor_email=actor_email, actor_id=actor_id,
        target_type="lead", target_id=lead_id,
        request=request,
        metadata={
            "contact_id": contact_id,
            "fields": list(fields.keys()),
            "status_change": updates.get("status"),
        },
    )


@router.patch("/{lead_id}", response_model=Lead)
async def update_lead(
    lead_id: str,
    payload: LeadUpdate,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    # Agents cannot reassign leads — only admins/compliance.
    if current_user.get("role") == "agent" and "agent_assigned_id" in updates:
        raise HTTPException(status_code=403, detail="Agents cannot reassign leads")
    # Phase 2 IDOR check: fetch, then verify ownership before mutating.
    existing = await db.leads.find_one({"id": lead_id}, {"_id": 0, "id": 1, "agent_id": 1})
    _idor_or_403(existing, current_user)
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.leads.update_one({"id": lead_id}, {"$set": updates})
    await write_audit(db, "lead_updated", actor_email=current_user["email"],
                      actor_id=current_user["id"], target_type="lead", target_id=lead_id,
                      request=request, metadata={"fields": list(updates.keys())})

    # Best-effort outbound mirror to GHL. Wrapped so any failure path
    # (network, missing contact id, mock mode) cannot turn a Mongo-success
    # PATCH into a 500.
    try:
        await _push_lead_update_to_ghl(
            db, lead_id, updates, request,
            actor_email=current_user.get("email"),
            actor_id=current_user.get("id"),
        )
    except Exception as e:
        logger.warning("GHL PATCH mirror failed for lead %s: %s", lead_id, e)

    doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    return Lead(**doc)


# ── Agent transfer ────────────────────────────────────────────────────────
# Reassigns a lead from one agent to another. Distinct from the generic
# PATCH endpoint because (a) it has stricter role gating (admin + coach
# only — coach owns load-balancing, agent departures, territory moves),
# (b) it validates the destination is actually an agent rather than an
# admin/coach/CS account, and (c) the audit metadata captures from/to
# agent names so the trail reads like a transfer log instead of a
# generic field-update event.
class LeadTransferRequest(BaseModel):
    new_agent_id: str = Field(..., min_length=1, max_length=128)
    reason: Optional[str] = Field(None, max_length=200)


@router.patch("/{lead_id}/transfer", response_model=Lead)
@limiter.limit("20/hour")
async def transfer_lead(
    lead_id: str,
    request: Request,
    body: LeadTransferRequest = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "coach")),
):
    """Reassign a lead to a different agent. admin + coach only.

    Validates that the destination user exists AND has role == "agent"
    so we never accidentally transfer a lead onto an admin / coach /
    accounting account (those roles read the agency book; they don't
    own individual leads in their personal scope).
    """
    lead = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    new_agent = await db.users.find_one(
        {"id": body.new_agent_id}, {"_id": 0},
    )
    if not new_agent:
        raise HTTPException(
            status_code=422,
            detail="Target agent not found",
        )
    if new_agent.get("role") != "agent":
        raise HTTPException(
            status_code=422,
            detail=(
                "Leads can only be transferred to a user with role "
                "'agent' — destination has role "
                f"'{new_agent.get('role') or 'unknown'}'."
            ),
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    reason = (body.reason or "").strip() or "No reason given"
    old_agent_id = lead.get("agent_id")
    old_agent_name = lead.get("agent_name")
    new_agent_name = (
        new_agent.get("agent_name")
        or new_agent.get("full_name")
        or new_agent.get("email")
    )

    await db.leads.update_one(
        {"id": lead_id},
        {"$set": {
            "agent_id": new_agent["id"],
            "agent_name": new_agent_name,
            "agent_email": (new_agent.get("email") or "").lower() or None,
            "transferred_at": now_iso,
            "transferred_from": old_agent_id,
            "transfer_reason": reason,
            "updated_at": now_iso,
        }},
    )

    await write_audit(
        db, "lead_transferred",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="lead",
        target_id=lead_id,
        request=request,
        metadata={
            "from_agent_id": old_agent_id,
            "from_agent_name": old_agent_name,
            "to_agent_id": new_agent["id"],
            "to_agent_name": new_agent_name,
            "reason": reason,
        },
    )

    fresh = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    return Lead(**fresh)


@router.get("/{lead_id}/pdf")
async def export_lead_pdf(
    lead_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Render the lead's intake record as a downloadable PDF."""
    lead_doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    lead_doc = _idor_or_403(lead_doc, current_user)
    soa_doc = await db.soa_records.find_one({"lead_id": lead_id}, {"_id": 0})

    pdf_bytes = generate_lead_pdf(lead_doc, soa_doc)

    await write_audit(db, "lead_pdf_exported", actor_email=current_user["email"],
                      actor_id=current_user["id"], target_type="lead", target_id=lead_id,
                      request=request)

    name_part = f"{lead_doc.get('first_name','')}_{lead_doc.get('last_name','')}".strip("_")
    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", name_part) or lead_id[:8]
    filename = f"lead_{safe_name}.pdf"

    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{lead_id}/sync-ghl", response_model=Lead)
async def sync_to_ghl(
    lead_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    # Gate access — agents may only sync their own leads. Phase 2 IDOR.
    owned = await db.leads.find_one(
        {"id": lead_id}, {"_id": 0, "id": 1, "agent_id": 1},
    )
    _idor_or_403(owned, current_user)

    try:
        await _sync_lead_to_ghl(db, lead_id, request,
                                actor_email=current_user["email"],
                                actor_id=current_user["id"])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"GHL sync failed: {e}")

    doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    return Lead(**doc)
