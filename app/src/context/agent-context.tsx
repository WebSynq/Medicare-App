"use client";

import * as React from "react";

import { setImpersonationAgentId } from "@/lib/api";
import {
  type ImpersonatedAgent,
  useImpersonationStore,
} from "@/stores";

/**
 * Agent (impersonation) context — Next.js port of
 * `frontend/src/context/AgentContext.jsx`.
 *
 * The actual state + persistence lives in the Zustand
 * `useImpersonationStore` (which the X-Agent-ID axios interceptor
 * already reads from). This Provider is a thin React-context
 * facade so the CRA-style `useAgent()` consumer hook is available
 * verbatim in the Next.js app, and so the AgentProvider becomes
 * the obvious mount point in the authed layout for any future
 * cross-cutting concerns (analytics, audit, etc).
 *
 * On mount we re-arm the api/client module-level state from the
 * store, so the first request after a hard reload carries
 * X-Agent-ID even if the Zustand rehydrate ran late. The store
 * itself also calls `setImpersonationAgentId` on every state
 * change, so the interceptor stays in sync for the rest of the
 * session.
 */

export interface AgentContextValue {
  selectedAgent: ImpersonatedAgent | null;
  setSelectedAgent: (agent: ImpersonatedAgent | null) => void;
  clearAgent: () => void;
  isImpersonating: boolean;
}

const AgentContext = React.createContext<AgentContextValue>({
  selectedAgent: null,
  setSelectedAgent: () => {},
  clearAgent: () => {},
  isImpersonating: false,
});

export function AgentProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const selectedAgent = useImpersonationStore((s) => s.selectedAgent);
  const setAgent = useImpersonationStore((s) => s.setAgent);
  const clearAgent = useImpersonationStore((s) => s.clearAgent);

  // Hard-reload defense: the persist middleware rehydrates the
  // store asynchronously, but the api/client module-level header
  // ref also resets to null. Push the store value back into the
  // interceptor once on mount so the very first request after
  // reload still carries X-Agent-ID.
  React.useEffect(() => {
    setImpersonationAgentId(selectedAgent?.id ?? null);
  }, [selectedAgent]);

  const setSelectedAgent = React.useCallback(
    (agent: ImpersonatedAgent | null) => {
      if (agent) {
        setAgent(agent);
      } else {
        clearAgent();
      }
    },
    [setAgent, clearAgent],
  );

  const value = React.useMemo<AgentContextValue>(
    () => ({
      selectedAgent,
      setSelectedAgent,
      clearAgent,
      isImpersonating: selectedAgent !== null,
    }),
    [selectedAgent, setSelectedAgent, clearAgent],
  );

  return (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
}

/** CRA parity — `useAgent()` returns the same shape as
 *  `frontend/src/context/AgentContext.jsx`. */
export function useAgent(): AgentContextValue {
  return React.useContext(AgentContext);
}
