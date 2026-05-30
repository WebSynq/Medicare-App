/**
 * Settings page payload shapes.
 *
 * Keeps the /settings forms (profile / booking / sessions / GHL /
 * agency) type-safe without polluting the existing types/lead /
 * types/auth modules. profile-tab is the file name to keep this
 * distinct from types/profile.ts which covers the /clients/[id]
 * subdocuments.
 */

import type { BookingSettings } from "./calendar";

// ─── Profile ───────────────────────────────────────────────────────────────

export interface ProfileMe {
  id: string;
  email: string;
  full_name: string | null;
  agent_name: string | null;
  agent_id: string | null;
  agent_npn: string | null;
  phone: string | null;
  timezone: string | null;
  role: string;
  is_active: boolean;
  status: string;
  agency_name: string | null;
  created_at: string | null;
  booking_settings: BookingSettings | null;
}

export interface ProfilePatchPayload {
  current_password: string;
  email?: string;
  full_name?: string;
  phone?: string;
  timezone?: string;
  agent_npn?: string;
  new_password?: string;
}

// ─── Booking settings ──────────────────────────────────────────────────────

export interface BookingSettingsPatchPayload {
  is_enabled?: boolean;
  bio?: string;
  meeting_types?: string[];
  phone_number?: string;
  video_link?: string;
  appointment_duration?: number;
  buffer_minutes?: number;
  max_per_day?: number;
  advance_notice_hours?: number;
  booking_window_days?: number;
  working_hours?: Record<string, { enabled: boolean; start: string; end: string }>;
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export interface ProfileSession {
  ip_address: string | null;
  user_agent: string | null;
  timestamp: string;
}

export interface ProfileSessionsResponse {
  sessions: ProfileSession[];
  count: number;
}

// ─── GHL integration ───────────────────────────────────────────────────────

export interface GhlIntegrationStatus {
  connected: boolean;
  agent_id?: string;
  location_id?: string | null;
  location_name?: string | null;
  connected_at?: string | null;
  last_validated_at?: string | null;
  contact_count_ghl?: number | null;
  contact_count_portal?: number | null;
  last_sync_at?: string | null;
  status?: string | null;
}

export interface GhlConnectPayload {
  token: string;
}

// ─── Agency settings ───────────────────────────────────────────────────────

export interface AgencySettings {
  agency_id: string;
  name: string;
  slug: string;
  tier: string;
  billing_status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  monthly_base_amount_cents: number;
  seats_included: number;
  seats_max: number;
  seats_active: number;
  from_name: string | null;
  from_email: string | null;
  email_domain: string | null;
  email_domain_verified: boolean;
}

// AgencyUsage now lives in types/agency.ts (the canonical home) so the
// SuperAdmin shape and the owner-facing /api/agency/usage shape can't
// drift apart. Import from "@/types" — both files share the barrel.
