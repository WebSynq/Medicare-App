import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { setImpersonatedAgent } from "@/lib/api";

const STORAGE_KEY = "ghw_impersonated_agent";

const AgentContext = createContext({
  selectedAgent: null,
  setSelectedAgent: () => {},
  clearAgent: () => {},
  isImpersonating: false,
});

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AgentProvider({ children }) {
  // Persist across reloads so the X-Agent-ID header (a module-level var in
  // api.js that resets on every reload) and the impersonation banner stay in
  // sync — admins refreshing the page shouldn't silently drop back to their
  // own scope without the banner updating.
  const [selectedAgent, setSelectedAgentState] = useState(readStored);

  useEffect(() => {
    setImpersonatedAgent(selectedAgent);
    if (selectedAgent) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedAgent));
      } catch {
        // localStorage full or disabled — header is still set in-memory.
      }
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [selectedAgent]);

  const setSelectedAgent = useCallback((agent) => {
    setSelectedAgentState(agent || null);
  }, []);

  const clearAgent = useCallback(() => {
    setSelectedAgentState(null);
  }, []);

  return (
    <AgentContext.Provider
      value={{
        selectedAgent,
        setSelectedAgent,
        clearAgent,
        isImpersonating: !!selectedAgent,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  return useContext(AgentContext);
}
