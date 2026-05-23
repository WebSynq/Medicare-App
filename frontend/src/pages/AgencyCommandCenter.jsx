import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart2,
  RefreshCw,
  Users,
  UserCheck,
  DollarSign,
  FileText,
  Briefcase,
  Cake,
  CalendarClock,
  Building2,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
  X as XIcon,
  Eye,
  Download,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";

const ACCENT = "#e85d2f";
const DARK_BAR = "#1A1A1A";
const BLUE = "#2563eb";

const PERIOD_PREF_KEY = "ghw_period_pref";
const PERIOD_TABS = [
  { value: "mtd", label: "MTD" },
  { value: "last30", label: "Last 30" },
  { value: "last90", label: "Last 90" },
  { value: "ytd", label: "YTD" },
];

const fmtMoney = (n) =>
  n == null || Number.isNaN(n)
    ? "—"
    : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const fmtNumber = (n) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US");
const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};
const fmtDateTime = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

function relativeMinutes(d) {
  if (!d) return "never";
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

// Drill-down column definitions per metric — kept in one place so the
// SheetContent renderer stays a simple map.
const DRILLDOWN_COLUMNS = {
  leads: [
    { key: "client_name", label: "Client" },
    { key: "agent_name", label: "Agent" },
    { key: "status", label: "Status" },
    { key: "source", label: "Source" },
    { key: "created_at", label: "Created", fmt: fmtDateTime },
  ],
  enrolled: [
    { key: "client_name", label: "Client" },
    { key: "agent_name", label: "Agent" },
    { key: "carrier", label: "Carrier" },
    { key: "product", label: "Product" },
    { key: "date", label: "Date", fmt: fmtDate },
    { key: "premium", label: "Premium", fmt: fmtMoney },
  ],
  policies: [
    { key: "client_name", label: "Client" },
    { key: "agent_name", label: "Agent" },
    { key: "carrier", label: "Carrier" },
    { key: "product", label: "Product" },
    { key: "premium", label: "Premium", fmt: fmtMoney },
    { key: "written_date", label: "Written", fmt: fmtDate },
  ],
  revenue: [
    { key: "agent_name", label: "Agent" },
    { key: "policy_count", label: "Policies", fmt: fmtNumber },
    { key: "revenue", label: "Revenue", fmt: fmtMoney },
  ],
  birthday_windows: [
    { key: "client_name", label: "Client" },
    { key: "agent_name", label: "Agent" },
    { key: "date_of_birth", label: "DOB", fmt: fmtDate },
    { key: "carrier", label: "Carrier" },
    { key: "days_remaining", label: "Days Left" },
  ],
  renewals: [
    { key: "client_name", label: "Client" },
    { key: "agent_name", label: "Agent" },
    { key: "carrier", label: "Carrier" },
    { key: "anniversary", label: "Anniversary", fmt: fmtDate },
    { key: "days_until", label: "Days Until" },
  ],
  stale_leads: [
    { key: "client_name", label: "Client" },
    { key: "agent_name", label: "Agent" },
    { key: "status", label: "Status" },
    { key: "source", label: "Source" },
    { key: "phone", label: "Phone" },
    { key: "last_contact", label: "Last Contact", fmt: fmtDateTime },
  ],
};

const METRIC_TITLES = {
  leads: "All Leads",
  enrolled: "Enrolled Clients",
  policies: "Policies Written",
  revenue: "Revenue by Agent",
  birthday_windows: "Open Birthday Windows",
  renewals: "Upcoming Renewals",
  stale_leads: "Stale Leads",
};

export default function AgencyCommandCenter() {
  const navigate = useNavigate();
  const { setSelectedAgent } = useAgent();
  const [period, setPeriod] = useState(() => {
    try {
      return localStorage.getItem(PERIOD_PREF_KEY) || "mtd";
    } catch {
      return "mtd";
    }
  });
  const [kpis, setKpis] = useState(null);
  const [agents, setAgents] = useState(null);
  const [charts, setCharts] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState(null);
  const [, setNowTick] = useState(0); // forces relative-time refresh

  const [drill, setDrill] = useState(null); // {metric, agent_id?, title?}

  // Tick every 30s so "Last updated X minutes ago" is honest without
  // re-firing the network on every render.
  useEffect(() => {
    const i = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(i);
  }, []);

  // Persist the period selection so a refresh / new session keeps it.
  useEffect(() => {
    try {
      localStorage.setItem(PERIOD_PREF_KEY, period);
    } catch {
      /* localStorage disabled — in-memory only is fine */
    }
  }, [period]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [k, a, c, al] = await Promise.all([
        api.get(`/agency-dashboard/kpis?period=${period}`),
        api.get(`/agency-dashboard/agent-performance?period=${period}`),
        api.get(`/agency-dashboard/charts?period=${period}`),
        api.get(`/agency-dashboard/alerts`),
      ]);
      setKpis(k.data);
      setAgents(a.data);
      setCharts(c.data);
      setAlerts(al.data);
      setLastFetched(new Date());
    } catch (e) {
      toast.error(
        e?.response?.data?.detail || "Could not load dashboard data",
      );
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  function viewAsAgent(agentRow) {
    // Switching contexts via the AgentContext mirrors what the sidebar
    // Agent Switcher does — sets the X-Agent-ID interceptor + the
    // impersonation banner, then we deep-link straight to the agent's
    // Today page so the user lands inside their workspace.
    setSelectedAgent({
      id: agentRow.agent_id,
      name: agentRow.agent_name,
      email: agentRow.email,
    });
    toast.success(`Viewing as ${agentRow.agent_name}`);
    navigate("/today");
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground mb-1">
            <BarChart2 className="w-3.5 h-3.5" />
            Agency Overview
          </div>
          <h1
            className="text-3xl font-semibold tracking-tight text-foreground"
            style={{ fontFamily: "Outfit" }}
          >
            Agency Command Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gruening Health &amp; Wealth
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <PeriodTabs value={period} onChange={setPeriod} />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Last updated {relativeMinutes(lastFetched)}</span>
            <button
              type="button"
              onClick={fetchAll}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              aria-label="Refresh"
              data-testid="cc-refresh"
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* SECTION 1 — KPI cards (8) */}
      <KpiGrid
        kpis={kpis}
        onCardClick={(metric, title) => setDrill({ metric, title })}
      />

      {/* SECTION 2 — Charts */}
      <ChartsSection charts={charts} loading={loading} />

      {/* SECTION 3 — Agent performance table */}
      <AgentTable
        agents={agents}
        period={period}
        onViewAgent={viewAsAgent}
      />

      {/* SECTION 4 — Alerts panel */}
      <AlertsPanel
        alerts={alerts}
        onOpenAll={(metric, title) => setDrill({ metric, title })}
      />

      {/* Drill-down sheet */}
      <DrillDownSheet
        drill={drill}
        period={period}
        agents={agents?.agents || []}
        onClose={() => setDrill(null)}
      />
    </div>
  );
}

// ── Period tabs ──────────────────────────────────────────────────────────

function PeriodTabs({ value, onChange }) {
  return (
    <div
      className="inline-flex items-center gap-1 p-1 rounded-full bg-secondary"
      role="tablist"
      aria-label="Period filter"
    >
      {PERIOD_TABS.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.value)}
            className={
              "px-3.5 h-8 text-xs font-medium rounded-full transition-colors " +
              (selected
                ? "text-white shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
            style={selected ? { background: ACCENT } : undefined}
            data-testid={`cc-period-${t.value}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── KPI cards ────────────────────────────────────────────────────────────

function KpiGrid({ kpis, onCardClick }) {
  const k = kpis || {};
  const agents = k.agents || {};
  const leads = k.leads || {};
  const enrolled = k.enrolled || {};
  const revenue = k.revenue || {};
  const policies = k.policies || {};
  const carriers = k.carriers || {};
  const bday = k.birthday_windows || {};
  const renewals = k.renewals || {};
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <KpiCard
        icon={Users}
        title="Active Agents"
        value={fmtNumber(agents.total)}
        subline={
          agents.active_this_period != null
            ? `● ${agents.active_this_period} active`
            : null
        }
        onClick={() => onCardClick("stale_leads", "Stale Leads")}
      />
      <KpiCard
        icon={Briefcase}
        title="Total Leads"
        value={fmtNumber(leads.total)}
        trendPct={leads.trend_pct}
        trendLabel={
          leads.new_this_period != null
            ? `${fmtNumber(leads.new_this_period)} new`
            : null
        }
        onClick={() => onCardClick("leads", "All Leads")}
      />
      <KpiCard
        icon={UserCheck}
        title="Enrolled"
        value={fmtNumber(enrolled.total)}
        trendPct={enrolled.trend_pct}
        trendLabel={
          enrolled.new_this_period != null
            ? `${fmtNumber(enrolled.new_this_period)} new`
            : null
        }
        onClick={() => onCardClick("enrolled", "Enrolled Clients")}
      />
      <KpiCard
        icon={DollarSign}
        title="Est. Revenue"
        value={fmtMoney(revenue.total_estimated)}
        trendPct={revenue.trend_pct}
        trendLabel={
          revenue.this_period != null
            ? fmtMoney(revenue.this_period) + " this period"
            : null
        }
        onClick={() => onCardClick("revenue", "Revenue by Agent")}
      />
      <KpiCard
        icon={FileText}
        title="Policies Written"
        value={fmtNumber(policies.total_written)}
        subline={
          policies.this_period != null
            ? `${fmtNumber(policies.this_period)} this period`
            : null
        }
        onClick={() => onCardClick("policies", "Policies Written")}
      />
      <KpiCard
        icon={Building2}
        title="Active Carriers"
        value={fmtNumber(carriers.active_count)}
      />
      <KpiCard
        icon={Cake}
        title="Birthday Windows"
        value={fmtNumber(bday.open_now)}
        alert={(bday.open_now || 0) > 0}
        alertColor="bg-red-100 text-red-900"
        onClick={() => onCardClick("birthday_windows", "Open Birthday Windows")}
      />
      <KpiCard
        icon={CalendarClock}
        title="Renewals · 30d"
        value={fmtNumber(renewals.due_30_days)}
        alert={(renewals.due_30_days || 0) > 0}
        alertColor="bg-amber-100 text-amber-900"
        onClick={() => onCardClick("renewals", "Upcoming Renewals")}
      />
    </div>
  );
}

function KpiCard({
  icon: Icon,
  title,
  value,
  subline,
  trendPct,
  trendLabel,
  alert,
  alertColor,
  onClick,
}) {
  const clickable = !!onClick;
  const positive = trendPct != null && trendPct >= 0;
  const trendArrow = trendPct == null ? null : positive ? ArrowUpRight : ArrowDownRight;
  const TrendIcon = trendArrow;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      className={
        "text-left rounded-lg border border-border bg-card p-4 transition-all " +
        (clickable
          ? "hover:border-foreground/20 hover:shadow-sm cursor-pointer"
          : "cursor-default")
      }
      data-testid={`cc-card-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div
        className="text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Outfit" }}
      >
        {value}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        {trendPct != null && TrendIcon ? (
          <span
            className={
              "inline-flex items-center gap-0.5 font-medium " +
              (positive ? "text-emerald-700" : "text-red-700")
            }
          >
            <TrendIcon className="w-3 h-3" />
            {Math.abs(trendPct).toFixed(1)}%
          </span>
        ) : null}
        {trendLabel ? <span>{trendLabel}</span> : null}
        {subline ? <span>{subline}</span> : null}
        {alert ? (
          <span
            className={
              "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold " +
              (alertColor || "bg-red-100 text-red-900")
            }
          >
            Action
          </span>
        ) : null}
      </div>
    </button>
  );
}

// ── Charts section ────────────────────────────────────────────────────────

function ChartsSection({ charts, loading }) {
  const enrollments = charts?.enrollments_by_week || [];
  const carriers = charts?.revenue_by_carrier || [];
  const sources = charts?.leads_by_source || [];

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-3">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Enrollments by Week</h3>
              <span className="text-xs text-muted-foreground">Last 12 weeks</span>
            </div>
            <div className="h-64">
              {loading && enrollments.length === 0 ? (
                <div className="h-full grid place-items-center text-xs text-muted-foreground">
                  Loading…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={enrollments}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <RTooltip />
                    <Bar dataKey="count" name="Enrollments" fill={ACCENT} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Revenue by Carrier</h3>
              <span className="text-xs text-muted-foreground">Top 8</span>
            </div>
            <div className="h-64">
              {carriers.length === 0 ? (
                <div className="h-full grid place-items-center text-xs text-muted-foreground">
                  {loading ? "Loading…" : "No revenue data for this period."}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={carriers} layout="vertical" margin={{ left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis
                      dataKey="carrier"
                      type="category"
                      width={110}
                      tick={{ fontSize: 11 }}
                    />
                    <RTooltip formatter={(v) => fmtMoney(v)} />
                    <Bar dataKey="revenue" name="Revenue" fill={DARK_BAR} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Lead Sources</h3>
            <span className="text-xs text-muted-foreground">
              Total vs Enrolled
            </span>
          </div>
          <div className="h-64">
            {sources.length === 0 ? (
              <div className="h-full grid place-items-center text-xs text-muted-foreground">
                {loading ? "Loading…" : "No lead-source data for this period."}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sources}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="source" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <RTooltip
                    formatter={(v, n, p) => {
                      if (n === "Conversion") return `${v.toFixed(1)}%`;
                      return v;
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="total" name="Total" fill={BLUE} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="enrolled" name="Enrolled" fill={ACCENT} radius={[4, 4, 0, 0]}>
                    {sources.map((s, i) => (
                      <Cell key={i} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Agent performance table ───────────────────────────────────────────────

function statusBadge(status) {
  switch (status) {
    case "active":
      return { className: "bg-emerald-100 text-emerald-900", label: "Active", dot: "bg-emerald-500" };
    case "stale":
      return { className: "bg-amber-100 text-amber-900", label: "Stale", dot: "bg-amber-500" };
    default:
      return { className: "bg-zinc-200 text-zinc-700", label: "Inactive", dot: "bg-zinc-400" };
  }
}

function AgentTable({ agents, period, onViewAgent }) {
  const [sortKey, setSortKey] = useState("enrolled_count");
  const [sortDir, setSortDir] = useState("desc"); // asc | desc

  const rows = useMemo(() => {
    const list = agents?.agents || [];
    const copy = [...list];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return copy;
  }, [agents, sortKey, sortDir]);

  function header(key, label, align = "left") {
    const active = sortKey === key;
    return (
      <TableHead
        onClick={() => {
          if (active) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
          else {
            setSortKey(key);
            setSortDir("desc");
          }
        }}
        className={
          "cursor-pointer select-none whitespace-nowrap " +
          (align === "right" ? "text-right" : "")
        }
      >
        {label}
        {active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
      </TableHead>
    );
  }

  const periodLabel =
    PERIOD_TABS.find((p) => p.value === period)?.label || period;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold">Agent Performance</h3>
            <p className="text-xs text-muted-foreground">{periodLabel}</p>
          </div>
          <p className="text-xs text-muted-foreground italic hidden sm:block">
            Click a row to view that agent's workspace
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {header("agent_name", "Agent")}
                <TableHead>Status</TableHead>
                {header("leads_count", "Leads", "right")}
                {header("enrolled_count", "Enrolled", "right")}
                {header("conversion_rate", "Conv %", "right")}
                {header("estimated_revenue", "Revenue", "right")}
                {header("trend_pct", "Trend", "right")}
                {header("team_size", "Team", "right")}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {agents == null ? "Loading…" : "No agents to show."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((a) => {
                  const s = statusBadge(a.status);
                  const positive = (a.trend_pct ?? 0) >= 0;
                  return (
                    <TableRow
                      key={a.agent_id}
                      onClick={() => onViewAgent(a)}
                      className="cursor-pointer hover:bg-secondary/60"
                      data-testid={`cc-agent-row-${a.agent_id}`}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${s.dot}`} />
                          <div>
                            <div className="font-medium">{a.agent_name || "—"}</div>
                            <div className="text-[11px] text-muted-foreground">{a.email}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={`rounded-full border-0 text-[11px] ${s.className}`}>
                          {s.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNumber(a.leads_count)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNumber(a.enrolled_count)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {a.conversion_rate?.toFixed(1) ?? "0.0"}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(a.estimated_revenue)}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={
                            "inline-flex items-center gap-0.5 text-xs font-medium " +
                            (positive ? "text-emerald-700" : "text-red-700")
                          }
                        >
                          {positive ? (
                            <ArrowUpRight className="w-3 h-3" />
                          ) : (
                            <ArrowDownRight className="w-3 h-3" />
                          )}
                          {Math.abs(a.trend_pct ?? 0).toFixed(1)}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNumber(a.team_size)}
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onViewAgent(a)}
                          className="h-7 text-xs"
                          data-testid={`cc-view-${a.agent_id}`}
                        >
                          <Eye className="w-3 h-3 mr-1" /> View Workspace
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Alerts panel ──────────────────────────────────────────────────────────

function AlertsPanel({ alerts, onOpenAll }) {
  const stale = alerts?.stale_leads || [];
  const bday = alerts?.birthday_windows || [];
  const renew = alerts?.renewals_due || [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <AlertsCard
        title="Stale Leads"
        emoji="🕒"
        emptyLabel="No follow-up backlog. Nice."
        footerLabel={
          stale.length > 0 ? `${stale.length} agents need follow-up` : null
        }
        onViewAll={() => onOpenAll("stale_leads", "Stale Leads")}
      >
        {stale.map((row) => (
          <div
            key={row.agent_id}
            className="flex items-center justify-between text-sm py-1.5"
          >
            <span className="truncate">{row.agent_name}</span>
            <Badge className="rounded-full bg-red-100 text-red-900 border-0">
              {row.count}
            </Badge>
          </div>
        ))}
      </AlertsCard>

      <AlertsCard
        title="Birthday Windows Open"
        emoji="🎂"
        emptyLabel="No open windows today."
        onViewAll={() => onOpenAll("birthday_windows", "Open Birthday Windows")}
      >
        {bday.slice(0, 5).map((row) => (
          <div key={row.lead_id} className="text-sm py-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium truncate">{row.client_name}</span>
              <Badge className="rounded-full bg-amber-100 text-amber-900 border-0">
                {row.days_remaining}d
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {row.agent_name} · {row.carrier || "—"}
            </div>
          </div>
        ))}
      </AlertsCard>

      <AlertsCard
        title="Renewals Due This Week"
        emoji="🔄"
        emptyLabel="No renewals in the next 7 days."
        onViewAll={() => onOpenAll("renewals", "Upcoming Renewals")}
      >
        {renew.slice(0, 5).map((row, i) => (
          <div key={`${row.lead_id || "noid"}-${i}`} className="text-sm py-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium truncate">{row.client_name}</span>
              <Badge className="rounded-full bg-blue-100 text-blue-900 border-0">
                {row.days_until}d
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {row.agent_name} · {row.carrier || "—"}
            </div>
          </div>
        ))}
      </AlertsCard>
    </div>
  );
}

function AlertsCard({ title, emoji, emptyLabel, footerLabel, children, onViewAll }) {
  const isEmpty = Array.isArray(children) ? children.length === 0 : !children;
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <span>{emoji}</span> {title}
          </h3>
          <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        {isEmpty ? (
          <p className="text-sm text-muted-foreground py-2">{emptyLabel}</p>
        ) : (
          <div className="divide-y divide-border">{children}</div>
        )}
        <button
          type="button"
          onClick={onViewAll}
          className="mt-3 text-xs font-medium hover:underline"
          style={{ color: ACCENT }}
        >
          View All →
        </button>
        {footerLabel ? (
          <p className="text-[11px] text-muted-foreground mt-2">{footerLabel}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Drill-down sheet ──────────────────────────────────────────────────────

function DrillDownSheet({ drill, period, agents, onClose }) {
  const open = !!drill;
  const [page, setPage] = useState(1);
  const [agentFilter, setAgentFilter] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  // Reset paging when the drill or filter changes.
  const lastMetric = useRef(null);
  useEffect(() => {
    if (!open) return;
    if (lastMetric.current !== drill.metric) {
      lastMetric.current = drill.metric;
      setPage(1);
      setAgentFilter("all");
    }
  }, [open, drill]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("period", period);
    params.set("page", String(page));
    if (agentFilter !== "all") params.set("agent_id", agentFilter);
    api
      .get(`/agency-dashboard/drilldown/${drill.metric}?${params.toString()}`)
      .then((res) => setData(res.data))
      .catch((e) =>
        toast.error(
          e?.response?.data?.detail || "Could not load drill-down",
        ),
      )
      .finally(() => setLoading(false));
  }, [open, drill, period, page, agentFilter]);

  const columns = drill ? DRILLDOWN_COLUMNS[drill.metric] || [] : [];
  const rows = data?.rows || [];
  const title = drill?.title || (drill && METRIC_TITLES[drill.metric]) || "";

  function exportCsv() {
    if (rows.length === 0) {
      toast.message("Nothing to export yet.");
      return;
    }
    const header = columns.map((c) => c.label).join(",");
    const lines = rows.map((r) =>
      columns
        .map((c) => {
          let v = r[c.key];
          if (c.fmt) v = c.fmt(v);
          if (v == null) v = "";
          const s = String(v).replace(/"/g, '""');
          return /[",\n]/.test(s) ? `"${s}"` : s;
        })
        .join(","),
    );
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${drill.metric}-${period}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="!max-w-[600px] w-full sm:w-[600px] p-0 flex flex-col"
      >
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-lg font-semibold">{title}</SheetTitle>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
              aria-label="Close"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-xs text-muted-foreground">Period:</span>
            <Badge className="rounded-full bg-secondary text-foreground border-0">
              {PERIOD_TABS.find((p) => p.value === period)?.label || period}
            </Badge>
            <span className="text-xs text-muted-foreground ml-2">Agent:</span>
            <Select
              value={agentFilter}
              onValueChange={(v) => {
                setAgentFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-48">
                <SelectValue placeholder="All Agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Agents</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.agent_id} value={a.agent_id}>
                    {a.agent_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-8 text-xs"
              onClick={exportCsv}
            >
              <Download className="w-3 h-3 mr-1" /> Export CSV
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto px-5 pb-5">
          {loading && rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">
              Loading…
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">
              No records for this filter.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((c) => (
                    <TableHead key={c.key}>{c.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    {columns.map((c) => {
                      const raw = r[c.key];
                      const v = c.fmt ? c.fmt(raw) : raw;
                      return (
                        <TableCell key={c.key} className="text-xs">
                          {v == null || v === "" ? "—" : v}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {data && data.total > 0 ? (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {data.page} of {data.total_pages} · {data.total} total
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.total_pages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Load more
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
