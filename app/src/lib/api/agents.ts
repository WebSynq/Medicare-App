/**
 * Agent management — /api/agents/*
 *
 * Admin / compliance roster with per-agent production roll-up, plus
 * team-member assignment endpoints and the activate/deactivate
 * status toggle.
 */

import { api } from "./client";
import type { UserRole, UserStatus } from "@/types";

export interface AgentRosterRow {
  id: string;
  full_name: string | null;
  email: string | null;
  agent_name: string | null;
  agent_npn: string | null;
  agent_id: string | null;
  role: UserRole | null;
  is_active: boolean;
  status: UserStatus | null;
  agency_name: string | null;
  ghl_location_id: string | null;
  created_at: string | null;
  lead_count: number;
  policy_count: number;
  production_revenue: number;
  last_submission_date: string | null;
  team_count: number;
}

export interface AgentListResponse {
  agents: AgentRosterRow[];
  count: number;
}

export interface TeamMember {
  id: string;
  email: string | null;
  full_name: string | null;
  agent_name: string | null;
  role: UserRole | null;
  is_active?: boolean;
  parent_agent_id?: string | null;
}

export interface TeamMembersResponse {
  members: TeamMember[];
  count: number;
}

export async function list(): Promise<AgentListResponse> {
  const { data } = await api.get<AgentListResponse>("/api/agents");
  return data;
}

export async function getTeam(agentId: string): Promise<TeamMembersResponse> {
  const { data } = await api.get<TeamMembersResponse>(
    `/api/agents/${agentId}/team`,
  );
  return data;
}

export async function assignTeam(
  agentId: string,
  userId: string,
): Promise<{ success: boolean; user_id: string; parent_agent_id: string }> {
  const { data } = await api.post(`/api/agents/${agentId}/team`, {
    user_id: userId,
  });
  return data;
}

export async function removeTeam(
  agentId: string,
  userId: string,
): Promise<{
  success: boolean;
  user_id: string;
  parent_agent_id: string | null;
}> {
  const { data } = await api.delete(`/api/agents/${agentId}/team/${userId}`);
  return data;
}

export async function updateStatus(
  agentId: string,
  isActive: boolean,
): Promise<{ success: boolean; agent_id: string; is_active: boolean }> {
  const { data } = await api.patch(`/api/agents/${agentId}/status`, {
    is_active: isActive,
  });
  return data;
}
