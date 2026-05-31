/**
 * Admin data-import — /api/admin/import/*
 *
 * Preview-then-commit flow for the GHW production tracker. Preview
 * caches the parsed rows under a batch_id; commit confirms and
 * inserts. History lists past batches; rollback hard-deletes a
 * batch's records.
 */

import { api } from "./client";

export interface AgentMatchEntry {
  email: string;
  name: string;
  id?: string;
}

export interface PreviewSampleRow {
  agent: string;
  client: string;
  carrier: string;
  product_type: string;
  premium: number | string | null;
  revenue: number | string | null;
  app_date: string | null;
}

export interface PreviewParseError {
  row_num: number;
  raw: string;
  reason: string;
}

export interface ImportPreviewResponse {
  batch_id: string;
  filename: string;
  summary: {
    total_raw_rows: number;
    rows_parsed: number;
    rows_valid_new: number;
    rows_duplicate: number;
    rows_error: number;
  };
  agents: {
    matched: AgentMatchEntry[];
    unmatched: AgentMatchEntry[];
  };
  product_breakdown: Record<string, number>;
  sample_rows: PreviewSampleRow[];
  errors: PreviewParseError[];
}

export interface ImportCommitResponse {
  success: boolean;
  batch_id: string;
  records_inserted: number;
  records_skipped: number;
  agents_unmatched: AgentMatchEntry[];
}

export interface ImportBatchSummary {
  batch_id: string;
  filename: string;
  imported_by: string;
  imported_at: string;
  records_inserted: number;
  records_skipped: number;
  agents_matched: number;
  agents_unmatched: AgentMatchEntry[];
  rolled_back?: boolean;
  rolled_back_at?: string;
  rolled_back_by?: string;
}

export interface ImportHistoryResponse {
  batches: ImportBatchSummary[];
}

export interface ImportRollbackResponse {
  success: boolean;
  batch_id: string;
  records_deleted: number;
}

export async function preview(file: File): Promise<ImportPreviewResponse> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<ImportPreviewResponse>(
    "/api/admin/import/preview",
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}

export async function commit(
  batchId: string,
): Promise<ImportCommitResponse> {
  const { data } = await api.post<ImportCommitResponse>(
    "/api/admin/import/commit",
    { batch_id: batchId, confirm: true },
  );
  return data;
}

export async function getHistory(): Promise<ImportHistoryResponse> {
  const { data } = await api.get<ImportHistoryResponse>(
    "/api/admin/import/history",
  );
  return data;
}

export async function rollback(
  batchId: string,
): Promise<ImportRollbackResponse> {
  const { data } = await api.delete<ImportRollbackResponse>(
    `/api/admin/import/${batchId}`,
  );
  return data;
}
