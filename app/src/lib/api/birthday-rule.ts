/**
 * Birthday-rule alerts — /api/birthday-rule/*
 *
 * Illinois Med Supp 63-day post-birthday switch window. Backend
 * returns three buckets (urgent / soon / upcoming) plus counts; the
 * SPA renders them as separate panels.
 */

import { api } from "./client";

export interface BirthdayLeadRow {
  lead_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  date_of_birth: string | null;
  next_birthday: string;
  last_birthday: string;
  window_opens: string;
  window_closes: string;
  days_until_birthday: number;
  days_remaining_in_window: number | null;
  window_status: "open" | "future";
  current_plan: string | null;
  current_carrier: string | null;
  agent_name: string | null;
}

export interface BirthdayAlertsResponse {
  today: string;
  window_days: number;
  urgent: BirthdayLeadRow[];
  soon: BirthdayLeadRow[];
  upcoming: BirthdayLeadRow[];
  counts: { urgent: number; soon: number; upcoming: number };
}

export async function getAlerts(): Promise<BirthdayAlertsResponse> {
  const { data } = await api.get<BirthdayAlertsResponse>(
    "/api/birthday-rule/alerts",
  );
  return data;
}
