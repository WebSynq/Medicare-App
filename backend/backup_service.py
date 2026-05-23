"""
backup_service.py
=================
Nightly Mongo → S3 backup.

Dumps a fixed list of collections to a single gzipped JSON blob and
uploads it to ``s3://{AWS_S3_BUCKET}/backups/{YYYY}/{MM}/{DD}/...``.
Retention: 90 days; older objects under the ``backups/`` prefix are
deleted on every successful run.

The ``users`` collection projection explicitly excludes
``hashed_password`` so a backup leak never exposes credentials.

Designed to never raise — every failure is audit-logged and returned
in the result dict so callers (scheduler + manual /api/backup/run)
can react without breaking the app.
"""
from __future__ import annotations

import asyncio
import gzip
import io
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import boto3


logger = logging.getLogger("gruening.backup")


# Collections included in every nightly backup. Each entry is the
# collection name + a projection (or None for "everything except _id").
BACKUP_COLLECTIONS: List[Dict[str, Any]] = [
    # users — exclude hashed_password explicitly so a leaked backup
    # can never be used to derive credentials offline.
    {"name": "users", "projection": {
        "_id": 0, "hashed_password": 0,
    }},
    {"name": "leads", "projection": {"_id": 0}},
    {"name": "policies", "projection": {"_id": 0}},
    {"name": "soa_records", "projection": {"_id": 0}},
    # documents = metadata only. The actual encrypted files live in
    # local secure_storage or S3 — those are out of scope for this
    # logical-data backup.
    {"name": "documents", "projection": {"_id": 0}},
    {"name": "production_records", "projection": {"_id": 0}},
    {"name": "audit_logs", "projection": {"_id": 0}},
    {"name": "commission_syncs", "projection": {"_id": 0}},
    {"name": "agency_settings", "projection": {"_id": 0}},
    {"name": "invite_tokens", "projection": {"_id": 0}},
    {"name": "clients", "projection": {"_id": 0}},
    {"name": "import_batches", "projection": {"_id": 0}},
]


AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
S3_BUCKET = os.environ.get("AWS_S3_BUCKET", "")
BACKUP_RETENTION_DAYS = 90


def _get_s3_client():
    return boto3.client(
        service_name="s3",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def _json_default(obj):
    if isinstance(obj, (datetime, )):
        return obj.isoformat()
    return str(obj)


async def _dump_collection(db, name: str, projection: Optional[dict]) -> List[dict]:
    """Read every doc in a collection into a Python list. Cap-limited
    only by RAM — for the volumes GHW operates at (≤low millions of
    rows total) this is fine. If we outgrow it, swap to a streaming
    multipart upload."""
    out: List[dict] = []
    proj = projection or {"_id": 0}
    cursor = db[name].find({}, proj)
    async for doc in cursor:
        out.append(doc)
    return out


async def _enforce_retention(s3, bucket: str) -> int:
    """Delete S3 objects under ``backups/`` older than 90 days. Returns
    the number of keys deleted."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=BACKUP_RETENTION_DAYS)
    deleted = 0

    def _list_and_delete():
        nonlocal deleted
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix="backups/"):
            for obj in page.get("Contents", []) or []:
                last_mod = obj.get("LastModified")
                if not last_mod:
                    continue
                # boto returns tz-aware UTC; normalise just in case.
                if last_mod.tzinfo is None:
                    last_mod = last_mod.replace(tzinfo=timezone.utc)
                if last_mod < cutoff:
                    s3.delete_object(Bucket=bucket, Key=obj["Key"])
                    deleted += 1

    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _list_and_delete)
    except Exception as e:
        logger.warning("backup retention sweep failed: %s", e)
    return deleted


async def run_backup(db) -> Dict[str, Any]:
    """Run a full backup. Never raises — every error path returns a
    structured ``{"success": False, "error": ...}`` so callers can
    audit-log cleanly.

    Returns on success::
        {"success": True, "size_bytes": int, "s3_key": str,
         "collections_backed_up": int, "retention_deleted": int}
    """
    if not S3_BUCKET:
        return {"success": False, "error": "AWS_S3_BUCKET not configured"}
    now = datetime.now(timezone.utc)
    payload: Dict[str, Any] = {
        "backup_date": now.isoformat(),
        "schema_version": 1,
        "collections": {},
    }
    backed_up = 0
    try:
        for spec in BACKUP_COLLECTIONS:
            rows = await _dump_collection(db, spec["name"], spec.get("projection"))
            payload["collections"][spec["name"]] = rows
            backed_up += 1
    except Exception as e:
        logger.exception("backup collection dump failed: %s", e)
        return {"success": False, "error": f"dump_failed:{type(e).__name__}"}

    # Belt-and-suspenders: even if the projection were ever misconfigured,
    # never let hashed_password slip into the dump.
    for u in payload["collections"].get("users", []):
        u.pop("hashed_password", None)

    try:
        raw = json.dumps(payload, default=_json_default, separators=(",", ":")).encode("utf-8")
    except Exception as e:
        logger.exception("backup serialise failed: %s", e)
        return {"success": False, "error": f"serialise_failed:{type(e).__name__}"}

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
        gz.write(raw)
    body = buf.getvalue()
    size = len(body)

    key = (
        f"backups/{now.strftime('%Y')}/{now.strftime('%m')}/{now.strftime('%d')}/"
        f"ghw_backup_{now.strftime('%Y-%m-%d_%H%M%S')}.json.gz"
    )

    def _upload():
        s3 = _get_s3_client()
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType="application/gzip",
            ContentEncoding="gzip",
            ServerSideEncryption="AES256",
            Metadata={
                "ghw-backup-date": now.strftime("%Y-%m-%d"),
                "ghw-collection-count": str(backed_up),
            },
        )
        return s3

    try:
        loop = asyncio.get_event_loop()
        s3 = await loop.run_in_executor(None, _upload)
    except Exception as e:
        logger.exception("backup upload failed: %s", e)
        return {"success": False, "error": f"upload_failed:{type(e).__name__}"}

    retention_deleted = await _enforce_retention(s3, S3_BUCKET)

    return {
        "success": True,
        "size_bytes": size,
        "s3_key": key,
        "collections_backed_up": backed_up,
        "retention_deleted": retention_deleted,
    }


# ── APScheduler entry point ──────────────────────────────────────────────
def start_backup_scheduler(get_db_fn):
    """Add the 02:00 UTC daily backup job to a fresh AsyncIOScheduler.

    Returns the scheduler (so server.py can stash it on app.state for
    cleanup at shutdown). Gated by the ``DISABLE_SCHEDULER`` env var
    so pytest can disable background timers cleanly — matches the
    pattern used by comtrack_sync.start_scheduler.
    """
    if os.environ.get("DISABLE_SCHEDULER") == "1":
        logger.info("backup_scheduler: disabled via DISABLE_SCHEDULER")
        return None
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger

    sched = AsyncIOScheduler(timezone="UTC")

    async def _job():
        from deps import write_audit
        db = get_db_fn()
        try:
            result = await run_backup(db)
        except Exception as e:
            logger.exception("scheduled backup crashed: %s", e)
            result = {"success": False, "error": f"crash:{type(e).__name__}"}
        try:
            await write_audit(
                db,
                "backup_completed" if result.get("success") else "backup_failed",
                target_type="backup",
                target_id=result.get("s3_key") or "",
                metadata=result,
            )
        except Exception as e:
            logger.warning("backup audit-log write failed: %s", e)

    sched.add_job(_job, CronTrigger(hour=2, minute=0))
    sched.start()
    logger.info("backup_scheduler: scheduled daily at 02:00 UTC")
    return sched
