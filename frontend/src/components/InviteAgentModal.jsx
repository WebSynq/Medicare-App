import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";

export default function InviteAgentModal({ onClose }) {
  const [form, setForm] = useState({
    email: "",
    full_name: "",
    agency_name: "",
    agent_name: "",
    agent_npn: "",
  });
  const [loading, setLoading] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);

  const handleSubmit = async () => {
    if (!form.email) { toast.error("Email is required"); return; }
    if (!form.agent_name.trim()) {
      toast.error("Full Name (as on carrier statements) is required");
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-md rounded-xl p-6"
        style={{ background: "var(--color-background-primary)", border: "1px solid var(--color-border-tertiary)" }}>

        <div className="flex items-center justify-between mb-6">
          <h2 className="font-semibold text-lg" style={{ color: "var(--color-text-primary)", letterSpacing: "-0.02em" }}>
            Invite New Agent
          </h2>
          <button onClick={onClose} className="text-xl leading-none" style={{ color: "var(--color-text-secondary)" }}>✕</button>
        </div>

        {!inviteUrl ? (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase" style={{ letterSpacing: "0.08em", color: "var(--color-text-secondary)" }}>
                Email Address *
              </label>
              <input
                type="email"
                placeholder="agent@agency.com"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "var(--color-background-secondary)", border: "1px solid var(--color-border-tertiary)", color: "var(--color-text-primary)" }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase" style={{ letterSpacing: "0.08em", color: "var(--color-text-secondary)" }}>
                Full Name
              </label>
              <input
                type="text"
                placeholder="Jane Smith"
                value={form.full_name}
                onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "var(--color-background-secondary)", border: "1px solid var(--color-border-tertiary)", color: "var(--color-text-primary)" }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase" style={{ letterSpacing: "0.08em", color: "var(--color-text-secondary)" }}>
                Agency Name
              </label>
              <input
                type="text"
                placeholder="Smith Insurance Group"
                value={form.agency_name}
                onChange={e => setForm(f => ({ ...f, agency_name: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "var(--color-background-secondary)", border: "1px solid var(--color-border-tertiary)", color: "var(--color-text-primary)" }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase" style={{ letterSpacing: "0.08em", color: "var(--color-text-secondary)" }}>
                Full Name (as it appears on carrier statements) *
              </label>
              <input
                type="text"
                placeholder="Name as it appears on carrier commission statements"
                value={form.agent_name}
                onChange={e => setForm(f => ({ ...f, agent_name: e.target.value }))}
                maxLength={100}
                required
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "var(--color-background-secondary)", border: "1px solid var(--color-border-tertiary)", color: "var(--color-text-primary)" }}
              />
              <p className="text-[11px] mt-1" style={{ color: "var(--color-text-secondary)" }}>
                Used to look up this agent's commissions. Must match carrier statements exactly.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase" style={{ letterSpacing: "0.08em", color: "var(--color-text-secondary)" }}>
                NPN (National Producer Number)
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{5,10}"
                placeholder="5-10 digit National Producer Number"
                value={form.agent_npn}
                onChange={e => setForm(f => ({ ...f, agent_npn: e.target.value.replace(/\D/g, "").slice(0, 10) }))}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "var(--color-background-secondary)", border: "1px solid var(--color-border-tertiary)", color: "var(--color-text-primary)" }}
              />
            </div>
            <div className="pt-2 flex gap-3">
              <button onClick={onClose}
                className="flex-1 py-2 rounded-lg text-sm font-medium"
                style={{ background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border-tertiary)" }}>
                Cancel
              </button>
              <button onClick={handleSubmit} disabled={loading}
                className="flex-1 py-2 rounded-lg text-sm font-medium transition-opacity"
                style={{ background: "#e85d2f", color: "white", opacity: loading ? 0.6 : 1 }}>
                {loading ? "Creating..." : "Create Invite"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg p-3 text-center"
              style={{ background: "rgba(26,107,60,0.1)", border: "1px solid rgba(26,107,60,0.2)" }}>
              <p className="text-sm font-medium" style={{ color: "#1a6b3c" }}>✓ Invite created — expires in 24 hours</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5 uppercase" style={{ letterSpacing: "0.08em", color: "var(--color-text-secondary)" }}>
                Invite Link
              </label>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={inviteUrl}
                  className="flex-1 px-3 py-2 rounded-lg text-xs outline-none"
                  style={{ background: "var(--color-background-secondary)", border: "1px solid var(--color-border-tertiary)", color: "var(--color-text-secondary)" }}
                />
                <button onClick={copyUrl}
                  className="px-4 py-2 rounded-lg text-sm font-medium flex-shrink-0"
                  style={{ background: "#1e2d3d", color: "white" }}>
                  Copy
                </button>
              </div>
            </div>
            <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              Send this link to the agent. It is single-use and expires in 24 hours. The agent must register using the email address you entered above.
            </p>
            <button onClick={onClose}
              className="w-full py-2 rounded-lg text-sm font-medium"
              style={{ background: "#e85d2f", color: "white" }}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
