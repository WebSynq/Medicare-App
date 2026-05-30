/**
 * Dashboard endpoints — /api/dashboard/* and /api/agency-dashboard/*
 *
 * dashboard.lead-sources is agent-scoped; agency-dashboard.* is the
 * admin/owner agency-wide roll-up.
 */

import { api } from "./client";

export interface LeadSourceRow {
  source: string;
  total: number;
  enrolled: number;
  conversion_rate: number;
  avg_days_to_enroll: number | null;
}

export interface LeadSourcesResponse {
  period: "mtd" | "ytd" | "last30" | "last90" | "all";
  sources: LeadSourceRow[];
  top_source: string | null;
  best_converting: string | null;
}

export async function getLeadSources(
  period: "mtd" | "ytd" | "last30" | "last90" | "all" = "mtd",
): Promise<LeadSourcesResponse> {
  const { data } = await api.get<LeadSourcesResponse>(
    "/api/dashboard/lead-sources",
    { params: { period } },
  );
  return data;
}

// ─── Agency dashboard ──────────────────────────────────────────────────────

export interface AgencyKpisResponse {
  period: "mtd" | "last30" | "last90" | "ytd" | "all";
  date_range: { start: string; end: string };
  agents: { total: number; active_this_period: number };
  leads: { total: number; new_this_period: number; trend_pct: number };
  enrolled: { total: number; new_this_period: number; trend_pct: number };
  revenue: {
    total_estimated: number;
    this_period: number;
    trend_pct: number;
  };
  policies: { total_written: number; this_period: number };
  carriers: { active_count: number };
  birthday_windows: { open_now: number };
  renewals: { due_30_days: number };
  stale_agents: { count: number };
  _meta: {
    computed_at: string;
    freshness_seconds: number;
    stale_seconds_threshold: number;
    pipeline_errors: unknown[];
  };
}

export async function getAgencyKpis(
  period: "mtd" | "last30" | "last90" | "ytd" | "all" = "mtd",
): Promise<AgencyKpisResponse> {
  const { data } = await api.get<AgencyKpisResponse>(
    "/api/agency-dashboard/kpis",
    { params: { period } },
  );
  return data;
}

export interface AgentPerfRow {
  agent_id: string;
  agent_name: string | null;
  email: string | null;
  leads_count: number;
  enrolled_count: number;
  conversion_rate: number;
  estimated_revenue: number;
  trend_pct: number;
  last_active_at: string | null;
  team_size: number;
  status: string;
}

export interface AgentPerfResponse {
  agents: AgentPerfRow[];
}

export async function getAgentPerformance(
  period: "mtd" | "last30" | "last90" | "ytd" | "all" = "mtd",
): Promise<AgentPerfResponse> {
  const { data } = await api.get<AgentPerfResponse>(
    "/api/agency-dashboard/agent-performance",
    { params: { period } },
  );
  return data;
}

export interface AgencyChartsResponse {
  enrollments_by_week: { week: string; count: number }[];
  revenue_by_carrier: { carrier: string; revenue: number }[];
  leads_by_source: { source: string; count: number }[];
}

export async function getAgencyCharts(
  period: "mtd" | "last30" | "last90" | "ytd" | "all" = "mtd",
): Promise<AgencyChartsResponse> {
  const { data } = await api.get<AgencyChartsResponse>(
    "/api/agency-dashboard/charts",
    { params: { period } },
  );
  return data;
}

export interface AgencyAlert {
  level: "info" | "warning" | "critical" | string;
  title: string;
  message: string;
  count?: number;
}

export interface AgencyAlertsResponse {
  alerts: AgencyAlert[];
}

export async function getAgencyAlerts(): Promise<AgencyAlertsResponse> {
  const { data } = await api.get<AgencyAlertsResponse>(
    "/api/agency-dashboard/alerts",
  );
  return data;
}
