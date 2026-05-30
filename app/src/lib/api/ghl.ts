/**
 * GoHighLevel integration endpoints — /api/ghl-import/*
 * Just the connect / disconnect / status surface for the
 * Integrations tab on /settings. The bulk-import wizard
 * (preview / map-tags / start / jobs / report) lives elsewhere.
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
