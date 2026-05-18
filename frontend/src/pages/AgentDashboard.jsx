import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ArrowUpRight, Filter, ShieldCheck, AlertCircle, FileSignature, UserCheck, UserX, UserPlus } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";
import { AppHeader, Footer } from "@/components/Layout";
import InviteAgentModal from "@/components/InviteAgentModal";

const STATUS_COLORS = {
  new: "bg-secondary text-secondary-foreground",
  contacted: "bg-amber-100 text-amber-900",
  qualified: "bg-emerald-100 text-emerald-900",
  enrolled: "bg-primary text-primary-foreground",
  lost: "bg-muted text-muted-foreground",
};

const SYNC_DOT = {
  pending: "bg-amber-500",
  synced: "bg-emerald-500",
  mock: "bg-blue-500",
  error: "bg-destructive",
};

export default function AgentDashboard() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState([]);
  const [pendingBusy, setPendingBusy] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const user = auth.getUser();
  const isAdmin = user?.role === "admin";

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isAdmin) loadPending(); }, [isAdmin]);
  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/leads", { params: { status: status === "all" ? undefined : status, q: q || undefined } });
      setLeads(res.data);
    } finally { setLoading(false); }
  };
  const loadPending = async () => {
    try {
      const res = await api.get("/auth/pending");
      setPending(res.data);
    } catch (e) { /* non-fatal */ }
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
    synced: leads.filter((l) => l.ghl_sync_status === "synced" || l.ghl_sync_status === "mock").length,
    errors: leads.filter((l) => l.ghl_sync_status === "error").length,
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader />
      <main className="flex-1 max-w-[1400px] mx-auto w-full px-6 py-8">
        {/* Welcome row */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
              Lead Pipeline
            </p>
            <h1 className="text-2xl font-bold text-[#1e2d3d]">
              Welcome, {user?.full_name || user?.email?.split("@")[0] || "Administrator"}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Review encrypted intake submissions and sync to GoHighLevel.
            </p>
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

        <LeaderboardCard />

        {isAdmin && pending.length > 0 && (
          <Card className="border-border bg-surface mb-5" data-testid="pending-agents-card">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Pending agents ({pending.length})</h3>
                </div>
                <div className="flex items-center gap-2">
                  {user?.role === "admin" && (
                    <button
                      onClick={() => setShowInvite(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium"
                      style={{ background: "rgba(30,45,61,0.08)", color: "#1e2d3d", border: "1px solid rgba(30,45,61,0.2)" }}
                      data-testid="invite-agent-pending"
                    >
                      + Invite Agent
                    </button>
                  )}
                  <Button variant="ghost" size="sm" onClick={loadPending} data-testid="pending-refresh">Refresh</Button>
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
                        <TableCell className="font-medium">{p.full_name || "—"}</TableCell>
                        <TableCell className="text-sm">{p.email}</TableCell>
                        <TableCell className="text-sm">{p.agency_name || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex gap-2">
                            <Button size="sm" disabled={pendingBusy === p.id} onClick={() => decide(p.id, "approve")} data-testid={`pending-approve-${p.id}`}>
                              <UserCheck className="w-3.5 h-3.5 mr-1.5" /> Approve
                            </Button>
                            <Button size="sm" variant="outline" disabled={pendingBusy === p.id} onClick={() => decide(p.id, "reject")} data-testid={`pending-reject-${p.id}`}>
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

        <Card className="border-border bg-surface">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <div className="relative flex-1 min-w-[240px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, phone..."
                  className="pl-9 h-10"
                  value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && load()}
                  data-testid="lead-search"
                />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44 h-10" data-testid="status-filter"><Filter className="w-4 h-4 mr-2" /><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="contacted">Contacted</SelectItem>
                  <SelectItem value="qualified">Qualified</SelectItem>
                  <SelectItem value="enrolled">Enrolled</SelectItem>
                  <SelectItem value="lost">Lost</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={load} data-testid="reload-leads">Refresh</Button>
            </div>

            <div className="overflow-x-auto w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Beneficiary</TableHead>
                    <TableHead>Phone / Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>SOA</TableHead>
                    <TableHead>GHL</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Loading...</TableCell></TableRow>
                  )}
                  {!loading && leads.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No leads yet. New intake submissions will appear here in real time.</TableCell></TableRow>
                  )}
                  {leads.map((l) => (
                    <TableRow key={l.id} className="hover:bg-secondary/40" data-testid={`lead-row-${l.id}`}>
                      <TableCell className="font-medium">
                        <Link to={`/leads/${l.id}`} className="hover:text-primary" data-testid={`lead-link-${l.id}`}>{l.first_name} {l.last_name}</Link>
                        {l.mbi_number && <div className="text-xs text-muted-foreground font-mono">MBI ••••{l.mbi_number.slice(-4)}</div>}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{l.phone || "—"}</div>
                        <div className="text-muted-foreground text-xs">{l.email || ""}</div>
                      </TableCell>
                      <TableCell>
                        <Badge className={`rounded-full capitalize ${STATUS_COLORS[l.status] || "bg-secondary"}`}>{l.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {l.soa_signed
                          ? <span className="text-xs flex items-center gap-1.5 text-primary"><FileSignature className="w-3.5 h-3.5" />Signed</span>
                          : <span className="text-xs text-muted-foreground">Pending</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`w-2 h-2 rounded-full ${SYNC_DOT[l.ghl_sync_status] || "bg-muted"}`} />
                          <span className="capitalize">{l.ghl_sync_status}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString()}</TableCell>
                      <TableCell>
                        <Link to={`/leads/${l.id}`} className="text-primary hover:underline" data-testid={`lead-open-${l.id}`}><ArrowUpRight className="w-4 h-4" /></Link>
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
        <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </Link>

      <Footer />

      {showInvite && <InviteAgentModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}

function StatCard({ label, value, accent, danger, icon: Icon }) {
  return (
    <Card className={`border-border min-w-0 overflow-hidden ${accent ? "bg-primary text-primary-foreground" : danger ? "bg-destructive/10" : "bg-surface"}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-widest opacity-80">{label}</div>
          {Icon && <Icon className={`w-4 h-4 ${danger ? "text-destructive" : "opacity-70"}`} />}
        </div>
        <div className="text-3xl font-bold mt-2 tabular-nums" style={{fontFamily:'Outfit'}}>{value}</div>
      </CardContent>
    </Card>
  );
}


// ── Leaderboard card ────────────────────────────────────────────────────────
// Sources GET /api/leaderboard. The backend ranks by revenue_total (desc) and
// stamps is_self=true on the caller's row when their users.agent_name matches
// — we just highlight that row visually and render the period selector.

function fmtUSD(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(val);
}

function LeaderboardCard() {
  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState("all");
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [period]);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/leaderboard", { params: { period, limit: 25 } });
      setRows(data.rows || []);
    } catch (e) {
      // Non-fatal — leaderboard 503s shouldn't break the rest of the dashboard.
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-border bg-surface mb-5" data-testid="leaderboard-card">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
            Leaderboard
          </h3>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-36 h-9" data-testid="leaderboard-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Last 7 days</SelectItem>
              <SelectItem value="month">Last 30 days</SelectItem>
              <SelectItem value="ytd">Year to date</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No production records yet. Import the tracker to populate the board.
          </p>
        ) : (
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Policies</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.agent_name + r.rank}
                    className={r.is_self ? "bg-orange-50" : ""}
                    data-testid={`leaderboard-row-${r.rank}`}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.rank}
                    </TableCell>
                    <TableCell className="font-medium">
                      {r.agent_name}
                      {r.is_self && (
                        <Badge className="ml-2 rounded-full bg-[#e85d2f]/15 text-[#e85d2f] border-0 text-[10px]">
                          you
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.policies_count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {fmtUSD(r.revenue_total)}
                    </TableCell>
                    {/* audit_gap is signed: negative = underpaid (owed to agent),
                        positive = overpaid. We highlight underpaid in red since
                        that's the actionable state for the agent. */}
                    <TableCell
                      className={`text-right tabular-nums ${
                        r.audit_gap < 0 ? "text-red-600 font-medium" : ""
                      }`}
                    >
                      {r.audit_gap == null
                        ? "—"
                        : r.audit_gap === 0
                          ? "$0.00"
                          : (r.audit_gap < 0 ? "−" : "+") + fmtUSD(Math.abs(r.audit_gap))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
