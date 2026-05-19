"""
production_records_router.py
============================
Admin-only endpoints for importing GHW production
tracker data into the production_records collection.
Supports preview-before-commit flow with full rollback.
"""
import logging
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import (APIRouter, Depends, File, HTTPException,
                     UploadFile)
from pydantic import BaseModel

from deps import get_db, write_audit
from auth_router import get_current_user

from import_parser import parse_production_file


logger = logging.getLogger("gruening.import")
router = APIRouter(prefix="/api/admin/import",
                   tags=["data-import"])

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
ALLOWED_EXTENSIONS = {".xlsx", ".xls", ".csv"}


def _require_admin(current_user=Depends(get_current_user)):
    if current_user.get("role") != "admin":
        raise HTTPException(403, "Admin role required")
    return current_user


# In-memory preview cache. Keyed by batch_id (UUID) and consumed exactly once
# by /commit. Process-local — acceptable for the single-admin flow per spec.
# On a Render redeploy or worker restart between preview and commit, the
# admin re-uploads the file (no data loss; preview is idempotent).
_preview_cache: Dict[str, Dict[str, Any]] = {}


@router.post("/preview")
async def preview_import(
    file: UploadFile = File(...),
    current_user: dict = Depends(_require_admin),
    db=Depends(get_db),
):
    """Step 1 — upload file, parse and preview. No DB writes.

    Returns a summary plus sample rows for admin review. Calling /commit
    with the returned batch_id is what actually persists records.
    """
    ext = "." + (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            400, f"File type not allowed. Use: {ALLOWED_EXTENSIONS}")

    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(413, "File exceeds 10MB limit")

    parsed = parse_production_file(contents, file.filename)
    rows: List[Dict] = parsed["rows"]
    errors: List[Dict] = parsed["errors"]
    agents: Dict[str, str] = parsed["agents"]

    # Check for duplicates against records already on file (both fields —
    # legacy import_production.py uses natural_key, the new path uses
    # dedup_key, and we write both with the same value so either lookup
    # works regardless of which import created the row).
    existing_keys: set = set()
    if rows:
        dedup_keys = [r["dedup_key"] for r in rows]
        cursor = db["production_records"].find(
            {"$or": [
                {"dedup_key": {"$in": dedup_keys}},
                {"natural_key": {"$in": dedup_keys}},
            ]},
            {"dedup_key": 1, "natural_key": 1, "_id": 0},
        )
        async for doc in cursor:
            existing_keys.add(doc.get("dedup_key") or doc.get("natural_key"))

    new_rows = [r for r in rows if r["dedup_key"] not in existing_keys]
    dupe_rows = [r for r in rows if r["dedup_key"] in existing_keys]

    # Check which agents exist in users collection
    agent_emails = list(agents.keys())
    matched_agents: Dict[str, Dict[str, str]] = {}
    unmatched_agents: Dict[str, str] = {}
    if agent_emails:
        cursor = db["users"].find(
            {"email": {"$in": agent_emails}},
            {"email": 1, "id": 1, "full_name": 1, "_id": 0},
        )
        async for user in cursor:
            matched_agents[user["email"]] = {
                "id": user.get("id", ""),
                "full_name": user.get("full_name", ""),
            }
    for email, name in agents.items():
        if email not in matched_agents:
            unmatched_agents[email] = name

    # Cache the parsed rows for the commit step
    batch_id = str(uuid.uuid4())
    _preview_cache[batch_id] = {
        "rows": new_rows,
        "filename": file.filename,
        "agent_match": matched_agents,
        "parsed_at": datetime.now(timezone.utc).isoformat(),
        "imported_by": current_user.get("email"),
    }

    # Sample rows for display (first 10 valid new rows)
    sample = []
    for r in new_rows[:10]:
        sample.append({
            "agent": r["agent_name"],
            "client": r["client_name"],
            "carrier": r["carrier"],
            "product_type": r["product_type"],
            "premium": r["monthly_premium"],
            "revenue": r["revenue_expected"],
            "app_date": r["app_date"],
        })

    product_counts = Counter(
        r["product_type"] for r in new_rows if r["product_type"])

    return {
        "batch_id": batch_id,
        "filename": file.filename,
        "summary": {
            "total_raw_rows": parsed["total_raw"],
            "rows_parsed": len(rows),
            "rows_valid_new": len(new_rows),
            "rows_duplicate": len(dupe_rows),
            "rows_error": len(errors),
        },
        "agents": {
            "matched": [
                {"email": e, "name": agents.get(e, ""), "id": v["id"]}
                for e, v in matched_agents.items()
            ],
            "unmatched": [
                {"email": e, "name": n}
                for e, n in unmatched_agents.items()
            ],
        },
        "product_breakdown": dict(product_counts),
        "sample_rows": sample,
        "errors": errors[:20],
    }


class CommitRequest(BaseModel):
    batch_id: str
    confirm: bool = False


@router.post("/commit")
async def commit_import(
    payload: CommitRequest,
    current_user: dict = Depends(_require_admin),
    db=Depends(get_db),
):
    """Step 2 — commit the previewed batch. Requires confirm=true."""
    if not payload.confirm:
        raise HTTPException(400, "Must set confirm=true")

    cached = _preview_cache.get(payload.batch_id)
    if not cached:
        raise HTTPException(
            404,
            "Preview batch not found or expired. Re-upload the file.",
        )

    rows = cached["rows"]
    if not rows:
        raise HTTPException(400, "No valid rows to import")

    agent_match = cached.get("agent_match", {})

    now = datetime.now(timezone.utc).isoformat()
    batch_id = payload.batch_id
    inserted = 0
    skipped = 0

    # Insert in batches of 100. Each doc also stamps `natural_key = dedup_key`
    # so the pre-existing unique index on `natural_key` (added before this
    # module — see server.py startup hooks) is satisfied for every row.
    # Without that, the second insert in a batch would collide on null.
    batch_size = 100
    for i in range(0, len(rows), batch_size):
        chunk = rows[i:i + batch_size]
        docs = []
        for r in chunk:
            email = r["agent_email"]
            agent_info = agent_match.get(email, {})
            doc = {
                **r,
                "natural_key": r["dedup_key"],
                "agent_id": agent_info.get("id", ""),
                "agent_matched": bool(agent_info),
                "import_batch_id": batch_id,
                "imported_at": now,
                "imported_by": current_user.get("email"),
                "status": "pending",
                "revenue_received": None,
            }
            docs.append(doc)

        if docs:
            try:
                result = await db["production_records"].insert_many(
                    docs, ordered=False)
                inserted += len(result.inserted_ids)
            except Exception as e:
                # Bulk write errors carry partial success counts. Pull them
                # off the details dict where available; otherwise log and
                # treat the whole chunk as skipped so the API call doesn't
                # mis-report success.
                if hasattr(e, "details"):
                    n_ok = e.details.get("nInserted", 0)
                    inserted += n_ok
                    skipped += len(docs) - n_ok
                else:
                    logger.warning("Batch insert error: %s", e)
                    skipped += len(docs)

    # Deduplicate the unmatched-agents list before saving
    unmatched_unique: List[Dict[str, str]] = []
    seen: set = set()
    for r in rows:
        email = r["agent_email"]
        if agent_match.get(email):
            continue
        if email in seen:
            continue
        seen.add(email)
        unmatched_unique.append({
            "email": email,
            "name": r["agent_name"],
        })

    await db["import_batches"].insert_one({
        "batch_id": batch_id,
        "filename": cached["filename"],
        "imported_by": current_user.get("email"),
        "imported_at": now,
        "records_inserted": inserted,
        "records_skipped": skipped,
        "agents_matched": len(agent_match),
        "agents_unmatched": unmatched_unique,
    })

    await write_audit(
        db, "production_data_imported",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        metadata={
            "batch_id": batch_id,
            "filename": cached["filename"],
            "inserted": inserted,
            "skipped": skipped,
        },
    )

    _preview_cache.pop(batch_id, None)

    logger.info("Import committed: batch=%s inserted=%d skipped=%d",
                batch_id, inserted, skipped)

    return {
        "success": True,
        "batch_id": batch_id,
        "records_inserted": inserted,
        "records_skipped": skipped,
        "agents_unmatched": unmatched_unique,
    }


@router.get("/history")
async def import_history(
    current_user: dict = Depends(_require_admin),
    db=Depends(get_db),
):
    """List all past import batches (newest first, capped at 50)."""
    cursor = (
        db["import_batches"]
        .find({}, {"_id": 0})
        .sort("imported_at", -1)
        .limit(50)
    )
    batches = await cursor.to_list(length=50)
    return {"batches": batches}


@router.delete("/{batch_id}")
async def rollback_import(
    batch_id: str,
    current_user: dict = Depends(_require_admin),
    db=Depends(get_db),
):
    """Roll back an import batch — hard-deletes all records from it."""
    result = await db["production_records"].delete_many(
        {"import_batch_id": batch_id})
    await db["import_batches"].update_one(
        {"batch_id": batch_id},
        {"$set": {
            "rolled_back": True,
            "rolled_back_at": datetime.now(timezone.utc).isoformat(),
            "rolled_back_by": current_user.get("email"),
        }},
    )
    await write_audit(
        db, "production_import_rolled_back",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        metadata={"batch_id": batch_id,
                   "deleted": result.deleted_count},
    )
    return {
        "success": True,
        "batch_id": batch_id,
        "records_deleted": result.deleted_count,
    }
