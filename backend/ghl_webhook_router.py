"""GoHighLevel inbound webhook bridge.

Scope: GHW's own GHL sub-account today; built so the same handler scales
to N tenant sub-accounts later — each agent carries its own
``ghl_location_id`` and inbound payloads route to the matching agent.

Security model
--------------
* No auth dependency — GHL calls this externally.
* The router verifies a HMAC-SHA256 signature against the
  ``GHL_WEBHOOK_SECRET`` env var; failure → 400.
* Rate-limited per source IP at 200/min.
* The endpoint must **never** raise — GHL retries indefinitely on
  non-2xx, so any internal error is swallowed, audit-logged, and
  returned as 200.
* PHI handling: payloads are audit-logged by *shape* only — field
  names and the location id, never raw field values.
"""
import hmac
import hashlib
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import get_db, require_roles, write_audit


logger = logging.getLogger("gruening.ghl.webhook")
router = APIRouter(prefix="/ghl", tags=["ghl-webhook"])

# slowapi default IP-keyed limiter. server.py installs a global limiter
# on the app; this local one wires the per-route decorator only.
limiter = Limiter(key_func=get_remote_address)


# ── Payload shapes (loosely-typed; GHL adds fields over time) ─────────────
class GHLContact(BaseModel):
    id: Optional[str] = None
    firstName: Optional[str] = None
    lastName: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    tags: List[Any] = Field(default_factory=list)
    customFields: List[Any] = Field(default_factory=list)
    source: Optional[str] = None
    dateOfBirth: Optional[str] = None
    address1: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    postalCode: Optional[str] = None


class GHLOpportunity(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    status: Optional[str] = None
    pipelineId: Optional[str] = None
    pipelineStageId: Optional[str] = None


class GHLWebhookPayload(BaseModel):
    type: Optional[str] = None
    locationId: Optional[str] = None
    contact: Optional[GHLContact] = None
    opportunity: Optional[GHLOpportunity] = None


SUPPORTED_EVENTS = [
    "ContactCreate",
    "ContactUpdate",
    "OpportunityCreate",
    "OpportunityUpdate",
]


# ── Signature verification ────────────────────────────────────────────────
def _verify_signature(raw_body: bytes, provided: Optional[str]) -> bool:
    """HMAC-SHA256(GHL_WEBHOOK_SECRET, raw_body).

    GHL's signature format isn't perfectly documented across versions, so
    we accept any of:
      - hex digest
      - "sha256=<hex>"
      - "t=<ts>,v1=<hex>"  (Stripe-style; GHL has used this shape too)

    Comparison is constant-time. Returns False on any mismatch / missing
    secret. If the secret env var is unset we fail closed.
    """
    secret = os.environ.get("GHL_WEBHOOK_SECRET", "").strip()
    if not secret or not provided:
        return False
    digest = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    candidates = [provided.strip().lower()]
    if "=" in provided:
        for part in provided.split(","):
            kv = part.strip().split("=", 1)
            if len(kv) == 2:
                candidates.append(kv[1].strip().lower())
    for c in candidates:
        if c and hmac.compare_digest(c, digest):
            return True
    return False


def _sanitized_metadata(payload_dict: dict) -> dict:
    """Extract non-PHI shape data for the audit log.

    We record event type, location, and which contact/opportunity field
    names were present — never values. This satisfies "log every inbound
    payload" while keeping MBI/DOB/email/etc. out of the audit table.
    """
    contact = payload_dict.get("contact") or {}
    opp = payload_dict.get("opportunity") or {}
    return {
        "event_type": payload_dict.get("type"),
        "location_id": payload_dict.get("locationId"),
        "contact_field_names": sorted(contact.keys()) if isinstance(contact, dict) else [],
        "opportunity_field_names": sorted(opp.keys()) if isinstance(opp, dict) else [],
        "ghl_contact_id": contact.get("id") if isinstance(contact, dict) else None,
        "ghl_opportunity_id": opp.get("id") if isinstance(opp, dict) else None,
    }


# ── Agent routing ─────────────────────────────────────────────────────────
async def _agent_for_location(db, location_id: Optional[str]) -> Optional[dict]:
    """Find the user whose ``ghl_location_id`` matches the inbound event.

    Falls back to the first admin when no match exists — so leads still
    land somewhere actionable while sub-account mappings are being set
    up. Returns the user doc or None if the users collection is empty.
    """
    if location_id:
        u = await db.users.find_one({"ghl_location_id": location_id}, {"_id": 0})
        if u:
            return u
    return await db.users.find_one({"role": "admin"}, {"_id": 0})


# ── Lead build helpers ────────────────────────────────────────────────────
def _lead_fields_from_contact(contact: GHLContact) -> Dict[str, Any]:
    """Map GHL contact shape onto our lead schema."""
    return {
        "first_name": (contact.firstName or "").strip(),
        "last_name": (contact.lastName or "").strip(),
        "email": (contact.email or "").strip().lower() or None,
        "phone": (contact.phone or "").strip() or None,
        "date_of_birth": (contact.dateOfBirth or "").strip() or None,
        "address_line1": (contact.address1 or "").strip() or None,
        "city": (contact.city or "").strip() or None,
        "state": (contact.state or "").strip() or None,
        "zip_code": (contact.postalCode or "").strip() or None,
    }


async def _find_existing_lead(db, contact: GHLContact) -> Optional[dict]:
    """Dedup by GHL contact id first, then email, then phone."""
    if contact.id:
        existing = await db.leads.find_one(
            {"ghl_contact_id": contact.id}, {"_id": 0},
        )
        if existing:
            return existing
    email = (contact.email or "").strip().lower()
    if email:
        existing = await db.leads.find_one({"email": email}, {"_id": 0})
        if existing:
            return existing
    phone = (contact.phone or "").strip()
    if phone:
        existing = await db.leads.find_one({"phone": phone}, {"_id": 0})
        if existing:
            return existing
    return None


# ── Handlers per event type ───────────────────────────────────────────────
async def _handle_contact_create(
    db, payload: GHLWebhookPayload, request: Request,
) -> Dict[str, Any]:
    contact = payload.contact or GHLContact()
    existing = await _find_existing_lead(db, contact)
    if existing:
        return {"action": "skipped_duplicate", "lead_id": existing.get("id")}

    agent = await _agent_for_location(db, payload.locationId)
    now = datetime.now(timezone.utc).isoformat()
    lead_id = str(uuid.uuid4())
    lead = {
        "id": lead_id,
        "status": "new",
        "soa_signed": False,
        "soa_signed_at": None,
        "document_ids": [],
        # Phase-2 scoping triple from the matched agent (or admin fallback).
        "agent_id": (agent or {}).get("id"),
        "agent_email": ((agent or {}).get("email") or "").lower() or None,
        "agent_name": (agent or {}).get("agent_name")
                       or (agent or {}).get("full_name"),
        "agent_assigned_id": (agent or {}).get("id"),
        # GHL provenance
        "ghl_contact_id": contact.id,
        "ghl_location_id": payload.locationId,
        "ghl_sync_status": "synced",
        "ghl_synced_at": now,
        "lead_source": contact.source or "GHL",
        "tags": [t for t in (contact.tags or []) if isinstance(t, str)],
        # Inbound provenance — distinguishes webhook-created leads from
        # the SPA intake / manual create flows for analytics + audit.
        "created_via": "ghl_webhook",
        "created_at": now,
        "updated_at": now,
        **_lead_fields_from_contact(contact),
    }
    await db.leads.insert_one(lead.copy())
    await write_audit(
        db, "ghl_lead_created",
        actor_email=None,
        actor_id=None,
        target_type="lead", target_id=lead_id,
        request=request,
        metadata={
            "ghl_contact_id": contact.id,
            "location_id": payload.locationId,
            "agent_id": (agent or {}).get("id"),
        },
    )
    return {"action": "created", "lead_id": lead_id}


async def _handle_contact_update(
    db, payload: GHLWebhookPayload, request: Request,
) -> Dict[str, Any]:
    contact = payload.contact or GHLContact()
    existing = await _find_existing_lead(db, contact)
    if not existing:
        # Treat as a create — GHL's update event sometimes races the create
        # webhook for the same contact, and we'd rather have a row than not.
        return await _handle_contact_create(db, payload, request)

    updates = {k: v for k, v in _lead_fields_from_contact(contact).items() if v}
    if contact.id and not existing.get("ghl_contact_id"):
        updates["ghl_contact_id"] = contact.id
    if payload.locationId and not existing.get("ghl_location_id"):
        updates["ghl_location_id"] = payload.locationId
    if contact.tags:
        merged_tags = list({*(existing.get("tags") or []),
                            *(t for t in contact.tags if isinstance(t, str))})
        updates["tags"] = merged_tags
    if not updates:
        return {"action": "no_changes", "lead_id": existing["id"]}
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.leads.update_one({"id": existing["id"]}, {"$set": updates})
    await write_audit(
        db, "ghl_lead_updated",
        actor_email=None, actor_id=None,
        target_type="lead", target_id=existing["id"],
        request=request,
        metadata={
            "ghl_contact_id": contact.id,
            "location_id": payload.locationId,
            "fields": list(updates.keys()),
        },
    )
    return {"action": "updated", "lead_id": existing["id"]}


async def _handle_opportunity_event(
    db, payload: GHLWebhookPayload, request: Request,
) -> Dict[str, Any]:
    contact = payload.contact or GHLContact()
    opp = payload.opportunity or GHLOpportunity()
    if not contact.id:
        return {"action": "skipped_no_contact_id"}
    lead = await db.leads.find_one({"ghl_contact_id": contact.id}, {"_id": 0})
    if not lead:
        return {"action": "skipped_lead_not_found"}
    now = datetime.now(timezone.utc).isoformat()
    updates = {
        "opportunity_id": opp.id,
        "opportunity_status": opp.status,
        "pipeline_id": opp.pipelineId,
        "pipeline_stage": opp.pipelineStageId,
        "updated_at": now,
    }
    # Drop None values so we don't overwrite real data with blanks when
    # GHL only sends a partial update.
    updates = {k: v for k, v in updates.items() if v is not None or k == "updated_at"}
    await db.leads.update_one({"id": lead["id"]}, {"$set": updates})
    await write_audit(
        db, "ghl_opportunity_updated",
        actor_email=None, actor_id=None,
        target_type="lead", target_id=lead["id"],
        request=request,
        metadata={
            "event_type": payload.type,
            "ghl_contact_id": contact.id,
            "opportunity_id": opp.id,
            "stage": opp.pipelineStageId,
        },
    )
    return {"action": "opportunity_updated", "lead_id": lead["id"]}


# ── Webhook entrypoint ────────────────────────────────────────────────────
@router.post("/webhook")
@limiter.limit("200/minute")
async def ghl_webhook(request: Request, db=Depends(get_db)):
    """Inbound GHL event sink. Always 200 — GHL retries on non-2xx."""
    raw = await request.body()
    sig = (
        request.headers.get("x-ghl-signature")
        or request.headers.get("x-hub-signature-256")
        or request.headers.get("x-signature")
        or ""
    )

    if not _verify_signature(raw, sig):
        # 400 is the one signal we send back — invalid signature is the
        # only thing we want GHL to NOT retry. Everything else returns
        # 200 so legitimate retries don't spiral.
        logger.warning("GHL webhook signature mismatch from %s",
                       get_remote_address(request))
        return JSONResponse({"error": "invalid_signature"}, status_code=400)

    # Parse / validate. Wrap everything from this point onward in a broad
    # try so an unexpected payload shape still returns 200.
    try:
        body_dict = json.loads(raw) if raw else {}
    except Exception:
        await write_audit(
            db, "ghl_webhook_unparseable",
            request=request,
            metadata={"bytes": len(raw)},
        )
        return JSONResponse({"ok": True, "note": "unparseable"}, status_code=200)

    try:
        payload = GHLWebhookPayload(**body_dict)
    except Exception as e:
        logger.warning("GHL webhook validation failed: %s", e)
        await write_audit(
            db, "ghl_webhook_invalid_shape",
            request=request,
            metadata={"location_id": body_dict.get("locationId")},
        )
        return JSONResponse({"ok": True, "note": "invalid_shape"}, status_code=200)

    await write_audit(
        db, "ghl_webhook_received",
        request=request,
        metadata=_sanitized_metadata(body_dict),
    )

    try:
        etype = (payload.type or "").strip()
        if etype == "ContactCreate":
            result = await _handle_contact_create(db, payload, request)
        elif etype == "ContactUpdate":
            result = await _handle_contact_update(db, payload, request)
        elif etype in ("OpportunityCreate", "OpportunityUpdate"):
            result = await _handle_opportunity_event(db, payload, request)
        else:
            await write_audit(
                db, "ghl_webhook_unknown_type",
                request=request,
                metadata={"event_type": etype,
                          "location_id": payload.locationId},
            )
            return JSONResponse({"ok": True, "note": "unknown_type"}, status_code=200)
    except Exception as e:
        logger.exception("GHL webhook handler crashed: %s", e)
        await write_audit(
            db, "ghl_webhook_handler_error",
            request=request,
            metadata={
                "event_type": payload.type,
                "location_id": payload.locationId,
                "error_type": type(e).__name__,
            },
        )
        # Still 200 — handler bugs should not summon infinite retries.
        return JSONResponse({"ok": True, "note": "handled_with_error"}, status_code=200)

    return JSONResponse({"ok": True, **result}, status_code=200)


# ── Admin: config probe ───────────────────────────────────────────────────
@router.get("/webhook/config")
async def webhook_config(
    request: Request,
    _admin: dict = Depends(require_roles("admin")),
    db=Depends(get_db),
):
    """Returns the URL to paste into GHL and stats on inbound traffic.

    The webhook URL is built from the inbound request's own scheme +
    host so it matches whatever public hostname the API is reachable
    on (Render, custom domain, etc.) without needing a separate env
    var. ``location_id`` echoes the GHL_LOCATION_ID env var so the
    admin can confirm the sub-account being targeted.
    """
    base = str(request.base_url).rstrip("/")
    webhook_url = f"{base}/api/ghl/webhook"

    last = await db.audit_logs.find_one(
        {"event_type": "ghl_webhook_received"},
        sort=[("timestamp", -1)],
    )
    last_received = (last or {}).get("timestamp") if last else None

    leads_received = await db.leads.count_documents({"created_via": "ghl_webhook"})

    return {
        "webhook_url": webhook_url,
        "supported_events": SUPPORTED_EVENTS,
        "location_id": os.environ.get("GHL_LOCATION_ID", "") or None,
        "secret_configured": bool(os.environ.get("GHL_WEBHOOK_SECRET", "").strip()),
        "last_received_at": last_received,
        "leads_received_total": leads_received,
    }
