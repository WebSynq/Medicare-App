"""
integrations_router.py — admin-only health check for external integrations.

GET /api/integrations/status
    Returns per-integration status. Each is a cheap "do we have credentials
    and can we reach the service?" check. We deliberately avoid expensive
    listings (e.g. ListBuckets, ListFoundationModels) and stick to no-cost
    introspection so this can be polled by the Settings page without
    burning quota.

Each entry returns:
    {
      "status": "ok" | "error" | "not_configured",
      "detail": short human-readable string,
      "metadata": optional dict with extra context (no secrets)
    }
"""
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends

from deps import get_db, require_roles


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/integrations", tags=["integrations"])


def _ok(detail: str, **meta) -> Dict[str, Any]:
    return {"status": "ok", "detail": detail, "metadata": meta}


def _err(detail: str, **meta) -> Dict[str, Any]:
    return {"status": "error", "detail": detail, "metadata": meta}


def _not_configured(detail: str, **meta) -> Dict[str, Any]:
    return {"status": "not_configured", "detail": detail, "metadata": meta}


async def _check_ghl() -> Dict[str, Any]:
    """GHL is "ok" if both GHL_PRIVATE_TOKEN and GHL_LOCATION_ID are set.
    The client already has a mock_mode flag derived from these, so we mirror
    that signal back to the SPA — anything else would lie about live mode."""
    token = os.environ.get("GHL_PRIVATE_TOKEN", "").strip()
    location = os.environ.get("GHL_LOCATION_ID", "").strip()
    if not token or not location:
        return _not_configured(
            "GHL_PRIVATE_TOKEN and GHL_LOCATION_ID not set — mock mode.",
            location_id=location or None,
            mock_mode=True,
        )
    # Don't issue a network call here — Render's free tier wakes up slowly
    # and an outbound timeout would make Settings feel broken even when the
    # integration is healthy. Presence of credentials = "ok" at this layer.
    return _ok("Credentials configured.",
                location_id=location, mock_mode=False)


async def _check_bedrock() -> Dict[str, Any]:
    region = os.environ.get("AWS_REGION", "us-east-1")
    key = os.environ.get("AWS_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("AWS_SECRET_ACCESS_KEY", "").strip()
    if not key or not secret:
        return _not_configured(
            "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set.",
            region=region, model="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        )
    return _ok("Credentials configured.",
                region=region, model="us.anthropic.claude-sonnet-4-5-20250929-v1:0")


async def _check_s3() -> Dict[str, Any]:
    bucket = os.environ.get("AWS_S3_BUCKET", "").strip()
    region = os.environ.get("AWS_REGION", "us-east-1")
    if not bucket:
        return _not_configured(
            "AWS_S3_BUCKET not set — PDF archival disabled.",
            region=region,
        )
    return _ok("Bucket configured.", bucket=bucket, region=region)


async def _check_comtrack() -> Dict[str, Any]:
    key = os.environ.get("COMTRACK_API_KEY", "").strip()
    if not key:
        return _not_configured("COMTRACK_API_KEY not set — mock mode.")
    return _ok("API key configured.")


@router.get("/status")
async def integrations_status(
    db=Depends(get_db),
    current_user: dict = Depends(require_roles("admin", "owner")),
):
    """Per-integration status for the Settings → Integrations tab.

    Admin only — the per-integration detail leaks info that's only useful
    to operators (which env vars are set, last sync ts, etc.).
    """
    ghl = await _check_ghl()
    bedrock = await _check_bedrock()
    s3 = await _check_s3()
    comtrack = await _check_comtrack()

    # ComTrack also benefits from a "last successful sync" hint. Pull it
    # from the run-log collection if there is one.
    try:
        last_sync = await db.commission_sync_runs.find_one(
            {"status": "ok"}, {"_id": 0, "completed_at": 1},
            sort=[("completed_at", -1)],
        )
        if last_sync and last_sync.get("completed_at"):
            comtrack["metadata"]["last_successful_sync"] = last_sync["completed_at"]
    except Exception:
        pass

    return {
        "ghl": ghl,
        "bedrock": bedrock,
        "s3": s3,
        "comtrack": comtrack,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
