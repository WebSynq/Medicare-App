import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { api } from "@/lib/api";
import ScrollableCard from "@/components/ScrollableCard";

// ── Shared helpers (kept inline so this page stays self-contained) ──────────
function fmt(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(val);
}

function fmtGap(gap) {
  if (gap == null) return "—";
  if (Math.abs(gap) < 0.005) return "$0.00";
  return (gap < 0 ? "−" : "+") + fmt(Math.abs(gap));
}

function fmtDate(iso) {
  if (!iso) return "—";
  // production_records.effective_date is stored as ISO date string.
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

const STATUS_STYLES = {
  missing:   { className: "bg-red-100 text-red-900",        label: "Missing" },
  underpaid: { className: "bg-orange-100 text-orange-900",  label: "Underpaid" },
  overpaid:  { className: "bg-blue-100 text-blue-900",      label: "Overpaid" },
  matched:   { className: "bg-emerald-100 text-emerald-900", label: "Matched" },
  pending:   { className: "bg-muted text-muted-foreground", label: "Pending" },
  resolved:  { className: "bg-slate-200 text-slate-700",    label: "Resolved" },
};

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.pending;
  return (
    <Badge className={`rounded-full capitalize border-0 ${style.className}`}>
      {style.label}
    </Badge>
  );
}

// Escapes a single CSV cell. Wraps in quotes when the value contains a comma,
// quote, or newline; doubles embedded quotes per RFC 4180.
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(filename, rows, headers) {
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function AccountingDashboard() {
  // Filter state. Period is the only param that hits /summary; the rest are
  // applied client-side on top of the records list so the user can re-slice
  // without re-fetching.
  const [period, setPeriod] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [carrierFilter, setCarrierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const [summary, setSummary] = useState(null);
  const [allRows, setAllRows] = useState([]);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingRows, setLoadingRows] = useState(true);
  // Canonical agent list from the leaderboard. Used so the agent filter
  // shows every active agent even when they have no audit rows in the
  // current period (otherwise the dropdown would shrink as data fades).
  const [leaderboardAgents, setLeaderboardAgents] = useState([]);

  // Modal state for "Mark Resolved"
  const [resolveRow, setResolveRow] = useState(null); // record being resolved
  const [resolveNotes, setResolveNotes] = useState("");
  const [resolving, setResolving] = useState(false);

  // ── data fetching ────────────────────────────────────────────────────────
  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const { data } = await api.get("/commission/audit/summary", { params: { period } });
      setSummary(data);
    } catch (e) {
      console.error(e);
      toast.error("Could not load audit summary");
    } finally {
      setLoadingSummary(false);
    }
  }, [period]);

  const fetchRows = useCallback(async () => {
    setLoadingRows(true);
    try {
      // Pull the broadest result set the API allows for the period; we filter
      // by agent/carrier/status client-side. 1000 is the server's hard cap.
      const { data } = await api.get("/commission/audit", {
        params: { period, status: "all", limit: 1000 },
      });
      setAllRows(data.records || []);
    } catch (e) {
      console.error(e);
      toast.error("Could not load audit records");
    } finally {
      setLoadingRows(false);
    }
  }, [period]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { fetchRows(); }, [fetchRows]);

  // One-time load of the canonical agent list (period-independent).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/leaderboard", {
          params: { period: "all", limit: 1000 },
        });
        if (!alive) return;
        const names = (data.rows || [])
          .map((r) => r.agent_name)
          .filter(Boolean);
        setLeaderboardAgents(names);
      } catch (e) {
        // Non-fatal — fall back to row-derived agent options below.
        if (alive) setLeaderboardAgents([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  // ── derived ──────────────────────────────────────────────────────────────
  // Dropdown options come from the data we have, so the lists are scoped to
  // what's actually present in this period — no stale carriers or agents.
  const agentOptions = useMemo(() => {
    // Leaderboard list is the canonical source; we also union any agents
    // that appear in the current rows but aren't on the leaderboard yet
    // so admins never see a row whose agent isn't selectable.
    const set = new Set(leaderboardAgents);
    allRows.forEach((r) => {
      if (r.agent_name) set.add(r.agent_name);
    });
    return Array.from(set).sort();
  }, [leaderboardAgents, allRows]);

  const carrierOptions = useMemo(() => {
    const set = new Set(allRows.map((r) => r.carrier).filter(Boolean));
    return Array.from(set).sort();
  }, [allRows]);

  const filteredRows = useMemo(() => {
    return allRows.filter((r) => {
      if (agentFilter !== "all" && r.agent_name !== agentFilter) return false;
      if (carrierFilter !== "all" && r.carrier !== carrierFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      return true;
    });
  }, [allRows, agentFilter, carrierFilter, statusFilter]);

  const counts = summary?.count_by_status || {};
  const unresolved = (counts.missing ?? 0) + (counts.underpaid ?? 0)
                      + (counts.overpaid ?? 0) + (counts.pending ?? 0);
  const totalGap = summary?.total_gap ?? 0;

  // ── handlers ─────────────────────────────────────────────────────────────
  const openResolve = (row) => {
    setResolveRow(row);
    setResolveNotes("");
  };

  const submitResolve = async () => {
    if (!resolveRow) return;
    const trimmed = resolveNotes.trim();
    if (!trimmed) {
      toast.error("Notes are required to mark a record resolved.");
      return;
    }
    const recordId = resolveRow.natural_key || resolveRow.id;
    setResolving(true);
    try {
      await api.post(`/commission/audit/mark-resolved/${recordId}`, { notes: trimmed });
      toast.success(`Marked ${resolveRow.policy_number} resolved.`);
      setResolveRow(null);
      // Refresh in parallel — summary counts will shift and the row status flips.
      await Promise.all([fetchSummary(), fetchRows()]);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not mark resolved.");
    } finally {
      setResolving(false);
    }
  };

  const onExport = () => {
    if (filteredRows.length === 0) {
      toast.error("Nothing to export — no rows match the current filters.");
      return;
    }
    const headers = [
      "agent_name", "carrier", "policy_number", "effective_date",
      "expected", "received", "gap", "status", "notes",
    ];
    const rows = filteredRows.map((r) => [
      r.agent_name,
      r.carrier,
      r.policy_number,
      r.effective_date,
      r.revenue_expected,
      r.revenue_received,
      r.gap,
      r.status,
      r.audit_notes,
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`commission_audit_${period}_${stamp}.csv`, rows, headers);
  };

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#1e2d3d]">Accounting</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Agency-wide commission audit. Reconcile expected vs received
              across every agent and carrier.
            </p>
          </div>
          <Button
            onClick={onExport}
            className="bg-[#1e2d3d] hover:bg-[#1e2d3d]/90 text-white"
            data-testid="accounting-export"
          >
            Export CSV
          </Button>
        </div>

        {/* Top summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 w-full overflow-hidden">
          <Card className="min-w-0">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Expected
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-[#1e2d3d]">
                {loadingSummary ? "—" : fmt(summary?.total_expected ?? 0)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {summary?.policies ?? 0} policies
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Received
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-[#1e2d3d]">
                {loadingSummary ? "—" : fmt(summary?.total_received ?? 0)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {counts.matched ?? 0} matched · {counts.resolved ?? 0} resolved
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Gap
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${totalGap < 0 ? "text-red-600" : totalGap > 0 ? "text-blue-600" : "text-[#1e2d3d]"}`}>
                {loadingSummary ? "—" : fmtGap(totalGap)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {totalGap < 0 ? "Owed to agents" : totalGap > 0 ? "Overpaid" : "All settled"}
              </p>
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Unresolved
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${unresolved > 0 ? "text-red-600" : "text-[#1e2d3d]"}`}>
                {loadingSummary ? "—" : unresolved}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                missing + under/overpaid + pending
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Filter bar */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="space-y-1">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Period</label>
                <Select value={period} onValueChange={setPeriod}>
                  <SelectTrigger className="w-36 h-9" data-testid="accounting-period">
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
              <div className="space-y-1">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Agent</label>
                <Select value={agentFilter} onValueChange={setAgentFilter}>
                  <SelectTrigger className="w-48 h-9" data-testid="accounting-agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    {agentOptions.map((a) => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Carrier</label>
                <Select value={carrierFilter} onValueChange={setCarrierFilter}>
                  <SelectTrigger className="w-48 h-9" data-testid="accounting-carrier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All carriers</SelectItem>
                    {carrierOptions.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-36 h-9" data-testid="accounting-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="missing">Missing</SelectItem>
                    <SelectItem value="underpaid">Underpaid</SelectItem>
                    <SelectItem value="overpaid">Overpaid</SelectItem>
                    <SelectItem value="matched">Matched</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="ml-auto text-sm text-muted-foreground">
                Showing <span className="font-semibold text-[#1e2d3d]">{filteredRows.length}</span> of {allRows.length} records
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Records table — fixed-height scroll so a long backlog never
            pushes the action buttons off-screen. */}
        <ScrollableCard
          title="Records"
          count={filteredRows.length}
          height="calc(100vh - 420px)"
          loading={loadingRows}
          isEmpty={!loadingRows && filteredRows.length === 0}
          emptyState="No records match these filters."
          testId="accounting-records-card"
        >
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Policy</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <TableRow key={r.natural_key || r.policy_number}>
                    <TableCell className="font-medium">{r.agent_name || "—"}</TableCell>
                    <TableCell>{r.carrier || "—"}</TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {r.policy_number || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {fmtDate(r.effective_date)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(r.revenue_expected)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.revenue_received == null
                        ? <span className="text-muted-foreground italic">Pending</span>
                        : fmt(r.revenue_received)}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${
                      r.gap < 0 ? "text-red-600" : r.gap > 0 ? "text-blue-600" : ""
                    }`}>
                      {fmtGap(r.gap)}
                    </TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="text-right">
                      {r.status === "resolved" ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openResolve(r)}
                          data-testid={`accounting-resolve-${r.natural_key || r.policy_number}`}
                        >
                          Mark Resolved
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollableCard>
      </main>

      {/* Mark Resolved modal */}
      {resolveRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setResolveRow(null); }}
        >
          <div className="w-full max-w-md rounded-xl p-6 bg-white shadow-xl">
            <h2 className="text-lg font-semibold text-[#1e2d3d] mb-1">Mark Record Resolved</h2>
            <p className="text-xs text-muted-foreground mb-4">
              {resolveRow.agent_name} · {resolveRow.carrier} · {resolveRow.policy_number}
              <br />
              Gap: <span className={resolveRow.gap < 0 ? "text-red-600" : "text-blue-600"}>
                {fmtGap(resolveRow.gap)}
              </span>
            </p>
            <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
              Resolution Notes <span className="text-red-600">*</span>
            </label>
            <textarea
              value={resolveNotes}
              onChange={(e) => setResolveNotes(e.target.value)}
              placeholder="e.g. Carrier issued a corrective payment on 2026-05-12; AB updated."
              rows={4}
              maxLength={2000}
              className="w-full p-2 rounded-md border border-border text-sm outline-none focus:ring-2 focus:ring-[#e85d2f]/50"
              data-testid="accounting-resolve-notes"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {resolveNotes.length}/2000 chars
            </p>
            <div className="flex gap-2 mt-4 justify-end">
              <Button
                variant="outline"
                onClick={() => setResolveRow(null)}
                disabled={resolving}
              >
                Cancel
              </Button>
              <Button
                onClick={submitResolve}
                disabled={resolving || !resolveNotes.trim()}
                className="bg-[#e85d2f] hover:bg-[#d04d22] text-white"
                data-testid="accounting-resolve-submit"
              >
                {resolving ? "Saving…" : "Mark Resolved"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
