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

from deps import get_db, get_current_user, agent_filter


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
    """All policies on file, newest first.

    Accepts either a GHL contact id (legacy callers) or a portal lead
    id in the URL — we look up the lead by id first, then union-query
    policies by `lead_id == X` OR `ghl_contact_id == lead.ghl_contact_id`
    so older policies (which only have ghl_contact_id) still surface
    when the frontend hits this endpoint with a portal lead id.

    Phase 2 scoping: agents see only policies they submitted; admin /
    compliance see everything. The agent_filter helper returns an empty
    dict for privileged roles so the existing query is unaffected for
    them.
    """
    scope = agent_filter(current_user)

    # Try the URL segment as a portal lead id first. If it matches a
    # lead row, also union in the contact id stored on that lead so
    # pre-Phase-2 policies (with only ghl_contact_id stamped) surface.
    lead = await db.leads.find_one({"id": contact_id}, {"_id": 0, "id": 1, "ghl_contact_id": 1})
    if lead:
        or_terms = [{"lead_id": lead["id"]}]
        if lead.get("ghl_contact_id"):
            or_terms.append({"ghl_contact_id": lead["ghl_contact_id"]})
        match: dict = {"$or": or_terms, **scope}
    else:
        # Treat the URL segment as a GHL contact id (legacy path).
        match = {"ghl_contact_id": contact_id, **scope}

    cursor = (
        db["policies"]
        .find(match, {"_id": 0})
        .sort("submitted_at", -1)
    )
    policies = await cursor.to_list(length=200)
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
    query = {"ghl_contact_id": contact_id, **agent_filter(current_user)}
    cursor = (
        db["policies"]
        .find(query, {"_id": 0, "all_fields": 0})
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
