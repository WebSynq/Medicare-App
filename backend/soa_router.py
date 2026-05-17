"""Scope of Appointment (SOA) e-signature capture."""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from models import SOASignRequest, SOARecord
from deps import get_db, get_current_user, get_optional_user, write_audit, get_client_ip


router = APIRouter(prefix="/soa", tags=["soa"])


@router.post("/sign", response_model=SOARecord, status_code=201)
async def sign_soa(
    payload: SOASignRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: Optional[dict] = Depends(get_optional_user),
):
    if not payload.consent_acknowledged:
        raise HTTPException(status_code=400, detail="Consent must be acknowledged")

    lead = await db.leads.find_one({"id": payload.lead_id}, {"_id": 0, "id": 1})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if not payload.signature_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="Invalid signature format")

    # If an agent is signed in, prefer the agent's stored name over whatever
    # the form sent for agent_name (the client form often leaves it null).
    agent_name = payload.agent_name
    if current_user and not agent_name:
        agent_name = current_user.get("full_name") or current_user.get("email")

    now = datetime.now(timezone.utc).isoformat()
    record = {
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "signature_data_url": payload.signature_data_url,
        "beneficiary_name": payload.beneficiary_name,
        "agent_name": agent_name,
        "plan_types_discussed": payload.plan_types_discussed,
        "ip_address": get_client_ip(request),
        "user_agent": request.headers.get("user-agent"),
        "signed_at": now,
    }
    await db.soa_records.insert_one(record.copy())
    await db.leads.update_one(
        {"id": payload.lead_id},
        {"$set": {"soa_signed": True, "soa_signed_at": now, "updated_at": now}},
    )
    await write_audit(
        db, "soa_signed",
        actor_email=current_user.get("email") if current_user else "anonymous (intake)",
        actor_id=current_user.get("id") if current_user else None,
        target_type="lead", target_id=payload.lead_id,
        request=request,
        metadata={"beneficiary": payload.beneficiary_name,
                  "plan_types": payload.plan_types_discussed},
    )
    return SOARecord(**record)


@router.get("/by-lead/{lead_id}")
async def get_soa_for_lead(
    lead_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    doc = await db.soa_records.find_one({"lead_id": lead_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="No SOA on file")
    return doc
