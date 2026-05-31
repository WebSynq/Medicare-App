/**
 * Admin commissions overview — /api/admin/commissions
 *
 * Admin / compliance roster of every agent with their commission
 * upload stats and derived "current / stale / no_data" status.
 */

import { api } from "./client";

export type CommissionStatus = "current" | "stale" | "no_data";
export type AccountStatus = "active" | "pending" | "rejected" | string;

export interface AgentCommissionRow {
  id: string;
  full_name: string;
  email: string;
  agency_name: string;
  account_status: AccountStatus;
  created_at: string | null;
  total_uploads: number;
  digested_count: number;
  not_recognized_count: number;
  rejected_count: number;
  last_upload: string | null;
  commission_status: CommissionStatus;
  ytd_commission: number | null;
  active_policies: number | null;
}

export interface AdminCommissionsResponse {
  agents: AgentCommissionRow[];
  summary: {
    total_agents: number;
    current: number;
    stale: number;
    no_data: number;
  };
}

export async function getAll(): Promise<AdminCommissionsResponse> {
  const { data } = await api.get<AdminCommissionsResponse>(
    "/api/admin/commissions",
  );
  return data;
}
