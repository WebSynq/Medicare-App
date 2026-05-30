/**
 * Appointment endpoints — /api/appointments/*
 */

import { api } from "./client";
import type {
  Appointment,
  AppointmentCreatePayload,
  AppointmentOutcomePayload,
  AppointmentStatus,
  AppointmentUpdatePayload,
} from "@/types";

export interface AppointmentListResponse {
  appointments: Appointment[];
  total: number;
}

export async function listAppointments(options?: {
  date?: string;
  start_date?: string;
  end_date?: string;
  status?: AppointmentStatus;
  lead_id?: string;
  agent_id?: string;
  limit?: number;
}): Promise<AppointmentListResponse> {
  const { data } = await api.get<AppointmentListResponse>(
    "/api/appointments",
    { params: options },
  );
  return data;
}

export async function createAppointment(
  payload: AppointmentCreatePayload,
): Promise<Appointment> {
  const { data } = await api.post<Appointment>("/api/appointments", payload);
  return data;
}

export async function getAppointment(id: string): Promise<Appointment> {
  const { data } = await api.get<Appointment>(`/api/appointments/${id}`);
  return data;
}

export async function patchAppointment(
  id: string,
  payload: AppointmentUpdatePayload,
): Promise<Appointment> {
  const { data } = await api.patch<Appointment>(
    `/api/appointments/${id}`,
    payload,
  );
  return data;
}

export async function cancelAppointment(id: string): Promise<Appointment> {
  const { data } = await api.delete<Appointment>(`/api/appointments/${id}`);
  return data;
}

/** Feature A — outcome buttons. Stamps a 4-state enum + flips
 *  status to no_show or completed + fires the no-show reschedule
 *  email when applicable + audits appointment_outcome_set. */
export async function setAppointmentOutcome(
  id: string,
  payload: AppointmentOutcomePayload,
): Promise<Appointment> {
  const { data } = await api.post<Appointment>(
    `/api/appointments/${id}/outcome`,
    payload,
  );
  return data;
}
