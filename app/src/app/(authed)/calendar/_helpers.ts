/**
 * Shared types + formatters + color/label maps for the Calendar
 * page. Lives next to the page so each tab-file imports what it
 * needs without a broader path. Mirrors the constants in
 * `frontend/src/pages/CalendarPage.jsx`.
 */

import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
  addDays,
} from "date-fns";

import type {
  AppointmentStatus,
  AppointmentType,
} from "@/types";
import type { BookingType } from "@/types/calendar";

// ─── Color + label maps ──────────────────────────────────────────────────

/** Calendar-grid color is driven by booking SOURCE per spec — agents
 *  glance at the wall and instantly see where each appointment came
 *  from (public booking page vs VA call vs AE outreach vs manual
 *  agent entry). */
export const BOOKING_TYPE_COLOR: Record<BookingType, string> = {
  autobook: "#16a34a", // emerald-600
  va: "#7c3aed",       // violet-600
  ae: "#ea580c",       // orange-600
  manual: "#2563eb",   // blue-600 — covers the "default" bucket per spec
};

export const BOOKING_TYPE_LABEL: Record<BookingType, string> = {
  autobook: "Autobook",
  va: "VA",
  ae: "AE",
  manual: "Manual",
};

export function bookingColor(type: BookingType | undefined | null): string {
  if (!type) return BOOKING_TYPE_COLOR.manual;
  return BOOKING_TYPE_COLOR[type] ?? BOOKING_TYPE_COLOR.manual;
}

/** Type drives sidebar swatches + the detail-modal label pill. */
export const TYPE_LABEL: Record<AppointmentType, string> = {
  initial_consultation: "Initial Consultation",
  plan_review: "Plan Review",
  enrollment: "Enrollment",
  annual_review: "Annual Review",
  follow_up: "Follow-up",
  other: "Other",
};

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No Show",
};

// ─── Date / time helpers ─────────────────────────────────────────────────

/** Combine YYYY-MM-DD + HH:MM into a local Date. Returns null on bad input. */
export function parseDateTime(
  dateStr: string | null | undefined,
  timeStr: string | null | undefined,
): Date | null {
  if (!dateStr || !timeStr) return null;
  const dateParts = dateStr.split("-").map(Number);
  const timeParts = timeStr.split(":").map(Number);
  const [y, m, d] = dateParts;
  const [hh, mm] = timeParts;
  if (y == null || m == null || d == null || hh == null || mm == null) {
    return null;
  }
  const dt = new Date(y, m - 1, d, hh, mm);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Currency for `estimated_commission`. */
export function fmtMoney(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

// ─── react-big-calendar view window ──────────────────────────────────────
// String enums so this module doesn't have to import react-big-calendar
// (which side-effects its own CSS — keep that contained to the page).
export type CalendarViewName = "month" | "week" | "day" | "agenda";

/** Inclusive [start, end] dates the current view needs to display.
 *  Widened by ~one week for month view so "spillover" cells (last week
 *  of previous month rendered in month grid) also fill with events. */
export function viewWindow(
  date: Date,
  view: CalendarViewName,
): { start: Date; end: Date } {
  if (view === "month") {
    return {
      start: startOfWeek(startOfMonth(date), { weekStartsOn: 0 }),
      end: endOfWeek(endOfMonth(date), { weekStartsOn: 0 }),
    };
  }
  if (view === "week") {
    return {
      start: startOfWeek(date, { weekStartsOn: 0 }),
      end: endOfWeek(date, { weekStartsOn: 0 }),
    };
  }
  if (view === "day") {
    return { start: startOfDay(date), end: endOfDay(date) };
  }
  // Agenda — 30-day forward window.
  return { start: startOfDay(date), end: endOfDay(addDays(date, 30)) };
}
