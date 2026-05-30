/**
 * Application submission endpoints — /api/applications/*
 *
 *   POST /extract              — AI extraction of a carrier app PDF
 *   POST /upload-supporting    — bulk supporting-doc upload (SOA / EFT / ID …)
 *   POST /submit               — final submission + GHL push
 *   GET  /extracted-data/{lead_id}
 *   GET  /search-contacts?query=
 */

import { api } from "./client";

export interface ExtractResponse {
  product_type: string;
  product_label: string;
  extracted: Record<string, string | number | null>;
  field_count: number;
  fields_available: string[];
  auto_detected: boolean;
  pdf_url: string;
  main_extracted: Record<string, unknown>;
  main_confidences: Record<string, number>;
  doc_type: string;
}

export async function extractApplication(
  file: File,
  productType?: string,
): Promise<ExtractResponse> {
  const form = new FormData();
  form.append("file", file);
  if (productType) form.append("product_type", productType);
  const { data } = await api.post<ExtractResponse>(
    "/api/applications/extract",
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}

export interface SupportingDoc {
  file_id?: string;
  filename: string;
  file_label: string;
  s3_url: string;
  s3_key: string;
  size_bytes: number;
  content_type: string;
  doc_type?: string | null;
  extracted: Record<string, unknown>;
  confidences: Record<string, number>;
}

export interface UploadSupportingResponse {
  uploaded: SupportingDoc[];
  total: number;
  total_size_bytes: number;
}

export async function uploadSupporting(
  files: File[],
  labels?: string[],
  contactId?: string,
): Promise<UploadSupportingResponse> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  if (labels) form.append("labels", JSON.stringify(labels));
  if (contactId) form.append("contact_id", contactId);
  const { data } = await api.post<UploadSupportingResponse>(
    "/api/applications/upload-supporting",
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}

export interface SubmitApplicationPayload {
  contact_id: string;
  product_type: string;
  extracted: Record<string, string | number | null>;
  contact_name?: string;
  pdf_url?: string;
  supporting_documents?: SupportingDoc[];
  main_extracted?: Record<string, unknown>;
  main_confidences?: Record<string, number>;
}

export interface SubmitApplicationResponse {
  policy_id: string;
  lead_id: string;
  ghl_synced: boolean;
  ghl_sync_error: string | null;
  ghl_contact_id: string | null;
  product_type: string;
  fields_pushed: number;
  supporting_count: number;
}

export async function submitApplication(
  payload: SubmitApplicationPayload,
): Promise<SubmitApplicationResponse> {
  const { data } = await api.post<SubmitApplicationResponse>(
    "/api/applications/submit",
    payload,
  );
  return data;
}

export interface GhlContact {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  /** Side-effect import returns the portal lead id so the SPA can
   *  deep-link to /clients/{lead_id}. */
  lead_id?: string;
}

export async function searchContacts(query: string): Promise<GhlContact[]> {
  const { data } = await api.get<{ contacts: GhlContact[] }>(
    "/api/applications/search-contacts",
    { params: { query } },
  );
  return data.contacts;
}
