/**
 * Lead — Medicare beneficiary CRM record.
 *
 * Backend collection: db.leads. One doc per prospect, keyed on
 * agent_id + GHL contact sync. Phase 2+ row-level scoping means
 * every read filters on (agency_id, agent_id) unless the caller's
 * role is in FULL_AGENCY_SCOPE_ROLES.
 */

export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "appointment_set"
  | "enrolled"
  | "lost"
  | "not_interested"
  | "do_not_contact";

/** Per-lead AI urgency model (computed by the daily-brief tick
 *  and stamped onto the row as `ai_score` + reason). */
export type LeadUrgencyLevel = "urgent" | "high" | "moderate" | "low";

export interface Lead {
  id: string;
  /** Identity / contact */
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null; // 2-letter, normalized
  zip_code: string | null;

  /** Coverage / status */
  status: LeadStatus;
  current_carrier: string | null;
  current_plan: string | null;
  monthly_premium: number | null;
  product_interest: string | null;
  plan_type_premium: string | null;

  /** Medicare eligibility */
  mbi_number: string | null;
  medicare_part_a_effective: string | null;
  medicare_part_b_effective: string | null;

  /** Multi-tenant scoping */
  agency_id: string;
  agent_id: string | null;
  agent_email: string | null;
  agent_name: string | null;
  agent_assigned_id: string | null;

  /** Source attribution */
  lead_source: string | null;
  source: string | null;
  created_via: string | null;

  /** GHL sync */
  ghl_contact_id: string | null;
  ghl_sync_status: "synced" | "error" | null;

  /** Tags + AI scoring */
  tags: string[];
  ai_score: number | null;
  ai_score_reason: string | null;
  ai_score_updated: string | null;

  /** SOA */
  soa_signed: boolean;
  soa_signed_at: string | null;
  sales_submitting_agent: string | null;

  /** Automation flags */
  birthday_email_sent: boolean | null;
  enrolled_welcome_sent: boolean | null;
  stale_alert_sent: boolean | null;
  new_lead_notified: boolean | null;

  /** Free-form */
  notes: string | null;
  appointment_goal: string | null;

  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  transferred_from: string | null;
}

/** POST /api/leads body. */
export interface LeadCreatePayload {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  date_of_birth?: string;
  state?: string;
  current_carrier?: string;
  current_plan?: string;
  product_interest?: string;
  notes?: string;
  lead_source?: string;
  source?: string;
  status?: LeadStatus;
  /** Anything else the backend's LeadCreate model accepts. */
  [key: string]: unknown;
}

/** PATCH /api/leads/{id} body — every field on the LeadUpdate
 *  model is optional; sending null clears the value. */
export type LeadUpdatePayload = Partial<
  Pick<
    Lead,
    | "first_name"
    | "last_name"
    | "email"
    | "phone"
    | "date_of_birth"
    | "address_line1"
    | "address_line2"
    | "city"
    | "state"
    | "zip_code"
    | "status"
    | "current_carrier"
    | "current_plan"
    | "monthly_premium"
    | "product_interest"
    | "plan_type_premium"
    | "mbi_number"
    | "medicare_part_a_effective"
    | "medicare_part_b_effective"
    | "notes"
    | "appointment_goal"
  >
>;
