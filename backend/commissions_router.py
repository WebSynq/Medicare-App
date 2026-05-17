"""
commissions_router.py
---------------------
Commission tracking endpoints. All Comtrack API calls happen server-side.
COMTRACK_API_KEY is never exposed to the browser.
"""

import logging
from datetime import datetime, timezone
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from motor.motor_asyncio import AsyncIOMotorDatabase

from comtrack_client import ComtrackClient
from deps import get_current_user, get_db, write_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/commissions", tags=["commissions"])

# Accepted MIME types + extensions for carrier statements
_ALLOWED_MIME = {
    "application/pdf",
    "text/csv",
    "text/plain",
    "text/x-csv",
    "application/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
}
_ALLOWED_EXT = {"pdf", "csv", "xlsx", "xls", "txt"}
_MAX_BYTES = 15 * 1024 * 1024  # 15 MB — matches documents_router


def _ext(filename: str) -> str:
    """Return lowercase file extension without the dot."""
    return (filename or "").rsplit(".", 1)[-1].lower()


# ── POST /api/commissions/upload ──────────────────────────────────────────────

@router.post("/upload")
async def upload_statement(
    file: UploadFile = File(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """
    Upload a carrier commission statement.
    File is proxied server-side to Comtrack /api/digest.
    Result is stored in commission_syncs collection and returned to the caller.
    """
    ct = (file.content_type or "").lower().split(";")[0].strip()
    ext = _ext(file.filename or "")

    if ct not in _ALLOWED_MIME and ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ct or ext}'. Accepted: PDF, CSV, XLSX, TXT.",
        )

    content = await file.read()

    if len(content) == 0:
        raise HTTPException(status_code=400, detail="File is empty.")

    if len(content) > _MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the 15 MB limit ({len(content) // 1_048_576} MB received).",
        )

    client = ComtrackClient()
    comtrack_result: dict = {}

    try:
        comtrack_result = await client.digest_file(
            file_content=content,
            filename=file.filename or "statement",
            content_type=ct or "application/octet-stream",
        )
    except httpx.HTTPStatusError as exc:
        logger.error("Comtrack digest HTTP error: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="Comtrack returned an error processing your file. Try again shortly.",
        )
    except httpx.RequestError as exc:
        logger.error("Comtrack digest connection error: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="Could not reach Comtrack. Check your connection and try again.",
        )

    # Persist upload record
    agent_name = (current_user.get("full_name") or "").strip() or current_user.get("email", "unknown")
    sync_doc = {
        "id": str(uuid4()),
        "agent_id": current_user["id"],
        "agent_name": agent_name,
        "comtrack_file_id": comtrack_result.get("file", {}).get("id", ""),
        "filename": file.filename or "statement",
        "status": comtrack_result.get("status", "unknown"),
        "mock": comtrack_result.get("mock", False),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.commission_syncs.insert_one({k: v for k, v in sync_doc.items()})

    await write_audit(
        db=db,
        event_type="commission_upload",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="commission_sync",
        target_id=sync_doc["id"],
        metadata={
            "filename": sync_doc["filename"],
            "status": sync_doc["status"],
            "comtrack_file_id": sync_doc["comtrack_file_id"],
            "mock": sync_doc["mock"],
        },
    )

    return {
        "id": sync_doc["id"],
        "status": sync_doc["status"],
        "filename": sync_doc["filename"],
        "comtrack_file_id": sync_doc["comtrack_file_id"],
        "mock": sync_doc["mock"],
        "uploaded_at": sync_doc["uploaded_at"],
    }


# ── GET /api/commissions/summary ─────────────────────────────────────────────

@router.get("/summary")
async def get_commission_summary(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """
    Return aggregated commission stats for the current agent.
    Queries Comtrack /api/reference by agent full_name.
    """
    agent_name = (current_user.get("full_name") or "").strip() or current_user.get("email", "")
    client = ComtrackClient()

    try:
        summary = await client.get_summary(agent_name)
    except (httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.error("Comtrack summary error for agent '%s': %s", agent_name, exc)
        raise HTTPException(
            status_code=502,
            detail="Could not retrieve commission data. Try again shortly.",
        )

    await write_audit(
        db=db,
        event_type="commission_summary_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user["id"],
        target_type="commission_summary",
        target_id=current_user["id"],
        metadata={"agent_name": agent_name, "mock": summary.get("mock", False)},
    )

    return summary


# ── GET /api/commissions/history ─────────────────────────────────────────────

@router.get("/history")
async def get_upload_history(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """
    Return the current agent's past statement upload records.
    Admin/compliance roles see all uploads.
    """
    role = current_user.get("role", "agent")

    # Admins and compliance see everything; agents see only their own
    query: dict = {}
    if role == "agent":
        query = {"agent_id": current_user["id"]}

    cursor = (
        db.commission_syncs.find(query, {"_id": 0})
        .sort("uploaded_at", -1)
        .limit(100)
    )

    records = await cursor.to_list(length=100)

    return {"uploads": records, "total": len(records)}
