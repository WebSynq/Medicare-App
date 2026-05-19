"""
clients_router.py
=================
Read-side endpoints for the application-submission persistence layer.

When an agent submits an application via /api/applications/submit, two
Mongo collections are written:
  - clients   : one row per GHL contact (upserted)
  - policies  : one row per submitted application (insert-only history)

This router exposes those records back to the SPA so the client profile
page can show policies on file plus a summary card.
"""
from datetime import datetime, timezone

import logging

from fastapi import APIRouter, Depends

from deps import get_db, get_current_user


logger = logging.getLogger("gruening.clients")

router = APIRouter(prefix="/api/clients", tags=["clients"])


# Display palette for policy product badges. Consumed by the frontend; kept
# here so the canonical mapping is server-side and stays in sync with
# PRODUCT_LABELS in application_router.
PRODUCT_COLORS = {
    "Medicare Supplement": "blue",
    "Medicare Advantage": "purple",
    "Prescription Drug Plan": "teal",
    "Cancer": "rose",
    "Heart/Stroke": "red",
    "Hospital Indemnity": "orange",
    "Recovery Care": "amber",
    "Dental Vision Hearing": "green",
    "Life": "indigo",
    "Annuity": "slate",
    "Medicare": "cyan",
}


def _is_inactive(status: str) -> bool:
    """Return True for statuses that should not count toward active policies."""
    return (status or "").lower() in ("cancelled", "lapsed", "terminated")


@router.get("/{contact_id}/policies")
async def get_client_policies(
    contact_id: str,
    db=Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """All policies on file for a GHL contact, newest first."""
    cursor = (
        db["policies"]
        .find({"ghl_contact_id": contact_id}, {"_id": 0})
        .sort("submitted_at", -1)
    )
    policies = await cursor.to_list(length=100)
    return {
        "contact_id": contact_id,
        "policies": policies,
        "count": len(policies),
    }


@router.get("/{contact_id}/summary")
async def get_client_summary(
    contact_id: str,
    db=Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    """Client record + policy roll-up for the profile header.

    `all_fields` is excluded from the per-policy projection to keep the
    response small — the policies list endpoint is the right place to pull
    full extracted data for a single record.
    """
    client = await db["clients"].find_one(
        {"ghl_contact_id": contact_id}, {"_id": 0}
    )
    cursor = (
        db["policies"]
        .find({"ghl_contact_id": contact_id}, {"_id": 0, "all_fields": 0})
        .sort("submitted_at", -1)
    )
    policies = await cursor.to_list(length=100)

    active_policies = [p for p in policies if not _is_inactive(p.get("policy_status", ""))]

    total_premium = 0.0
    for p in active_policies:
        try:
            total_premium += float(p.get("premium") or 0)
        except (ValueError, TypeError):
            # Non-numeric premium strings (e.g. "—", "tbd") are skipped — they
            # are display artifacts, not real values.
            pass

    return {
        "contact_id": contact_id,
        "client": client,
        "policies": policies,
        "active_count": len(active_policies),
        "total_count": len(policies),
        "total_monthly_premium": round(total_premium, 2),
        "last_activity": policies[0].get("submitted_at") if policies else None,
    }
