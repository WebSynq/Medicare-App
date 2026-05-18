"""
commissions_router.py
---------------------
Commission tracking endpoints. All Comtrack API calls happen server-side.
COMTRACK_API_KEY is never exposed to the browser.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from motor.motor_asyncio import AsyncIOMotorDatabase

from comtrack_client import ComtrackClient
from deps import get_client_ip, get_current_user, get_db, write_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/commissions", tags=["commissions"])

# Live-endpoint cache + rate-limit configuration
_LIVE_CACHE_TTL = timedelta(hours=1)
_LIVE_RATE_LIMIT = 20            # requests per window per user
_LIVE_RATE_WINDOW = timedelta(hours=1)

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


# ── GET /api/commissions/live ────────────────────────────────────────────────
# Live ComTrack pull, cached, rate-limited, audited.
#
# Hard rules baked in (do not relax):
# - agent_name is read from the authenticated user's DB row only.
#   Request body, query, headers, and JWT claims are all rejected as sources.
#   This prevents IDOR via tampered tokens or query params.
# - COMTRACK_API_KEY is read by ComtrackClient from os.environ only.
# - Upstream errors are logged server-side and replaced with a 503 + generic
#   message to the client (no leaked upstream response bodies).
# - Every access (cache hit or upstream call) writes an audit log entry.

def _matches_filters(row: dict, carrier: Optional[str], date: Optional[str]) -> bool:
    if carrier:
        if (row.get("carrier") or "").strip().lower() != carrier.strip().lower():
            return False
    if date:
        if (row.get("statement_date") or "").strip() != date.strip():
            return False
    return True


async def _check_user_rate_limit(db: AsyncIOMotorDatabase, user_id: str) -> None:
    """Reject if user has hit the per-user-per-hour budget.

    Stored in commission_rate_limits with a TTL index that auto-expires
    entries after the window. Each call is one document; counts are derived
    by counting documents in the window.
    """
    now = datetime.now(timezone.utc)
    window_start = now - _LIVE_RATE_WINDOW
    count = await db.commission_rate_limits.count_documents({
        "user_id": user_id,
        "called_at": {"$gte": window_start},
    })
    if count >= _LIVE_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded ({_LIVE_RATE_LIMIT}/hour). "
                   "Please wait before retrying.",
        )
    await db.commission_rate_limits.insert_one({
        "user_id": user_id,
        "called_at": now,
        # expires_at drives the TTL index — see startup index creation in server.py
        "expires_at": now + _LIVE_RATE_WINDOW,
    })


async def _get_cached(db: AsyncIOMotorDatabase, user_id: str) -> Optional[dict]:
    """Return cached commission payload for this user if still fresh."""
    now = datetime.now(timezone.utc)
    doc = await db.commission_cache.find_one(
        {"user_id": user_id, "expires_at": {"$gt": now}},
        {"_id": 0},
    )
    return doc


async def _set_cached(db: AsyncIOMotorDatabase, user_id: str, agent_name: str,
                       rows: list[dict]) -> None:
    now = datetime.now(timezone.utc)
    await db.commission_cache.update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id": user_id,
            "agent_name": agent_name,
            "rows": rows,
            "cached_at": now,
            "expires_at": now + _LIVE_CACHE_TTL,
        }},
        upsert=True,
    )


@router.get("/live")
async def get_live_commissions(
    request: Request,
    carrier: Optional[str] = Query(None, max_length=64,
                                    description="Optional carrier filter"),
    date: Optional[str] = Query(None, max_length=16,
                                 description="Optional statement_date filter (MM/DD/YYYY)"),
    refresh: bool = Query(False, description="Bypass the 1h cache"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Live ComTrack commission rows for the authenticated agent.

    agent_name is sourced from the user's DB row only. Optional carrier/date
    narrow the result set for that agent — they cannot widen access to
    another agent's data.
    """
    # 1. Resolve agent identity from the DB (re-fetch, don't trust JWT claims).
    fresh = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not fresh:
        # Token references a user that no longer exists.
        raise HTTPException(status_code=401, detail="User not found")
    agent_name = (fresh.get("agent_name") or "").strip()
    if not agent_name:
        raise HTTPException(
            status_code=400,
            detail="Agent name not configured. Contact your administrator.",
        )

    user_id = fresh["id"]
    ip = get_client_ip(request)

    # 2. Per-user rate limit (refresh requests count too).
    await _check_user_rate_limit(db, user_id)

    # 3. Cache lookup unless explicitly bypassed.
    cache_hit = False
    if not refresh:
        cached = await _get_cached(db, user_id)
        if cached:
            cache_hit = True
            rows = cached.get("rows", [])
        else:
            rows = None
    else:
        rows = None

    # 4. Live pull on miss / refresh.
    if rows is None:
        client = ComtrackClient()
        try:
            rows = await client.get_rows(agent_name)
        except (httpx.HTTPStatusError, httpx.RequestError) as exc:
            # Log full upstream detail; never expose it to the client.
            logger.error("ComTrack live pull failed for user %s: %s", user_id, exc)
            await write_audit(
                db=db, event_type="commission_data_access",
                actor_email=fresh.get("email"), actor_id=user_id,
                target_type="commission_data", target_id=agent_name,
                request=request,
                metadata={
                    "agent_name": agent_name,
                    "carrier_filter": carrier,
                    "date_filter": date,
                    "cache_hit": False,
                    "status": "error",
                },
            )
            raise HTTPException(
                status_code=503,
                detail="Commission data temporarily unavailable",
            )
        await _set_cached(db, user_id, agent_name, rows)

    # 5. Apply post-query filters (carrier, date) for the authenticated agent.
    if carrier or date:
        rows = [r for r in rows if _matches_filters(r, carrier, date)]

    # 6. Audit log every access (cache hit included).
    await write_audit(
        db=db, event_type="commission_data_access",
        actor_email=fresh.get("email"), actor_id=user_id,
        target_type="commission_data", target_id=agent_name,
        request=request,
        metadata={
            "agent_name": agent_name,
            "ip_address": ip,
            "carrier_filter": carrier,
            "date_filter": date,
            "cache_hit": cache_hit,
            "status": "success",
            "row_count": len(rows),
        },
    )

    return {
        "rows": rows,
        "total": len(rows),
        "cache_hit": cache_hit,
        "agent_name": agent_name,
    }
