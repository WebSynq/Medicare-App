import { useState } from "react";
import { X as XIcon } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

// Roles an admin can grant from this modal. Kept in sync with the
// InviteRequest.role Literal on the backend — "admin" is intentionally
// not invitable here (privilege escalation requires DB-level intervention).
const INVITABLE_ROLES = [
  { value: "agent", label: "Agent" },
  { value: "owner", label: "Owner" },
  { value: "coach", label: "Coach" },
  { value: "accounting", label: "Accounting" },
  { value: "client_success", label: "Client Success" },
  { value: "compliance", label: "Compliance" },
  { value: "sales_manager", label: "Sales Manager" },
  { value: "cyber_security", label: "Cyber Security" },
  { value: "onboarding", label: "Onboarding" },
  { value: "crm_specialist", label: "CRM Specialist" },
  { value: "va", label: "Virtual Assistant" },
  { value: "support", label: "Support" },
];

export default function InviteAgentModal({ onClose }) {
  const [form, setForm] = useState({
    email: "",
    full_name: "",
    agency_name: "",
    agent_name: "",
    agent_npn: "",
    role: "agent",
  });
  const [loading, setLoading] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);

  const handleSubmit = async () => {
    if (!form.email) { toast.error("Email is required"); return; }
    // Client Success and other non-agent roles don't earn commissions, so
    // the carrier-statement name doesn't apply to them. Only enforce the
    // requirement for the "agent" role.
    if (form.role === "agent" && !form.agent_name.trim()) {
      toast.error("Full Name (as on carrier statements) is required for agents");
      return;
    }
    // Send only fields the user filled in. Backend validators reject empty
    // strings on agent_npn (must be 5-10 digits) so we drop falsy values
    // before posting.
    const payload = Object.fromEntries(
      Object.entries(form).filter(([_, v]) => v !== "")
    );
    setLoading(true);
    try {
      const { data } = await api.post("/auth/invite", payload);
      setInviteUrl(data.invite_url);
      toast.success("Invite created successfully");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create invite");
    } finally {
      setLoading(false);
    }
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(inviteUrl);
    toast.success("Invite link copied to clipboard");
  };

  // Shared styling for form inputs/selects so every control matches
  // the rest of the app's shadcn chrome.
  const inputCls =
    "w-full px-3 py-2 rounded-lg text-sm outline-none border border-border bg-background text-foreground focus:ring-2 focus:ring-[#e85d2f]/40";
  const labelCls =
    "block text-xs font-medium mb-1.5 uppercase tracking-[0.08em] text-muted-foreground";

  return (
    // Outer backdrop — semi-opaque black layer over the whole viewport.
    // The inner card uses solid shadcn surface tokens (bg-card / border)
    // so the modal is fully opaque regardless of theme. The previous
    // version pointed every surface at undefined CSS variables
    // (--color-background-primary, etc.) which silently resolved to
    // transparent and made the modal invisible.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Invite a new agent"
    >
      <div
        className="w-full max-w-md rounded-xl p-6 bg-card text-card-foreground border border-border shadow-xl max-h-[90vh] overflow-y-auto"
        data-testid="invite-agent-modal"
      >
        <div className="flex items-center justify-between mb-6">
          <h2
            className="font-semibold text-lg text-foreground"
            style={{ letterSpacing: "-0.02em" }}
          >
            Invite New Agent
          </h2>
          <button
            onClick={onClose}
            className="p-1 -mr-1 text-muted-foreground hover:text-foreground rounded transition-colors"
            aria-label="Close"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {!inviteUrl ? (
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Email Address *</label>
              <input
                type="email"
                placeholder="agent@agency.com"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                className={inputCls}
              >
                {INVITABLE_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] mt-1 text-muted-foreground">
                {form.role === "client_success"
                  ? "Client Success sees all agents' clients but never commission data."
                  : "Controls which screens the invited user can access."}
              </p>
            </div>
            <div>
              <label className={labelCls}>Full Name</label>
              <input
                type="text"
                placeholder="Jane Smith"
                value={form.full_name}
                onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Agency Name</label>
              <input
                type="text"
                placeholder="Smith Insurance Group"
                value={form.agency_name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, agency_name: e.target.value }))
                }
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                Full Name (as it appears on carrier statements) *
              </label>
              <input
                type="text"
                placeholder="Name as it appears on carrier commission statements"
                value={form.agent_name}
                onChange={(e) => setForm((f) => ({ ...f, agent_name: e.target.value }))}
                maxLength={100}
                required
                className={inputCls}
              />
              <p className="text-[11px] mt-1 text-muted-foreground">
                Used to look up this agent's commissions. Must match carrier
                statements exactly.
              </p>
            </div>
            <div>
              <label className={labelCls}>NPN (National Producer Number)</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{5,10}"
                placeholder="5-10 digit National Producer Number"
                value={form.agent_npn}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    agent_npn: e.target.value.replace(/\D/g, "").slice(0, 10),
                  }))
                }
                className={inputCls}
              />
            </div>
            <div className="pt-2 flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg text-sm font-medium border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 py-2 rounded-lg text-sm font-medium text-white bg-[#e85d2f] hover:bg-[#c84416] disabled:opacity-60 transition-opacity"
              >
                {loading ? "Creating..." : "Create Invite"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div
              className="rounded-lg p-3 text-center"
              style={{
                background: "rgba(26,107,60,0.1)",
                border: "1px solid rgba(26,107,60,0.2)",
              }}
            >
              <p className="text-sm font-medium" style={{ color: "#1a6b3c" }}>
                ✓ Invite created — expires in 24 hours
              </p>
            </div>
            <div>
              <label className={labelCls}>Invite Link</label>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={inviteUrl}
                  className="flex-1 px-3 py-2 rounded-lg text-xs outline-none border border-border bg-background text-muted-foreground"
                />
                <button
                  onClick={copyUrl}
                  className="px-4 py-2 rounded-lg text-sm font-medium flex-shrink-0 text-white"
                  style={{ background: "#1e2d3d" }}
                >
                  Copy
                </button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Send this link to the agent. It is single-use and expires in 24
              hours. The agent must register using the email address you
              entered above.
            </p>
            <button
              onClick={onClose}
              className="w-full py-2 rounded-lg text-sm font-medium text-white bg-[#e85d2f] hover:bg-[#c84416] transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
