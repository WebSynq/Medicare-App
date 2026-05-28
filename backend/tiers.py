"""Multi-tenant tier definitions: feature flags, plan limits, overage rates.

Single source of truth for "what is included in each plan" and "what
do we charge for usage above the plan limit". Read by:
  - agency seed / migration (default feature flags on creation)
  - deps.require_feature / require_billing_active (runtime enforcement)
  - metering.py (overage cost calculation)
  - super admin panel (display + Apply Defaults button)

Convention:
  - All monetary values in cents (int) — no floats, no rounding bugs
  - `-1` in seat fields means "unlimited"
  - Feature keys are stable identifiers — never renamed (frontend keys off them)

Adding a new feature:
  1. Add the key + default to FEATURE_REGISTRY (default off)
  2. Add to the appropriate tier(s) in TIER_DEFAULTS
  3. Wire backend enforcement via require_feature(KEY)
  4. Surface the toggle in the super admin panel
"""
from __future__ import annotations

from typing import Dict, List


# ── Feature registry ──────────────────────────────────────────────────────
# Every feature key the platform knows about. Used to validate
# agency.features dicts on write (reject unknown keys), and as the
# canonical list for the super admin "Apply Defaults" button.
FEATURE_REGISTRY: List[str] = [
    # Foundation (always-on for any paying tier)
    "crm",
    "leads",
    "clients",
    "documents",
    "soa",
    "birthday_rule",
    "renewals",
    "pipeline",
    "leaderboard",
    "basic_automations",
    "audit_log",
    "commission_tracking",
    # Growth
    "booking_system",
    "advanced_automations",
    "ai_application_intake",
    "ghl_import",
    "ai_daily_brief",
    "lead_scoring",
    # Domination
    "cna",
    "ai_client_intelligence",
    "aep_war_room",
    "agency_dashboard",
    "ops_console",
    # Add-ons (any tier, explicit enable)
    "va_access",
    "meta_attribution",
    "dialer",
    "quoting",
    "api_access",
    "custom_reporting",
]


# Tier identifiers. Anything outside this list is rejected on agency
# create / tier change.
TIER_KEYS = ("beta", "foundation", "growth", "domination")


def _features_all_on() -> Dict[str, bool]:
    return {k: True for k in FEATURE_REGISTRY}


def _features_all_off() -> Dict[str, bool]:
    return {k: False for k in FEATURE_REGISTRY}


def _features_with(*keys: str) -> Dict[str, bool]:
    """Helper: start with all-off and flip the listed keys on. Used to
    keep tier definitions terse + readable."""
    out = _features_all_off()
    for k in keys:
        if k not in out:
            raise ValueError(f"unknown feature key in tier definition: {k}")
        out[k] = True
    return out


# Foundation feature set — every paying tier gets these.
_FOUNDATION_KEYS = (
    "crm", "leads", "clients", "documents", "soa", "birthday_rule",
    "renewals", "pipeline", "leaderboard", "basic_automations",
    "audit_log", "commission_tracking",
)

# Growth = Foundation + the AI / automation suite.
_GROWTH_KEYS = _FOUNDATION_KEYS + (
    "booking_system", "advanced_automations", "ai_application_intake",
    "ghl_import", "ai_daily_brief", "lead_scoring",
)

# Domination = Growth + advanced intelligence (but not ops_console — that's
# super-admin-only by default and granted per-agency on request).
_DOMINATION_KEYS = _GROWTH_KEYS + (
    "cna", "ai_client_intelligence", "aep_war_room", "agency_dashboard",
)


TIER_DEFAULTS: Dict[str, dict] = {
    # Beta — early-access agencies; everything on for free testing.
    # ops_console + paid add-ons still gated to keep "free trial" honest.
    "beta": {
        "seats_included": 3,
        "seats_max": 10,
        "ai_calls_included": 500,
        "emails_included": 1000,
        "storage_gb_included": 5.0,
        "app_intakes_included": 10,
        "monthly_base_cents": 29700,
        "features": _features_with(*_DOMINATION_KEYS),
    },
    "foundation": {
        "seats_included": 5,
        "seats_max": 10,
        "ai_calls_included": 1000,
        "emails_included": 2000,
        "storage_gb_included": 10.0,
        "app_intakes_included": 20,
        "monthly_base_cents": 29700,
        "features": _features_with(*_FOUNDATION_KEYS),
    },
    "growth": {
        "seats_included": 15,
        "seats_max": 50,
        "ai_calls_included": 5000,
        "emails_included": 10000,
        "storage_gb_included": 25.0,
        "app_intakes_included": 100,
        "monthly_base_cents": 49700,
        "features": _features_with(*_GROWTH_KEYS),
    },
    "domination": {
        "seats_included": -1,   # unlimited
        "seats_max": -1,        # unlimited
        "ai_calls_included": 20000,
        "emails_included": 50000,
        "storage_gb_included": 100.0,
        "app_intakes_included": 500,
        "monthly_base_cents": 99700,
        "features": _features_with(*_DOMINATION_KEYS),
    },
}


# Overage rates (cents). Per-tier so the highest tier can waive seat
# overages on unlimited plans.
OVERAGE_RATES: Dict[str, Dict[str, int]] = {
    "beta": {
        "ai_tokens_per_1k": 1,
        "email_per_1k": 1,
        "storage_per_gb": 10,
        "app_intake_each": 25,
        "seat_per_month": 2500,
    },
    "foundation": {
        "ai_tokens_per_1k": 1,
        "email_per_1k": 1,
        "storage_per_gb": 10,
        "app_intake_each": 25,
        "seat_per_month": 2500,
    },
    "growth": {
        "ai_tokens_per_1k": 1,
        "email_per_1k": 1,
        "storage_per_gb": 10,
        "app_intake_each": 25,
        "seat_per_month": 2500,
    },
    "domination": {
        "ai_tokens_per_1k": 1,
        "email_per_1k": 1,
        "storage_per_gb": 10,
        "app_intake_each": 25,
        "seat_per_month": 0,    # unlimited tier — seats waived
    },
}


# ── Helpers ───────────────────────────────────────────────────────────────
def is_valid_tier(tier: str) -> bool:
    return tier in TIER_KEYS


def is_valid_feature(key: str) -> bool:
    return key in FEATURE_REGISTRY


def tier_limits(tier: str) -> dict:
    """Return the `limits` sub-dict for a tier (seats + usage caps).
    Useful when seeding agency.limits at create time."""
    t = TIER_DEFAULTS[tier]
    return {
        "seats": t["seats_included"],
        "ai_calls_included": t["ai_calls_included"],
        "emails_included": t["emails_included"],
        "storage_gb_included": t["storage_gb_included"],
        "app_intakes_included": t["app_intakes_included"],
    }


def tier_features(tier: str) -> Dict[str, bool]:
    """Return a fresh copy of the default feature flags for a tier."""
    return dict(TIER_DEFAULTS[tier]["features"])


def tier_overage_rates(tier: str) -> Dict[str, int]:
    return dict(OVERAGE_RATES[tier])


def sanitise_features(supplied: Dict[str, bool]) -> Dict[str, bool]:
    """Drop unknown feature keys and coerce values to bool. Returns a
    fresh dict — never mutates the input. Use on every write so the
    persisted shape stays canonical."""
    out: Dict[str, bool] = {}
    for k in FEATURE_REGISTRY:
        if k in supplied:
            out[k] = bool(supplied[k])
        else:
            out[k] = False
    return out
