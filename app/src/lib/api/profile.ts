/**
 * Profile endpoints — /api/profile/*
 * Covers: profile patch (incl. password change), booking-settings
 * patch, sessions list. Used by the /settings page tabs.
 */

import { api } from "./client";
import type {
  BookingSettingsPatchPayload,
  ProfileMe,
  ProfilePatchPayload,
  ProfileSessionsResponse,
} from "@/types";

export async function getMe(): Promise<ProfileMe> {
  const { data } = await api.get<ProfileMe>("/api/profile/me");
  return data;
}

export async function patchMe(
  payload: ProfilePatchPayload,
): Promise<ProfileMe> {
  const { data } = await api.patch<ProfileMe>("/api/profile/me", payload);
  return data;
}

export async function patchBookingSettings(
  payload: BookingSettingsPatchPayload,
): Promise<ProfileMe> {
  const { data } = await api.patch<ProfileMe>(
    "/api/profile/booking-settings",
    payload,
  );
  return data;
}

export async function getSessions(): Promise<ProfileSessionsResponse> {
  const { data } = await api.get<ProfileSessionsResponse>(
    "/api/profile/sessions",
  );
  return data;
}
