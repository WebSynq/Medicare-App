"""Audit log query + export endpoints (admin / compliance only).

⚠️ HIPAA: audit_logs MUST be retained 7 years minimum per
45 CFR 164.312(b). Do NOT add a TTL index to this collection.
"""
import csv
import io
import json as _json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from deps import COMPLIANCE_ROLES, get_db, require_roles, write_audit


router = APIRouter(prefix="/audit", tags=["audit"])


_DATE_FMT = "%Y-%m-%d"


def _parse_date(s: Optional[str], field_name: str) -> Optional[str]:
    """Validate a YYYY-MM-DD string. Returns the original ISO string or
    raises 400. The audit `timestamp` field is stored as an ISO string,
    so we compare string-prefix style — keeps the export portable."""
    if s is None:
        return None
    try:
        datetime.strptime(s, _DATE_FMT)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must be YYYY-MM-DD",
        )
    return s


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


# ── CSV export (Hardening 6) ──────────────────────────────────────────────
@router.get("/export")
async def export_audit_events(
    request: Request,
    start: Optional[str] = Query(None, description="YYYY-MM-DD inclusive"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD inclusive"),
    event_type: Optional[str] = None,
    format: str = Query("csv", pattern="^(csv|json)$"),
    limit: int = Query(10_000, ge=1, le=50_000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    user=Depends(require_roles(*COMPLIANCE_ROLES)),
):
    """Stream audit_logs as CSV (default) or NDJSON. Admin / compliance
    only — same gate as the list endpoint. Hard-capped at 50k rows per
    request so a runaway query can't materialize the whole 7-year
    retention window into memory.

    Never includes payload-shaped metadata — only the canonical audit
    columns (event_type, actor, target, ip, user_agent, session_id,
    timestamp). Compliance reviewers who need richer context use the
    list endpoint.
    """
    start_iso = _parse_date(start, "start")
    end_iso = _parse_date(end, "end")

    q: dict = {}
    if event_type:
        q["event_type"] = event_type
    if start_iso or end_iso:
        ts_clause: dict = {}
        if start_iso:
            ts_clause["$gte"] = start_iso
        if end_iso:
            # Inclusive end-of-day: anything starting with the end date.
            ts_clause["$lt"] = (
                datetime.strptime(end_iso, _DATE_FMT).replace(
                    hour=23, minute=59, second=59,
                ).isoformat() + "Z"
            )
        q["timestamp"] = ts_clause

    cursor = db.audit_logs.find(q, {"_id": 0}).sort("timestamp", -1).limit(limit)

    # Audit the export itself so any compliance reviewer can see who
    # pulled the report — meta only, no row data.
    await write_audit(
        db, "audit_log_exported",
        actor_email=user.get("email"),
        actor_id=user.get("id"),
        request=request,
        metadata={
            "format": format, "limit": limit,
            "start": start_iso, "end": end_iso,
            "event_type": event_type,
        },
    )

    if format == "json":
        async def jgen():
            async for row in cursor:
                # NDJSON — one row per line, easier to grep / stream.
                yield _json.dumps(row, default=str) + "\n"
        filename = f"ghw-audit-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.ndjson"
        return StreamingResponse(
            jgen(),
            media_type="application/x-ndjson",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # CSV path — same canonical columns the compliance team trained on.
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "timestamp", "event_type", "actor_email", "actor_role",
        "target_type", "target_id", "ip_address", "user_agent",
        "session_id",
    ])
    async for row in cursor:
        meta = row.get("metadata") or {}
        writer.writerow([
            row.get("timestamp") or "",
            row.get("event_type") or "",
            row.get("actor_email") or "",
            meta.get("actor_role") or "",
            row.get("target_type") or "",
            row.get("target_id") or "",
            row.get("ip_address") or "",
            row.get("user_agent") or "",
            row.get("session_id") or "",
        ])
    filename = f"ghw-audit-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
