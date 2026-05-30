/**
 * Super-admin endpoints — /api/super-admin/*
 *
 * Every endpoint requires super_admin. Mutations audit-write. Self-
 * modification is refused on PATCH /users/{id}.
 */

import { api } from "./client";
import type {
  Agency,
  AgencyBillingStatus,
  AgencyFeatureMap,
  AgencyTier,
  AgencyUsage,
  UserRole,
} from "@/types";

// ─── Agencies ──────────────────────────────────────────────────────────────

export interface SuperAdminAgencyRow extends Agency {
  /** Recomputed seat usage from the live users collection (may differ
   *  briefly from the persisted `seats_active` between writes). */
  seats_active_live: number;
  /** Whether a GHL Private Integration Token is stored. The token
   *  itself is never returned. */
  ghl_token_encrypted: boolean;
}

export interface AgenciesListResponse {
  agencies: SuperAdminAgencyRow[];
  total: number;
}

export async function listAgencies(options?: {
  tier?: AgencyTier;
  billing_status?: AgencyBillingStatus;
  q?: string;
}): Promise<AgenciesListResponse> {
  const { data } = await api.get<AgenciesListResponse>(
    "/api/super-admin/agencies",
    { params: options },
  );
  return data;
}

export async function getAgency(
  agencyId: string,
): Promise<SuperAdminAgencyRow> {
  const { data } = await api.get<SuperAdminAgencyRow>(
    `/api/super-admin/agencies/${encodeURIComponent(agencyId)}`,
  );
  return data;
}

export interface AgencyPatchPayload {
  name?: string;
  tier?: AgencyTier;
  notes?: string;
  billing_status?: AgencyBillingStatus;
  seats_max?: number;
  features?: AgencyFeatureMap;
  /** When true, resets features / limits / overage_rates /
   *  monthly_base_amount / seats_included / seats_max to the
   *  defaults baked into TIER_DEFAULTS for the agency's tier
   *  (or the new tier if you patch both at once). */
  apply_tier_defaults?: boolean;
}

export async function patchAgency(
  agencyId: string,
  payload: AgencyPatchPayload,
): Promise<SuperAdminAgencyRow> {
  const { data } = await api.patch<SuperAdminAgencyRow>(
    `/api/super-admin/agencies/${encodeURIComponent(agencyId)}`,
    payload,
  );
  return data;
}

export interface SuperAdminUsageResponse {
  agency: {
    agency_id: string;
    name: string;
    tier: AgencyTier;
    billing_status: AgencyBillingStatus;
    seats_included: number;
    seats_max: number;
    seats_active: number;
  };
  limits: AgencyUsage["limits"];
  usage: {
    agency_id: string;
    billing_period: string;
    live: boolean;
    ai_calls_total: number;
    emails_sent: number;
    app_intakes: number;
    storage_gb: number;
  };
  billing_period: string;
}

export async function getAgencyUsage(
  agencyId: string,
): Promise<SuperAdminUsageResponse> {
  const { data } = await api.get<SuperAdminUsageResponse>(
    `/api/super-admin/agencies/${encodeURIComponent(agencyId)}/usage`,
  );
  return data;
}

// ─── Users ─────────────────────────────────────────────────────────────────

export interface SuperAdminUserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  agency_id: string;
  is_active: boolean;
  status: "pending" | "active" | "rejected";
  agent_name: string | null;
  created_at: string | null;
  mfa_enabled: boolean;
  last_failed_at: string | null;
  locked_until: string | null;
  parent_agent_id: string | null;
}

export interface UsersListResponse {
  users: SuperAdminUserRow[];
  total: number;
}

export async function listUsers(options?: {
  agency_id?: string;
  role?: UserRole;
  q?: string;
}): Promise<UsersListResponse> {
  const { data } = await api.get<UsersListResponse>(
    "/api/super-admin/users",
    { params: options },
  );
  return data;
}

export interface UserPatchPayload {
  role?: UserRole;
  is_active?: boolean;
  status?: "pending" | "active" | "rejected";
  agency_id?: string;
}

export async function patchUser(
  userId: string,
  payload: UserPatchPayload,
): Promise<SuperAdminUserRow> {
  const { data } = await api.patch<SuperAdminUserRow>(
    `/api/super-admin/users/${encodeURIComponent(userId)}`,
    payload,
  );
  return data;
}

// ─── System ────────────────────────────────────────────────────────────────

export interface SystemSectionError {
  error: string;
}

export interface SuperAdminSystemResponse {
  generated_at: string;
  billing_period: string;
  feature_registry: string[] | SystemSectionError;
  tier_keys: string[] | SystemSectionError;
  agencies:
    | {
        total: number;
        active: number;
        past_due: number;
        suspended: number;
        cancelled: number;
      }
    | SystemSectionError;
  users:
    | { total: number; active: number }
    | SystemSectionError;
  env:
    | {
        stripe_secret_configured: boolean;
        stripe_webhook_configured: boolean;
        stripe_mock_mode: boolean;
        resend_configured: boolean;
        anthropic_configured: boolean;
        frontend_url: string;
      }
    | SystemSectionError;
}

export function isSystemError<T>(
  section: T | SystemSectionError,
): section is SystemSectionError {
  return (
    typeof section === "object" &&
    section !== null &&
    "error" in section &&
    typeof (section as SystemSectionError).error === "string"
  );
}

export async function getSystem(): Promise<SuperAdminSystemResponse> {
  const { data } = await api.get<SuperAdminSystemResponse>(
    "/api/super-admin/system",
  );
  return data;
}
