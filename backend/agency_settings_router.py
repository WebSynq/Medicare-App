"""Owner-side agency settings + usage view.

Three endpoints, all scoped to the caller's own agency (no path-based
agency_id selection — that would require trusting the URL over the
JWT, which is a footgun we already avoid elsewhere):

  GET   /api/agency/settings  — agency name, slug, tier, seat counts,
                                 billing snapshot
  PATCH /api/agency/settings  — owner can edit display name only;
                                 tier / billing / features are
                                 super-admin-only via super_admin_router
  GET   /api/agency/usage     — current billing-period usage with
                                 plan limits, ready to render as
                                 progress bars

Access
======
- Auth: ``get_current_user`` + ``get_agency`` (gives us the caller's
  agency without trusting any header).
- Role: owner OR admin within the agency (admin here is the agency-
  admin role, not super_admin — both can manage their own tenant).
  super_admin bypasses via the same role gate; the
  ``agency.super_admin=True`` flag implies they're the agency owner
  in the GHW case.
- Cross-agency reads are impossible by construction — we never read
  ``agency_id`` off the path or body, only off ``get_agency``.

Why not just extend ``agency_router.py``?
   That router is the agency *dashboard* (read-only stats + activity
   feed). This file is owner-write surface. Keeping them apart means
   the dashboard's broader role list (compliance/coach/accounting can
   read it) doesn't accidentally widen who can rename the agency.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    get_agency,
    get_current_user,
    get_db,
    write_audit,
)
from metering import current_billing_period
from tiers import TIER_DEFAULTS


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agency", tags=["agency-settings"])
limiter = Limiter(key_func=get_remote_address)


# ── Pydantic bodies ───────────────────────────────────────────────────
class AgencySettingsPatch(BaseModel):
    """Fields an agency owner can change on themselves through the
    Settings → Agency tab.

    Notably absent: ``tier``, ``billing_status``, ``features``,
    ``seats_max``, ``slug``, ``agency_id``, ``super_admin``,
    ``stripe_*``. Those are super-admin-only (managed via the
    super_admin_router) — agency owners can't self-upgrade.
    """
    name: Optional[str] = Field(None, min_length=1, max_length=200)


class AgencyUserPatch(BaseModel):
    """What an agency owner can change about a teammate on their own
    agency. Role is intentionally NOT here — role changes go through
    the existing /agents endpoint (compliance roles only) or the
    super admin console. Owners can only activate / deactivate
    members of their own agency."""
    is_active: bool


# ── Helpers ───────────────────────────────────────────────────────────
def _require_owner_or_admin(user: dict, agency: dict) -> None:
    """Owner OR admin role can edit. super_admin (GHW) also passes."""
    role = (user.get("role") or "").strip().lower()
    if role in {"owner", "admin"}:
        return
    if agency.get("super_admin"):
        return
    raise HTTPException(
        status_code=403,
        detail="Only agency owners and admins can manage agency settings.",
    )


async def _count_active_seats(db, agency_id: str) -> int:
    return await db.users.count_documents({
        "agency_id": agency_id,
        "is_active": True,
        "status": "active",
    })


def _public_agency(agency: dict, seats_active: int) -> Dict[str, Any]:
    """Owner-facing agency shape — NEVER leaks stripe ids, super_admin
    flag, encrypted GHL token, etc. Just the fields the Agency tab
    actually renders."""
    return {
        "agency_id": agency.get("agency_id"),
        "name": agency.get("name"),
        "slug": agency.get("slug"),
        "tier": agency.get("tier"),
        "billing_status": agency.get("billing_status"),
        "trial_ends_at": agency.get("trial_ends_at"),
        "current_period_end": agency.get("current_period_end"),
        "monthly_base_amount_cents": agency.get("monthly_base_amount"),
        "seats_included": agency.get("seats_included"),
        "seats_max": agency.get("seats_max"),
        "seats_active": seats_active,
        "from_name": agency.get("from_name"),
        "from_email": agency.get("from_email"),
        "email_domain": agency.get("email_domain"),
        "email_domain_verified": bool(agency.get("email_domain_verified")),
    }


# ── Endpoints ─────────────────────────────────────────────────────────
@router.get("/settings")
@limiter.limit("120/hour")
async def get_settings(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Return the caller's own agency settings shape.

    Read access is intentionally broader than the patch surface — any
    authenticated user on the agency can view (so an agent's UI can
    show "you're on the Growth plan"). Writes are owner/admin only.
    """
    seats_active = await _count_active_seats(db, agency["agency_id"])
    return _public_agency(agency, seats_active)


@router.patch("/settings")
@limiter.limit("30/hour")
async def patch_settings(
    request: Request,
    body: AgencySettingsPatch = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Owner/admin-only display-name edit.

    Refuses to write empty / whitespace-only names. Returns the
    updated public shape so the SPA can reflect the new name without
    a second GET. Audit-logged.
    """
    _require_owner_or_admin(current_user, agency)

    updates: Dict[str, Any] = {}
    audit_meta: Dict[str, Any] = {}

    if body.name is not None:
        cleaned = body.name.strip()
        if not cleaned:
            raise HTTPException(400, "Name cannot be empty.")
        if cleaned != agency.get("name"):
            updates["name"] = cleaned
            audit_meta["name_changed"] = True
            audit_meta["previous_name"] = agency.get("name")
            audit_meta["new_name"] = cleaned

    if not updates:
        raise HTTPException(400, "No fields supplied.")

    updates["last_active_at"] = datetime.now(timezone.utc).isoformat()
    await db.agencies.update_one(
        {"agency_id": agency["agency_id"]},
        {"$set": updates},
    )
    await write_audit(
        db, "agency_settings_patch",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="agency", target_id=agency["agency_id"],
        request=request,
        metadata=audit_meta,
    )
    refreshed = await db.agencies.find_one(
        {"agency_id": agency["agency_id"]}, {"_id": 0},
    ) or {**agency, **updates}
    seats_active = await _count_active_seats(db, agency["agency_id"])
    return _public_agency(refreshed, seats_active)


@router.get("/usage")
@limiter.limit("120/hour")
async def get_usage(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Current billing-period usage for the caller's own agency.

    Reads from agency_usage_summary when the monthly rollup has
    populated it; otherwise falls back to a live aggregate over
    usage_events for the in-flight period. Identical shape regardless
    so the SPA progress-bar renderer is unchanged.
    """
    agency_id = agency["agency_id"]
    period = current_billing_period()

    summary = await db.agency_usage_summary.find_one(
        {"agency_id": agency_id, "billing_period": period}, {"_id": 0},
    )

    if not summary:
        pipeline = [
            {"$match": {"agency_id": agency_id, "billing_period": period}},
            {
                "$group": {
                    "_id": None,
                    "ai_calls_total": {
                        "$sum": {
                            "$cond": [
                                {"$in": ["$event_type",
                                          ["cna_analysis", "daily_brief",
                                           "security_analysis",
                                           "tag_mapping",
                                           "ai_client_intelligence"]]},
                                1, 0,
                            ]
                        }
                    },
                    "emails_sent": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$event_type", "email_sent"]},
                                "$quantity", 0,
                            ]
                        }
                    },
                    "app_intakes": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$event_type", "app_intake"]},
                                1, 0,
                            ]
                        }
                    },
                    "storage_gb": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$unit", "gb"]},
                                "$quantity", 0,
                            ]
                        }
                    },
                },
            },
        ]
        live = None
        async for row in db.usage_events.aggregate(pipeline):
            live = row
        usage = {
            "ai_calls_total": int((live or {}).get("ai_calls_total", 0)),
            "emails_sent": int((live or {}).get("emails_sent", 0)),
            "app_intakes": int((live or {}).get("app_intakes", 0)),
            "storage_gb": float((live or {}).get("storage_gb", 0.0)),
            "live": True,
        }
    else:
        usage = {
            "ai_calls_total": int(summary.get("ai_calls_total", 0)),
            "emails_sent": int(summary.get("emails_sent", 0)),
            "app_intakes": int(summary.get("app_intakes", 0)),
            "storage_gb": float(summary.get("storage_gb", 0.0)),
            "live": False,
            "total_invoice_usd": summary.get("total_invoice_usd"),
            "total_overage_usd": summary.get("total_overage_usd"),
        }

    seats_active = await _count_active_seats(db, agency_id)

    # Resolve plan limits — prefer the agency's persisted limits dict
    # (recorded at provisioning time) so a tier-default change doesn't
    # retroactively shrink an active agency. Fall back to TIER_DEFAULTS
    # when the limits sub-doc is missing (defensive — modern agencies
    # always have it).
    limits = agency.get("limits") or {}
    if not limits:
        tier = (agency.get("tier") or "foundation").lower()
        tdef = TIER_DEFAULTS.get(tier) or TIER_DEFAULTS["foundation"]
        limits = {
            "seats": tdef["seats_included"],
            "ai_calls_included": tdef["ai_calls_included"],
            "emails_included": tdef["emails_included"],
            "storage_gb_included": tdef["storage_gb_included"],
            "app_intakes_included": tdef["app_intakes_included"],
        }

    return {
        "agency_id": agency_id,
        "billing_period": period,
        "tier": agency.get("tier"),
        "billing_status": agency.get("billing_status"),
        "seats": {
            "active": seats_active,
            "max": agency.get("seats_max"),
            "included": agency.get("seats_included"),
        },
        "limits": limits,
        "usage": usage,
    }


# ── Seat management (owner scope) ─────────────────────────────────────
@router.get("/users")
@limiter.limit("120/hour")
async def list_users_on_agency(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """List every user on the caller's own agency.

    Read access — owner / admin / agent can all see the team roster
    (matches what existing settings UIs expect). Auth-only, no
    role gate beyond "logged-in user on this agency". Sensitive
    fields (hashed_password / mfa_secret / password_history) are
    stripped from the projection so we never round-trip them.
    """
    proj = {
        "_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1,
        "agency_id": 1, "is_active": 1, "status": 1,
        "agent_name": 1, "agent_npn": 1, "created_at": 1,
        "mfa_enabled": 1, "parent_agent_id": 1,
    }
    cursor = db.users.find(
        {"agency_id": agency["agency_id"]}, proj,
    ).sort("created_at", 1)
    rows = [u async for u in cursor]
    return {"users": rows, "total": len(rows)}


@router.patch("/users/{user_id}")
@limiter.limit("60/hour")
async def patch_user_on_agency(
    user_id: str,
    request: Request,
    body: AgencyUserPatch = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Activate or deactivate a teammate on the caller's own agency.

    Owner / admin only. Refuses to operate on:
      - the caller's own row (self-deactivation footgun)
      - users belonging to a different agency (403 — never trust
        a path id in a multi-tenant surface)

    Deactivation bumps ``token_version`` so any in-flight JWTs the
    user holds are invalidated on the next /me check. Audit-logged.
    """
    _require_owner_or_admin(current_user, agency)

    if user_id == current_user.get("id"):
        raise HTTPException(
            400,
            "Refusing to modify your own user record through this "
            "surface. Have another owner do it.",
        )

    target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(404, "User not found.")
    if target.get("agency_id") != agency["agency_id"]:
        # Cross-agency attempt — surface as 404 rather than 403 to
        # avoid leaking existence of users on other tenants.
        raise HTTPException(404, "User not found.")

    updates: Dict[str, Any] = {
        "is_active": bool(body.is_active),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if not body.is_active:
        updates["token_version"] = int(
            target.get("token_version") or 0,
        ) + 1

    await db.users.update_one({"id": user_id}, {"$set": updates})

    await write_audit(
        db, "agency_user_active_changed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="user", target_id=user_id,
        request=request,
        metadata={
            "is_active": bool(body.is_active),
            "agency_id": agency["agency_id"],
        },
    )
    refreshed = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1,
         "is_active": 1, "status": 1, "agency_id": 1},
    )
    return refreshed
