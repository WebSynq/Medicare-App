import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowUpRight,
  ShieldCheck,
  AlertCircle,
  FileSignature,
  UserCheck,
  UserX,
  UserPlus,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import InviteAgentModal from "@/components/InviteAgentModal";

const STATUS_COLORS = {
  new: "bg-secondary text-secondary-foreground",
  contacted: "bg-amber-100 text-amber-900",
  qualified: "bg-emerald-100 text-emerald-900",
  enrolled: "bg-primary text-primary-foreground",
  lost: "bg-muted text-muted-foreground",
};

export default function AgentDashboard() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState([]);
  const [pendingBusy, setPendingBusy] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const user = auth.getUser();
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (isAdmin) loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/leads");
      setLeads(res.data);
    } finally {
      setLoading(false);
    }
  };

  const loadPending = async () => {
    try {
      const res = await api.get("/auth/pending");
      setPending(res.data);
    } catch (e) {
      /* non-fatal */
    }
  };

  const decide = async (userId, action) => {
    setPendingBusy(userId);
    try {
      await api.post(`/auth/users/${userId}/${action}`);
      toast.success(action === "approve" ? "Agent approved" : "Request rejected");
      setPending((cur) => cur.filter((p) => p.id !== userId));
    } catch (e) {
      toast.error(e?.response?.data?.detail || `${action} failed`);
    } finally {
      setPendingBusy(null);
    }
  };

  const counts = {
    total: leads.length,
    new: leads.filter((l) => l.status === "new").length,
    soa: leads.filter((l) => l.soa_signed).length,
    synced: leads.filter(
      (l) => l.ghl_sync_status === "synced" || l.ghl_sync_status === "mock"
    ).length,
    errors: leads.filter((l) => l.ghl_sync_status === "error").length,
  };

  const recentLeads = leads.slice(0, 5);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        {/* Welcome row */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
              Dashboard
            </p>
            <h1 className="text-2xl font-bold text-[#1e2d3d]">
              Welcome, {user?.full_name || user?.email?.split("@")[0] || "Administrator"}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Daily operations overview
            </p>
            <ImpersonationBanner />
            {!user?.mfa_enabled && (
              <button
                type="button"
                onClick={() => navigate("/mfa-setup")}
                className="mt-3 flex items-center gap-2 text-sm text-[#1e2d3d] border border-[#1e2d3d]/20 rounded-lg px-3 py-2 hover:bg-[#1e2d3d]/5 transition-colors"
                data-testid="mfa-banner"
              >
                <span>🛡️</span>
                <span>Enable MFA on your account</span>
              </button>
            )}
          </div>
          {user?.role === "admin" && (
            <button
              onClick={() => setShowInvite(true)}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium flex-shrink-0"
              style={{ border: "1px solid #1e2d3d", color: "#1e2d3d" }}
              data-testid="invite-agent-header"
            >
              + Invite Agent
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 w-full overflow-hidden mb-6">
          <StatCard label="Total leads" value={counts.total} />
          <StatCard label="New" value={counts.new} accent />
          <StatCard label="SOA signed" value={counts.soa} icon={FileSignature} />
          <StatCard label="Synced to GHL" value={counts.synced} icon={ShieldCheck} />
          <StatCard label="Sync errors" value={counts.errors} danger icon={AlertCircle} />
        </div>

        {isAdmin && pending.length > 0 && (
          <Card
            className="border-border bg-surface mb-5"
            data-testid="pending-agents-card"
          >
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                    Pending agents ({pending.length})
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  {user?.role === "admin" && (
                    <button
                      onClick={() => setShowInvite(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium"
                      style={{
                        background: "rgba(30,45,61,0.08)",
                        color: "#1e2d3d",
                        border: "1px solid rgba(30,45,61,0.2)",
                      }}
                      data-testid="invite-agent-pending"
                    >
                      + Invite Agent
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadPending}
                    data-testid="pending-refresh"
                  >
                    Refresh
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Agency</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map((p) => (
                      <TableRow key={p.id} data-testid={`pending-row-${p.id}`}>
                        <TableCell className="font-medium">
                          {p.full_name || "—"}
                        </TableCell>
                        <TableCell className="text-sm">{p.email}</TableCell>
                        <TableCell className="text-sm">
                          {p.agency_name || "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(p.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex gap-2">
                            <Button
                              size="sm"
                              disabled={pendingBusy === p.id}
                              onClick={() => decide(p.id, "approve")}
                              data-testid={`pending-approve-${p.id}`}
                            >
                              <UserCheck className="w-3.5 h-3.5 mr-1.5" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pendingBusy === p.id}
                              onClick={() => decide(p.id, "reject")}
                              data-testid={`pending-reject-${p.id}`}
                            >
                              <UserX className="w-3.5 h-3.5 mr-1.5" /> Reject
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent clients — full list lives at /clients */}
        <Card className="border-border bg-surface">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                Recent clients
              </h3>
              <Button asChild variant="outline" size="sm" data-testid="view-all-clients">
                <Link to="/clients">
                  View All Clients
                  <ArrowUpRight className="w-3.5 h-3.5 ml-1.5" />
                </Link>
              </Button>
            </div>
            <div className="overflow-x-auto w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Beneficiary</TableHead>
                    <TableHead>Phone / Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        Loading…
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading && recentLeads.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No clients yet. New intake submissions will appear here.
                      </TableCell>
                    </TableRow>
                  )}
                  {recentLeads.map((l) => (
                    <TableRow
                      key={l.id}
                      className="hover:bg-secondary/40"
                      data-testid={`lead-row-${l.id}`}
                    >
                      <TableCell className="font-medium">
                        <Link
                          to={`/clients/${l.id}`}
                          className="hover:text-primary"
                          data-testid={`lead-link-${l.id}`}
                        >
                          {l.first_name} {l.last_name}
                        </Link>
                        {l.mbi_number && (
                          <div className="text-xs text-muted-foreground font-mono">
                            MBI ••••{l.mbi_number.slice(-4)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{l.phone || "—"}</div>
                        <div className="text-muted-foreground text-xs">
                          {l.email || ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={`rounded-full capitalize ${
                            STATUS_COLORS[l.status] || "bg-secondary"
                          }`}
                        >
                          {l.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(l.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/clients/${l.id}`}
                          className="text-primary hover:underline"
                          data-testid={`lead-open-${l.id}`}
                        >
                          <ArrowUpRight className="w-4 h-4" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* FAB — New Intake — always visible, bottom right */}
      <Link
        to="/intake"
        className="fixed z-50 flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95 bottom-[4.5rem] md:bottom-6 right-6"
        style={{
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          background: "#e85d2f",
          color: "white",
          boxShadow: "0 4px 14px rgba(232, 93, 47, 0.4)",
        }}
        aria-label="New Intake"
        title="New Intake"
        data-testid="new-intake-fab"
      >
        <svg
          width="24"
          height="24"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 4.5v15m7.5-7.5h-15"
          />
        </svg>
      </Link>

      {showInvite && <InviteAgentModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}

function StatCard({ label, value, accent, danger, icon: Icon }) {
  return (
    <Card
      className={`border-border min-w-0 overflow-hidden ${
        accent
          ? "bg-primary text-primary-foreground"
          : danger
            ? "bg-destructive/10"
            : "bg-surface"
      }`}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest opacity-80">{label}</div>
          {Icon && (
            <Icon
              className={`w-4 h-4 ${danger ? "text-destructive" : "opacity-70"}`}
            />
          )}
        </div>
        <div
          className="text-3xl font-bold mt-2 tabular-nums"
          style={{ fontFamily: "Outfit" }}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
