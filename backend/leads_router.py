"""Lead CRUD + GHL sync."""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from models import Lead, LeadCreate, LeadUpdate
from deps import get_db, get_current_user, write_audit
from ghl_client import GHLClient


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leads", tags=["leads"])


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
        await db.leads.update_one(
            {"id": lead_id},
            {"$set": {"ghl_sync_status": "error", "ghl_sync_error": str(e)[:500],
                      "updated_at": datetime.now(timezone.utc).isoformat()}},
        )
        await write_audit(db, "ghl_sync_failed", actor_email=actor_email,
                          actor_id=actor_id, target_type="lead", target_id=lead_id,
                          request=request, metadata={"error": str(e)[:200]})
        raise


@router.post("", response_model=Lead, status_code=201)
async def create_lead(
    payload: LeadCreate,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Public intake endpoint — beneficiaries can submit without auth."""
    lead = Lead(**payload.model_dump())
    doc = lead.model_dump()
    await db.leads.insert_one(doc.copy())
    await write_audit(db, "lead_created", actor_email=lead.email,
                      target_type="lead", target_id=lead.id, request=request,
                      metadata={"source": "public_intake"})

    # Auto-sync to GHL. Failures must not block the intake response — the helper
    # has already persisted ghl_sync_status="error" + the audit event by the time
    # we get here.
    try:
        await _sync_lead_to_ghl(db, lead.id, request,
                                actor_email=lead.email, actor_id=None)
    except Exception as e:
        logger.warning("Auto GHL sync failed for lead %s: %s", lead.id, e)

    fresh = await db.leads.find_one({"id": lead.id}, {"_id": 0})
    return Lead(**fresh)


@router.get("", response_model=List[Lead])
async def list_leads(
    status: Optional[str] = None,
    q: Optional[str] = Query(None, description="Search first/last/email"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    query: dict = {}
    if status:
        query["status"] = status
    if q:
        query["$or"] = [
            {"first_name": {"$regex": q, "$options": "i"}},
            {"last_name": {"$regex": q, "$options": "i"}},
            {"email": {"$regex": q, "$options": "i"}},
            {"phone": {"$regex": q, "$options": "i"}},
        ]
    cursor = db.leads.find(query, {"_id": 0}).sort("created_at", -1).limit(500)
    return [Lead(**doc) async for doc in cursor]


@router.get("/{lead_id}", response_model=Lead)
async def get_lead(
    lead_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Lead not found")
    return Lead(**doc)


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
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await db.leads.update_one({"id": lead_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Lead not found")
    await write_audit(db, "lead_updated", actor_email=current_user["email"],
                      actor_id=current_user["id"], target_type="lead", target_id=lead_id,
                      request=request, metadata={"fields": list(updates.keys())})
    doc = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    return Lead(**doc)


@router.post("/{lead_id}/sync-ghl", response_model=Lead)
async def sync_to_ghl(
    lead_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
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
