/**
 * Audit log endpoints — /api/audit/*
 *
 * Admin + compliance only. Read-only. Export streams CSV or JSON.
 */

import { api } from "./client";

export interface AuditRow {
  id?: string;
  event_type: string;
  timestamp: string;
  actor_email?: string | null;
  actor_id?: string | null;
  actor_role?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  session_id?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuditSummary {
  total: number;
  by_event_type: { event_type: string; count: number }[];
}

export interface AuditFilters {
  event_type?: string;
  actor_email?: string;
  target_type?: string;
  target_id?: string;
  limit?: number;
}

export async function listAudit(
  filters: AuditFilters = {},
): Promise<AuditRow[]> {
  const { data } = await api.get<AuditRow[] | { events: AuditRow[] }>(
    "/api/audit",
    { params: filters },
  );
  // Backend returns a bare array (limit-truncated, no envelope) but
  // tolerate either shape since other readers may wrap it.
  if (Array.isArray(data)) return data;
  return data.events ?? [];
}

export async function getAuditSummary(): Promise<AuditSummary> {
  const { data } = await api.get<AuditSummary>("/api/audit/summary");
  return data;
}

export function auditExportUrl(options: {
  start?: string;
  end?: string;
  event_type?: string;
  format?: "csv" | "json";
  limit?: number;
}): string {
  const params = new URLSearchParams();
  if (options.start) params.set("start", options.start);
  if (options.end) params.set("end", options.end);
  if (options.event_type) params.set("event_type", options.event_type);
  params.set("format", options.format ?? "csv");
  if (options.limit) params.set("limit", String(options.limit));
  const base = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";
  return `${base}/api/audit/export?${params.toString()}`;
}
