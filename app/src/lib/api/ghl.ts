/**
 * GoHighLevel integration endpoints — /api/ghl-import/*
 * Connect / disconnect / status drive the Integrations tab on
 * /settings; the rest (preview / map-tags / start / jobs / report)
 * drive the bulk-import wizard on /import.
 */

import { api } from "./client";
import type { GhlConnectPayload, GhlIntegrationStatus } from "@/types";

export async function getStatus(): Promise<GhlIntegrationStatus> {
  const { data } = await api.get<GhlIntegrationStatus>(
    "/api/ghl-import/status",
  );
  return data;
}

export async function connect(
  payload: GhlConnectPayload,
): Promise<GhlIntegrationStatus> {
  const { data } = await api.post<GhlIntegrationStatus>(
    "/api/ghl-import/connect",
    payload,
  );
  return data;
}

export async function disconnect(): Promise<{ disconnected: boolean }> {
  const { data } = await api.delete<{ disconnected: boolean }>(
    "/api/ghl-import/connect",
  );
  return data;
}

// ── Bulk-import wizard ─────────────────────────────────────────────────────

export interface GhlPreviewResponse {
  total_contacts: number;
  sample_size: number;
  sample_fields: string[];
  unique_tags: string[];
  estimated_duplicates: number;
  missing_email_pct: number;
  missing_dob_pct: number;
}

export interface GhlTagMappingResponse {
  mapping: Record<string, string | null>;
  portal_tags: string[];
}

export interface GhlStartImportResponse {
  job_id: string;
  status: "pending" | "running" | "complete" | "failed" | "cancelled";
}

export interface GhlImportJob {
  job_id: string;
  agent_id: string;
  agency_id: string;
  started_at: string | null;
  completed_at: string | null;
  status: "pending" | "running" | "complete" | "failed" | "cancelled";
  total_contacts: number;
  processed: number;
  imported: number;
  duplicates: number;
  flagged: number;
  failed: number;
  current_page: number;
  overwrite_existing?: boolean;
  tag_mapping?: Record<string, string | null>;
  error_log?: string[];
}

export interface GhlJobsResponse {
  jobs: GhlImportJob[];
  count: number;
}

export async function preview(): Promise<GhlPreviewResponse> {
  const { data } = await api.post<GhlPreviewResponse>(
    "/api/ghl-import/preview",
  );
  return data;
}

export async function mapTags(
  tags: string[],
): Promise<GhlTagMappingResponse> {
  const { data } = await api.post<GhlTagMappingResponse>(
    "/api/ghl-import/map-tags",
    { tags },
  );
  return data;
}

export async function startImport(payload: {
  tag_mapping: Record<string, string | null>;
  overwrite_existing?: boolean;
}): Promise<GhlStartImportResponse> {
  const { data } = await api.post<GhlStartImportResponse>(
    "/api/ghl-import/start",
    payload,
  );
  return data;
}

export async function listJobs(): Promise<GhlJobsResponse> {
  const { data } = await api.get<GhlJobsResponse>("/api/ghl-import/jobs");
  return data;
}

export async function getJob(jobId: string): Promise<GhlImportJob> {
  const { data } = await api.get<GhlImportJob>(
    `/api/ghl-import/jobs/${jobId}`,
  );
  return data;
}

export async function cancelJob(
  jobId: string,
): Promise<{ cancelled: boolean; job_id: string }> {
  const { data } = await api.post(`/api/ghl-import/jobs/${jobId}/cancel`);
  return data;
}
