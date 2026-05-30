/**
 * Agency / multi-tenant shapes (Phases 1-6 of the backend).
 *
 * Every authenticated user belongs to exactly one agency; the
 * row stamps `agency_id` on every business record and the
 * deps.agent_filter helper turns that stamp into a Mongo filter.
 */

export type AgencyTier = "beta" | "foundation" | "growth" | "domination";

export type AgencyBillingStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "suspended"
  | "cancelled";

/** FEATURE_REGISTRY keys from backend/tiers.py. Listed exhaustively
 *  so the SPA can typecheck calls to `features[key]` without a
 *  free-form string. Update when tiers.py adds a key. */
export type AgencyFeature =
  | "cna"
  | "ai_client_intelligence"
  | "ai_application_intake"
  | "ghl_import"
  | "booking"
  | "soa"
  | "audit_log"
  | "leaderboard"
  | "ops_console"
  | "ai_security"
  | "round_robin"
  | "email_domain"
  | "agency_dashboard"
  | "super_admin_panel"
  | "owner_settings"
  | "stripe_billing"
  | "metering"
  | "compliance_dashboard"
  | "accounting_dashboard"
  | "production_records"
  | "reconciliation"
  | "cfo_chat"
  | "google_calendar_sync"
  | "renewals"
  | "birthday_rule"
  | "tags"
  | "documents"
  | "ghl_webhook"
  | "feedback";

export type AgencyFeatureMap = Partial<Record<AgencyFeature, boolean>>;

export interface AgencyUsageLimits {
  ai_messages_per_month: number;
  emails_per_month: number;
  app_intake_per_month: number;
  storage_gb: number;
  seats: number;
}

export interface Agency {
  agency_id: string;
  name: string;
  slug: string;
  tier: AgencyTier;
  billing_status: AgencyBillingStatus;
  super_admin: boolean;

  features: AgencyFeatureMap;
  limits: AgencyUsageLimits;

  seats_max: number; // -1 = unlimited (Domination)
  seats_active: number;
  seats_included: number;

  /** Stripe linkage (Phase 3). */
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;

  /** Per-agency email domain (Phase 4). */
  from_name: string | null;
  from_email: string | null;
  email_domain_verified: boolean;

  created_at: string;
  updated_at: string;
}

/** GET /api/agency/usage response. */
export interface AgencyUsage {
  agency_id: string;
  period_start: string;
  period_end: string;
  ai_messages: { used: number; limit: number };
  emails_sent: { used: number; limit: number };
  app_intake: { used: number; limit: number };
  storage_bytes: { used: number; limit: number };
  seats: { used: number; limit: number };
}

/** GET /api/agency/stats response — the admin dashboard payload. */
export interface AgencyStats {
  health: {
    score: number; // 0-100
    label: "healthy" | "watch" | "critical";
  };
  pipeline: {
    total_leads: number;
    by_status: Record<string, number>;
  };
  compliance: {
    soa_signed_pct: number;
    tcpa_consent_pct: number;
  };
  /** Anything else the backend rolls in. */
  [key: string]: unknown;
}
