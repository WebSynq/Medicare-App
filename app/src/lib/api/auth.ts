/**
 * Auth endpoints — mirror /api/auth/* on the backend.
 *
 * The backend plants the httpOnly session cookie on every
 * successful auth response, so the SPA never sees the access
 * token text. We forward the cookie automatically via the
 * shared axios client's `withCredentials: true`.
 *
 * Login flow:
 *   1. POST /login {email, password} — returns either:
 *        a) LoginSuccessResponse  — cookie planted, ship to /today
 *        b) LoginMfaRequiredResponse — session_token returned,
 *           SPA pushes /mfa and posts /mfa/verify
 *   2. POST /mfa/verify {session_token, code} — cookie planted.
 *
 * Magic-link flow:
 *   1. POST /magic-link {email} — backend emails a signed URL.
 *   2. The URL lands on /auth/magic?token=…; the page POSTs
 *      /magic-link/verify {token}, cookie planted, ship to /today.
 */

import { api } from "./client";
import type {
  LoginPayload,
  LoginResponse,
  MagicLinkPayload,
  MagicLinkVerifyPayload,
  MfaBackupCodePayload,
  MfaStatus,
  MfaVerifyPayload,
  User,
} from "@/types";

export async function login(payload: LoginPayload): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>("/api/auth/login", payload);
  return data;
}

export async function logout(): Promise<void> {
  await api.post("/api/auth/logout");
}

export async function getMe(): Promise<User> {
  const { data } = await api.get<User>("/api/auth/me");
  return data;
}

export async function refreshSession(): Promise<void> {
  await api.post("/api/auth/refresh");
}

export async function requestMagicLink(payload: MagicLinkPayload): Promise<void> {
  // Opaque 200 by design — never leaks whether the email exists.
  await api.post("/api/auth/magic-link", payload);
}

export async function verifyMagicLink(
  payload: MagicLinkVerifyPayload,
): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>(
    "/api/auth/magic-link/verify",
    payload,
  );
  return data;
}

export async function verifyMfa(
  payload: MfaVerifyPayload,
): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>(
    "/api/auth/mfa/verify",
    payload,
  );
  return data;
}

export async function consumeMfaBackupCode(
  payload: MfaBackupCodePayload,
): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>(
    "/api/auth/mfa/backup-code",
    payload,
  );
  return data;
}

export async function getMfaStatus(): Promise<MfaStatus> {
  const { data } = await api.get<MfaStatus>("/api/auth/mfa/status");
  return data;
}
