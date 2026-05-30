/**
 * SOA — /api/soa/*
 */

import { api } from "./client";
import type { SoaListResponse, SoaRecord } from "@/types";

export async function listByLead(leadId: string): Promise<SoaListResponse> {
  const { data } = await api.get<SoaListResponse>(
    `/api/soa/by-lead-list/${leadId}`,
  );
  return data;
}

export async function sendSoa(leadId: string): Promise<SoaRecord> {
  const { data } = await api.post<SoaRecord>(`/api/soa/send/${leadId}`);
  return data;
}
