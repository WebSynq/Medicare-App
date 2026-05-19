import { Eye } from "lucide-react";
import { useAgent } from "@/context/AgentContext";

// Small pill rendered directly under a page title whenever the admin /
// compliance user has impersonation active. Returns null when not
// impersonating so callers can drop it in unconditionally and the banner
// only shows up when relevant.
export default function ImpersonationBanner({ className = "" }) {
  const { isImpersonating, selectedAgent } = useAgent();
  if (!isImpersonating || !selectedAgent) return null;
  const name =
    selectedAgent.full_name ||
    selectedAgent.agent_name ||
    selectedAgent.email ||
    "Agent";
  return (
    <div
      className={`inline-flex items-center gap-2 mt-2 pl-2 pr-3 py-1 rounded-md border-l-4 border-[#e85d2f] bg-amber-50 text-amber-900 text-xs ${className}`}
      data-testid="impersonation-banner"
    >
      <Eye className="w-3.5 h-3.5 text-[#e85d2f]" />
      <span>
        Viewing as: <span className="font-semibold">{name}</span>
      </span>
    </div>
  );
}
