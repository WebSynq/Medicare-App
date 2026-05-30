/**
 * Agency settings endpoints — /api/agency/*
 *
 * GET /settings  — name + tier + billing + seats overview (any auth user)
 * PATCH /settings — name only for owner/admin (tier/billing are
 *                   super-admin-only and live on /api/super-admin/*)
 * GET /usage      — live usage roll-up vs tier limits (any auth user)
 */

import { api } from "./client";
import type { AgencySettings, AgencyUsage } from "@/types";

export async function getSettings(): Promise<AgencySettings> {
  const { data } = await api.get<AgencySettings>("/api/agency/settings");
  return data;
}

export interface AgencySettingsPatchPayload {
  name?: string;
}

export async function patchSettings(
  payload: AgencySettingsPatchPayload,
): Promise<AgencySettings> {
  const { data } = await api.patch<AgencySettings>(
    "/api/agency/settings",
    payload,
  );
  return data;
}

export async function getUsage(): Promise<AgencyUsage> {
  const { data } = await api.get<AgencyUsage>("/api/agency/usage");
  return data;
}
