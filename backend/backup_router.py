"""
backup_router.py
================
Admin-facing backup endpoints. Manual trigger + history view.

The actual upload logic lives in ``backup_service`` so the scheduled
job and the manual ``/api/backup/run`` button share code.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, Request

from deps import get_current_user, get_db, require_roles, write_audit
from backup_service import run_backup


logger = logging.getLogger("gruening.backup")
router = APIRouter(prefix="/backup", tags=["backup"])


@router.post("/run")
async def run_backup_now(
    request: Request,
    current_user: dict = Depends(require_roles("admin")),
    db=Depends(get_db),
) -> Dict[str, Any]:
    """Trigger a manual backup right now. Returns the same shape the
    scheduled job records — success/error + key/size on success."""
    result = await run_backup(db)
    event = "backup_completed" if result.get("success") else "backup_failed"
    await write_audit(
        db, event,
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="backup",
        target_id=result.get("s3_key") or "",
        request=request,
        metadata=result,
    )
    return result


@router.get("/history")
async def backup_history(
    _admin: dict = Depends(require_roles("admin")),
    db=Depends(get_db),
):
    """Last 30 backup audit log entries (both successes and failures).
    Used by the Settings → Agency → Database Backups card."""
    cursor = (
        db.audit_logs.find(
            {"event_type": {"$in": ["backup_completed", "backup_failed"]}},
            {"_id": 0, "event_type": 1, "timestamp": 1, "metadata": 1,
             "target_id": 1, "actor_email": 1},
        )
        .sort("timestamp", -1)
        .limit(30)
    )
    rows = []
    async for e in cursor:
        md = e.get("metadata") or {}
        rows.append({
            "timestamp": e.get("timestamp"),
            "event_type": e.get("event_type"),
            "success": e.get("event_type") == "backup_completed",
            "size_bytes": md.get("size_bytes"),
            "s3_key": md.get("s3_key") or e.get("target_id") or "",
            "collections_backed_up": md.get("collections_backed_up"),
            "retention_deleted": md.get("retention_deleted"),
            "error": md.get("error"),
            "actor_email": e.get("actor_email") or "(scheduled)",
        })
    return {"items": rows, "count": len(rows)}
