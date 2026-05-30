"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  Cake,
  CalendarDays,
  CheckCircle2,
  DollarSign,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { dashboard as dashboardApi } from "@/lib/api";
import { useAuthStore, selectHasAgencyScope } from "@/stores/auth";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const PERIODS = [
  { value: "mtd", label: "Month-to-date" },
  { value: "last30", label: "Last 30 days" },
  { value: "last90", label: "Last 90 days" },
  { value: "ytd", label: "Year-to-date" },
  { value: "all", label: "All time" },
] as const;

type Period = (typeof PERIODS)[number]["value"];

const PIE_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--chart-4))",
  "hsl(140 50% 50%)",
  "hsl(var(--ghw-copper))",
  "hsl(var(--muted-foreground))",
];

export default function AgencyDashboardPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);

  React.useEffect(() => {
    if (status === "authed" && !hasAgencyScope) {
      router.replace("/dashboard");
    }
  }, [status, hasAgencyScope, router]);

  if (status !== "authed" || !hasAgencyScope) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <AgencyDashboard />;
}

function AgencyDashboard() {
  const [period, setPeriod] = React.useState<Period>("mtd");

  const kpisQuery = useQuery({
    queryKey: ["agency-dashboard", "kpis", period],
    queryFn: () => dashboardApi.getAgencyKpis(period),
  });

  const perfQuery = useQuery({
    queryKey: ["agency-dashboard", "agent-performance", period],
    queryFn: () => dashboardApi.getAgentPerformance(period),
  });

  const chartsQuery = useQuery({
    queryKey: ["agency-dashboard", "charts", period],
    queryFn: () => dashboardApi.getAgencyCharts(period),
  });

  const alertsQuery = useQuery({
    queryKey: ["agency-dashboard", "alerts"],
    queryFn: () => dashboardApi.getAgencyAlerts(),
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Building2 className="h-6 w-6 text-primary" />
            Agency dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production roll-up across all agents in your agency.
          </p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <SelectTrigger className="h-9 w-[180px]">
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
      </header>

      {alertsQuery.data?.alerts && alertsQuery.data.alerts.length > 0 ? (
        <AlertsRow alerts={alertsQuery.data.alerts} />
      ) : null}

      <KpiGrid loading={kpisQuery.isLoading} kpis={kpisQuery.data} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Enrollments by week">
          {chartsQuery.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartsQuery.data?.enrollments_by_week ?? []}
                  margin={{ left: 0, right: 8, top: 8 }}
                >
                  <CartesianGrid
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="week"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    allowDecimals={false}
                    width={28}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      fontSize: 11,
                      borderRadius: 6,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>

        <ChartCard title="Revenue by carrier">
          {chartsQuery.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartsQuery.data?.revenue_by_carrier ?? []}
                  margin={{ left: 0, right: 8, top: 8 }}
                >
                  <CartesianGrid
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="carrier"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    angle={-25}
                    textAnchor="end"
                    height={50}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    width={50}
                  />
                  <Tooltip
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
                  <Bar dataKey="revenue" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Leads by source">
        {chartsQuery.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (chartsQuery.data?.leads_by_source ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No lead-source data this period.
          </p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartsQuery.data?.leads_by_source ?? []}
                  dataKey="count"
                  nameKey="source"
                  outerRadius={90}
                  label
                >
                  {(chartsQuery.data?.leads_by_source ?? []).map((_, i) => (
                    <Cell
                      key={i}
                      fill={PIE_COLORS[i % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    fontSize: 11,
                    borderRadius: 6,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>

      <AgentPerformanceTable
        loading={perfQuery.isLoading}
        agents={perfQuery.data?.agents ?? []}
      />
    </div>
  );
}

// ─── Alerts ────────────────────────────────────────────────────────────────

function AlertsRow({
  alerts,
}: {
  alerts: { level: string; title: string; message: string; count?: number }[];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {alerts.slice(0, 3).map((a, i) => (
        <Card
          key={i}
          className={cn(
            "border-2",
            a.level === "critical"
              ? "border-destructive/40 bg-destructive/5"
              : a.level === "warning"
                ? "border-ghw-copper/40 bg-ghw-copper/5"
                : "border-primary/40 bg-primary/5",
          )}
        >
          <CardContent className="p-3 flex items-start gap-2">
            {a.level === "critical" ? (
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
            ) : a.level === "warning" ? (
              <AlertTriangle className="h-4 w-4 text-ghw-copper flex-shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate">
                {a.title}
                {a.count != null ? (
                  <Badge variant="outline" className="ml-1.5 text-[10px]">
                    {a.count}
                  </Badge>
                ) : null}
              </p>
              <p className="text-[11px] text-muted-foreground line-clamp-2">
                {a.message}
              </p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── KPI cards ─────────────────────────────────────────────────────────────

function KpiGrid({
  loading,
  kpis,
}: {
  loading: boolean;
  kpis: ReturnType<typeof useQuery<Awaited<ReturnType<typeof dashboardApi.getAgencyKpis>>>>["data"] | undefined;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (!kpis) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-destructive text-sm">
          Couldn&apos;t load KPIs.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Kpi
        icon={<Users />}
        label="Agents"
        value={kpis.agents.total.toLocaleString()}
        hint={`${kpis.agents.active_this_period} active`}
      />
      <Kpi
        icon={<TrendingUp />}
        label="Leads"
        value={kpis.leads.new_this_period.toLocaleString()}
        hint={`${kpis.leads.total.toLocaleString()} total`}
        trend={kpis.leads.trend_pct}
      />
      <Kpi
        icon={<CheckCircle2 />}
        label="Enrolled"
        value={kpis.enrolled.new_this_period.toLocaleString()}
        hint={`${kpis.enrolled.total.toLocaleString()} total`}
        trend={kpis.enrolled.trend_pct}
      />
      <Kpi
        icon={<DollarSign />}
        label="Revenue"
        value={USD.format(kpis.revenue.this_period)}
        hint={USD.format(kpis.revenue.total_estimated) + " est"}
        trend={kpis.revenue.trend_pct}
        accent
      />
      <Kpi
        icon={<Cake />}
        label="Birthday windows"
        value={kpis.birthday_windows.open_now.toLocaleString()}
        hint="open now"
      />
      <Kpi
        icon={<CalendarDays />}
        label="Renewals 30d"
        value={kpis.renewals.due_30_days.toLocaleString()}
      />
      <Kpi
        icon={<TrendingDown />}
        label="Stale agents"
        value={kpis.stale_agents.count.toLocaleString()}
        hint="no activity 14d"
        warn={kpis.stale_agents.count > 0}
      />
      <Kpi
        icon={<TrendingUp />}
        label="Policies"
        value={kpis.policies.this_period.toLocaleString()}
        hint={`${kpis.policies.total_written.toLocaleString()} total`}
      />
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
  trend,
  accent,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  trend?: number;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <Card className={cn(warn && "border-ghw-copper/30 bg-ghw-copper/5")}>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="h-3.5 w-3.5">{icon}</span>
          <span className="text-[10px] uppercase tracking-widest">{label}</span>
        </div>
        <div
          className={cn(
            "text-xl font-bold tabular-nums",
            accent ? "text-primary" : "",
          )}
        >
          {value}
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {hint ? (
            <span className="text-muted-foreground truncate">{hint}</span>
          ) : null}
          {trend != null && trend !== 0 ? (
            <span
              className={cn(
                "font-semibold tabular-nums",
                trend > 0 ? "text-ghw-forest" : "text-destructive",
              )}
            >
              {trend > 0 ? "↑" : "↓"} {Math.abs(trend).toFixed(0)}%
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Chart card wrapper ────────────────────────────────────────────────────

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 md:p-5 space-y-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {children}
      </CardContent>
    </Card>
  );
}

// ─── Agent performance table ───────────────────────────────────────────────

function AgentPerformanceTable({
  loading,
  agents,
}: {
  loading: boolean;
  agents: Awaited<
    ReturnType<typeof dashboardApi.getAgentPerformance>
  >["agents"];
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 pt-4 pb-2">
          <h3 className="text-sm font-semibold">Agent performance</h3>
        </div>
        {loading ? (
          <div className="px-5 pb-5 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <p className="px-5 pb-5 text-xs text-muted-foreground text-center">
            No agent data this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40">
                <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
                  <th className="text-left px-3 py-2">Agent</th>
                  <th className="text-right px-3 py-2">Leads</th>
                  <th className="text-right px-3 py-2">Enrolled</th>
                  <th className="text-right px-3 py-2 hidden sm:table-cell">
                    Conv %
                  </th>
                  <th className="text-right px-3 py-2 hidden md:table-cell">
                    Trend
                  </th>
                  <th className="text-right px-3 py-2">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr
                    key={a.agent_id}
                    className={cn(
                      "border-b border-border/60 hover:bg-secondary/40",
                      a.status === "stale" && "opacity-60",
                    )}
                  >
                    <td className="px-3 py-3">
                      <p className="font-medium text-sm truncate">
                        {a.agent_name ?? a.email ?? "—"}
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {a.email ?? "—"}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-right text-xs tabular-nums">
                      {a.leads_count.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right text-xs tabular-nums">
                      {a.enrolled_count.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-right hidden sm:table-cell text-xs tabular-nums">
                      {(a.conversion_rate * 100).toFixed(0)}%
                    </td>
                    <td className="px-3 py-3 text-right hidden md:table-cell text-xs tabular-nums">
                      {a.trend_pct === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={cn(
                            "font-semibold",
                            a.trend_pct > 0
                              ? "text-ghw-forest"
                              : "text-destructive",
                          )}
                        >
                          {a.trend_pct > 0 ? "↑" : "↓"}{" "}
                          {Math.abs(a.trend_pct).toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right text-sm font-semibold text-primary tabular-nums">
                      {USD.format(a.estimated_revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
