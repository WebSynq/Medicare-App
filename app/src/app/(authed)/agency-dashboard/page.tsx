"use client";

/**
 * Agency Command Center — leadership-only deep dashboard.
 *
 * Ports CRA frontend/src/pages/AgencyCommandCenter.jsx. Same four
 * sections (KPI grid → charts → agent table → alerts) plus a
 * right-side drilldown sheet that any KPI card can open.
 *
 * The combined /dashboard route also surfaces an Agency Overview
 * section (the same four panels minus the drilldown sheet) for
 * leadership roles, sitting under their personal Today. This page
 * is the dedicated leadership surface — sidebar's "Command Center"
 * link lands here.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  Briefcase,
  Building2,
  Cake,
  CalendarClock,
  DollarSign,
  Download,
  Eye,
  FileText,
  RefreshCw,
  UserCheck,
  Users,
  X as XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { dashboard as dashboardApi } from "@/lib/api";
import type {
  AgencyAlertsResponse,
  AgencyChartsResponse,
  AgencyKpisResponse,
  AgentPerfRow,
  DrilldownMetric,
  DrilldownResponse,
  DrilldownRow,
} from "@/lib/api/dashboard";
import { useAuthStore } from "@/stores/auth";
import type { UserRole } from "@/types";

// ─── Role gate ────────────────────────────────────────────────────────────
// Mirrors CRA Layout.jsx COMMAND_CENTER_ROLES_SET and the backend
// agency_dashboard_router AGENCY_ROLES. Update all three together if
// leadership composition changes.
const COMMAND_CENTER_ROLES: readonly UserRole[] = [
  "owner",
  "admin",
  "coach",
  "sales_manager",
  "compliance",
  "accounting",
] as const;

// Spec: "Revenue cards: admin/owner/compliance see full amount, other
// roles see '—'". Tighter than COMMAND_CENTER_ROLES — coach,
// sales_manager and accounting still see the page but revenue numbers
// are masked.
const REVENUE_VISIBLE_ROLES: readonly UserRole[] = [
  "admin",
  "owner",
  "compliance",
] as const;

// ─── Period state ─────────────────────────────────────────────────────────

type Period = "mtd" | "last30" | "last90" | "ytd";

const PERIOD_TABS: readonly { value: Period; label: string }[] = [
  { value: "mtd", label: "MTD" },
  { value: "last30", label: "Last 30" },
  { value: "last90", label: "Last 90" },
  { value: "ytd", label: "YTD" },
] as const;

const PERIOD_PREF_KEY = "ghw_period_pref";

function isPeriod(v: string | null): v is Period {
  return v === "mtd" || v === "last30" || v === "last90" || v === "ytd";
}

// ─── Formatters ───────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function fmtNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return USD.format(n);
}

function fmtDate(iso: unknown): string {
  if (!iso || typeof iso !== "string") return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function fmtDateTime(iso: unknown): string {
  if (!iso || typeof iso !== "string") return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function relativeMinutes(d: Date | null): string {
  if (!d) return "never";
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Drilldown column registry ────────────────────────────────────────────
// Each metric pulls different columns out of the row shape — see
// backend agency_dashboard_router.py drilldown(). Keeping the map
// declarative keeps the sheet renderer a simple loop.

interface DrillColumn {
  key: string;
  label: string;
  fmt?: (v: unknown) => string;
}

const DRILLDOWN_COLUMNS: Record<DrilldownMetric, DrillColumn[]> = {
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
    { key: "premium", label: "Premium", fmt: (v) => fmtMoney(v as number | null) },
  ],
  policies: [
    { key: "client_name", label: "Client" },
    { key: "agent_name", label: "Agent" },
    { key: "carrier", label: "Carrier" },
    { key: "product", label: "Product" },
    { key: "premium", label: "Premium", fmt: (v) => fmtMoney(v as number | null) },
    { key: "written_date", label: "Written", fmt: fmtDate },
  ],
  revenue: [
    { key: "agent_name", label: "Agent" },
    { key: "policy_count", label: "Policies", fmt: (v) => fmtNumber(v as number | null) },
    { key: "revenue", label: "Revenue", fmt: (v) => fmtMoney(v as number | null) },
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

const METRIC_TITLES: Record<DrilldownMetric, string> = {
  leads: "All Leads",
  enrolled: "Enrolled Clients",
  policies: "Policies Written",
  revenue: "Revenue by Agent",
  birthday_windows: "Open Birthday Windows",
  renewals: "Upcoming Renewals",
  stale_leads: "Stale Leads",
};

interface DrillState {
  metric: DrilldownMetric;
  title: string;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function AgencyCommandCenterPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const role = useAuthStore((s) => s.user?.role ?? null);
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const isAllowed =
    role !== null && COMMAND_CENTER_ROLES.includes(role);
  const canSeeRevenue =
    role !== null && REVENUE_VISIBLE_ROLES.includes(role);

  // Server-authoritative-style redirect: as soon as we know who the
  // user is, bounce off-role users to /dashboard. Keeps the skeleton
  // up until status resolves so we don't flash content for a frame.
  React.useEffect(() => {
    if (status === "authed" && !isAllowed) {
      router.replace("/dashboard");
    }
    if (status === "anon") {
      router.replace("/login");
    }
  }, [status, isAllowed, router]);

  // Period state — hydrate from localStorage on mount, persist on
  // change. Defaults to MTD when no prior preference.
  const [period, setPeriod] = React.useState<Period>("mtd");
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PERIOD_PREF_KEY);
      if (isPeriod(saved)) setPeriod(saved);
    } catch {
      /* localStorage disabled */
    }
  }, []);
  React.useEffect(() => {
    try {
      window.localStorage.setItem(PERIOD_PREF_KEY, period);
    } catch {
      /* localStorage disabled */
    }
  }, [period]);

  // Drill state — which metric the right-side sheet is showing.
  const [drill, setDrill] = React.useState<DrillState | null>(null);

  // "Last updated" pill needs a tick to stay honest without re-firing
  // queries. 30s feels like the right cadence for "minutes ago".
  const [, setNowTick] = React.useState(0);
  React.useEffect(() => {
    const i = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(i);
  }, []);

  // Data queries — keyed on period so a tab flip refetches all four.
  // Alerts intentionally not keyed on period (the underlying scan
  // looks at absolute dates, not the period window).
  const kpisQuery = useQuery<AgencyKpisResponse>({
    queryKey: ["agency-dashboard", "kpis", period],
    queryFn: () => dashboardApi.getAgencyKpis(period),
    enabled: isAllowed,
  });
  const perfQuery = useQuery({
    queryKey: ["agency-dashboard", "agent-performance", period],
    queryFn: () => dashboardApi.getAgentPerformance(period),
    enabled: isAllowed,
  });
  const chartsQuery = useQuery<AgencyChartsResponse>({
    queryKey: ["agency-dashboard", "charts", period],
    queryFn: () => dashboardApi.getAgencyCharts(period),
    enabled: isAllowed,
  });
  const alertsQuery = useQuery<AgencyAlertsResponse>({
    queryKey: ["agency-dashboard", "alerts"],
    queryFn: () => dashboardApi.getAgencyAlerts(),
    enabled: isAllowed,
  });

  const lastFetched = React.useMemo(() => {
    const t = [
      kpisQuery.dataUpdatedAt,
      perfQuery.dataUpdatedAt,
      chartsQuery.dataUpdatedAt,
      alertsQuery.dataUpdatedAt,
    ]
      .filter((x) => x > 0)
      .sort((a, b) => b - a)[0];
    return t ? new Date(t) : null;
  }, [
    kpisQuery.dataUpdatedAt,
    perfQuery.dataUpdatedAt,
    chartsQuery.dataUpdatedAt,
    alertsQuery.dataUpdatedAt,
  ]);

  const isLoading =
    kpisQuery.isLoading ||
    perfQuery.isLoading ||
    chartsQuery.isLoading ||
    alertsQuery.isLoading;

  function refetchAll() {
    kpisQuery.refetch();
    perfQuery.refetch();
    chartsQuery.refetch();
    alertsQuery.refetch();
  }

  // Pre-page-gate skeleton while auth resolves or we're redirecting.
  if (status !== "authed" || !isAllowed) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        <Skeleton className="h-12 w-72" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 p-4 md:p-6" data-testid="agency-command-center">
      <Header
        period={period}
        onPeriodChange={setPeriod}
        lastFetched={lastFetched}
        loading={isLoading}
        onRefresh={refetchAll}
      />

      <KpiGrid
        kpis={kpisQuery.data}
        loading={kpisQuery.isLoading}
        canSeeRevenue={canSeeRevenue}
        onOpenDrill={(metric, title) => setDrill({ metric, title })}
      />

      <ChartsSection
        charts={chartsQuery.data}
        loading={chartsQuery.isLoading}
      />

      <AgentTable
        rows={perfQuery.data?.agents ?? []}
        loading={perfQuery.isLoading}
        period={period}
        meId={meId}
        canSeeRevenue={canSeeRevenue}
      />

      <AlertsPanel
        alerts={alertsQuery.data}
        loading={alertsQuery.isLoading}
        onOpenAll={(metric, title) => setDrill({ metric, title })}
      />

      <DrillDownSheet
        drill={drill}
        period={period}
        agents={perfQuery.data?.agents ?? []}
        onClose={() => setDrill(null)}
      />
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────

function Header({
  period,
  onPeriodChange,
  lastFetched,
  loading,
  onRefresh,
}: {
  period: Period;
  onPeriodChange: (next: Period) => void;
  lastFetched: Date | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 text-eyebrow text-muted-foreground mb-1">
          <BarChart2 className="h-3.5 w-3.5" />
          Agency Overview
        </div>
        <h1 className="text-3xl font-bold tracking-tight font-display">
          Agency Command Center
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gruening Health &amp; Wealth
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PeriodTabs value={period} onChange={onPeriodChange} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Last updated {relativeMinutes(lastFetched)}</span>
          <button
            type="button"
            onClick={onRefresh}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="Refresh"
            data-testid="cc-refresh"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>
    </div>
  );
}

function PeriodTabs({
  value,
  onChange,
}: {
  value: Period;
  onChange: (next: Period) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Period filter"
      className="inline-flex items-center gap-1 p-1 rounded-full bg-secondary"
    >
      {PERIOD_TABS.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.value)}
            className={cn(
              "px-3.5 h-8 text-xs font-medium rounded-full transition-colors tabular-nums",
              selected
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`cc-period-${t.value}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── KPI grid (8 cards) ───────────────────────────────────────────────────

function KpiGrid({
  kpis,
  loading,
  canSeeRevenue,
  onOpenDrill,
}: {
  kpis: AgencyKpisResponse | undefined;
  loading: boolean;
  canSeeRevenue: boolean;
  onOpenDrill: (metric: DrilldownMetric, title: string) => void;
}) {
  const leads = kpis?.leads;
  const enrolled = kpis?.enrolled;
  const revenue = kpis?.revenue;
  const policies = kpis?.policies;
  const agents = kpis?.agents;
  const carriers = kpis?.carriers;
  const bday = kpis?.birthday_windows;
  const renewals = kpis?.renewals;

  return (
    <div
      className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4"
      data-testid="cc-kpi-grid"
    >
      <KpiCard
        Icon={Briefcase}
        title="Total Leads"
        value={fmtNumber(leads?.total)}
        trendPct={leads?.trend_pct}
        subline={
          leads?.new_this_period != null
            ? `${fmtNumber(leads.new_this_period)} new`
            : null
        }
        loading={loading}
        onClick={() => onOpenDrill("leads", "All Leads")}
      />
      <KpiCard
        Icon={UserCheck}
        title="Enrolled MTD"
        value={fmtNumber(enrolled?.total)}
        trendPct={enrolled?.trend_pct}
        subline={
          enrolled?.new_this_period != null
            ? `${fmtNumber(enrolled.new_this_period)} new`
            : null
        }
        loading={loading}
        onClick={() => onOpenDrill("enrolled", "Enrolled Clients")}
      />
      <KpiCard
        Icon={DollarSign}
        title="Est. Revenue MTD"
        value={canSeeRevenue ? fmtMoney(revenue?.total_estimated) : "—"}
        trendPct={canSeeRevenue ? revenue?.trend_pct : undefined}
        subline={
          canSeeRevenue && revenue?.this_period != null
            ? `${fmtMoney(revenue.this_period)} this period`
            : canSeeRevenue
              ? null
              : "Restricted"
        }
        loading={loading}
        onClick={
          canSeeRevenue
            ? () => onOpenDrill("revenue", "Revenue by Agent")
            : undefined
        }
      />
      <KpiCard
        Icon={FileText}
        title="Policies Written"
        value={fmtNumber(policies?.total_written)}
        subline={
          policies?.this_period != null
            ? `${fmtNumber(policies.this_period)} this period`
            : null
        }
        loading={loading}
        onClick={() => onOpenDrill("policies", "Policies Written")}
      />
      <KpiCard
        Icon={Users}
        title="Active Agents"
        value={fmtNumber(agents?.total)}
        subline={
          agents?.active_this_period != null
            ? `${fmtNumber(agents.active_this_period)} active`
            : null
        }
        loading={loading}
      />
      <KpiCard
        Icon={Building2}
        title="Active Carriers"
        value={fmtNumber(carriers?.active_count)}
        loading={loading}
      />
      <KpiCard
        Icon={Cake}
        title="Birthday Windows"
        value={fmtNumber(bday?.open_now)}
        alert={(bday?.open_now ?? 0) > 0}
        alertColor="bg-destructive/15 text-destructive ring-destructive/30"
        loading={loading}
        onClick={() => onOpenDrill("birthday_windows", "Open Birthday Windows")}
      />
      <KpiCard
        Icon={CalendarClock}
        title="Renewals · 30d"
        value={fmtNumber(renewals?.due_30_days)}
        alert={(renewals?.due_30_days ?? 0) > 0}
        alertColor="bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30"
        loading={loading}
        onClick={() => onOpenDrill("renewals", "Upcoming Renewals")}
      />
    </div>
  );
}

function KpiCard({
  Icon,
  title,
  value,
  trendPct,
  subline,
  alert,
  alertColor,
  loading,
  onClick,
}: {
  Icon: LucideIcon;
  title: string;
  value: string;
  trendPct?: number | null;
  subline?: string | null;
  alert?: boolean;
  alertColor?: string;
  loading?: boolean;
  onClick?: () => void;
}) {
  const clickable = !!onClick;
  const trendPositive = trendPct != null && trendPct >= 0;
  const TrendIcon =
    trendPct == null ? null : trendPositive ? ArrowUpRight : ArrowDownRight;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      className={cn(
        "text-left rounded-lg border border-border bg-card p-4 transition-all",
        clickable
          ? "hover:border-foreground/20 hover:shadow-sm cursor-pointer"
          : "cursor-default",
      )}
      data-testid={`cc-card-${slug(title)}`}
    >
      <div className="flex items-start justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <p
          className="text-2xl font-bold tracking-tight tabular-nums font-display"
          data-testid={`cc-card-${slug(title)}-value`}
        >
          {value}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground min-h-[16px]">
        {TrendIcon ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 font-medium",
              trendPositive ? "text-ghw-forest" : "text-destructive",
            )}
          >
            <TrendIcon className="h-3 w-3" />
            {Math.abs(trendPct ?? 0).toFixed(1)}%
          </span>
        ) : null}
        {subline ? <span className="truncate">{subline}</span> : null}
        {alert ? (
          <span
            className={cn(
              "ml-auto inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1",
              alertColor ?? "bg-destructive/15 text-destructive ring-destructive/30",
            )}
          >
            Action
          </span>
        ) : null}
      </div>
    </button>
  );
}

// ─── Charts section (3 charts) ────────────────────────────────────────────

function ChartsSection({
  charts,
  loading,
}: {
  charts: AgencyChartsResponse | undefined;
  loading: boolean;
}) {
  const enrollments = charts?.enrollments_by_week ?? [];
  const carriers = (charts?.revenue_by_carrier ?? []).slice(0, 8);
  const sources = charts?.leads_by_source ?? [];

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-3">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Enrollments by Week</h3>
              <span className="text-xs text-muted-foreground">Last 12 weeks</span>
            </div>
            <div className="h-56 md:h-64">
              {loading && enrollments.length === 0 ? (
                <Skeleton className="h-full w-full" />
              ) : enrollments.length === 0 ? (
                <EmptyChart message="No enrollments in the window." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={enrollments}
                    margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
                  >
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      stroke="hsl(var(--border))"
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      stroke="hsl(var(--border))"
                      allowDecimals={false}
                      width={28}
                    />
                    <ReTooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 11,
                        borderRadius: 6,
                      }}
                    />
                    <Bar
                      dataKey="count"
                      name="Enrollments"
                      fill="hsl(var(--primary))"
                      radius={[4, 4, 0, 0]}
                    />
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
            <div className="h-56 md:h-64">
              {loading && carriers.length === 0 ? (
                <Skeleton className="h-full w-full" />
              ) : carriers.length === 0 ? (
                <EmptyChart message="No revenue data for this period." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={carriers}
                    layout="vertical"
                    margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
                  >
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      stroke="hsl(var(--border))"
                    />
                    <YAxis
                      dataKey="carrier"
                      type="category"
                      width={110}
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      stroke="hsl(var(--border))"
                    />
                    <ReTooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 11,
                        borderRadius: 6,
                      }}
                      formatter={(v) =>
                        typeof v === "number" ? USD.format(v) : String(v)
                      }
                    />
                    <Bar
                      dataKey="revenue"
                      name="Revenue"
                      fill="hsl(var(--primary))"
                      radius={[0, 4, 4, 0]}
                    />
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
            <span className="text-xs text-muted-foreground">Total vs Enrolled</span>
          </div>
          <div className="h-56 md:h-64">
            {loading && sources.length === 0 ? (
              <Skeleton className="h-full w-full" />
            ) : sources.length === 0 ? (
              <EmptyChart message="No lead-source data for this period." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={sources}
                  margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
                >
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="source"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    allowDecimals={false}
                    width={28}
                  />
                  <ReTooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      fontSize: 11,
                      borderRadius: 6,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar
                    dataKey="total"
                    name="Total"
                    fill="hsl(var(--chart-2))"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="enrolled"
                    name="Enrolled"
                    fill="hsl(var(--primary))"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}

// ─── Agent performance table ──────────────────────────────────────────────

type SortKey =
  | "agent_name"
  | "leads_count"
  | "enrolled_count"
  | "conversion_rate"
  | "estimated_revenue"
  | "trend_pct"
  | "team_size";
type SortDir = "asc" | "desc";

function AgentTable({
  rows,
  loading,
  period,
  meId,
  canSeeRevenue,
}: {
  rows: AgentPerfRow[];
  loading: boolean;
  period: Period;
  meId: string | null;
  canSeeRevenue: boolean;
}) {
  const router = useRouter();
  const [sortKey, setSortKey] = React.useState<SortKey>("enrolled_count");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");

  // "Avg Premium" is estimated_revenue ÷ enrolled count. Not a backend
  // column today, derived on the row here. NaN-safe.
  function avgPremium(r: AgentPerfRow): number | null {
    const enrolled = r.enrolled_count;
    const rev = r.estimated_revenue;
    if (!enrolled || enrolled === 0 || rev == null) return null;
    return rev / enrolled;
  }

  const sorted = React.useMemo(() => {
    const copy = [...rows];
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
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (key !== sortKey) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  function viewAgentClients(row: AgentPerfRow) {
    // Spec: "Click row → navigate to /clients?agent_id={id}". This is
    // a filter-by-agent affordance, distinct from impersonation
    // (X-Agent-ID interceptor). The Next.js AgentContext port is a
    // tracked follow-up; once it lands, this becomes setSelectedAgent
    // + push("/today") to mirror CRA.
    router.push(`/clients?agent_id=${encodeURIComponent(row.agent_id)}`);
  }

  const periodLabel =
    PERIOD_TABS.find((p) => p.value === period)?.label ?? period;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold">Agent Performance</h3>
            <p className="text-xs text-muted-foreground">{periodLabel}</p>
          </div>
          <p className="text-xs text-muted-foreground italic hidden sm:block">
            Click a row to view that agent&apos;s clients
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead
                  onClick={() => toggleSort("agent_name")}
                  className="cursor-pointer select-none"
                >
                  Agent{sortIndicator("agent_name")}
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead
                  onClick={() => toggleSort("enrolled_count")}
                  className="cursor-pointer select-none text-right"
                >
                  Enrolled{sortIndicator("enrolled_count")}
                </TableHead>
                <TableHead
                  onClick={() => toggleSort("estimated_revenue")}
                  className="cursor-pointer select-none text-right"
                >
                  Revenue{sortIndicator("estimated_revenue")}
                </TableHead>
                <TableHead
                  onClick={() => toggleSort("leads_count")}
                  className="cursor-pointer select-none text-right"
                >
                  Policies{sortIndicator("leads_count")}
                </TableHead>
                <TableHead className="text-right">Avg Premium</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground py-8"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground py-8"
                  >
                    No agents to show.
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((a) => {
                  const isMe = meId !== null && a.agent_id === meId;
                  const avg = avgPremium(a);
                  return (
                    <TableRow
                      key={a.agent_id}
                      onClick={() => viewAgentClients(a)}
                      className="cursor-pointer hover:bg-secondary/60"
                      data-testid={`cc-agent-row-${a.agent_id}`}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <StatusDot status={a.status} />
                          <div>
                            <div className="font-medium text-sm flex items-center gap-1.5">
                              {a.agent_name ?? "—"}
                              {isMe ? (
                                <Badge
                                  variant="outline"
                                  className="rounded-full text-[10px] border-primary/40 bg-primary/10 text-primary px-1.5 py-0"
                                  data-testid="cc-you-badge"
                                >
                                  You
                                </Badge>
                              ) : null}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {a.email ?? ""}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNumber(a.enrolled_count)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {canSeeRevenue ? fmtMoney(a.estimated_revenue) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNumber(a.leads_count)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {canSeeRevenue ? fmtMoney(avg) : "—"}
                      </TableCell>
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => viewAgentClients(a)}
                          className="h-7 text-xs"
                          data-testid={`cc-view-${a.agent_id}`}
                        >
                          <Eye className="h-3 w-3 mr-1" /> View
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

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-ghw-forest"
      : status === "stale"
        ? "bg-ghw-copper"
        : "bg-muted-foreground";
  return <span className={cn("inline-block w-1.5 h-1.5 rounded-full", cls)} />;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: {
      label: "Active",
      cls: "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30",
    },
    stale: {
      label: "Stale",
      cls: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
    },
  };
  const entry = map[status] ?? {
    label: "Inactive",
    cls: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full border text-[11px]", entry.cls)}
    >
      {entry.label}
    </Badge>
  );
}

// ─── Alerts panel (3 cards) ───────────────────────────────────────────────

function AlertsPanel({
  alerts,
  loading,
  onOpenAll,
}: {
  alerts: AgencyAlertsResponse | undefined;
  loading: boolean;
  onOpenAll: (metric: DrilldownMetric, title: string) => void;
}) {
  const stale = alerts?.stale_leads ?? [];
  const bday = alerts?.birthday_windows ?? [];
  const renew = alerts?.renewals_due ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <AlertsCard
        title="Stale Leads"
        Icon={AlertTriangle}
        emptyMessage="No follow-up backlog. Nice."
        loading={loading}
        footerLabel={
          stale.length > 0
            ? `${stale.length} agent${stale.length === 1 ? "" : "s"} need follow-up`
            : null
        }
        onViewAll={() => onOpenAll("stale_leads", "Stale Leads")}
      >
        {stale.slice(0, 5).map((row) => (
          <div
            key={row.agent_id}
            className="flex items-center justify-between text-sm py-1.5"
          >
            <span className="truncate">{row.agent_name}</span>
            <Badge
              variant="outline"
              className="rounded-full border-destructive/30 bg-destructive/10 text-destructive"
            >
              {row.count}
            </Badge>
          </div>
        ))}
      </AlertsCard>

      <AlertsCard
        title="Birthday Windows"
        Icon={Cake}
        emptyMessage="No open windows today."
        loading={loading}
        onViewAll={() => onOpenAll("birthday_windows", "Open Birthday Windows")}
      >
        {bday.slice(0, 5).map((row) => (
          <div key={row.lead_id} className="text-sm py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{row.client_name}</span>
              <Badge
                variant="outline"
                className="rounded-full border-destructive/30 bg-destructive/10 text-destructive flex-shrink-0"
              >
                {row.days_remaining}d
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {row.agent_name}
              {row.carrier ? ` · ${row.carrier}` : ""}
            </div>
          </div>
        ))}
      </AlertsCard>

      <AlertsCard
        title="Renewals Due"
        Icon={RefreshCw}
        emptyMessage="No renewals in the next 7 days."
        loading={loading}
        onViewAll={() => onOpenAll("renewals", "Upcoming Renewals")}
      >
        {renew.slice(0, 5).map((row, i) => (
          <div
            key={`${row.lead_id ?? "noid"}-${i}`}
            className="text-sm py-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{row.client_name}</span>
              <Badge
                variant="outline"
                className="rounded-full border-primary/30 bg-primary/10 text-primary flex-shrink-0"
              >
                {row.days_until}d
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {row.agent_name}
              {row.carrier ? ` · ${row.carrier}` : ""}
            </div>
          </div>
        ))}
      </AlertsCard>
    </div>
  );
}

function AlertsCard({
  title,
  Icon,
  emptyMessage,
  footerLabel,
  loading,
  children,
  onViewAll,
}: {
  title: string;
  Icon: LucideIcon;
  emptyMessage: string;
  footerLabel?: string | null;
  loading?: boolean;
  children: React.ReactNode;
  onViewAll: () => void;
}) {
  const childArray = React.Children.toArray(children);
  const isEmpty = childArray.length === 0;
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            {title}
          </h3>
        </div>
        {loading && isEmpty ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ) : isEmpty ? (
          <p className="text-sm text-muted-foreground py-2">{emptyMessage}</p>
        ) : (
          <div className="divide-y divide-border/60">{children}</div>
        )}
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center mt-3 text-xs font-medium text-primary hover:underline"
        >
          View All <ArrowUpRight className="h-3 w-3 ml-0.5" />
        </button>
        {footerLabel ? (
          <p className="text-[11px] text-muted-foreground mt-2">{footerLabel}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Drilldown sheet ──────────────────────────────────────────────────────

function DrillDownSheet({
  drill,
  period,
  agents,
  onClose,
}: {
  drill: DrillState | null;
  period: Period;
  agents: AgentPerfRow[];
  onClose: () => void;
}) {
  const open = drill !== null;
  const [page, setPage] = React.useState(1);
  const [agentFilter, setAgentFilter] = React.useState<string>("all");

  // Reset paging + agent filter when the user opens a different
  // metric. Keeps the sheet consistent across opens.
  const lastMetricRef = React.useRef<DrilldownMetric | null>(null);
  React.useEffect(() => {
    if (!drill) return;
    if (lastMetricRef.current !== drill.metric) {
      lastMetricRef.current = drill.metric;
      setPage(1);
      setAgentFilter("all");
    }
  }, [drill]);

  const drillQuery = useQuery<DrilldownResponse>({
    queryKey: [
      "agency-dashboard",
      "drilldown",
      drill?.metric ?? "",
      period,
      page,
      agentFilter,
    ],
    queryFn: () =>
      dashboardApi.getAgencyDrilldown(drill!.metric, {
        period,
        page,
        agent_id: agentFilter === "all" ? null : agentFilter,
      }),
    enabled: open && drill !== null,
  });

  React.useEffect(() => {
    if (drillQuery.error) {
      toast.error("Could not load drill-down records.");
    }
  }, [drillQuery.error]);

  const columns: DrillColumn[] = drill ? DRILLDOWN_COLUMNS[drill.metric] : [];
  const rows: DrilldownRow[] = drillQuery.data?.rows ?? [];
  const title = drill?.title ?? (drill ? METRIC_TITLES[drill.metric] : "");

  function exportCsv() {
    if (!drill || rows.length === 0) {
      toast.message("Nothing to export yet.");
      return;
    }
    const header = columns.map((c) => c.label).join(",");
    const lines = rows.map((r) =>
      columns
        .map((c) => {
          const raw = r[c.key];
          const display = c.fmt ? c.fmt(raw) : raw == null ? "" : String(raw);
          const s = String(display).replace(/"/g, '""');
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
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        className="!max-w-[640px] w-full sm:w-[640px] p-0 flex flex-col"
      >
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border space-y-3">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-lg font-semibold">{title}</SheetTitle>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
              aria-label="Close drilldown"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Period:</span>
            <Badge variant="secondary" className="rounded-full text-[11px]">
              {PERIOD_TABS.find((p) => p.value === period)?.label ?? period}
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
                    {a.agent_name ?? a.email ?? a.agent_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-8 text-xs"
              onClick={exportCsv}
              disabled={rows.length === 0}
              data-testid="cc-drilldown-export"
            >
              <Download className="h-3 w-3 mr-1" /> Export CSV
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto px-5 pb-5">
          {drillQuery.isLoading && rows.length === 0 ? (
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
                      const display = c.fmt
                        ? c.fmt(raw)
                        : raw == null || raw === ""
                          ? "—"
                          : String(raw);
                      return (
                        <TableCell key={c.key} className="text-xs">
                          {display}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {drillQuery.data && drillQuery.data.total > 0 ? (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {drillQuery.data.page} of {drillQuery.data.total_pages} ·{" "}
              {drillQuery.data.total} total
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || drillQuery.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  page >= drillQuery.data.total_pages || drillQuery.isFetching
                }
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
