/**
 * Calendar system (Feature C — backend phases C1-C5).
 *
 * Calendars promoted from per-user booking_settings into a
 * first-class collection. Three types (individual / round_robin /
 * group), backed by a deficit-weighted distribution engine for
 * round-robin. Slugs are globally unique across all tenants.
 */

export type CalendarType = "individual" | "round_robin" | "group";

export type CalendarSourceLabel = "autobook" | "va" | "ae" | "manual";

/** Same enum as CalendarSourceLabel — stamped onto an appointment
 *  row at booking time from the calendar.source_label. The split
 *  keeps the "which kind of calendar issued this booking" question
 *  answerable without joining back to the calendars table. */
export type BookingType = CalendarSourceLabel;

/** Settings shape carried on `calendars.booking_settings`. Note
 *  the field-name drift from the legacy `users.booking_settings`:
 *    appointment_duration → duration_minutes
 *    max_per_day          → max_bookings_per_day
 *  The legacy fallback path in booking_router merges the two
 *  shapes; here we use the canonical calendar names. */
export interface BookingSettings {
  /** Optional because the per-user legacy shape used a different
   *  name; the migration script and booking_router aliasing fill
   *  whichever side is missing. */
  duration_minutes?: number;
  buffer_minutes?: number;
  advance_notice_hours?: number;
  max_bookings_per_day?: number | null;
  timezone?: string;
  meeting_types?: string[];
  working_hours?: WorkingHours;
  /** Slug + is_enabled live here only when the settings came from
   *  the legacy users.booking_settings path. */
  slug?: string;
  is_enabled?: boolean;
  /** Pre-C1 legacy fields the booking_router still reads. */
  appointment_duration?: number;
  max_per_day?: number;
  booking_window_days?: number;
  bio?: string;
  phone_number?: string;
  video_link?: string;
}

export type WeekdayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type WorkingHours = Record<WeekdayKey, WorkingHoursDay>;

export interface WorkingHoursDay {
  enabled: boolean;
  start: string; // HH:MM
  end: string; // HH:MM
}

/** Round-robin distribution ledger. */
export interface CalendarDistribution {
  /** member_id → weight (1-5). */
  weights: Record<string, number>;
  /** member_id → assignment count. Admin-only on agent reads
   *  (the response is stripped to weights-only for non-privileged
   *  callers). */
  assignment_counts?: Record<string, number>;
  /** member_id → last_assigned ISO datetime. Admin-only. */
  last_assigned_at?: Record<string, string>;
}

/** First-class calendar record. */
export interface Calendar {
  id: string;
  agency_id: string;
  name: string;
  type: CalendarType;
  slug: string;
  color: string;
  source_label: CalendarSourceLabel;
  owner_id: string | null;
  member_ids: string[];
  distribution: CalendarDistribution | null;
  booking_settings: BookingSettings;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** POST /api/calendars body. */
export interface CalendarCreatePayload {
  name: string;
  type: CalendarType;
  slug: string;
  source_label?: CalendarSourceLabel;
  color?: string;
  owner_id?: string;
  member_ids?: string[];
  booking_settings?: BookingSettings;
  distribution?: CalendarDistribution;
}

/** PATCH /api/calendars/{id} body. Agent path: only name +
 *  booking_settings are honored (others silently dropped). */
export interface CalendarUpdatePayload {
  name?: string;
  type?: CalendarType;
  slug?: string;
  source_label?: CalendarSourceLabel;
  color?: string;
  owner_id?: string;
  member_ids?: string[];
  distribution?: CalendarDistribution;
  booking_settings?: BookingSettings;
  is_active?: boolean;
}

/** Per-member distribution row returned by
 *  GET /api/calendars/{id}/distribution. */
export interface DistributionMember {
  user_id: string;
  full_name: string;
  weight: number;
  assignment_count: number;
  last_assigned_at: string | null;
  /** expected_share - actual_share. Higher = pick this member next. */
  deficit: number;
  is_available_now: boolean;
}

export interface DistributionResponse {
  calendar_id: string;
  type: CalendarType;
  members: DistributionMember[];
  totals: {
    total_weight: number;
    total_assignments: number;
    available_now: number;
  };
}

/** PATCH /api/calendars/{id}/distribution body. */
export interface DistributionPatchPayload {
  /** member_id → new weight (1-5). Partial — unsupplied members
   *  keep their existing weight. */
  weights: Record<string, number>;
}
