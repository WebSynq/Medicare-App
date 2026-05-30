/**
 * Lead endpoints — /api/leads/*
 */

import { api } from "./client";
import type { Lead, LeadCreatePayload, LeadStatus, LeadUpdatePayload } from "@/types";

export interface LeadListResponse {
  leads: Lead[];
  total: number;
}

export interface ListLeadsParams {
  status?: LeadStatus;
  tags?: string[];
  q?: string;
  limit?: number;
  skip?: number;
}

export async function listLeads(
  options?: ListLeadsParams,
): Promise<LeadListResponse> {
  const params: Record<string, string | number> = {};
  if (options?.status) params.status = options.status;
  if (options?.tags?.length) params.tags = options.tags.join(",");
  if (options?.q) params.q = options.q;
  if (options?.limit != null) params.limit = options.limit;
  if (options?.skip != null) params.skip = options.skip;
  const { data } = await api.get<LeadListResponse>("/api/leads", { params });
  return data;
}

export async function getLead(id: string): Promise<Lead> {
  const { data } = await api.get<Lead>(`/api/leads/${id}`);
  return data;
}

export async function createLead(payload: LeadCreatePayload): Promise<Lead> {
  const { data } = await api.post<Lead>("/api/leads", payload);
  return data;
}

export async function patchLead(
  id: string,
  payload: LeadUpdatePayload,
): Promise<Lead> {
  const { data } = await api.patch<Lead>(`/api/leads/${id}`, payload);
  return data;
}

export async function syncLeadToGhl(id: string): Promise<{
  synced: boolean;
  ghl_contact_id: string | null;
  error?: string;
}> {
  const { data } = await api.post(`/api/leads/${id}/sync-ghl`);
  return data;
}
