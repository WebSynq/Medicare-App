/**
 * Commissions —
 *   - calculator endpoints at /api/commission/*  (carriers + calculate)
 *   - tracking endpoints   at /api/commissions/* (summary, live, upload, history)
 *
 * The backend split: /commission is the calculator that scopes a single
 * deal; /commissions is the ComTrack-backed pull for the agent's actuals.
 */

import { api } from "./client";
import type {
  CommissionCalculatePayload,
  CommissionCalculateResponse,
  CommissionCarriersResponse,
} from "@/types";

// ─── /api/commission (calculator) ──────────────────────────────────────────

export async function getCarriers(): Promise<CommissionCarriersResponse> {
  const { data } = await api.get<CommissionCarriersResponse>(
    "/api/commission/carriers",
  );
  return data;
}

export async function calculate(
  payload: CommissionCalculatePayload,
): Promise<CommissionCalculateResponse> {
  const { data } = await api.post<CommissionCalculateResponse>(
    "/api/commission/calculate",
    payload,
  );
  return data;
}

// ─── /api/commissions (ComTrack pulls + statement upload) ─────────────────

export interface CommissionSummary {
  agent_name?: string;
  ytd_total?: number;
  ytd_paid?: number;
  ytd_pending?: number;
  ytd_chargebacks?: number;
  this_month_total?: number;
  last_month_total?: number;
  by_carrier?: Array<{
    carrier: string;
    total: number;
    paid?: number;
    pending?: number;
    chargebacks?: number;
  }>;
  by_product?: Array<{ product: string; total: number }>;
  mock?: boolean;
  [key: string]: unknown;
}

export interface CommissionLiveRow {
  agent_name?: string;
  carrier?: string;
  product?: string;
  client_name?: string;
  policy_number?: string;
  statement_date?: string;
  amount?: number;
  status?: string;
  [key: string]: unknown;
}

export interface CommissionLiveResponse {
  rows: CommissionLiveRow[];
  total: number;
  cache_hit: boolean;
  agent_name: string;
}

export interface CommissionUpload {
  id?: string;
  agent_id?: string;
  agent_name?: string;
  filename?: string;
  uploaded_at?: string;
  file_size?: number;
  status?: string;
  carrier?: string;
  statement_date?: string;
  rows_processed?: number;
  total_amount?: number;
  notes?: string;
  [key: string]: unknown;
}

export interface CommissionHistoryResponse {
  uploads: CommissionUpload[];
  total: number;
}

export async function getSummary(): Promise<CommissionSummary> {
  const { data } = await api.get<CommissionSummary>("/api/commissions/summary");
  return data;
}

export async function getLive(options?: {
  carrier?: string;
  date?: string;
  refresh?: boolean;
}): Promise<CommissionLiveResponse> {
  const { data } = await api.get<CommissionLiveResponse>(
    "/api/commissions/live",
    {
      params: {
        ...(options?.carrier ? { carrier: options.carrier } : {}),
        ...(options?.date ? { date: options.date } : {}),
        ...(options?.refresh ? { refresh: true } : {}),
      },
    },
  );
  return data;
}

export async function getHistory(): Promise<CommissionHistoryResponse> {
  const { data } = await api.get<CommissionHistoryResponse>(
    "/api/commissions/history",
  );
  return data;
}

export async function uploadStatement(
  file: File,
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<Record<string, unknown>>(
    "/api/commissions/upload",
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}

// ─── /api/leaderboard (preview widget on /commissions) ────────────────────

export interface LeaderboardRow {
  rank: number;
  agent_name: string;
  agent_split: number;
  agent_split_pct: number;
  /** Admin / compliance only. */
  revenue_total?: number;
  audit_gap: number;
  policies_count: number;
  is_self: boolean;
}

export interface LeaderboardResponse {
  period: "week" | "month" | "ytd" | "all";
  rows: LeaderboardRow[];
  total: number;
}

export async function getLeaderboard(
  period: "week" | "month" | "ytd" | "all" = "month",
  limit = 10,
): Promise<LeaderboardResponse> {
  const { data } = await api.get<LeaderboardResponse>("/api/leaderboard", {
    params: { period, limit },
  });
  return data;
}
