import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  DollarSign,
  Eye,
  FileSignature,
  ListChecks,
  Minus,
  PieChart as PieIcon,
  Quote as QuoteIcon,
  Sparkles,
  TrendingUp,
  Users2,
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
import { api, auth } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import InviteAgentModal from "@/components/InviteAgentModal";
import QuickAddLeadSheet from "@/components/QuickAddLeadSheet";
import ScrollableCard from "@/components/ScrollableCard";

const PERIODS = [
  { value: "mtd", label: "MTD" },
  { value: "ytd", label: "YTD" },
  { value: "last30", label: "Last 30" },
  { value: "last90", label: "Last 90" },
];

const ACCENT = "#e85d2f";

// Donut palette for the product breakdown — stable, color-blind friendly.
const PIE_COLORS = [
  "#e85d2f", "#1e2d3d", "#3b82f6", "#10b981",
  "#a855f7", "#f59e0b", "#ef4444", "#0ea5e9",
  "#14b8a6", "#6366f1",
];

const URGENCY_BORDER = {
  high: "border-l-rose-500",
  medium: "border-l-amber-500",
  low: "border-l-emerald-500",
};

const QUOTE_CATEGORY_LABEL = {
  mindset: "Mindset",
  sales: "Sales",
  discipline: "Discipline",
  winning: "Winning",
};

function fmtMoney(n) {
  const v = Number(n || 0);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function monthLabel(yyyymm) {
  if (!yyyymm || yyyymm.length < 7) return yyyymm || "";
  const [y, m] = yyyymm.split("-");
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return d.toLocaleString("en-US", { month: "short" });
}

// Build a small {dir,label} object describing how `current` moved vs
// `prev`. "new" when the prior week was zero but this week isn't,
// "—" when there's nothing to compare on either side. Returns null when
// the caller didn't pass a prev value so the card stays unchanged.
function buildTrend(current, prev) {
  if (prev === undefined || prev === null) return null;
  const c = current || 0;
  const p = prev || 0;
  if (p === 0) {
    if (c === 0) return { dir: "flat", label: "—" };
    return { dir: "up", label: "new" };
  }
  const pct = Math.round(((c - p) / p) * 100);
  if (c === p) return { dir: "flat", label: "0%" };
  const sign = c > p ? "+" : "";
  return { dir: c > p ? "up" : "down", label: `${sign}${pct}%` };
}

// ── Small reusable bits ─────────────────────────────────────────────────
function KpiCard({ label, value, icon: Icon, accent = false, money = false, trend = null }) {
  const TrendIcon =
    trend?.dir === "up" ? ArrowUpRight : trend?.dir === "down" ? ArrowDownRight : Minus;
  const trendColor =
    trend?.dir === "up"
      ? "text-emerald-700"
      : trend?.dir === "down"
        ? "text-rose-700"
        : "text-muted-foreground";
  return (
    <Card className="bg-surface">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div
          className={`mt-2 tabular-nums ${accent ? "text-[#e85d2f]" : "text-foreground"}`}
          style={{
            fontFamily: "Outfit",
            fontSize: money ? 26 : 30,
            fontWeight: 700,
          }}
        >
          {money ? fmtMoney(value) : (value ?? 0).toLocaleString()}
        </div>
        {trend && (
          <div
            className={`mt-1 flex items-center gap-1 text-[11px] font-medium ${trendColor}`}
            data-testid="kpi-trend"
          >
            <TrendIcon className="w-3 h-3" />
            <span>{trend.label} vs last week</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionTitle({ icon: Icon, children, action }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-[#e85d2f]" />}
        <h3 className="text-sm font-semibold tracking-tight" style={{ fontFamily: "Outfit" }}>
          {children}
        </h3>
      </div>
      {action}
    </div>
  );
}

function SkeletonBlock({ className = "h-24" }) {
  return <div className={`rounded-md bg-secondary/40 animate-pulse ${className}`} />;
}

// Daily inspiration card — full-width, visually dominant. Dark navy
// background with a giant faded quote-mark watermark, the line itself in
// italic white, author/category callouts. Sets the tone for the day.
function DailyQuoteCard({ quote, loading }) {
  if (loading) {
    return <SkeletonBlock className="h-32 mb-4" />;
  }
  if (!quote || !quote.text) return null;
  const categoryLabel = QUOTE_CATEGORY_LABEL[quote.category] || "Mindset";
  return (
    <div
      className="relative overflow-hidden rounded-xl mb-6 px-6 py-7 md:px-10 md:py-9 text-white"
      style={{
        background:
          "linear-gradient(135deg, #0f172a 0%, #1e2d3d 60%, #2a1810 100%)",
      }}
      data-testid="daily-quote-card"
    >
      <QuoteIcon
        className="absolute -top-2 -left-2 w-32 h-32 md:w-44 md:h-44"
        style={{ color: "rgba(232, 93, 47, 0.10)" }}
        aria-hidden="true"
      />
      <span
        className="absolute top-4 right-4 inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wider uppercase"
        style={{
          background: "rgba(232, 93, 47, 0.15)",
          color: "#ffb997",
          border: "1px solid rgba(232, 93, 47, 0.4)",
        }}
      >
        {categoryLabel}
      </span>
      <blockquote
        className="relative italic leading-snug text-lg md:text-2xl font-medium max-w-3xl"
        style={{ fontFamily: "Outfit" }}
      >
        “{quote.text}”
      </blockquote>
      <div
        className="relative mt-4 text-right text-sm font-semibold"
        style={{ color: "#ff8a5b" }}
      >
        — {quote.author}
      </div>
    </div>
  );
}

function todayDateLine() {
  try {
    return new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function PeriodTabs({ value, onChange }) {
  return (
    <div
      role="tablist"
      aria-label="Period filter"
      className="inline-flex rounded-md border border-border bg-background overflow-hidden text-xs"
      data-testid="dashboard-period-tabs"
    >
      {PERIODS.map((p) => (
        <button
          key={p.value}
          role="tab"
          aria-selected={value === p.value}
          type="button"
          onClick={() => onChange(p.value)}
          className={`px-3 h-8 transition-colors ${
            value === p.value
              ? "bg-[#e85d2f] text-white"
              : "text-foreground/70 hover:bg-secondary"
          }`}
          data-testid={`dashboard-period-${p.value}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────
function RevenueBarChart({ data }) {
  const series = (data || []).map((d) => ({
    label: monthLabel(d.month),
    revenue: Number(d.revenue || 0),
  }));
  const empty = series.every((d) => d.revenue === 0);
  if (empty) {
    return (
      <div className="h-56 grid place-items-center text-xs text-muted-foreground">
        No revenue recorded in the last 6 months yet.
      </div>
    );
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
          />
          <Tooltip
            formatter={(v) => fmtMoney(v)}
            cursor={{ fill: "rgba(232,93,47,0.08)" }}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey="revenue" fill={ACCENT} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ProductDonut({ data }) {
  const items = (data || []).slice(0, 10);
  if (items.length === 0) {
    return (
      <div className="h-56 grid place-items-center text-xs text-muted-foreground">
        No policies on record yet.
      </div>
    );
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={items}
            dataKey="count"
            nameKey="product"
            cx="50%"
            cy="50%"
            innerRadius={45}
            outerRadius={75}
            paddingAngle={2}
          >
            {items.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(v, _name, item) =>
              [`${v} · ${fmtMoney(item?.payload?.revenue)}`, item?.payload?.product]
            }
            contentStyle={{ fontSize: 12 }}
          />
          <Legend
            verticalAlign="bottom"
            iconSize={8}
            wrapperStyle={{ fontSize: 11 }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function PipelineFunnel({ stats }) {
  const stages = [
    { key: "leads_new", label: "New", value: stats?.leads_new || 0 },
    { key: "leads_contacted", label: "Contacted", value: stats?.leads_contacted || 0 },
    { key: "leads_qualified", label: "Qualified", value: stats?.leads_qualified || 0 },
    { key: "appointments_set", label: "Appt Set", value: stats?.appointments_set || 0 },
    { key: "leads_enrolled", label: "Enrolled", value: stats?.leads_enrolled || 0 },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-2">
      {stages.map((s, i) => {
        const pct = (s.value / max) * 100;
        const prev = i > 0 ? stages[i - 1].value : null;
        const conv =
          prev && prev > 0
            ? `${Math.round((s.value / prev) * 100)}% from prev`
            : null;
        return (
          <div key={s.key} className="text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium">{s.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {s.value}
                {conv && <span className="ml-2 text-[10px]">({conv})</span>}
              </span>
            </div>
            <div className="h-3 rounded bg-secondary overflow-hidden">
              <div
                className="h-full rounded"
                style={{
                  width: `${Math.max(2, pct)}%`,
                  background: `linear-gradient(90deg, ${ACCENT} 0%, #c84416 100%)`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Lists ───────────────────────────────────────────────────────────────
function AlertsList({ alerts, isAdminAgency }) {
  if (!alerts || alerts.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center" data-testid="alerts-empty">
        ✅ All caught up!
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {alerts.map((a, i) => (
        <div
          key={i}
          className={`rounded-md border border-border border-l-4 ${
            URGENCY_BORDER[a.urgency] || "border-l-gray-400"
          } bg-background p-3 flex items-start gap-3`}
          data-testid={`alert-${a.type}`}
        >
          <AlertTriangle className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">{a.message}</div>
            <div className="text-[11px] text-muted-foreground truncate">
              {a.lead_name}
              {isAdminAgency && a.agent_name && (
                <span className="ml-1 opacity-80">· {a.agent_name}</span>
              )}
            </div>
          </div>
          {a.lead_id && (
            <Button
              asChild
              size="sm"
              variant="outline"
              className="text-xs h-7 px-2 flex-shrink-0"
            >
              <Link to={`/clients/${a.lead_id}`}>View</Link>
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({ events }) {
  if (!events || events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        Nothing recorded yet today.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {events.map((e, i) => (
        <li key={i} className="flex items-start gap-3 text-xs">
          <div className="w-1.5 h-1.5 rounded-full bg-[#e85d2f] mt-1.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium capitalize">{e.description || e.action}</div>
            <div className="text-[10px] text-muted-foreground">
              {fmtDateTime(e.timestamp)}
              {e.lead_name ? ` · ${e.lead_name}` : ""}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Agent performance table (admin view) ────────────────────────────────
function AgentPerformanceTable({ rows, onViewAs }) {
  const [sortKey, setSortKey] = useState("revenue_mtd");
  const [dir, setDir] = useState("desc");

  const sorted = useMemo(() => {
    const out = [...(rows || [])];
    out.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return dir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [rows, sortKey, dir]);

  function header(label, key) {
    const active = sortKey === key;
    return (
      <button
        type="button"
        onClick={() => {
          if (active) setDir(dir === "asc" ? "desc" : "asc");
          else {
            setSortKey(key);
            setDir(key === "agent_name" ? "asc" : "desc");
          }
        }}
        className={`inline-flex items-center gap-1 text-xs ${
          active ? "text-foreground font-semibold" : "text-muted-foreground"
        }`}
      >
        {label}
        {active && <span>{dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        No agents on file yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{header("Agent", "agent_name")}</TableHead>
            <TableHead className="text-right">{header("Leads", "leads")}</TableHead>
            <TableHead className="text-right">{header("Apps MTD", "apps_mtd")}</TableHead>
            <TableHead className="text-right">{header("Revenue MTD", "revenue_mtd")}</TableHead>
            <TableHead className="text-right">{header("Active Policies", "policies_active")}</TableHead>
            <TableHead className="text-right">{header("Conv %", "conversion_rate")}</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => (
            <TableRow key={r.agent_id} className="hover:bg-secondary/40">
              <TableCell className="font-medium text-sm">{r.agent_name}</TableCell>
              <TableCell className="text-right tabular-nums">{r.leads}</TableCell>
              <TableCell className="text-right tabular-nums">{r.apps_mtd}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtMoney(r.revenue_mtd)}</TableCell>
              <TableCell className="text-right tabular-nums">{r.policies_active}</TableCell>
              <TableCell className="text-right tabular-nums">{r.conversion_rate}%</TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onViewAs(r)}
                  data-testid={`view-as-${r.agent_id}`}
                >
                  <Eye className="w-3 h-3 mr-1" /> View Workspace
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────
export default function AgentDashboard() {
  const navigate = useNavigate();
  const user = auth.getUser();
  const role = user?.role;
  const { isImpersonating, selectedAgent, setSelectedAgent } = useAgent();

  // Leadership / back-office roles see the agency-wide view by default.
  // coach + accounting were added once both joined the
  // FULL_AGENCY_SCOPE_ROLES list — without widening this gate they'd get
  // an empty personal-view dashboard (no leads of their own to populate
  // the KPI row).
  const isAgencyViewRole =
    role === "admin" ||
    role === "compliance" ||
    role === "coach" ||
    role === "accounting";
  const isAdminAgency = isAgencyViewRole && !isImpersonating;
  const impersonatedName =
    isImpersonating
      ? selectedAgent?.full_name ||
        selectedAgent?.agent_name ||
        selectedAgent?.email ||
        "Agent"
      : null;

  const [period, setPeriod] = useState("mtd");
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [showNewLead, setShowNewLead] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/dashboard/stats?period=${period}`);
      setStats(data);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || err?.message || "Failed to load dashboard",
      );
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load, isImpersonating]);

  function handleViewAs(row) {
    setSelectedAgent({
      id: row.agent_id,
      full_name: row.agent_name,
      agent_name: row.agent_name,
    });
    toast.success(`Viewing as ${row.agent_name}`);
    // Stay on /dashboard — the AgentContext flip will re-fetch via the
    // effect above and the view will switch to agent-personal.
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        {/* ── Welcome row ── */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
              {isAdminAgency ? "Agency Command Center" : "Performance Dashboard"}
            </p>
            <h1
              className="text-2xl font-bold text-[#1e2d3d] flex flex-wrap items-center gap-2"
              style={{ fontFamily: "Outfit" }}
            >
              <span>
                {isAdminAgency
                  ? `Welcome back, ${user?.full_name?.split(" ")[0] || "Admin"}`
                  : `Welcome back, ${(user?.full_name || user?.email || "Agent").split(/[ @]/)[0]}`}
              </span>
              {/* Agency-view / impersonation context badge. The orange
                  ImpersonationBanner below carries the full alert; this
                  is the inline title cue so leadership users don't
                  mistake aggregate numbers for one agent's. */}
              {isAdminAgency && (
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded-full uppercase tracking-wider"
                  style={{
                    background: "rgba(30,45,61,0.08)",
                    color: "#1e2d3d",
                  }}
                  data-testid="dashboard-agency-badge"
                >
                  Agency View
                </span>
              )}
              {isImpersonating && impersonatedName && (
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded-full uppercase tracking-wider"
                  style={{
                    background: "rgba(232,93,47,0.12)",
                    color: "#c84416",
                  }}
                  data-testid="dashboard-viewing-badge"
                >
                  Viewing: {impersonatedName}
                </span>
              )}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{todayDateLine()}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isAdminAgency
                ? "Agency-wide production, pipeline, and action items."
                : "Your production at a glance — pipeline, revenue, and what needs attention."}
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
          <div className="flex flex-col items-end gap-2">
            <PeriodTabs value={period} onChange={setPeriod} />
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowNewLead(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white shadow-sm hover:opacity-95 transition-opacity"
                style={{ background: `linear-gradient(135deg, ${ACCENT} 0%, #c84416 100%)` }}
                data-testid="new-lead-header"
              >
                + New Lead
              </button>
              {role === "admin" && (
                <button
                  type="button"
                  onClick={() => setShowInvite(true)}
                  className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium"
                  style={{ border: "1px solid #1e2d3d", color: "#1e2d3d" }}
                  data-testid="invite-agent-header"
                >
                  + Invite Agent
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Daily quote card ── */}
        <DailyQuoteCard quote={stats?.daily_quote} loading={loading} />

        {/* ── ROW 1: KPI cards ── */}
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-6">
            {Array.from({ length: 7 }).map((_, i) => (
              <SkeletonBlock key={i} />
            ))}
          </div>
        ) : isAdminAgency ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-6">
            <KpiCard
              label="This Week"
              value={stats?.weekly_enrollments || 0}
              icon={CalendarDays}
              trend={buildTrend(stats?.weekly_enrollments, stats?.weekly_enrollments_prev)}
            />
            <KpiCard label="Active Agents" value={stats?.agents_active || 0} icon={Users2} />
            <KpiCard label="Leads MTD" value={stats?.leads_total || 0} icon={ListChecks} />
            <KpiCard label="Apps MTD" value={stats?.apps_submitted_mtd || 0} icon={FileSignature} />
            <KpiCard label="Agency Revenue" value={stats?.revenue_mtd || 0} money icon={DollarSign} accent />
            <KpiCard label="Active Policies" value={stats?.policies_active || 0} icon={ClipboardList} />
            <KpiCard label="Open Alerts" value={(stats?.alerts || []).length} icon={Bell} />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-6">
            <KpiCard
              label="This Week"
              value={stats?.weekly_enrollments || 0}
              icon={CalendarDays}
              trend={buildTrend(stats?.weekly_enrollments, stats?.weekly_enrollments_prev)}
            />
            <KpiCard label="New Leads" value={stats?.leads_new || 0} icon={Sparkles} accent />
            <KpiCard label="Apps Submitted" value={stats?.apps_submitted_mtd || 0} icon={FileSignature} />
            <KpiCard label="SOAs Sent" value={stats?.soa_sent_mtd || 0} icon={FileSignature} />
            <KpiCard label="SOAs Signed" value={stats?.soa_signed_mtd || 0} icon={CheckCircle2} />
            <KpiCard label="Active Policies" value={stats?.policies_active || 0} icon={ClipboardList} />
            <KpiCard label="Revenue MTD" value={stats?.revenue_mtd || 0} money icon={DollarSign} accent />
          </div>
        )}

        {/* ── ROW 2: Revenue chart ── */}
        <Card className="bg-surface mb-4">
          <CardContent className="p-5">
            <SectionTitle icon={TrendingUp}>
              {isAdminAgency ? "Agency Monthly Revenue" : "Monthly Revenue"}
            </SectionTitle>
            {loading ? <SkeletonBlock className="h-56" /> : <RevenueBarChart data={stats?.revenue_by_month} />}
          </CardContent>
        </Card>

        {/* ── ROW 3: Product donut + Pipeline / Agent table ── */}
        {isAdminAgency ? (
          <div className="mb-4">
            <ScrollableCard
              title="Agent Performance"
              count={stats?.agent_breakdown?.length}
              height="400px"
              loading={loading}
              isEmpty={!loading && !(stats?.agent_breakdown || []).length}
              emptyState="No agents on file yet."
              testId="dashboard-agent-performance"
            >
              <div className="p-3">
                <AgentPerformanceTable
                  rows={stats?.agent_breakdown}
                  onViewAs={handleViewAs}
                />
              </div>
            </ScrollableCard>
          </div>
        ) : null}

        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <Card className="bg-surface">
            <CardContent className="p-5">
              <SectionTitle icon={PieIcon}>Product Breakdown</SectionTitle>
              {loading ? <SkeletonBlock className="h-56" /> : <ProductDonut data={stats?.policies_by_product} />}
            </CardContent>
          </Card>
          <Card className="bg-surface">
            <CardContent className="p-5">
              <SectionTitle icon={TrendingUp}>
                {isAdminAgency ? "Top 5 Agents · Revenue MTD" : "Pipeline Health"}
              </SectionTitle>
              {loading ? (
                <SkeletonBlock className="h-56" />
              ) : isAdminAgency ? (
                <TopAgentsList rows={stats?.agent_breakdown} />
              ) : (
                <PipelineFunnel stats={stats} />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── ROW 4: Alerts ── */}
        <div className="mb-4">
          <ScrollableCard
            title="Needs Attention"
            count={stats?.alerts?.length}
            height="360px"
            loading={loading}
            isEmpty={!loading && !(stats?.alerts || []).length}
            emptyState="✅ All caught up — nothing needs attention today!"
            testId="dashboard-alerts"
          >
            <div className="p-4">
              <AlertsList alerts={stats?.alerts} isAdminAgency={isAdminAgency} />
            </div>
          </ScrollableCard>
        </div>

        {/* ── ROW 5: Activity ── */}
        <div className="mb-6">
          <ScrollableCard
            title="Today's Activity"
            height="300px"
            loading={loading}
            isEmpty={!loading && !(stats?.recent_activity || []).length}
            emptyState="Nothing recorded yet today."
            headerAction={
              <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                <Link to="/audit">
                  Full audit log <ChevronRight className="w-3 h-3 ml-0.5" />
                </Link>
              </Button>
            }
            testId="dashboard-activity"
          >
            <div className="p-4">
              <ActivityFeed events={stats?.recent_activity} />
            </div>
          </ScrollableCard>
        </div>
      </main>

      <QuickAddLeadSheet
        open={showNewLead}
        onOpenChange={setShowNewLead}
        onCreated={() => load()}
      />
      {showInvite && <InviteAgentModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}

function TopAgentsList({ rows }) {
  const sorted = (rows || [])
    .filter((r) => (r.revenue_mtd || 0) > 0)
    .sort((a, b) => (b.revenue_mtd || 0) - (a.revenue_mtd || 0))
    .slice(0, 5);
  if (sorted.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        No agent revenue posted yet this period.
      </div>
    );
  }
  const max = Math.max(1, ...sorted.map((r) => r.revenue_mtd || 0));
  return (
    <ol className="space-y-2">
      {sorted.map((r, i) => (
        <li key={r.agent_id} className="text-xs">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium truncate">
              <span className="text-muted-foreground mr-1">{i + 1}.</span>
              {r.agent_name}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {fmtMoney(r.revenue_mtd)}
            </span>
          </div>
          <div className="h-2 rounded bg-secondary overflow-hidden">
            <div
              className="h-full rounded"
              style={{
                width: `${(r.revenue_mtd / max) * 100}%`,
                background: `linear-gradient(90deg, ${ACCENT} 0%, #c84416 100%)`,
              }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
