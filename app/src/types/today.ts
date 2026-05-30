/**
 * Today page response shapes.
 *
 * Two endpoints feed the Today page:
 *   GET /api/today/actions  — buckets + KPI scalars + MTD
 *   GET /api/brief/today    — AI-prioritized top-10 call list
 *
 * Mirrors the FastAPI response exactly. Any rename here is a bug.
 */

import type { LeadStatus, LeadUrgencyLevel } from "./lead";

/** Lead in the IL birthday-rule window (≤63 days post-birthday). */
export interface TodayUrgentCall {
  lead_id: string;
  full_name: string;
  phone: string | null;
  days_remaining_in_window: number;
  current_plan: string | null;
  current_carrier: string | null;
}

/** Policy whose anniversary is inside the next 30 days. */
export interface TodayRenewalDue {
  /** Null when the policy couldn't be joined back to a portal lead
   *  (frontend hides the View Client button in that case). */
  lead_id: string | null;
  full_name: string;
  carrier: string | null;
  product_label: string | null;
  renewal_date: string; // YYYY-MM-DD
  days_until_renewal: number;
}

/** Lead in new/contacted that hasn't moved in 7+ days. */
export interface TodayStaleLead {
  lead_id: string;
  full_name: string;
  phone: string | null;
  status: LeadStatus;
  days_since_contact: number;
}

/** Appointment scheduled for today. */
export interface TodayAppointment {
  appointment_id: string;
  lead_id: string | null;
  client_name: string | null;
  time: string; // HH:MM
  notes: string;
}

export interface TodaySummary {
  urgent_count: number;
  renewals_count: number;
  stale_count: number;
  appointments_count: number;
}

export interface TodayActionsResponse {
  today: string; // YYYY-MM-DD
  summary: TodaySummary;
  urgent_calls: TodayUrgentCall[];
  renewals_due: TodayRenewalDue[];
  stale_leads: TodayStaleLead[];
  todays_appointments: TodayAppointment[];
  mtd_commission: number;
  /** Feature B — number of leads created today (UTC). */
  new_leads_today: number;
  /** Feature B — number of policies submitted today (UTC). */
  apps_submitted_today: number;
}

// ── Brief ─────────────────────────────────────────────────────────────────

export interface BriefTopCall {
  lead_id: string;
  name: string;
  phone: string;
  email: string;
  score: number; // 0-100
  urgency_level: LeadUrgencyLevel;
  /** Headline reason — the one most worth saying first. */
  reason: string;
  /** Supporting reasons (capped at 4 by the backend). */
  reasons: string[];
}

export interface DailyBrief {
  agent_id: string;
  date: string; // YYYY-MM-DD
  generated_at: string; // ISO
  top_calls: BriefTopCall[];
  total_urgent: number;
  total_priority: number;
}
