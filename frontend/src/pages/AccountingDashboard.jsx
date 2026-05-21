import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  Brain,
  Building2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  ClipboardList,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  Gavel,
  PercentCircle,
  Plus,
  RefreshCcw,
  TrendingUp,
  Upload,
  X as XIcon,
} from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, API } from "@/lib/api";
import ScrollableCard from "@/components/ScrollableCard";
import CFOChat from "@/components/CFOChat";

const CSRF_COOKIE = "ghw_csrf_token";
const DONUT_COLORS = [
  "#e85d2f",
  "#0d1b2a",
  "#5e7a93",
  "#2eb88a",
  "#f59e0b",
  "#7c3aed",
  "#0891b2",
];

const PERIODS = [
  { value: "mtd", label: "MTD" },
  { value: "ytd", label: "YTD" },
  { value: "q1", label: "Q1" },
  { value: "q2", label: "Q2" },
  { value: "q3", label: "Q3" },
  { value: "q4", label: "Q4" },
  { value: "all", label: "All" },
];

const LEDGER_STATUS_STYLES = {
  paid: "bg-emerald-100 text-emerald-900",
  pending: "bg-amber-100 text-amber-900",
  gap: "bg-red-100 text-red-900",
  underpaid: "bg-red-100 text-red-900",
  overpaid: "bg-blue-100 text-blue-900",
  chargeback: "bg-purple-100 text-purple-900",
  unmatched: "bg-slate-200 text-slate-700",
};

const DISPUTE_STATUS_STYLES = {
  open: "bg-amber-100 text-amber-900",
  in_progress: "bg-blue-100 text-blue-900",
  resolved: "bg-emerald-100 text-emerald-900",
  closed: "bg-slate-200 text-slate-700",
};

// ── Helpers ─────────────────────────────────────────────────────────────
function fmt(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(val);
}
function fmtShort(val) {
  if (val == null) return "—";
  const n = Number(val);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return fmt(n);
}
function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
function fmtPct(p) {
  if (p == null || Number.isNaN(Number(p))) return "—";
  return `${Number(p).toFixed(1)}%`;
}
function readCsrf() {
  const m = document.cookie
    .split("; ")
    .find((r) => r.startsWith(`${CSRF_COOKIE}=`));
  return m ? decodeURIComponent(m.split("=")[1]) : null;
}
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function downloadCsv(filename, rows, headers) {
  const head = headers.map((h) => csvCell(h.label)).join(",");
  const body = rows
    .map((r) => headers.map((h) => csvCell(h.get(r))).join(","))
    .join("\n");
  const csv = `${head}\n${body}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function LedgerStatusBadge({ status }) {
  const cls = LEDGER_STATUS_STYLES[status] || LEDGER_STATUS_STYLES.pending;
  return (
    <Badge className={`rounded-full capitalize border-0 ${cls}`}>
      {(status || "pending").replace(/_/g, " ")}
    </Badge>
  );
}
function DisputeStatusBadge({ status }) {
  const cls = DISPUTE_STATUS_STYLES[status] || DISPUTE_STATUS_STYLES.open;
  return (
    <Badge className={`rounded-full capitalize border-0 ${cls}`}>
      {(status || "open").replace(/_/g, " ")}
    </Badge>
  );
}

function KpiCard({ title, value, accent, icon: Icon, subtitle }) {
  return (
    <Card className="bg-surface" data-testid={`kpi-${title.replace(/\s+/g, "-").toLowerCase()}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              {title}
            </div>
            <div
              className={`mt-1 text-2xl font-bold tabular-nums truncate ${
                accent || ""
              }`}
              style={{ fontFamily: "Outfit" }}
            >
              {value}
            </div>
            {subtitle ? (
              <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
            ) : null}
          </div>
          {Icon ? (
            <Icon className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main shell ──────────────────────────────────────────────────────────
export default function AccountingDashboard() {
  const [tab, setTab] = useState("overview");
  const [cfoOpen, setCfoOpen] = useState(false);
  const [period, setPeriod] = useState("mtd");
  const [carrierFilter, setCarrierFilter] = useState("");

  // When the user clicks a carrier in the Overview donut, jump to the
  // Ledger tab pre-filtered.
  function focusCarrierInLedger(carrier) {
    setCarrierFilter(carrier);
    setTab("ledger");
  }

  return (
    <div
      className={`p-6 md:p-8 transition-all ${
        cfoOpen ? "md:pr-[420px]" : ""
      }`}
    >
      <main className="max-w-[1500px] mx-auto w-full">
        {/* Header */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Banknote className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Accounting
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
              data-testid="accounting-title"
            >
              Financial Command Center
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Live commission reconciliation, carrier collections, and dispute
              management.
            </p>
          </div>
          <Button
            onClick={() => setCfoOpen((v) => !v)}
            className="rounded-lg text-white"
            style={{
              background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
            }}
            data-testid="open-cfo"
          >
            <Brain className="w-4 h-4 mr-2" />
            {cfoOpen ? "Close CFO" : "Ask CFO AI"}
            <Badge
              variant="outline"
              className="ml-2 text-[9px] uppercase border-white/40 text-white/85"
            >
              Bedrock
            </Badge>
          </Button>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4 flex flex-wrap">
            <TabsTrigger value="overview" data-testid="tab-overview">
              <TrendingUp className="w-3.5 h-3.5 mr-1.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="ledger" data-testid="tab-ledger">
              <ClipboardList className="w-3.5 h-3.5 mr-1.5" /> Ledger
            </TabsTrigger>
            <TabsTrigger value="carriers" data-testid="tab-carriers">
              <Building2 className="w-3.5 h-3.5 mr-1.5" /> Carriers
            </TabsTrigger>
            <TabsTrigger value="disputes" data-testid="tab-disputes">
              <Gavel className="w-3.5 h-3.5 mr-1.5" /> Disputes
            </TabsTrigger>
            <TabsTrigger value="statements" data-testid="tab-statements">
              <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" /> Statements
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab
              period={period}
              setPeriod={setPeriod}
              onCarrierClick={focusCarrierInLedger}
              onJumpDisputes={() => setTab("disputes")}
            />
          </TabsContent>
          <TabsContent value="ledger">
            <LedgerTab
              carrierFilter={carrierFilter}
              setCarrierFilter={setCarrierFilter}
            />
          </TabsContent>
          <TabsContent value="carriers">
            <CarriersTab onViewLedger={focusCarrierInLedger} />
          </TabsContent>
          <TabsContent value="disputes">
            <DisputesTab />
          </TabsContent>
          <TabsContent value="statements">
            <StatementsTab />
          </TabsContent>
        </Tabs>
      </main>

      <CFOChat open={cfoOpen} onClose={() => setCfoOpen(false)} />
    </div>
  );
}

// ── OVERVIEW ────────────────────────────────────────────────────────────
function OverviewTab({ period, setPeriod, onCarrierClick, onJumpDisputes }) {
  const [data, setData] = useState(null);
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeBucket, setActiveBucket] = useState(null); // null | "current" | "days_31_60" | ...
  const [aging, setAging] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summary, ag, dlist] = await Promise.all([
        api.get(`/accounting/summary?period=${period}`),
        api.get(`/accounting/aging`),
        api.get(`/accounting/disputes`),
      ]);
      setData(summary.data);
      setAging(ag.data);
      setDisputes((dlist.data?.items || []).slice(0, 5));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load accounting data");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  const ag = aging?.buckets || {};
  const agingCards = [
    { key: "current", label: "0–30 days", color: "text-foreground" },
    { key: "days_31_60", label: "31–60 days", color: "text-amber-700" },
    { key: "days_61_90", label: "61–90 days", color: "text-orange-700" },
    { key: "days_90_plus", label: "90+ days", color: "text-red-700" },
  ];

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-32 h-9" data-testid="accounting-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          data-testid="accounting-refresh"
        >
          <RefreshCcw
            className={`w-3.5 h-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          title="Expected MTD"
          value={fmtShort(data?.expected_mtd)}
          accent="text-[#e85d2f]"
        />
        <KpiCard
          title="Received MTD"
          value={fmtShort(data?.received_mtd)}
          accent="text-emerald-600"
        />
        <KpiCard
          title="Gap MTD"
          value={fmtShort(data?.gap_mtd)}
          accent={data?.gap_mtd > 0 ? "text-red-600" : "text-foreground"}
        />
        <KpiCard
          title="Collection Rate"
          value={fmtPct(data?.collection_rate_pct)}
          accent={
            (data?.collection_rate_pct ?? 0) >= 90
              ? "text-emerald-600"
              : (data?.collection_rate_pct ?? 0) >= 75
              ? "text-amber-600"
              : "text-red-600"
          }
          icon={PercentCircle}
        />
        <KpiCard
          title="Outstanding"
          value={fmtShort(data?.outstanding_total)}
          accent="text-amber-600"
        />
        <KpiCard
          title="Overpaid"
          value={fmtShort(data?.overpaid_total)}
          accent="text-blue-600"
          subtitle="To be returned"
        />
      </div>

      {/* Monthly revenue chart */}
      <Card className="bg-surface">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Revenue — last 12 months</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={data?.revenue_by_month || []}>
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  formatter={(v) => fmt(v)}
                  labelClassName="text-xs"
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  dataKey="expected"
                  name="Expected"
                  fill="#e85d2f"
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="received"
                  name="Received"
                  fill="#0d1b2a"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Three columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="bg-surface">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Revenue by Carrier</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={(data?.revenue_by_carrier || []).slice(0, 5)}
                    dataKey="expected"
                    nameKey="carrier"
                    innerRadius={50}
                    outerRadius={85}
                    paddingAngle={2}
                    onClick={(p) => p?.carrier && onCarrierClick(p.carrier)}
                    style={{ cursor: "pointer" }}
                  >
                    {(data?.revenue_by_carrier || [])
                      .slice(0, 5)
                      .map((_, i) => (
                        <Cell
                          key={i}
                          fill={DONUT_COLORS[i % DONUT_COLORS.length]}
                        />
                      ))}
                  </Pie>
                  <Tooltip formatter={(v) => fmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[10px] text-muted-foreground text-center mt-1">
              Click a slice to filter the ledger
            </p>
          </CardContent>
        </Card>

        <Card className="bg-surface">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Revenue by Product</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={(data?.revenue_by_product || []).slice(0, 7)}
                    dataKey="expected"
                    nameKey="product"
                    innerRadius={50}
                    outerRadius={85}
                    paddingAngle={2}
                  >
                    {(data?.revenue_by_product || [])
                      .slice(0, 7)
                      .map((_, i) => (
                        <Cell
                          key={i}
                          fill={DONUT_COLORS[i % DONUT_COLORS.length]}
                        />
                      ))}
                  </Pie>
                  <Tooltip formatter={(v) => fmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-surface">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Top Agents by Revenue</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
              {(data?.revenue_by_agent || []).slice(0, 8).map((a) => {
                const pct =
                  a.expected > 0
                    ? Math.min(100, (a.received / a.expected) * 100)
                    : 0;
                return (
                  <div key={a.agent_id || a.agent_name}>
                    <div className="flex justify-between items-baseline text-xs">
                      <span className="font-medium truncate">
                        {a.agent_name}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {fmtShort(a.received)} / {fmtShort(a.expected)}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-secondary mt-1 overflow-hidden">
                      <div
                        className="h-full"
                        style={{
                          width: `${pct}%`,
                          background:
                            "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
              {!loading && (data?.revenue_by_agent || []).length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  No agent revenue in this period.
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Aging */}
      <Card className="bg-surface">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CircleAlert className="w-4 h-4 text-amber-500" />
            Aging Report
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {agingCards.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() =>
                  setActiveBucket((prev) => (prev === c.key ? null : c.key))
                }
                className={`text-left rounded-lg border p-3 transition-colors ${
                  activeBucket === c.key
                    ? "border-[#e85d2f]/60 bg-secondary/40"
                    : "border-border hover:border-[#e85d2f]/40"
                }`}
                data-testid={`aging-${c.key}`}
              >
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  {c.label}
                </div>
                <div
                  className={`text-xl font-bold tabular-nums mt-1 ${c.color}`}
                  style={{ fontFamily: "Outfit" }}
                >
                  {fmtShort(ag?.[c.key]?.amount)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {ag?.[c.key]?.count || 0} policies
                </div>
              </button>
            ))}
          </div>
          {activeBucket ? (
            <div className="mt-3 max-h-56 overflow-y-auto border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(ag?.[activeBucket]?.policies || []).map((p, i) => (
                    <TableRow key={p.policy_id || i}>
                      <TableCell className="text-xs">{p.client_name}</TableCell>
                      <TableCell className="text-xs">{p.carrier}</TableCell>
                      <TableCell className="text-xs">{p.product}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {fmt(p.expected)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {p.days_old}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Recent disputes */}
      <ScrollableCard
        title="Recent Disputes"
        count={disputes.length}
        height="280px"
        loading={loading}
        isEmpty={!loading && disputes.length === 0}
        emptyState="No open disputes."
        headerAction={
          <Button
            variant="outline"
            size="sm"
            onClick={onJumpDisputes}
            data-testid="overview-view-disputes"
          >
            View All Disputes
          </Button>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Carrier</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Days Open</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {disputes.map((d) => (
              <TableRow key={d.dispute_id}>
                <TableCell className="text-xs">{d.carrier}</TableCell>
                <TableCell className="text-xs">{d.client_name || "—"}</TableCell>
                <TableCell className="text-xs">{d.agent_name || "—"}</TableCell>
                <TableCell className="text-xs text-right tabular-nums">
                  {fmt(d.amount_disputed)}
                </TableCell>
                <TableCell className="text-xs text-right tabular-nums">
                  {d.days_open}
                </TableCell>
                <TableCell>
                  <DisputeStatusBadge status={d.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollableCard>
    </div>
  );
}

// ── LEDGER ──────────────────────────────────────────────────────────────
function LedgerTab({ carrierFilter, setCarrierFilter }) {
  const [items, setItems] = useState([]);
  const [agentFilter, setAgentFilter] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null); // policy_id of expanded row

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (carrierFilter) params.set("carrier", carrierFilter);
      if (agentFilter) params.set("agent_id", agentFilter);
      if (productFilter) params.set("product", productFilter);
      if (statusFilter && statusFilter !== "all")
        params.set("status", statusFilter);
      params.set("page", page);
      params.set("limit", 50);
      const { data } = await api.get(`/accounting/ledger?${params.toString()}`);
      setItems(data.items || []);
      setPage(data.page || 1);
      setPages(data.pages || 1);
      setTotal(data.total || 0);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load ledger");
    } finally {
      setLoading(false);
    }
  }, [carrierFilter, agentFilter, productFilter, statusFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter((r) =>
      (r.client_name || "").toLowerCase().includes(q),
    );
  }, [items, search]);

  function exportCsv() {
    downloadCsv(
      `ledger_${Date.now()}.csv`,
      filtered,
      [
        { label: "Submission Date", get: (r) => r.submission_date || "" },
        { label: "Agent", get: (r) => r.agent_name || "" },
        { label: "Client", get: (r) => r.client_name || "" },
        { label: "Carrier", get: (r) => r.carrier || "" },
        { label: "Product", get: (r) => r.product_type || "" },
        { label: "Monthly Premium", get: (r) => r.monthly_premium ?? "" },
        { label: "Expected", get: (r) => r.expected_commission ?? "" },
        { label: "Received", get: (r) => r.received_commission ?? "" },
        { label: "Gap", get: (r) => r.gap_amount ?? "" },
        { label: "Status", get: (r) => r.status || "" },
      ],
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <Card className="bg-surface">
        <CardContent className="p-3 flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-[10px] uppercase tracking-widest">
              Carrier
            </Label>
            <Input
              value={carrierFilter}
              onChange={(e) => setCarrierFilter(e.target.value)}
              placeholder="Any"
              className="w-36 h-9"
              data-testid="ledger-carrier"
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-widest">
              Agent ID
            </Label>
            <Input
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              placeholder="Any"
              className="w-36 h-9"
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-widest">
              Product
            </Label>
            <Input
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              placeholder="MA, PDP…"
              className="w-32 h-9"
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-widest">
              Status
            </Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="gap">Gap</SelectItem>
                <SelectItem value="overpaid">Overpaid</SelectItem>
                <SelectItem value="chargeback">Chargeback</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <Label className="text-[10px] uppercase tracking-widest">
              Client search
            </Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client name"
              className="h-9"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCarrierFilter("");
              setAgentFilter("");
              setProductFilter("");
              setStatusFilter("all");
              setSearch("");
              setPage(1);
            }}
          >
            <Filter className="w-3.5 h-3.5 mr-1" /> Clear
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={!filtered.length}
            data-testid="ledger-export"
          >
            <Download className="w-3.5 h-3.5 mr-1" /> Export CSV
          </Button>
        </CardContent>
      </Card>

      <ScrollableCard
        title="Commission Ledger"
        count={total}
        height="calc(100vh - 460px)"
        loading={loading}
        isEmpty={!loading && filtered.length === 0}
        emptyState="No commission records match these filters."
        testId="ledger-card"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Premium</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Gap</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r, i) => {
              const key = `${r.policy_id || r.client_name}-${i}`;
              const open = expanded === key;
              return (
                <>
                  <TableRow
                    key={key}
                    className="cursor-pointer"
                    onClick={() => setExpanded(open ? null : key)}
                  >
                    <TableCell className="text-xs">
                      {fmtDate(r.submission_date)}
                    </TableCell>
                    <TableCell className="text-xs">{r.agent_name || "—"}</TableCell>
                    <TableCell className="text-xs">{r.client_name || "—"}</TableCell>
                    <TableCell className="text-xs">{r.carrier || "—"}</TableCell>
                    <TableCell className="text-xs">
                      {r.product_type || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(r.annual_premium)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(r.expected_commission)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {r.received_commission == null
                        ? "—"
                        : fmt(r.received_commission)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(r.gap_amount)}
                    </TableCell>
                    <TableCell>
                      <LedgerStatusBadge status={r.status} />
                    </TableCell>
                  </TableRow>
                  {open ? (
                    <TableRow>
                      <TableCell colSpan={10} className="bg-secondary/30">
                        <div className="flex flex-wrap gap-2 py-1">
                          <span className="text-[11px] text-muted-foreground">
                            Policy {r.policy_id || "—"} · effective{" "}
                            {fmtDate(r.effective_date)}
                          </span>
                          {r.status === "gap" || r.status === "underpaid" ? (
                            <Button size="sm" variant="outline" className="h-7 text-xs">
                              Create Dispute
                            </Button>
                          ) : null}
                          {r.status === "paid" ? (
                            <Button size="sm" variant="ghost" className="h-7 text-xs">
                              Mark Resolved
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" className="h-7 text-xs">
                            View Client Profile
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </>
              );
            })}
          </TableBody>
        </Table>
      </ScrollableCard>
      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          Page {page} of {pages} · {total.toLocaleString()} records
        </div>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── CARRIERS ────────────────────────────────────────────────────────────
function CarriersTab({ onViewLedger }) {
  const [carriers, setCarriers] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/accounting/carriers`);
      setCarriers(data?.carriers || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load carriers");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {carriers.length} carriers · YTD
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCcw
            className={`w-3.5 h-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading carriers…</p>
      ) : carriers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No carrier activity yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {carriers.map((c) => {
            const pct =
              c.expected_ytd > 0
                ? Math.min(100, (c.received_ytd / c.expected_ytd) * 100)
                : 0;
            return (
              <Card key={c.carrier_name} className="bg-surface">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3
                      className="text-base font-semibold truncate"
                      style={{ fontFamily: "Outfit" }}
                    >
                      {c.carrier_name}
                    </h3>
                    <Badge variant="outline" className="text-[10px]">
                      {c.total_policies} policies
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <div>
                      <div className="text-muted-foreground">Expected YTD</div>
                      <div className="font-semibold tabular-nums">
                        {fmt(c.expected_ytd)}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Received YTD</div>
                      <div className="font-semibold tabular-nums">
                        {fmt(c.received_ytd)}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Gap</div>
                      <div
                        className={`font-semibold tabular-nums ${
                          (c.gap_ytd || 0) > 0 ? "text-red-600" : ""
                        }`}
                      >
                        {fmt(c.gap_ytd)}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Collection</div>
                      <div className="font-semibold tabular-nums">
                        {fmtPct(c.collection_rate)}
                      </div>
                    </div>
                  </div>
                  <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${pct}%`,
                        background:
                          "linear-gradient(135deg, #2eb88a 0%, #1e9870 100%)",
                      }}
                    />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Last payment {fmtDate(c.last_payment_date)} · avg{" "}
                    {c.avg_days_to_pay == null
                      ? "—"
                      : `${c.avg_days_to_pay}d`}{" "}
                    to pay
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => onViewLedger(c.carrier_name)}
                    >
                      View Ledger
                    </Button>
                    {(c.gap_ytd || 0) > 500 ? (
                      <Button
                        size="sm"
                        className="h-7 text-xs text-white"
                        style={{
                          background:
                            "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
                        }}
                      >
                        Create Dispute
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── DISPUTES ────────────────────────────────────────────────────────────
function DisputesTab() {
  const [data, setData] = useState({ items: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [letter, setLetter] = useState(null); // { dispute_id, text }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/accounting/disputes");
      setData(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load disputes");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function updateStatus(id, status) {
    try {
      await api.patch(`/accounting/disputes/${id}`, { status });
      toast.success(`Marked ${status.replace("_", " ")}`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    }
  }

  async function generateLetter(id) {
    try {
      const resp = await fetch(`${API}/accounting/disputes/${id}/letter`, {
        method: "POST",
        credentials: "include",
        headers: {
          "X-CSRF-Token": readCsrf() || "",
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      setLetter({ dispute_id: id, text });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("letter failed", e);
      toast.error("Letter generation failed");
    }
  }

  function downloadLetter() {
    if (!letter) return;
    const blob = new Blob([letter.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dispute_letter_${letter.dispute_id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const counts = data.counts || {};
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Open" value={counts.open ?? 0} accent="text-amber-600" />
        <KpiCard
          title="In Progress"
          value={counts.in_progress ?? 0}
          accent="text-blue-600"
        />
        <KpiCard
          title="Resolved"
          value={counts.resolved ?? 0}
          accent="text-emerald-600"
        />
        <KpiCard
          title="Recovered MTD"
          value={fmtShort(data.total_recovered_mtd)}
          accent="text-emerald-600"
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {data.items?.length ?? 0} disputes
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCcw
              className={`w-3.5 h-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            className="text-white"
            style={{
              background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
            }}
            onClick={() => setCreateOpen(true)}
            data-testid="open-create-dispute"
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            New Dispute
          </Button>
        </div>
      </div>

      <ScrollableCard
        title="Disputes"
        count={data.items?.length ?? 0}
        height="calc(100vh - 460px)"
        loading={loading}
        isEmpty={!loading && (data.items?.length ?? 0) === 0}
        emptyState="No disputes on file."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Days Open</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data.items || []).map((d) => (
              <TableRow key={d.dispute_id}>
                <TableCell className="text-xs">
                  {fmtDate(d.created_at)}
                </TableCell>
                <TableCell className="text-xs">{d.carrier}</TableCell>
                <TableCell className="text-xs">{d.agent_name || "—"}</TableCell>
                <TableCell className="text-xs">{d.client_name || "—"}</TableCell>
                <TableCell className="text-xs text-right tabular-nums">
                  {fmt(d.amount_disputed)}
                </TableCell>
                <TableCell className="text-xs text-right tabular-nums">
                  {d.days_open}
                </TableCell>
                <TableCell>
                  <DisputeStatusBadge status={d.status} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex gap-1">
                    <Select
                      onValueChange={(v) => updateStatus(d.dispute_id, v)}
                    >
                      <SelectTrigger className="h-7 w-32 text-xs">
                        <SelectValue placeholder="Update" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                        <SelectItem value="closed">Closed</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => generateLetter(d.dispute_id)}
                    >
                      <FileText className="w-3 h-3 mr-1" />
                      Letter
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollableCard>

      {createOpen ? (
        <CreateDisputeModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            load();
          }}
        />
      ) : null}

      {letter ? (
        <LetterModal letter={letter} onClose={() => setLetter(null)} onDownload={downloadLetter} />
      ) : null}
    </div>
  );
}

function CreateDisputeModal({ onClose, onCreated }) {
  const [carrier, setCarrier] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [clientName, setClientName] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!carrier.trim()) {
      toast.error("Carrier is required");
      return;
    }
    setSaving(true);
    try {
      await api.post("/accounting/disputes", {
        carrier: carrier.trim(),
        policy_id: policyId.trim() || null,
        agent_name: agentName.trim() || null,
        client_name: clientName.trim() || null,
        amount_disputed: Number(amount) || 0,
        reason: reason.trim(),
        notes: notes.trim() || null,
      });
      toast.success("Dispute created");
      onCreated();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create dispute");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">New Commission Dispute</CardTitle>
          <button onClick={onClose} aria-label="Close">
            <XIcon className="w-4 h-4" />
          </button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Carrier *</Label>
            <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Policy #</Label>
              <Input
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
              />
            </div>
            <div>
              <Label>Amount disputed</Label>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Agent</Label>
              <Input
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              />
            </div>
            <div>
              <Label>Client</Label>
              <Input
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving}
              className="text-white"
              style={{
                background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
              }}
            >
              {saving ? "Saving…" : "Create dispute"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LetterModal({ letter, onClose, onDownload }) {
  function copy() {
    navigator.clipboard.writeText(letter.text);
    toast.success("Copied to clipboard");
  }
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-2xl bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Dispute Letter</CardTitle>
          <button onClick={onClose} aria-label="Close">
            <XIcon className="w-4 h-4" />
          </button>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="whitespace-pre-wrap text-xs leading-snug bg-secondary/40 p-3 rounded max-h-[60vh] overflow-y-auto">
            {letter.text}
          </pre>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={copy}>
              Copy
            </Button>
            <Button
              onClick={onDownload}
              className="text-white"
              style={{
                background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
              }}
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Download
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── STATEMENTS / RECONCILIATION ─────────────────────────────────────────
function StatementsTab() {
  const [carrier, setCarrier] = useState("");
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [statement, setStatement] = useState(null);
  const fileInputRef = useRef(null);

  async function handleUpload() {
    if (!file || !carrier) {
      toast.error("Pick a file and carrier first");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("carrier", carrier);
    setUploading(true);
    try {
      const resp = await fetch(`${API}/reconciliation/upload`, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": readCsrf() || "" },
        body: fd,
      });
      if (!resp.ok) {
        const msg = await resp.text().catch(() => "");
        throw new Error(msg || `HTTP ${resp.status}`);
      }
      const { statement_id, extracted_count } = await resp.json();
      toast.success(`Extracted ${extracted_count} records — matching…`);
      // Immediately run matching.
      const matchResp = await api.post(
        `/reconciliation/${statement_id}/match`,
      );
      setStatement(matchResp.data);
      toast.success("Reconciliation complete");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("upload failed", e);
      toast.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  }

  const summary = statement?.summary;
  const records = statement?.records || [];

  function exportReconciliation() {
    if (!records.length) return;
    downloadCsv(
      `reconciliation_${Date.now()}.csv`,
      records,
      [
        { label: "Client", get: (r) => r.client_name || "" },
        { label: "Policy #", get: (r) => r.policy_number || "" },
        { label: "Product", get: (r) => r.product_type || "" },
        { label: "Carrier", get: (r) => r.carrier || "" },
        { label: "Expected", get: (r) => r.expected_commission ?? "" },
        { label: "Received", get: (r) => r.commission_paid ?? "" },
        { label: "Gap", get: (r) => r.gap ?? "" },
        { label: "Status", get: (r) => r.match_status || "" },
        { label: "Confidence", get: (r) => r.match_confidence ?? "" },
        { label: "Matched Policy", get: (r) => r.matched_policy_id || "" },
      ],
    );
  }

  async function bulkDisputesForGaps() {
    const gaps = records.filter(
      (r) => r.match_status === "underpaid" && (r.gap ?? 0) > 0,
    );
    if (!gaps.length) {
      toast.error("No gaps in this statement");
      return;
    }
    let created = 0;
    for (const r of gaps) {
      try {
        await api.post("/accounting/disputes", {
          carrier: r.carrier || carrier,
          policy_id: r.matched_policy_id || r.policy_number,
          agent_name: r.matched_agent_name || null,
          client_name: r.client_name || null,
          amount_disputed: r.gap,
          reason: "Underpayment identified by reconciliation",
          notes: `Auto-created from statement ${statement?.statement_id}`,
        });
        created += 1;
      } catch {
        /* swallow individual failures */
      }
    }
    toast.success(`Created ${created} disputes`);
  }

  return (
    <div className="space-y-4">
      <Card className="bg-surface">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Upload carrier statement</CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <Label>Carrier</Label>
              <Input
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="UHC, Aetna, Heartland…"
              />
            </div>
            <div className="md:col-span-2">
              <Label>Statement file (PDF or CSV)</Label>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                className="mt-1 rounded-lg border-2 border-dashed border-border bg-secondary/30 p-4 text-center cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-5 h-5 mx-auto text-muted-foreground" />
                <p className="text-xs text-muted-foreground mt-1">
                  {file ? file.name : "Drop file or click to browse · max 10MB"}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.csv"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  data-testid="statement-file-input"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleUpload}
              disabled={!file || !carrier || uploading}
              className="text-white"
              style={{
                background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
              }}
              data-testid="upload-statement"
            >
              {uploading ? "Processing…" : "Upload + Reconcile"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {summary ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <KpiCard
              title="Total Records"
              value={summary.total_records}
              accent="text-foreground"
            />
            <KpiCard
              title="Matched"
              value={summary.matched}
              accent="text-emerald-600"
            />
            <KpiCard
              title="Gaps"
              value={summary.underpaid}
              accent="text-red-600"
            />
            <KpiCard
              title="Unmatched"
              value={summary.unmatched}
              accent="text-amber-600"
            />
            <KpiCard
              title="Total Gap"
              value={fmtShort(summary.total_gap)}
              accent="text-red-600"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={exportReconciliation}>
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export Reconciliation
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={bulkDisputesForGaps}
              disabled={!summary.underpaid}
            >
              Create Disputes for All Gaps
            </Button>
          </div>
          <ScrollableCard
            title="Reconciliation Results"
            count={records.length}
            height="calc(100vh - 540px)"
            loading={false}
            isEmpty={records.length === 0}
            emptyState="No reconciled rows."
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Policy #</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs">{r.client_name}</TableCell>
                    <TableCell className="text-xs">{r.policy_number}</TableCell>
                    <TableCell className="text-xs">{r.product_type}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(r.expected_commission)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(r.commission_paid)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(r.gap)}
                    </TableCell>
                    <TableCell>
                      <LedgerStatusBadge status={r.match_status} />
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {r.match_confidence
                        ? `${Math.round(r.match_confidence * 100)}%`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollableCard>
        </>
      ) : null}
    </div>
  );
}
