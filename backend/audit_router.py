"""Audit log query endpoint (admin / compliance only)."""
from typing import Optional, List
from fastapi import APIRouter, Depends, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from deps import get_db, require_roles, COMPLIANCE_ROLES


router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
async def list_audit_events(
    event_type: Optional[str] = None,
    actor_email: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    limit: int = Query(200, le=1000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _user=Depends(require_roles(*COMPLIANCE_ROLES)),
):
    q: dict = {}
    if event_type:
        q["event_type"] = event_type
    if actor_email:
        q["actor_email"] = actor_email
    if target_type:
        q["target_type"] = target_type
    if target_id:
        q["target_id"] = target_id
    cursor = db.audit_logs.find(q, {"_id": 0}).sort("timestamp", -1).limit(limit)
    return [doc async for doc in cursor]


@router.get("/summary")
async def audit_summary(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _user=Depends(require_roles(*COMPLIANCE_ROLES)),
):
    pipeline = [
        {"$group": {"_id": "$event_type", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    by_event = [{"event_type": d["_id"], "count": d["count"]} async for d in db.audit_logs.aggregate(pipeline)]
    total = await db.audit_logs.count_documents({})
    return {"total": total, "by_event_type": by_event}
