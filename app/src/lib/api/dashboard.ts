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

/** Row shapes mirror what backend/agency_dashboard_router.py:/charts
 *  actually returns (verified 2026-05). The earlier drafts that
 *  declared only `{week,count}` and `{source,count}` predicted a
 *  shape that never shipped; the production CRA reads `label`,
 *  `total`, and `enrolled`. */
export interface EnrollmentsByWeekRow {
  /** ISO week key, e.g. "2024-W12". */
  week: string;
  /** Short display label for chart axis, e.g. "Mar 18". */
  label: string;
  count: number;
}
export interface RevenueByCarrierRow {
  carrier: string;
  revenue: number;
  count: number;
}
export interface LeadsBySourceRow {
  source: string;
  total: number;
  enrolled: number;
  conversion_rate: number;
}

export interface AgencyChartsResponse {
  enrollments_by_week: EnrollmentsByWeekRow[];
  revenue_by_carrier: RevenueByCarrierRow[];
  leads_by_source: LeadsBySourceRow[];
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

/** @deprecated Earlier draft expected a `{ alerts: AgencyAlert[] }`
 *  envelope; backend never shipped that shape. Kept on the response
 *  union so existing callers reading `.alerts` still typecheck while
 *  they get migrated to the per-category arrays below. */
export interface AgencyAlert {
  level: "info" | "warning" | "critical" | string;
  title: string;
  message: string;
  count?: number;
}

export interface StaleLeadAlertRow {
  agent_id: string;
  agent_name: string;
  count: number;
}

export interface BirthdayWindowAlertRow {
  lead_id: string;
  client_name: string;
  agent_name: string;
  days_remaining: number;
  carrier: string | null;
}

export interface RenewalDueAlertRow {
  lead_id: string | null;
  client_name: string;
  agent_name: string;
  renewal_date: string;
  days_until: number;
  carrier: string | null;
}

/** What backend/agency_dashboard_router.py:/alerts actually returns
 *  (verified 2026-05): three per-category arrays. The `alerts` field
 *  is kept optional for backwards compatibility with the deprecated
 *  envelope shape — see AgencyAlert. */
export interface AgencyAlertsResponse {
  stale_leads?: StaleLeadAlertRow[];
  birthday_windows?: BirthdayWindowAlertRow[];
  renewals_due?: RenewalDueAlertRow[];
  /** @deprecated — never returned by the backend; preserved on the
   *  type for the AlertsRow callsite in /admin until migrated. */
  alerts?: AgencyAlert[];
  _meta?: Record<string, unknown>;
}

export async function getAgencyAlerts(): Promise<AgencyAlertsResponse> {
  const { data } = await api.get<AgencyAlertsResponse>(
    "/api/agency-dashboard/alerts",
  );
  return data;
}

// ─── Agency dashboard drilldown ────────────────────────────────────────────

export type DrilldownMetric =
  | "leads"
  | "enrolled"
  | "policies"
  | "revenue"
  | "birthday_windows"
  | "renewals"
  | "stale_leads";

/** Row shape is metric-specific — see backend agency_dashboard_router.py
 *  `drilldown()`. The page's column registry knows which keys to render
 *  per metric. Kept as a loose record so a backend column add doesn't
 *  break the typecheck before the column registry is updated. */
export type DrilldownRow = Record<string, unknown>;

export interface DrilldownResponse {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  rows: DrilldownRow[];
}

export async function getAgencyDrilldown(
  metric: DrilldownMetric,
  opts: {
    period?: "mtd" | "last30" | "last90" | "ytd" | "all";
    agent_id?: string | null;
    page?: number;
  } = {},
): Promise<DrilldownResponse> {
  const params: Record<string, string | number> = {
    period: opts.period ?? "mtd",
    page: opts.page ?? 1,
  };
  if (opts.agent_id) params.agent_id = opts.agent_id;
  const { data } = await api.get<DrilldownResponse>(
    `/api/agency-dashboard/drilldown/${metric}`,
    { params },
  );
  return data;
}
