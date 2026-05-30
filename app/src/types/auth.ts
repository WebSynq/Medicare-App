/**
 * Auth + user shapes.
 *
 * Mirrors the backend `models.UserPublic` / login-flow responses
 * exactly. Anything renamed here is wrong — the API contract is
 * authoritative.
 */

import type { BookingSettings } from "./calendar";

/** Every role the backend's UserBase Literal accepts. Used in
 *  permission gates throughout the SPA. */
export type UserRole =
  | "admin"
  | "owner"
  | "agent"
  | "compliance"
  | "va"
  | "support"
  | "crm_specialist"
  | "cyber_security"
  | "sales_manager"
  | "onboarding"
  | "client_success"
  | "coach"
  | "accounting";

export type UserStatus = "pending" | "active" | "rejected";

/** The deps.FULL_AGENCY_SCOPE_ROLES list. Users in this set see
 *  every record in their agency on lead/client reads; everyone else
 *  is self-scoped via agent_filter. Kept as a value-level constant
 *  here (not just a type) so role gates can do `.includes(user.role)`
 *  at runtime. */
export const FULL_AGENCY_SCOPE_ROLES: readonly UserRole[] = [
  "admin",
  "owner",
  "compliance",
] as const;

/** deps.IMPERSONATION_ROLES. */
export const IMPERSONATION_ROLES: readonly UserRole[] = [
  "admin",
  "owner",
  "compliance",
  "coach",
  "accounting",
] as const;

/** What `/api/auth/me` returns. */
export interface User {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  is_active: boolean;
  status: UserStatus;
  agency_id: string;
  agency_name: string | null;
  phone: string | null;
  timezone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_npn: string | null;
  ghl_location_id: string | null;
  parent_agent_id: string | null;
  failed_attempts: number;
  last_failed_at: string | null;
  locked_until: string | null;
  token_version: number;
  booking_settings: BookingSettings | null;
  mfa_enabled: boolean;
  mfa_verified_at: string | null;
  super_admin: boolean;
  created_at: string;
}

/** POST /api/auth/login body. */
export interface LoginPayload {
  email: string;
  password: string;
}

/** Successful POST /api/auth/login response when MFA is OFF. */
export interface LoginSuccessResponse {
  access_token: string;
  token_type: "bearer";
  user: User;
  mfa_required?: false;
}

/** Response when the account has MFA enabled — the SPA redirects
 *  to /mfa and exchanges the session token for an access token via
 *  POST /api/auth/mfa/verify. */
export interface LoginMfaRequiredResponse {
  mfa_required: true;
  session_token: string;
  /** When the session token expires (ISO datetime). 5 min from issue. */
  expires_at: string;
}

export type LoginResponse = LoginSuccessResponse | LoginMfaRequiredResponse;

/** POST /api/auth/magic-link body. */
export interface MagicLinkPayload {
  email: string;
}

/** POST /api/auth/magic-link/verify body — the token comes from
 *  the URL the user clicked in their email. */
export interface MagicLinkVerifyPayload {
  token: string;
}

/** POST /api/auth/mfa/verify body. */
export interface MfaVerifyPayload {
  session_token: string;
  code: string;
}

/** POST /api/auth/mfa/backup-code body. */
export interface MfaBackupCodePayload {
  session_token: string;
  backup_code: string;
}

/** GET /api/auth/mfa/status response. */
export interface MfaStatus {
  mfa_enabled: boolean;
  enrolled_at: string | null;
  backup_codes_remaining: number;
}
