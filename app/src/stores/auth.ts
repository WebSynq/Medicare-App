/**
 * Auth store.
 *
 * Mirrors the backend's session state for synchronous access from
 * route guards + the sidebar. The httpOnly cookie is the source
 * of truth; we hydrate by calling /api/auth/me on app mount and
 * mirror the result here. NOT persisted across reloads because
 * stale data on a revoked session is worse than a one-time
 * network hop.
 */

"use client";

import { create } from "zustand";

import type { User, UserRole } from "@/types";
import { FULL_AGENCY_SCOPE_ROLES, IMPERSONATION_ROLES } from "@/types";

export type AuthStatus = "unknown" | "authed" | "anon";

interface AuthState {
  status: AuthStatus;
  user: User | null;

  setUser: (user: User) => void;
  clear: () => void;
  setStatus: (status: AuthStatus) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "unknown",
  user: null,

  setUser: (user) => set({ status: "authed", user }),
  clear: () => set({ status: "anon", user: null }),
  setStatus: (status) => set({ status }),
}));

/** Selectors — call from components so re-renders are scoped. */
export const selectUser = (s: AuthState): User | null => s.user;
export const selectStatus = (s: AuthState): AuthStatus => s.status;
export const selectIsAuthed = (s: AuthState): boolean => s.status === "authed";
export const selectRole = (s: AuthState): UserRole | null =>
  s.user?.role ?? null;

/** Permission helpers backed by the role constants in @/types. */
export const selectHasAgencyScope = (s: AuthState): boolean => {
  const role = s.user?.role;
  if (!role) return false;
  return FULL_AGENCY_SCOPE_ROLES.includes(role);
};

export const selectCanImpersonate = (s: AuthState): boolean => {
  const role = s.user?.role;
  if (!role) return false;
  return IMPERSONATION_ROLES.includes(role);
};

export const selectIsSuperAdmin = (s: AuthState): boolean =>
  s.user?.super_admin ?? false;
