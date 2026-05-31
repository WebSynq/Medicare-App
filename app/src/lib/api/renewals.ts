/**
 * Renewal calendar — /api/renewals/*
 *
 * Returns the AEP / OEP countdown chips plus a list of policy
 * anniversaries inside the next 90 days. Agent-scoped on the
 * backend.
 */

import { api } from "./client";

export interface EnrollmentCountdown {
  days_until: number;
  is_active: boolean;
  opens: string;
  closes: string;
}

export interface RenewalAlertRow {
  lead_id: string | null;
  full_name: string;
  product_type: string | null;
  product_label: string | null;
  carrier: string | null;
  effective_date: string;
  renewal_date: string;
  days_until_renewal: number;
  agent_name: string | null;
}

export interface RenewalAlertsResponse {
  today: string;
  aep_countdown: EnrollmentCountdown;
  oep_countdown: EnrollmentCountdown;
  renewal_alerts: RenewalAlertRow[];
  total_ma_clients: number;
  total_pdp_clients: number;
}

export async function getAlerts(): Promise<RenewalAlertsResponse> {
  const { data } = await api.get<RenewalAlertsResponse>(
    "/api/renewals/alerts",
  );
  return data;
}
