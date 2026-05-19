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
from ghl_client import GHLClient


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
def _signature_secret_configured() -> bool:
    return bool(os.environ.get("GHL_WEBHOOK_SECRET", "").strip())


def _verify_signature(raw_body: bytes, provided: Optional[str]) -> bool:
    """HMAC-SHA256(GHL_WEBHOOK_SECRET, raw_body).

    GHL's signature format isn't perfectly documented across versions, so
    we accept any of:
      - hex digest
      - "sha256=<hex>"
      - "t=<ts>,v1=<hex>"  (Stripe-style; GHL has used this shape too)

    Comparison is constant-time. Returns False on any mismatch / missing
    secret. Callers gate this on ``_signature_secret_configured()`` so
    deployments that haven't set GHL_WEBHOOK_SECRET (e.g. when running
    against GHL Automation workflows, which don't sign payloads) can
    skip verification entirely instead of failing closed.
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


# ── Payload normalisation ─────────────────────────────────────────────────
# GHL has two webhook surfaces with two different payload shapes:
#
#   1. Native webhooks (the public API)  → nested:
#        { "type": "ContactCreate", "locationId": "...",
#          "contact": { "id": "...", "firstName": "...", ... },
#          "opportunity": { "id": "...", ... } }
#
#   2. Automation workflow webhook steps → flat / snake_case:
#        { "contact_id": "...", "location_id": "...",
#          "first_name": "...", "last_name": "...",
#          "opportunity_id": "...", "pipeline_stage_id": "...",
#          ... no "type" key }
#
# Below we detect the flat shape (``contact_id`` at the top level), fold
# it into the nested shape the rest of the router already understands,
# and auto-detect the event type from which fields are present.
_FLAT_CONTACT_KEYS = (
    "first_name", "last_name", "email", "phone",
    "date_of_birth", "address1", "city", "state", "postal_code",
    "tags", "source",
)
_FLAT_OPP_KEYS = (
    "opportunity_id", "opportunity_status",
    "pipeline_id", "pipeline_stage_id",
)


def _is_flat_payload(body: dict) -> bool:
    """Top-level ``contact_id`` is the cheap, reliable tell. Some GHL
    workflow steps also include ``contact`` as a nested object, but the
    flat fields then sit alongside — we still want to normalise so the
    contact id propagates."""
    if not isinstance(body, dict):
        return False
    return "contact_id" in body or "location_id" in body


def _normalize_flat_payload(body: dict) -> dict:
    """Translate a flat GHL automation payload into the nested API shape.

    Returns a *new* dict — callers should use the result. Any keys
    already present in the nested form (e.g. ``contact`` already a
    dict) are preserved and merged with the flat fields.
    """
    if not isinstance(body, dict):
        return body
    nested_contact = body.get("contact") if isinstance(body.get("contact"), dict) else {}
    nested_opp = body.get("opportunity") if isinstance(body.get("opportunity"), dict) else {}

    # Promote each flat field into the nested contact dict if a value is
    # present in the flat form. We don't overwrite values the nested
    # shape already supplied — the nested API source wins on conflict.
    if "contact_id" in body and not nested_contact.get("id"):
        nested_contact["id"] = body.get("contact_id")
    flat_to_nested_contact = {
        "first_name": "firstName",
        "last_name": "lastName",
        "email": "email",
        "phone": "phone",
        "date_of_birth": "dateOfBirth",
        "address1": "address1",
        "city": "city",
        "state": "state",
        "postal_code": "postalCode",
        "source": "source",
    }
    for flat_key, nested_key in flat_to_nested_contact.items():
        if flat_key in body and not nested_contact.get(nested_key):
            nested_contact[nested_key] = body.get(flat_key)
    if "tags" in body and not nested_contact.get("tags"):
        nested_contact["tags"] = body.get("tags") or []

    # Opportunity rollup.
    flat_to_nested_opp = {
        "opportunity_id": "id",
        "opportunity_status": "status",
        "pipeline_id": "pipelineId",
        "pipeline_stage_id": "pipelineStageId",
    }
    for flat_key, nested_key in flat_to_nested_opp.items():
        if flat_key in body and not nested_opp.get(nested_key):
            nested_opp[nested_key] = body.get(flat_key)

    normalised: Dict[str, Any] = dict(body)  # keep any extras
    if nested_contact:
        normalised["contact"] = nested_contact
    if nested_opp:
        normalised["opportunity"] = nested_opp
    if "location_id" in body and not normalised.get("locationId"):
        normalised["locationId"] = body.get("location_id")
    return normalised


def _detect_event_type(body: dict) -> str:
    """When the workflow webhook omits ``type``, infer one from shape.

    Rule:
      - any opportunity-shaped field → OpportunityCreate
      - else                          → ContactCreate
    Update vs. Create can't be distinguished from a single payload; we
    pick the Create variant and let the handlers fall through to
    update-or-create based on existing-record lookup.
    """
    if not isinstance(body, dict):
        return "ContactCreate"
    has_flat_opp = any(body.get(k) for k in _FLAT_OPP_KEYS)
    nested_opp = body.get("opportunity") or {}
    has_nested_opp = isinstance(nested_opp, dict) and (
        nested_opp.get("id") or nested_opp.get("pipelineStageId")
    )
    if has_flat_opp or has_nested_opp:
        return "OpportunityCreate"
    return "ContactCreate"


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

    # Signature verification is optional: when GHL_WEBHOOK_SECRET is set
    # we enforce it strictly; when it isn't, we skip the check (with a
    # warning). GHL Automation workflow steps don't sign their payloads
    # at all, so requiring a signature would lock that surface out.
    if _signature_secret_configured():
        if not _verify_signature(raw, sig):
            # 400 is the one signal we send back — invalid signature is
            # the only thing we want GHL to NOT retry. Everything else
            # returns 200 so legitimate retries don't spiral.
            logger.warning("GHL webhook signature mismatch from %s",
                           get_remote_address(request))
            return JSONResponse({"error": "invalid_signature"}, status_code=400)
    else:
        logger.warning(
            "GHL webhook received without signature verification — "
            "GHL_WEBHOOK_SECRET is not configured. Acceptable for "
            "Automation workflow webhooks, but native webhooks should "
            "set this env var."
        )

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

    # GHL Automation steps send flat snake_case payloads; native webhooks
    # send nested camelCase. Normalise here so the rest of the pipeline
    # only ever sees the nested shape.
    payload_format = "nested"
    if _is_flat_payload(body_dict):
        payload_format = "flat"
        body_dict = _normalize_flat_payload(body_dict)

    # Auto-detect event type when GHL Automation omits it.
    if not (body_dict.get("type") or "").strip():
        body_dict["type"] = _detect_event_type(body_dict)

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
        metadata={**_sanitized_metadata(body_dict), "payload_format": payload_format},
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


# ── Admin: manual contact sync via API pull ───────────────────────────────
@router.post("/sync")
async def sync_contacts(
    request: Request,
    current_user: dict = Depends(require_roles("admin")),
    db=Depends(get_db),
):
    """Pull the current page of GHL contacts and reconcile against our
    leads collection.

    Useful when the workflow webhook has been disabled, when bootstrapping
    a freshly-deployed environment, or when an admin wants to backfill
    after editing the GHL→agent location mapping. Uses the same
    `_find_existing_lead` dedup and the same per-event handlers as the
    inbound webhook so behaviour stays consistent.

    Limits itself to a single page of 100 contacts per call — running it
    again walks past the previous page via the `startAfterId` cursor.
    Mock mode (no `GHL_PRIVATE_TOKEN` configured) returns 0/0/0 so the
    UI doesn't error in dev.
    """
    client = GHLClient()
    if client.mock_mode:
        return {
            "synced": 0,
            "created": 0,
            "updated": 0,
            "note": "GHL is in mock mode — set GHL_PRIVATE_TOKEN to enable.",
        }

    try:
        contacts = await client.list_contacts(limit=100)
    except Exception as e:
        logger.exception("GHL list_contacts failed during manual sync: %s", e)
        await write_audit(
            db, "ghl_manual_sync_failed",
            actor_email=current_user.get("email"),
            actor_id=current_user.get("id"),
            request=request,
            metadata={"error_type": type(e).__name__},
        )
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail="GHL upstream error")

    created = 0
    updated = 0
    skipped = 0
    location_id = os.environ.get("GHL_LOCATION_ID", "") or None

    for raw in contacts:
        if not isinstance(raw, dict):
            continue
        # Reuse the webhook payload model so the sync path and the
        # webhook path can't drift.
        payload = GHLWebhookPayload(
            type="ContactCreate",
            locationId=raw.get("locationId") or location_id,
            contact=GHLContact(**{
                k: raw.get(k) for k in (
                    "id", "firstName", "lastName", "phone", "email",
                    "tags", "customFields", "source", "dateOfBirth",
                    "address1", "city", "state", "postalCode",
                ) if k in raw
            }),
        )
        existing = await _find_existing_lead(db, payload.contact or GHLContact())
        try:
            if existing:
                res = await _handle_contact_update(db, payload, request)
                if res.get("action") == "updated":
                    updated += 1
                else:
                    skipped += 1
            else:
                res = await _handle_contact_create(db, payload, request)
                if res.get("action") == "created":
                    created += 1
                else:
                    skipped += 1
        except Exception as e:
            # One bad contact shouldn't tank the whole batch.
            logger.warning("Sync per-contact failed: %s", e)
            skipped += 1

    synced = created + updated
    await write_audit(
        db, "ghl_manual_sync",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={
            "location_id": location_id,
            "fetched": len(contacts),
            "created": created,
            "updated": updated,
            "skipped": skipped,
        },
    )
    return {
        "synced": synced,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "fetched": len(contacts),
    }
