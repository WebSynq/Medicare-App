import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(val);
}

function statusVariant(status) {
  switch (status) {
    case "digested":
      return "default";
    case "skipped_duplicate":
      return "secondary";
    case "not_recognized":
      return "destructive";
    case "rejected":
      return "destructive";
    case "mock":
    case "unknown":
    default:
      return "outline";
  }
}

function statusLabel(status) {
  switch (status) {
    case "digested":          return "✓ Digested";
    case "skipped_duplicate": return "Duplicate";
    case "not_recognized":    return "⚠ Not Recognized";
    case "rejected":          return "✗ Rejected";
    case "mock":              return "Mock";
    default:                  return status ?? "Unknown";
  }
}

function fmtDate(isoOrSlash) {
  if (!isoOrSlash) return "—";
  try {
    let d;
    if (isoOrSlash.includes("T")) {
      d = new Date(isoOrSlash);
    } else if (isoOrSlash.includes("/")) {
      const [mm, dd, yyyy] = isoOrSlash.split("/");
      d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    } else {
      d = new Date(isoOrSlash + "T00:00:00Z");
    }
    if (isNaN(d.getTime())) return isoOrSlash;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return isoOrSlash;
  }
}

const ACCEPT = ".pdf,.csv,.xlsx,.xls,.txt";

// ── component ─────────────────────────────────────────────────────────────────

// ── Admin / compliance view ──────────────────────────────────────────────
// Senior staff don't have a personal commissions view — they see an
// agency-wide production roll-up. Reconciliation lives in /admin/accounting.
function AgencyProductionSummary() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get("/leaderboard", {
          params: { period: "all", limit: 1000 },
        });
        if (!alive) return;
        setRows(data.rows || []);
      } catch (e) {
        if (alive) setRows([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-6xl mx-auto w-full space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1e2d3d]">
            Agency Production Summary
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production rolled up by agent. Detailed reconciliation available in
            Accounting.
          </p>
          <ImpersonationBanner />
        </div>
        <Card className="bg-surface">
          <CardContent className="p-5">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Policies</TableHead>
                    <TableHead className="text-right">Total Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="text-center py-8 text-muted-foreground"
                      >
                        Loading…
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading && rows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="text-center py-8 text-muted-foreground"
                      >
                        No production records yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => (
                    <TableRow
                      key={`${r.agent_name}-${r.rank}`}
                      data-testid={`agency-row-${r.rank}`}
                    >
                      <TableCell className="font-medium">
                        {r.agent_name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.policies_count}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {fmt(r.revenue_total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}


export default function CommissionsDashboard() {
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const user = auth.getUser();
  const isAdminOrCompliance =
    user?.role === "admin" || user?.role === "compliance";

  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // ── data fetching ───────────────────────────────────────────────────────────

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const { data } = await api.get("/commissions/summary");
      setSummary(data);
    } catch (err) {
      console.error("Summary fetch error", err);
      toast.error("Could not load commission summary");
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const { data } = await api.get("/commissions/history");
      setHistory(data.uploads || []);
    } catch (err) {
      console.error("History fetch error", err);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (isAdminOrCompliance) return;  // admin sees the agency view; skip personal fetches
    fetchSummary();
    fetchHistory();
  }, [fetchSummary, fetchHistory, isAdminOrCompliance]);

  // ── upload ──────────────────────────────────────────────────────────────────

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;

      const ext = file.name.split(".").pop().toLowerCase();
      const allowed = ["pdf", "csv", "xlsx", "xls", "txt"];
      if (!allowed.includes(ext)) {
        toast.error("Unsupported file type", {
          description: "Please upload a PDF, CSV, XLSX, or TXT file.",
        });
        return;
      }

      if (file.size > 15 * 1024 * 1024) {
        toast.error("File too large", {
          description: "Maximum file size is 15 MB.",
        });
        return;
      }

      setUploading(true);
      const form = new FormData();
      form.append("file", file);

      try {
        const { data } = await api.post("/commissions/upload", form, {
          headers: { "Content-Type": "multipart/form-data" },
        });

        const messages = {
          digested: "Statement processed successfully.",
          skipped_duplicate: "This statement was already uploaded.",
          not_recognized: "Carrier format not recognized — contact support to add it.",
          rejected: "File could not be read. Re-download from the carrier portal and try again.",
        };

        const msg = messages[data.status] ?? `Status: ${data.status}`;
        if (data.status === "digested") {
          toast.success(msg);
        } else {
          toast.error(msg);
        }

        await Promise.all([fetchSummary(), fetchHistory()]);
      } catch (err) {
        const msg = err?.response?.data?.detail || "Upload failed. Try again.";
        toast.error(msg);
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [fetchSummary, fetchHistory]
  );

  const onFileChange = (e) => handleFile(e.target.files?.[0]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  // ── render ──────────────────────────────────────────────────────────────────

  const statCards = [
    {
      label: "YTD Commissions",
      value: loadingSummary ? "—" : fmt(summary?.ytd_commission ?? 0),
      sub: `${summary?.total_rows ?? 0} total rows`,
    },
    {
      label: "Active Policies",
      value: loadingSummary ? "—" : (summary?.active_policies ?? 0).toString(),
      sub: "No termination date",
    },
    {
      label: "Last Commission",
      value: loadingSummary ? "—" : fmt(summary?.last_paid_amount ?? 0),
      sub: summary?.last_paid_carrier ?? "—",
    },
    {
      label: "Last Statement",
      value: loadingSummary ? "—" : fmtDate(summary?.last_paid_date),
      sub: summary?.mock ? "⚠ Mock data — connect Comtrack" : "Live data",
    },
  ];

  // Admin/compliance see the agency-wide rollup; personal commission view
  // (ComTrack, audit, stats) is agent-only.
  if (isAdminOrCompliance) {
    return <AgencyProductionSummary />;
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-6xl mx-auto w-full space-y-6">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#1e2d3d]">Commissions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Upload carrier statements and track your earnings.
              {summary?.mock && (
                <span className="ml-2 text-amber-600 font-medium">
                  (Mock mode — connect Comtrack API key to see live data)
                </span>
              )}
            </p>
            <ImpersonationBanner />
          </div>
        </div>

        <Tabs defaultValue="comtrack" className="space-y-6">
          <TabsList className="h-10">
            <TabsTrigger value="comtrack" className="px-4">ComTrack</TabsTrigger>
            <TabsTrigger value="audit" className="px-4">Audit</TabsTrigger>
          </TabsList>

          <TabsContent value="comtrack" className="space-y-6 mt-0">

        {/* ── Stat cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 w-full overflow-hidden">
          {statCards.map((c) => (
            <Card key={c.label} className="min-w-0 overflow-hidden">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {c.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-[#1e2d3d]">{c.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* ── Upload ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-[#1e2d3d]">
              Upload Commission Statement
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                dragOver
                  ? "border-[#e85d2f] bg-orange-50"
                  : "border-muted-foreground/30 hover:border-[#e85d2f]/60"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={onFileChange}
              />
              {uploading ? (
                <div className="space-y-2">
                  <div className="text-[#e85d2f] font-medium animate-pulse">
                    Uploading…
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Sending to Comtrack for parsing
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-[#1e2d3d]">
                    Drop your statement here or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground">
                    PDF, CSV, XLSX, TXT · Max 15 MB
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 border-[#e85d2f] text-[#e85d2f] hover:bg-orange-50"
                    onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
                  >
                    Choose File
                  </Button>
                </div>
              )}
            </div>

            <div className="mt-4 text-xs text-muted-foreground space-y-1">
              <p>
                <span className="font-medium text-green-700">✓ Digested</span> — parsed and added to your commission records.
              </p>
              <p>
                <span className="font-medium text-amber-600">⚠ Not Recognized</span> — carrier format not yet supported. Contact support.
              </p>
              <p>
                <span className="font-medium text-red-600">✗ Rejected</span> — file unreadable or password-protected. Re-download from carrier portal.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Upload history ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-[#1e2d3d]">Upload History</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingHistory ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Loading…
              </p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No statements uploaded yet. Upload your first one above.
              </p>
            ) : (
              <div className="overflow-x-auto w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Uploaded</TableHead>
                      <TableHead>Comtrack ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium max-w-[220px] truncate">
                          {row.filename}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(row.status)}>
                            {statusLabel(row.status)}
                          </Badge>
                          {row.mock && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              mock
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {fmtDate(row.uploaded_at)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono truncate max-w-[160px]">
                          {row.comtrack_file_id || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

          </TabsContent>

          {/* ── Audit tab ── */}
          <TabsContent value="audit" className="space-y-6 mt-0">
            <AuditPanel />
            <ChatPanel />
          </TabsContent>

        </Tabs>

      </main>
    </div>
  );
}

// ── Audit tab ──────────────────────────────────────────────────────────────
// Sources:
//   GET /api/commission/audit/summary  → top stat cards
//   GET /api/commission/audit          → ranked records table
// Both endpoints already apply RBAC server-side — an agent only sees their
// own rows, admin/compliance see everything.

const AUDIT_STATUS_STYLES = {
  missing:   { className: "bg-red-100 text-red-900",       label: "Missing" },
  underpaid: { className: "bg-orange-100 text-orange-900", label: "Underpaid" },
  overpaid:  { className: "bg-blue-100 text-blue-900",     label: "Overpaid" },
  matched:   { className: "bg-emerald-100 text-emerald-900", label: "Matched" },
  pending:   { className: "bg-muted text-muted-foreground", label: "Pending" },
  resolved:  { className: "bg-slate-200 text-slate-700",   label: "Resolved" },
};

function AuditStatusBadge({ status }) {
  const style = AUDIT_STATUS_STYLES[status] || AUDIT_STATUS_STYLES.pending;
  return (
    <Badge className={`rounded-full capitalize border-0 ${style.className}`}>
      {style.label}
    </Badge>
  );
}

function fmtGap(gap) {
  // Gap is signed: negative = underpaid, positive = overpaid.
  // We surface the absolute amount + a direction prefix so a quick scan
  // shows "owed to agent" vs "agent owes back" without re-reading the sign.
  if (gap == null) return "—";
  if (Math.abs(gap) < 0.005) return "$0.00";
  const sign = gap < 0 ? "−" : "+";
  return `${sign}${fmt(Math.abs(gap))}`;
}

function AuditPanel() {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingRows, setLoadingRows] = useState(true);

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const { data } = await api.get("/commission/audit/summary", {
        params: { period },
      });
      setSummary(data);
    } catch (err) {
      console.error("Audit summary error", err);
      toast.error("Could not load audit summary");
    } finally {
      setLoadingSummary(false);
    }
  }, [period]);

  const fetchRows = useCallback(async () => {
    setLoadingRows(true);
    try {
      const params = { period, status: statusFilter };
      const { data } = await api.get("/commission/audit", { params });
      setRows(data.records || []);
    } catch (err) {
      console.error("Audit list error", err);
      toast.error("Could not load audit records");
    } finally {
      setLoadingRows(false);
    }
  }, [period, statusFilter]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { fetchRows(); }, [fetchRows]);

  const counts = summary?.count_by_status || {};
  const totalGap = summary?.total_gap ?? 0;
  const gapClass = totalGap < 0 ? "text-red-600" : totalGap > 0 ? "text-blue-600" : "text-[#1e2d3d]";

  return (
    <div className="space-y-6">
      {/* Summary cards */}
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
              {counts.matched ?? 0} matched · {counts.overpaid ?? 0} overpaid
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
            <p className={`text-2xl font-bold ${gapClass}`}>
              {loadingSummary ? "—" : fmtGap(totalGap)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {totalGap < 0 ? "Owed to you" : totalGap > 0 ? "Overpaid" : "All settled"}
            </p>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              By Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-red-700">Missing</span>
              <span className="font-semibold">{counts.missing ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-orange-700">Underpaid</span>
              <span className="font-semibold">{counts.underpaid ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-emerald-700">Matched</span>
              <span className="font-semibold">{counts.matched ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters + records table */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base text-[#1e2d3d]">Audit Records</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-32 h-9" data-testid="audit-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="week">Last 7 days</SelectItem>
                  <SelectItem value="month">Last 30 days</SelectItem>
                  <SelectItem value="all">All time</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-36 h-9" data-testid="audit-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="missing">Missing</SelectItem>
                  <SelectItem value="underpaid">Underpaid</SelectItem>
                  <SelectItem value="matched">Matched</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingRows ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No records match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Policy</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Gap</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.natural_key || r.policy_number}>
                      <TableCell className="font-medium">{r.carrier || "—"}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {r.policy_number || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt(r.revenue_expected)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.revenue_received == null
                          ? <span className="text-muted-foreground italic">Pending</span>
                          : fmt(r.revenue_received)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-medium ${
                          r.gap < 0 ? "text-red-600" : r.gap > 0 ? "text-blue-600" : ""
                        }`}
                      >
                        {fmtGap(r.gap)}
                      </TableCell>
                      <TableCell>
                        <AuditStatusBadge status={r.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


// ── AI chat panel ──────────────────────────────────────────────────────────
// Calls POST /api/commission/chat. The backend injects the agent's own
// production_records as context (RBAC-scoped — never another agent's), then
// returns { reply, suggested_actions } via the structured-output schema.

const STARTER_PROMPTS = [
  "What's my biggest gap?",
  "Which carrier owes me the most?",
  "Draft a dispute letter for my largest discrepancy",
  "Summarize my commissions this month",
];

function ChatPanel() {
  // messages: { role: 'user' | 'assistant', text: string, actions?: string[] }
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  // Auto-scroll the transcript when a new message lands. Using a small
  // timeout because the DOM update from setMessages lands in the next tick.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const sendMessage = useCallback(async (text) => {
    const trimmed = (text ?? "").trim();
    if (!trimmed || sending) return;
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setSending(true);
    try {
      const { data } = await api.post("/commission/chat", { message: trimmed });
      setMessages((prev) => [...prev, {
        role: "assistant",
        text: data.reply || "(no reply)",
        actions: Array.isArray(data.suggested_actions) ? data.suggested_actions : [],
      }]);
    } catch (err) {
      const detail = err?.response?.data?.detail || "Could not reach the assistant.";
      setMessages((prev) => [...prev, {
        role: "assistant",
        text: detail,
        actions: [],
        error: true,
      }]);
    } finally {
      setSending(false);
    }
  }, [sending]);

  const onSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-[#1e2d3d]">
          Commission Assistant
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Ask about your gaps, draft dispute letters, or summarise your book.
          Responses are scoped to your own records.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Transcript */}
        <div
          ref={scrollRef}
          className="border border-border rounded-lg p-3 bg-muted/30 h-72 overflow-y-auto space-y-3"
          data-testid="chat-transcript"
        >
          {messages.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-6">
              No messages yet. Ask a question or pick a starter below.
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                  m.role === "user"
                    ? "bg-[#1e2d3d] text-white"
                    : m.error
                      ? "bg-red-50 text-red-900 border border-red-200"
                      : "bg-white border border-border text-[#1e2d3d]"
                }`}
              >
                {m.text}
                {m.role === "assistant" && m.actions && m.actions.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/60 space-y-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Suggested actions
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {m.actions.map((a, j) => (
                        <button
                          key={j}
                          type="button"
                          onClick={() => sendMessage(a)}
                          className="text-xs px-2 py-1 rounded-md bg-[#e85d2f]/10 text-[#e85d2f] hover:bg-[#e85d2f]/20 transition-colors"
                          data-testid={`chat-action-${j}`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-white border border-border rounded-lg px-3 py-2 text-sm text-muted-foreground inline-flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#e85d2f] animate-pulse" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#e85d2f] animate-pulse [animation-delay:0.15s]" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#e85d2f] animate-pulse [animation-delay:0.3s]" />
                <span>Thinking…</span>
              </div>
            </div>
          )}
        </div>

        {/* Starter prompt chips */}
        <div className="flex flex-wrap gap-1.5">
          {STARTER_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setInput(p)}
              disabled={sending}
              className="text-xs px-2.5 py-1 rounded-full border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50"
              data-testid="chat-starter"
            >
              {p}
            </button>
          ))}
        </div>

        {/* Input */}
        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your commissions…"
            disabled={sending}
            className="flex-1 h-10"
            data-testid="chat-input"
          />
          <Button
            type="submit"
            disabled={sending || !input.trim()}
            className="h-10 px-4 bg-[#e85d2f] hover:bg-[#d04d22] text-white"
            data-testid="chat-send"
          >
            Send
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
