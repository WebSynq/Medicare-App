/**
 * Calendar endpoints — /api/calendars/*
 * Feature C — calendar system (C1-C5).
 */

import { api } from "./client";
import type {
  Calendar,
  CalendarCreatePayload,
  CalendarType,
  CalendarUpdatePayload,
  DistributionPatchPayload,
  DistributionResponse,
} from "@/types";

export interface CalendarListResponse {
  calendars: Calendar[];
  total: number;
}

export async function listCalendars(options?: {
  type?: CalendarType;
}): Promise<CalendarListResponse> {
  const { data } = await api.get<CalendarListResponse>("/api/calendars", {
    params: options,
  });
  return data;
}

export async function createCalendar(
  payload: CalendarCreatePayload,
): Promise<Calendar> {
  const { data } = await api.post<Calendar>("/api/calendars", payload);
  return data;
}

export async function getCalendar(id: string): Promise<Calendar> {
  const { data } = await api.get<Calendar>(`/api/calendars/${id}`);
  return data;
}

export async function patchCalendar(
  id: string,
  payload: CalendarUpdatePayload,
): Promise<Calendar> {
  const { data } = await api.patch<Calendar>(`/api/calendars/${id}`, payload);
  return data;
}

/** Soft-delete. Throws 409 with `blocking_appointments` when upcoming
 *  non-cancelled appointments still reference this calendar. */
export async function deactivateCalendar(id: string): Promise<Calendar> {
  const { data } = await api.delete<Calendar>(`/api/calendars/${id}`);
  return data;
}

// ── Round-robin distribution ─────────────────────────────────────────

export async function getDistribution(
  calendarId: string,
): Promise<DistributionResponse> {
  const { data } = await api.get<DistributionResponse>(
    `/api/calendars/${calendarId}/distribution`,
  );
  return data;
}

export async function patchDistribution(
  calendarId: string,
  payload: DistributionPatchPayload,
): Promise<Calendar> {
  const { data } = await api.patch<Calendar>(
    `/api/calendars/${calendarId}/distribution`,
    payload,
  );
  return data;
}

export async function resetDistribution(calendarId: string): Promise<Calendar> {
  const { data } = await api.post<Calendar>(
    `/api/calendars/${calendarId}/distribution/reset`,
  );
  return data;
}

// ── Google Calendar OAuth (per-agent) ────────────────────────────────
// Lives on backend/calendar_router.py under /api/calendar/google/*.
// One-way sync today: appointments created in this app push to Google
// when the agent has connected; the reverse (Google → app) is intentionally
// not synced.

export interface GoogleCalendarStatus {
  connected: boolean;
  email?: string | null;
  connected_at?: string | null;
}

export async function getGoogleStatus(): Promise<GoogleCalendarStatus> {
  const { data } = await api.get<GoogleCalendarStatus>(
    "/api/calendar/google/status",
  );
  return data;
}

/** Returns the OAuth start URL. The page navigates the browser to it;
 *  Google bounces back to /api/calendar/google/callback which closes
 *  the loop. */
export interface GoogleConnectStart {
  authorization_url: string;
}

export async function startGoogleConnect(): Promise<GoogleConnectStart> {
  const { data } = await api.get<GoogleConnectStart>(
    "/api/calendar/google/connect",
  );
  return data;
}

export async function disconnectGoogle(): Promise<{ status: string }> {
  const { data } = await api.delete<{ status: string }>(
    "/api/calendar/google/disconnect",
  );
  return data;
}
