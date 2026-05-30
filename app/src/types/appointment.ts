/**
 * Appointment — scheduled meeting between an agent and a lead/walk-in.
 *
 * Two creation flows:
 *   1. Linked     — lead_id provided; client_name denormalized from
 *                   the lead.
 *   2. Walk-in    — lead_id null; client_name required from caller.
 */

import type { BookingType } from "./calendar";

export type AppointmentType =
  | "initial_consultation"
  | "plan_review"
  | "enrollment"
  | "annual_review"
  | "follow_up"
  | "other";

export type AppointmentStatus =
  | "scheduled"
  | "completed"
  | "cancelled"
  | "no_show";

/** Feature A — outcome buttons on the appointment card. */
export type AppointmentOutcome = "showed" | "no_show" | "sold" | "not_sold";

export interface Appointment {
  appointment_id: string;
  agency_id: string;
  agent_id: string;
  agent_name: string | null;
  agent_email: string | null;

  /** Null when this is a walk-in appointment. */
  lead_id: string | null;
  client_name: string;
  client_phone: string | null;
  client_email: string | null;

  appointment_date: string; // YYYY-MM-DD
  appointment_time: string; // HH:MM
  duration_minutes: number;
  type: AppointmentType;
  status: AppointmentStatus;
  notes: string | null;
  outcome: AppointmentOutcome | null;
  outcome_set_at: string | null;
  outcome_set_by: string | null;

  estimated_commission: number | null;

  /** Booking flow extensions */
  meeting_type: "phone" | "video" | null;
  booking_reason: string | null;
  booked_by_client: boolean;

  /** Feature C — calendar attribution */
  calendar_id: string | null;
  booking_type: BookingType;

  /** Reminder/follow-up send flags */
  reminder_48hr_sent: boolean;
  reminder_24hr_sent: boolean;
  reminder_1hr_sent: boolean;
  followup_sent: boolean;

  /** Google Calendar sync */
  google_calendar_event_id: string | null;
  google_calendar_synced_at: string | null;

  created_at: string;
  updated_at: string;
}

/** POST /api/appointments body. */
export interface AppointmentCreatePayload {
  lead_id?: string;
  client_name?: string;
  appointment_date: string;
  appointment_time: string;
  duration_minutes?: number;
  type?: AppointmentType;
  notes?: string;
  estimated_commission?: number;
  meeting_type?: "phone" | "video";
  booking_reason?: string;
  client_email?: string;
  calendar_id?: string;
  booking_type?: BookingType;
}

/** PATCH /api/appointments/{id} body. */
export interface AppointmentUpdatePayload {
  status?: AppointmentStatus;
  notes?: string;
  outcome?: AppointmentOutcome | string;
  title?: string;
  appointment_date?: string;
  duration_minutes?: number;
  meeting_type?: "phone" | "video";
  reminder_48hr_sent?: boolean;
  reminder_24hr_sent?: boolean;
  reminder_1hr_sent?: boolean;
  followup_sent?: boolean;
}

/** POST /api/appointments/{id}/outcome body. */
export interface AppointmentOutcomePayload {
  outcome: AppointmentOutcome;
}
