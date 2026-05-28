"""Pydantic models for the multi-tenant data layer.

These are the on-the-wire and on-disk shapes for:
  - agencies            — one row per tenant
  - usage_events        — append-only audit of every billable action
  - agency_usage_summary — cached per-billing-period rollup
  - invitations         — owner→agent invite tokens

Conventions
===========
- All datetimes serialise to ISO 8601 strings on the wire (matches the
  rest of the codebase — see Lead/AuditEvent in models.py).
- Monetary values stay in cents (int) where they originate; usage
  events expose float USD for display convenience.
- ``billing_status`` is a state machine — transitions are validated in
  the billing handlers, not here.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from tiers import (
    FEATURE_REGISTRY,
    TIER_KEYS,
    sanitise_features,
    tier_features,
    tier_limits,
    tier_overage_rates,
)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Type aliases (string literals — kept narrow on purpose) ───────────
TierKey = Literal["beta", "foundation", "growth", "domination"]
BillingStatus = Literal[
    "trialing", "active", "past_due", "suspended", "cancelled",
]
InvitationStatus = Literal["pending", "accepted", "expired", "revoked"]
InvitedRole = Literal["owner", "agent", "va"]


# ── Agency ───────────────────────────────────────────────────────────
class AgencyLimits(BaseModel):
    """Plan limits — replicated onto the agency row so a tier-config
    change doesn't retroactively rewrite history. The agency keeps the
    limits it was provisioned with until an explicit upgrade/downgrade."""
    seats: int
    ai_calls_included: int
    emails_included: int
    storage_gb_included: float
    app_intakes_included: int


class AgencyOverageRates(BaseModel):
    """Cents per overage unit. Always sourced from tiers.OVERAGE_RATES;
    only super admins can override per-agency."""
    ai_tokens_per_1k: int
    email_per_1k: int
    storage_per_gb: int
    app_intake_each: int
    seat_per_month: int


class Agency(BaseModel):
    """Canonical tenant record. One row per agency in db.agencies."""
    model_config = ConfigDict(extra="ignore")

    agency_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    slug: str             # URL-safe identifier; unique; immutable after create
    owner_email: EmailStr
    super_admin: bool = False

    # Tier & Billing
    tier: TierKey = "beta"
    billing_status: BillingStatus = "trialing"
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    trial_ends_at: Optional[str] = None
    current_period_start: Optional[str] = None
    current_period_end: Optional[str] = None
    grace_period_ends_at: Optional[str] = None
    monthly_base_amount: int = 0   # cents

    # Seats
    seats_included: int = 0
    seats_active: int = 0
    seats_max: int = 0

    # Email (per-agency Resend domain)
    email_domain: Optional[str] = None
    email_domain_verified: bool = False
    resend_domain_id: Optional[str] = None
    from_name: Optional[str] = None
    from_email: Optional[str] = None

    # GHL integration (per-agency — already encrypted by ghl_import_router)
    ghl_location_id: Optional[str] = None
    ghl_token_encrypted: Optional[str] = None

    # Feature flags + limits + overages
    features: Dict[str, bool] = Field(default_factory=dict)
    limits: AgencyLimits
    overage_rates: AgencyOverageRates

    # Metadata
    created_at: str = Field(default_factory=_utcnow_iso)
    created_by: Optional[str] = None
    onboarded_at: Optional[str] = None
    last_active_at: Optional[str] = None
    notes: Optional[str] = None
    deleted_at: Optional[str] = None   # soft-delete only

    @field_validator("slug")
    @classmethod
    def _v_slug(cls, v: str) -> str:
        s = (v or "").strip().lower()
        if not s:
            raise ValueError("slug is required")
        if len(s) < 2 or len(s) > 60:
            raise ValueError("slug must be 2-60 characters")
        for ch in s:
            if not (ch.isalnum() or ch in "-_"):
                raise ValueError("slug may only contain a-z, 0-9, '-', '_'")
        return s

    @field_validator("features")
    @classmethod
    def _v_features(cls, v: dict) -> dict:
        # Drop unknown keys; force every registered key to a bool.
        return sanitise_features(v or {})


def build_agency_defaults(
    *,
    name: str,
    slug: str,
    owner_email: str,
    tier: str = "beta",
    super_admin: bool = False,
    created_by: Optional[str] = None,
    features_override: Optional[Dict[str, bool]] = None,
) -> Agency:
    """Construct an Agency with tier-default features, limits, overage
    rates, and monthly base. Use everywhere an agency is created
    (super-admin endpoint, GHW migration, future self-serve signup).
    """
    if tier not in TIER_KEYS:
        raise ValueError(f"unknown tier: {tier}")
    limits_dict = tier_limits(tier)
    features = features_override if features_override is not None else tier_features(tier)
    overages = tier_overage_rates(tier)
    from tiers import TIER_DEFAULTS
    tdef = TIER_DEFAULTS[tier]
    return Agency(
        name=name,
        slug=slug,
        owner_email=owner_email,
        super_admin=super_admin,
        tier=tier,                      # type: ignore[arg-type]
        billing_status="active" if super_admin else "trialing",
        monthly_base_amount=tdef["monthly_base_cents"],
        seats_included=tdef["seats_included"],
        seats_max=tdef["seats_max"],
        features=features,
        limits=AgencyLimits(**limits_dict),
        overage_rates=AgencyOverageRates(**overages),
        created_by=created_by,
    )


# ── UsageEvent ───────────────────────────────────────────────────────
EVENT_TYPES = (
    "cna_analysis",
    "daily_brief",
    "app_intake",
    "security_analysis",
    "tag_mapping",
    "email_sent",
    "document_stored",
    "ai_client_intelligence",
)

UsageEventType = Literal[
    "cna_analysis", "daily_brief", "app_intake", "security_analysis",
    "tag_mapping", "email_sent", "document_stored",
    "ai_client_intelligence",
]

UsageUnit = Literal["tokens", "emails", "gb", "count"]


class UsageEvent(BaseModel):
    """Append-only metering row. One per AI call / email / storage write.

    ``event_id`` is the idempotency key — same UUID arriving twice is a
    no-op. ``billing_period`` is the YYYY-MM bucket the rollup job
    aggregates over.
    """
    model_config = ConfigDict(extra="ignore")

    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agency_id: str
    agent_id: Optional[str] = None
    billing_period: str   # YYYY-MM
    event_type: UsageEventType
    quantity: float
    unit: UsageUnit
    cost_usd: float = 0.0
    charge_usd: float = 0.0
    model: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    included_in_plan: bool = True
    billed_to_stripe: bool = False
    timestamp: str = Field(default_factory=_utcnow_iso)

    @field_validator("billing_period")
    @classmethod
    def _v_period(cls, v: str) -> str:
        # YYYY-MM, e.g. "2026-05". Reject anything else so the rollup
        # group_by stays trustworthy.
        if not isinstance(v, str) or len(v) != 7 or v[4] != "-":
            raise ValueError("billing_period must be YYYY-MM")
        try:
            int(v[:4]); int(v[5:7])
        except ValueError:
            raise ValueError("billing_period must be YYYY-MM")
        return v


def current_billing_period() -> str:
    """UTC YYYY-MM for "right now". Used by every track_* helper."""
    now = datetime.now(timezone.utc)
    return f"{now.year:04d}-{now.month:02d}"


# ── AgencyUsageSummary ───────────────────────────────────────────────
class AgencyUsageSummary(BaseModel):
    """Cached per-period rollup. Rebuilt by the monthly aggregator.

    Reads from this collection are the path the SPA's Usage tab takes —
    we never recompute on a page load.
    """
    model_config = ConfigDict(extra="ignore")

    agency_id: str
    billing_period: str
    updated_at: str = Field(default_factory=_utcnow_iso)

    seats_active: int = 0
    seats_max: int = 0

    ai_calls_total: int = 0
    ai_tokens_input: int = 0
    ai_tokens_output: int = 0
    ai_cost_usd: float = 0.0
    ai_charge_usd: float = 0.0

    emails_sent: int = 0
    email_cost_usd: float = 0.0
    email_charge_usd: float = 0.0

    app_intakes: int = 0
    intake_cost_usd: float = 0.0
    intake_charge_usd: float = 0.0

    storage_gb: float = 0.0
    storage_cost_usd: float = 0.0
    storage_charge_usd: float = 0.0

    total_base_charge_usd: float = 0.0
    total_overage_usd: float = 0.0
    total_invoice_usd: float = 0.0
    reported_to_stripe: bool = False


# ── Invitation ───────────────────────────────────────────────────────
class Invitation(BaseModel):
    """Owner→agent invite token. Hashed; single-use; 7-day TTL."""
    model_config = ConfigDict(extra="ignore")

    invitation_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agency_id: str
    invited_email: EmailStr
    invited_role: InvitedRole
    invited_by: Optional[str] = None
    token_hash: str
    expires_at: str
    accepted_at: Optional[str] = None
    status: InvitationStatus = "pending"
    created_at: str = Field(default_factory=_utcnow_iso)
