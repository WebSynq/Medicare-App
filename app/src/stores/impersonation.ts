/**
 * Impersonation store.
 *
 * Admins / owners / compliance / coach / accounting can "view as"
 * an individual agent by setting selectedAgent. The store mirrors
 * the active impersonation target AND writes it to the api/client
 * module-level state so the X-Agent-ID request header flows on
 * every subsequent axios call.
 *
 * Persisted to localStorage so a page reload keeps the
 * impersonation context. The persist middleware runs only on the
 * client; SSR sees the unhydrated default.
 */

"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { setImpersonationAgentId } from "@/lib/api";

export interface ImpersonatedAgent {
  id: string;
  name: string;
  email: string | null;
}

interface ImpersonationState {
  selectedAgent: ImpersonatedAgent | null;
  setAgent: (agent: ImpersonatedAgent) => void;
  clearAgent: () => void;
}

export const useImpersonationStore = create<ImpersonationState>()(
  persist(
    (set) => ({
      selectedAgent: null,
      setAgent: (agent) => {
        setImpersonationAgentId(agent.id);
        set({ selectedAgent: agent });
      },
      clearAgent: () => {
        setImpersonationAgentId(null);
        set({ selectedAgent: null });
      },
    }),
    {
      name: "ghw:impersonation",
      storage: createJSONStorage(() => localStorage),
      // Restoring from localStorage on app mount also needs to
      // re-arm the api/client module-level state so the very
      // first request after reload carries X-Agent-ID. The
      // onRehydrateStorage callback fires after the store
      // hydrates from disk.
      onRehydrateStorage: () => (rehydrated) => {
        if (rehydrated?.selectedAgent) {
          setImpersonationAgentId(rehydrated.selectedAgent.id);
        }
      },
    },
  ),
);

export const selectIsImpersonating = (s: ImpersonationState): boolean =>
  s.selectedAgent !== null;

export const selectImpersonatedAgent = (
  s: ImpersonationState,
): ImpersonatedAgent | null => s.selectedAgent;
