/**
 * Notes + tasks — /api/notes/*
 */

import { api } from "./client";
import type {
  NoteCreatePayload,
  NoteListResponse,
  NoteRecord,
} from "@/types";

export async function listByLead(leadId: string): Promise<NoteListResponse> {
  const { data } = await api.get<NoteListResponse>("/api/notes", {
    params: { lead_id: leadId },
  });
  return data;
}

export async function createNote(
  payload: NoteCreatePayload,
): Promise<NoteRecord> {
  const { data } = await api.post<NoteRecord>("/api/notes", payload);
  return data;
}

export async function completeTask(noteId: string): Promise<NoteRecord> {
  const { data } = await api.patch<NoteRecord>(
    `/api/notes/${noteId}/complete`,
  );
  return data;
}

export async function deleteNote(noteId: string): Promise<void> {
  await api.delete(`/api/notes/${noteId}`);
}
