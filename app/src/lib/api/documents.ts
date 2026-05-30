/**
 * Documents — /api/documents/*
 */

import { api } from "./client";
import type {
  DocumentListResponse,
  DocumentType,
  LeadDocument,
} from "@/types";

export async function listByLead(leadId: string): Promise<DocumentListResponse> {
  const { data } = await api.get<DocumentListResponse>(
    `/api/documents/by-lead/${leadId}`,
  );
  return data;
}

export async function uploadDocument(
  leadId: string,
  file: File,
  docType: DocumentType,
): Promise<LeadDocument> {
  const form = new FormData();
  form.append("file", file);
  form.append("doc_type", docType);
  const { data } = await api.post<LeadDocument>(
    `/api/documents/upload/${leadId}`,
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}

/** Returns the absolute backend URL for a document download. The
 *  browser handles auth via the credentialed cookie when followed
 *  via <a href>, so we return a URL rather than a Blob — avoids
 *  buffering the whole file into JS memory. */
export function downloadUrl(docId: string): string {
  const base = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";
  return `${base.replace(/\/+$/, "")}/api/documents/${docId}/download`;
}
