"""Super Admin console — platform-wide tenant management.

Endpoint surface (all gated on deps.require_super_admin):
  GET    /api/super-admin/agencies
  GET    /api/super-admin/agencies/{agency_id}
  PATCH  /api/super-admin/agencies/{agency_id}
  GET    /api/super-admin/agencies/{agency_id}/usage
  GET    /api/super-admin/users
  PATCH  /api/super-admin/users/{user_id}
  GET    /api/super-admin/system            — platform-wide health snapshot

Hard rules
==========
- Every endpoint requires require_super_admin(). No role escape hatches.
- Every state-changing call writes a row to audit_logs with the
  acting super admin's email + the target agency/user id.
- super_admin flag itself is NEVER toggled via this API — that is
  done by setting agency.super_admin=True at the DB level (or via the
  SUPER_ADMIN_EMAILS env). Surfacing the toggle here would let a
  compromised super_admin elevate other tenants.
- Feature flag writes pass through tiers.sanitise_features so unknown
  keys are dropped silently.
- Tier changes recompute the agency's limits + overage_rates from
  TIER_DEFAULTS so a downgrade from Domination → Foundation actually
  shrinks the included AI calls / emails / etc.
"""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from agency_models import AgencyLimits, AgencyOverageRates
from deps import (
    get_current_user,
    get_db,
    require_super_admin,
    write_audit,
)
from metering import current_billing_period
from tiers import (
    FEATURE_REGISTRY,
    TIER_DEFAULTS,
    TIER_KEYS,
    is_valid_feature,
    is_valid_tier,
    sanitise_features,
    tier_features,
    tier_limits,
    tier_overage_rates,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/super-admin", tags=["super-admin"])
limiter = Limiter(key_func=get_remote_address)


# ── Pydantic bodies ───────────────────────────────────────────────────
class AgencyPatchRequest(BaseModel):
    """Anything a super admin is allowed to change on an agency record
    through the console. Fields are all optional; only supplied fields
    are written. Unknown features are silently dropped.

    Notably absent: ``super_admin``, ``agency_id``, ``slug``,
    ``stripe_*``. Those are immutable through this surface.
    """
    name: Optional[str] = Field(None, max_length=200)
    tier: Optional[Literal["beta", "foundation", "growth", "domination"]] = None
    notes: Optional[str] = Field(None, max_length=4000)
    billing_status: Optional[Literal[
        "trialing", "active", "past_due", "suspended", "cancelled",
    ]] = None
    seats_max: Optional[int] = Field(None, ge=-1, le=10_000)
    features: Optional[Dict[str, bool]] = None
    apply_tier_defaults: bool = Field(
        False,
        description=(
            "When true alongside a tier change, recompute features + "
            "limits + overage_rates from TIER_DEFAULTS. When false the "
            "tier value changes but feature flags / limits stay where "
            "they are — useful for promo overrides."
        ),
    )


class UserPatchRequest(BaseModel):
    role: Optional[Literal[
        "admin", "owner", "agent", "compliance",
        "va", "support", "crm_specialist",
        "cyber_security", "sales_manager", "onboarding",
        "client_success", "coach", "accounting",
    ]] = None
    is_active: Optional[bool] = None
    status: Optional[Literal["pending", "active", "rejected"]] = None
    agency_id: Optional[str] = Field(
        None, max_length=128,
        description=(
            "Move a user to a different agency. Use with care — "
            "audit-log entries from before the move stay attributed "
            "to the old tenant."
        ),
    )


# ── Helpers ───────────────────────────────────────────────────────────
def _public_agency(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Strip Mongo internals + collect the response shape the SPA wants."""
    if not doc:
        return {}
    out = {k: v for k, v in doc.items() if k != "_id"}
    # Don't ship the encrypted GHL token across the wire — only the
    # presence of an integration matters at this surface.
    if "ghl_token_encrypted" in out:
        out["ghl_token_encrypted"] = bool(out["ghl_token_encrypted"])
    return out


def _public_user(doc: Dict[str, Any]) -> Dict[str, Any]:
    if not doc:
        return {}
    out = {k: v for k, v in doc.items()
           if k not in ("_id", "hashed_password", "password_history",
                         "mfa_secret")}
    return out


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _count_active_seats(db, agency_id: str) -> int:
    """Live count of active users on an agency — the agency.seats_active
    counter is a hint; we recompute on demand for the console."""
    return await db.users.count_documents({
        "agency_id": agency_id,
        "is_active": True,
        "status": "active",
    })


# ── Agencies: list + read + patch ─────────────────────────────────────
@router.get("/agencies")
@limiter.limit("120/hour")
async def list_agencies(
    request: Request,
    tier: Optional[str] = Query(None,
                                  description="Filter by tier"),
    billing_status: Optional[str] = Query(None),
    q: Optional[str] = Query(None, max_length=120,
                              description="Substring on name / slug"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _agency=Depends(require_super_admin()),
):
    """Paginated agency list. No pagination cursor yet because the
    expected scale is hundreds, not millions — we cap at 500 results
    so a misuse can't OOM the worker.
    """
    query: Dict[str, Any] = {"deleted_at": {"$in": [None]}}
    if tier:
        if not is_valid_tier(tier):
            raise HTTPException(400, f"Unknown tier '{tier}'.")
        query["tier"] = tier
    if billing_status:
        query["billing_status"] = billing_status
    if q:
        # Case-insensitive substring on name OR slug.
        import re
        rx = re.compile(re.escape(q), re.IGNORECASE)
        query["$or"] = [{"name": rx}, {"slug": rx}]

    cursor = db.agencies.find(query, {"_id": 0}).sort(
        "created_at", -1,
    ).limit(500)
    rows: List[Dict[str, Any]] = []
    async for doc in cursor:
        # Compute live seat count so the table reflects reality even
        # if the cached agency.seats_active drifted.
        doc["seats_active_live"] = await _count_active_seats(
            db, doc.get("agency_id"),
        )
        rows.append(_public_agency(doc))
    return {"agencies": rows, "total": len(rows)}


@router.get("/agencies/{agency_id}")
@limiter.limit("120/hour")
async def get_agency_detail(
    agency_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _agency=Depends(require_super_admin()),
):
    doc = await db.agencies.find_one({"agency_id": agency_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Agency not found.")
    doc["seats_active_live"] = await _count_active_seats(db, agency_id)
    return _public_agency(doc)


@router.patch("/agencies/{agency_id}")
@limiter.limit("60/hour")
async def patch_agency(
    agency_id: str,
    request: Request,
    body: AgencyPatchRequest = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    _agency=Depends(require_super_admin()),
):
    """Update an agency. Tier + features can change in the same call.

    Tier change behavior:
      - apply_tier_defaults=True → features, limits, overage_rates,
        monthly_base_amount, seats_included, seats_max all overwritten
        from TIER_DEFAULTS[tier]. The current agency.features dict is
        wiped. Use this on a "Reset to plan" button in the SPA.
      - apply_tier_defaults=False → only ``tier`` is written. Features
        and limits stay where they are. Useful for promo grants
        ("Foundation plan, but with CNA enabled").

    Feature dict passthrough is sanitised — unknown keys dropped.
    """
    existing = await db.agencies.find_one({"agency_id": agency_id})
    if not existing:
        raise HTTPException(404, "Agency not found.")

    updates: Dict[str, Any] = {"last_active_at": _now_iso()}
    audit_meta: Dict[str, Any] = {}

    if body.name is not None:
        updates["name"] = body.name.strip()
        audit_meta["name_changed"] = True
    if body.notes is not None:
        updates["notes"] = body.notes
        audit_meta["notes_changed"] = True
    if body.billing_status is not None:
        updates["billing_status"] = body.billing_status
        audit_meta["billing_status"] = body.billing_status
    if body.seats_max is not None:
        updates["seats_max"] = int(body.seats_max)
        audit_meta["seats_max"] = body.seats_max
    if body.tier is not None:
        if not is_valid_tier(body.tier):
            raise HTTPException(400, f"Unknown tier '{body.tier}'.")
        updates["tier"] = body.tier
        audit_meta["tier"] = body.tier
        if body.apply_tier_defaults:
            tdef = TIER_DEFAULTS[body.tier]
            updates["features"] = tier_features(body.tier)
            updates["limits"] = AgencyLimits(
                **tier_limits(body.tier),
            ).model_dump()
            updates["overage_rates"] = AgencyOverageRates(
                **tier_overage_rates(body.tier),
            ).model_dump()
            updates["monthly_base_amount"] = tdef["monthly_base_cents"]
            updates["seats_included"] = tdef["seats_included"]
            if "seats_max" not in updates:
                updates["seats_max"] = tdef["seats_max"]
            audit_meta["applied_tier_defaults"] = True

    if body.features is not None:
        # When the caller passes a partial features map (the toggle UI
        # only sends the diff), merge onto the current persisted dict
        # so unspecified keys stay where they were.
        merged = dict(existing.get("features") or {})
        merged.update(body.features)
        updates["features"] = sanitise_features(merged)
        audit_meta["features_changed"] = sorted(
            k for k in (body.features or {}).keys()
        )

    if len(updates) == 1:   # only the last_active_at marker
        raise HTTPException(400, "No fields supplied.")

    await db.agencies.update_one(
        {"agency_id": agency_id}, {"$set": updates},
    )
    await write_audit(
        db, "super_admin_agency_patch",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="agency", target_id=agency_id,
        request=request,
        metadata=audit_meta,
    )
    refreshed = await db.agencies.find_one(
        {"agency_id": agency_id}, {"_id": 0},
    )
    return _public_agency(refreshed)


# ── Agency usage summary ──────────────────────────────────────────────
@router.get("/agencies/{agency_id}/usage")
@limiter.limit("120/hour")
async def get_agency_usage(
    agency_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _agency=Depends(require_super_admin()),
):
    """Per-agency usage for the current billing period.

    Reads from agency_usage_summary when the monthly rollup has
    already populated it; falls back to a live aggregate over
    usage_events for the current (in-flight) period. Lets the SPA
    show "this month so far" even before the 1st-of-next-month
    rollup runs.
    """
    agency = await db.agencies.find_one(
        {"agency_id": agency_id},
        {"_id": 0, "limits": 1, "tier": 1, "seats_included": 1,
         "seats_max": 1, "name": 1, "billing_status": 1},
    )
    if not agency:
        raise HTTPException(404, "Agency not found.")

    period = current_billing_period()
    summary = await db.agency_usage_summary.find_one(
        {"agency_id": agency_id, "billing_period": period}, {"_id": 0},
    )

    if not summary:
        # Live aggregation — the rollup job hasn't run yet for the
        # current period. Same shape as the persisted summary so the
        # SPA only has one renderer.
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
        summary = {
            "agency_id": agency_id,
            "billing_period": period,
            "live": True,
            "ai_calls_total": int((live or {}).get("ai_calls_total", 0)),
            "emails_sent": int((live or {}).get("emails_sent", 0)),
            "app_intakes": int((live or {}).get("app_intakes", 0)),
            "storage_gb": float((live or {}).get("storage_gb", 0.0)),
        }
    else:
        summary["live"] = False

    seats_active = await _count_active_seats(db, agency_id)
    return {
        "agency": {
            "agency_id": agency_id,
            "name": agency.get("name"),
            "tier": agency.get("tier"),
            "billing_status": agency.get("billing_status"),
            "seats_included": agency.get("seats_included"),
            "seats_max": agency.get("seats_max"),
            "seats_active": seats_active,
        },
        "limits": agency.get("limits") or {},
        "usage": summary,
        "billing_period": period,
    }


# ── Users: list + patch ───────────────────────────────────────────────
@router.get("/users")
@limiter.limit("120/hour")
async def list_users(
    request: Request,
    agency_id: Optional[str] = Query(None, max_length=128),
    role: Optional[str] = Query(None, max_length=40),
    q: Optional[str] = Query(None, max_length=120),
    db: AsyncIOMotorDatabase = Depends(get_db),
    _agency=Depends(require_super_admin()),
):
    """Cross-agency user list. Capped at 500 rows — pagination cursor
    can come later if we ever push past a few thousand users."""
    query: Dict[str, Any] = {}
    if agency_id:
        query["agency_id"] = agency_id
    if role:
        query["role"] = role
    if q:
        import re
        rx = re.compile(re.escape(q), re.IGNORECASE)
        query["$or"] = [{"email": rx}, {"full_name": rx},
                         {"agent_name": rx}]
    proj = {
        "_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1,
        "agency_id": 1, "is_active": 1, "status": 1,
        "agent_name": 1, "created_at": 1, "mfa_enabled": 1,
        "last_failed_at": 1, "locked_until": 1, "parent_agent_id": 1,
    }
    cursor = db.users.find(query, proj).sort("created_at", -1).limit(500)
    rows = [u async for u in cursor]
    return {"users": rows, "total": len(rows)}


@router.patch("/users/{user_id}")
@limiter.limit("60/hour")
async def patch_user(
    user_id: str,
    request: Request,
    body: UserPatchRequest = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    _agency=Depends(require_super_admin()),
):
    """Change a user's role / activation / agency assignment.

    Refuses to operate on the calling super admin themselves (no
    self-demotion through this surface — guards against a confused
    click). Cleaning that up requires a direct DB write.
    """
    if user_id == current_user.get("id"):
        raise HTTPException(
            400,
            "Refusing to modify your own user record through the "
            "super admin surface. Use the DB directly if you need to "
            "demote yourself.",
        )
    existing = await db.users.find_one({"id": user_id})
    if not existing:
        raise HTTPException(404, "User not found.")

    updates: Dict[str, Any] = {}
    audit_meta: Dict[str, Any] = {}
    if body.role is not None:
        updates["role"] = body.role
        audit_meta["role"] = body.role
    if body.is_active is not None:
        updates["is_active"] = bool(body.is_active)
        audit_meta["is_active"] = bool(body.is_active)
        if not body.is_active:
            # Bumping token_version invalidates every JWT this user
            # has out — same trick as the password-change path. A
            # deactivated user shouldn't keep their session alive on
            # the next /me check.
            updates["token_version"] = int(
                existing.get("token_version") or 0,
            ) + 1
    if body.status is not None:
        updates["status"] = body.status
        audit_meta["status"] = body.status
    if body.agency_id is not None:
        # Sanity check the target agency exists before we move them.
        agency_doc = await db.agencies.find_one(
            {"agency_id": body.agency_id}, {"_id": 0, "agency_id": 1},
        )
        if not agency_doc:
            raise HTTPException(
                400, f"Target agency '{body.agency_id}' not found.",
            )
        updates["agency_id"] = body.agency_id
        audit_meta["agency_moved_from"] = existing.get("agency_id")
        audit_meta["agency_moved_to"] = body.agency_id

    if not updates:
        raise HTTPException(400, "No fields supplied.")

    updates["updated_at"] = _now_iso()
    await db.users.update_one({"id": user_id}, {"$set": updates})

    await write_audit(
        db, "super_admin_user_patch",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="user", target_id=user_id,
        request=request,
        metadata=audit_meta,
    )
    refreshed = await db.users.find_one({"id": user_id})
    return _public_user(refreshed)


# ── System health snapshot ────────────────────────────────────────────
@router.get("/system")
@limiter.limit("120/hour")
async def system_overview(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _agency=Depends(require_super_admin()),
):
    """Platform-wide rollup used by the System tab.

    Every section degrades independently — a hiccup reading one
    collection returns ``{"error":"unavailable"}`` for that section
    while the rest of the response still ships. Mirrors the pattern
    /api/ops/health uses.
    """
    import os as _os

    out: Dict[str, Any] = {
        "generated_at": _now_iso(),
        "billing_period": current_billing_period(),
        "feature_registry": list(FEATURE_REGISTRY),
        "tier_keys": list(TIER_KEYS),
    }

    # Agency tallies
    try:
        total = await db.agencies.count_documents({})
        active = await db.agencies.count_documents(
            {"billing_status": {"$in": ["trialing", "active"]}},
        )
        past_due = await db.agencies.count_documents(
            {"billing_status": "past_due"},
        )
        suspended = await db.agencies.count_documents(
            {"billing_status": "suspended"},
        )
        cancelled = await db.agencies.count_documents(
            {"billing_status": "cancelled"},
        )
        out["agencies"] = {
            "total": total,
            "active": active,
            "past_due": past_due,
            "suspended": suspended,
            "cancelled": cancelled,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("super_admin/system: agencies tally failed: %s", e)
        out["agencies"] = {"error": "unavailable"}

    # Users tally
    try:
        total_users = await db.users.count_documents({})
        active_users = await db.users.count_documents(
            {"is_active": True, "status": "active"},
        )
        out["users"] = {"total": total_users, "active": active_users}
    except Exception as e:                                    # noqa: BLE001
        logger.warning("super_admin/system: users tally failed: %s", e)
        out["users"] = {"error": "unavailable"}

    # Env health
    try:
        stripe_secret = (_os.environ.get("STRIPE_SECRET_KEY") or "").strip()
        stripe_webhook = (
            _os.environ.get("STRIPE_WEBHOOK_SECRET") or ""
        ).strip()
        resend_key = (_os.environ.get("RESEND_API_KEY") or "").strip()
        anthropic_key = (
            _os.environ.get("ANTHROPIC_API_KEY") or ""
        ).strip()
        # Stripe "mock mode" = no secret key. Yellow banner in the SPA.
        out["env"] = {
            "stripe_secret_configured": bool(stripe_secret),
            "stripe_webhook_configured": bool(stripe_webhook),
            "stripe_mock_mode": not bool(stripe_secret),
            "resend_configured": bool(resend_key),
            "anthropic_configured": bool(anthropic_key),
            "frontend_url": (
                _os.environ.get("FRONTEND_URL") or ""
            ).strip() or None,
        }
    except Exception as e:                                    # noqa: BLE001
        logger.warning("super_admin/system: env probe failed: %s", e)
        out["env"] = {"error": "unavailable"}

    return out
