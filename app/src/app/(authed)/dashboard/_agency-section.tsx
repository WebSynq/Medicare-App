"use client";

/**
 * Agency Overview section — leadership-only second half of the
 * combined dashboard. Ports the four-panel layout from CRA
 * AgencyCommandCenter.jsx: KPI grid, two charts, agent performance
 * table, alert cards.
 *
 * Rendered conditionally by dashboard/page.tsx when the current
 * user's role is in COMMAND_CENTER_ROLES. The page owns the period
 * state so the header's period selector can drive every query in
 * this section.
 */

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Briefcase,
  Building2,
  Cake,
  CalendarClock,
  DollarSign,
  Eye,
  FileText,
  RefreshCw,
  UserCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  AgencyKpisResponse,
  AgentPerfRow,
  AgencyChartsResponse,
  AgencyAlertsResponse,
} from "@/lib/api/dashboard";

import type { Period } from "./_period";

// ─── Number formatters ───────────────────────────────────────────────────

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

// ─── Section root ────────────────────────────────────────────────────────

export function AgencySection({ period }: { period: Period }) {
  const kpisQuery = useQuery<AgencyKpisResponse>({
    queryKey: ["agency-dashboard", "kpis", period],
    queryFn: () => dashboardApi.getAgencyKpis(period),
  });

  const perfQuery = useQuery({
    queryKey: ["agency-dashboard", "agent-performance", period],
    queryFn: () => dashboardApi.getAgentPerformance(period),
  });

  const chartsQuery = useQuery<AgencyChartsResponse>({
    queryKey: ["agency-dashboard", "charts", period],
    queryFn: () => dashboardApi.getAgencyCharts(period),
  });

  const alertsQuery = useQuery<AgencyAlertsResponse>({
    queryKey: ["agency-dashboard", "alerts"],
    queryFn: () => dashboardApi.getAgencyAlerts(),
  });

  return (
    <section className="mt-10 md:mt-12 space-y-6" data-testid="dashboard-agency-section">
      <AgencyDivider />
      <KpiGrid kpis={kpisQuery.data} loading={kpisQuery.isLoading} />
      <ChartsRow
        charts={chartsQuery.data}
        loading={chartsQuery.isLoading}
      />
      <AgentTable
        rows={perfQuery.data?.agents ?? []}
        loading={perfQuery.isLoading}
        period={period}
      />
      <AlertsRow
        alerts={alertsQuery.data}
        loading={alertsQuery.isLoading}
      />
    </section>
  );
}

// ─── Divider ─────────────────────────────────────────────────────────────

function AgencyDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <div className="h-px flex-1 bg-border" />
      <span className="text-eyebrow text-muted-foreground">Agency Overview</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// ─── KPI grid (8 cards) ──────────────────────────────────────────────────

function KpiGrid({
  kpis,
  loading,
}: {
  kpis: AgencyKpisResponse | undefined;
  loading: boolean;
}) {
  const agents = kpis?.agents;
  const leads = kpis?.leads;
  const enrolled = kpis?.enrolled;
  const revenue = kpis?.revenue;
  const policies = kpis?.policies;
  const carriers = kpis?.carriers;
  const bday = kpis?.birthday_windows;
  const renewals = kpis?.renewals;

  return (
    <div
      className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4"
      data-testid="agency-kpi-grid"
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
      />
      <KpiCard
        Icon={UserCheck}
        title="Enrolled"
        value={fmtNumber(enrolled?.total)}
        trendPct={enrolled?.trend_pct}
        subline={
          enrolled?.new_this_period != null
            ? `${fmtNumber(enrolled.new_this_period)} new`
            : null
        }
        loading={loading}
      />
      <KpiCard
        Icon={DollarSign}
        title="Est. Revenue"
        value={fmtMoney(revenue?.total_estimated)}
        trendPct={revenue?.trend_pct}
        subline={
          revenue?.this_period != null
            ? `${fmtMoney(revenue.this_period)} this period`
            : null
        }
        loading={loading}
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
      />
      <KpiCard
        Icon={CalendarClock}
        title="Renewals · 30d"
        value={fmtNumber(renewals?.due_30_days)}
        alert={(renewals?.due_30_days ?? 0) > 0}
        alertColor="bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30"
        loading={loading}
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
}: {
  Icon: LucideIcon;
  title: string;
  value: string;
  trendPct?: number | null;
  subline?: string | null;
  alert?: boolean;
  alertColor?: string;
  loading?: boolean;
}) {
  const trendPositive = trendPct != null && trendPct >= 0;
  const TrendIcon =
    trendPct == null ? null : trendPositive ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className="border-border/70" data-testid={`agency-kpi-${slug(title)}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">
            {title}
          </span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <p
            className="text-2xl font-bold tracking-tight tabular-nums font-display"
            data-testid={`agency-kpi-${slug(title)}-value`}
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
      </CardContent>
    </Card>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Charts row ──────────────────────────────────────────────────────────

function ChartsRow({
  charts,
  loading,
}: {
  charts: AgencyChartsResponse | undefined;
  loading: boolean;
}) {
  const enrollments = charts?.enrollments_by_week ?? [];
  const carriers = charts?.revenue_by_carrier ?? [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="lg:col-span-3">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Enrollments by Week</h3>
            <span className="text-xs text-muted-foreground">Last 12 weeks</span>
          </div>
          <div className="h-56 md:h-64">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : enrollments.length === 0 ? (
              <EmptyChart message="No enrollments in the window." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={enrollments}
                  margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
                >
                  <CartesianGrid
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                  />
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
            {loading ? (
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
                  <CartesianGrid
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                  />
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
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}

// ─── Agent performance table ─────────────────────────────────────────────

type SortKey =
  | "agent_name"
  | "leads_count"
  | "enrolled_count"
  | "conversion_rate"
  | "estimated_revenue"
  | "trend_pct";
type SortDir = "asc" | "desc";

function AgentTable({
  rows,
  loading,
  period,
}: {
  rows: AgentPerfRow[];
  loading: boolean;
  period: Period;
}) {
  const [sortKey, setSortKey] = React.useState<SortKey>("enrolled_count");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");

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

  // CRA's row click calls viewAsAgent(row) which writes to AgentContext
  // and navigates the impersonator to /today inside that agent's
  // workspace. The Next.js AgentContext + X-Agent-ID interceptor port
  // is a tracked follow-up — for now the action is a toast that
  // signals the affordance without lying about capability.
  function onViewAgent(row: AgentPerfRow) {
    toast.info(
      `Switch Agent is on the way — for now click into ${row.agent_name ?? "the agent"}'s clients from /agents.`,
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold">Agent Performance</h3>
            <p className="text-xs text-muted-foreground capitalize">
              {period.replace(/(\d+)/, " $1")}
            </p>
          </div>
          <p className="text-xs text-muted-foreground italic hidden sm:block">
            Click a row to view that agent&apos;s workspace
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
                  onClick={() => toggleSort("leads_count")}
                  className="cursor-pointer select-none text-right"
                >
                  Leads{sortIndicator("leads_count")}
                </TableHead>
                <TableHead
                  onClick={() => toggleSort("enrolled_count")}
                  className="cursor-pointer select-none text-right"
                >
                  Enrolled{sortIndicator("enrolled_count")}
                </TableHead>
                <TableHead
                  onClick={() => toggleSort("conversion_rate")}
                  className="cursor-pointer select-none text-right"
                >
                  Conv %{sortIndicator("conversion_rate")}
                </TableHead>
                <TableHead
                  onClick={() => toggleSort("estimated_revenue")}
                  className="cursor-pointer select-none text-right"
                >
                  Revenue{sortIndicator("estimated_revenue")}
                </TableHead>
                <TableHead
                  onClick={() => toggleSort("trend_pct")}
                  className="cursor-pointer select-none text-right"
                >
                  Trend{sortIndicator("trend_pct")}
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center text-muted-foreground py-8"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center text-muted-foreground py-8"
                  >
                    No agents to show.
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((a) => {
                  const positive = (a.trend_pct ?? 0) >= 0;
                  return (
                    <TableRow
                      key={a.agent_id}
                      onClick={() => onViewAgent(a)}
                      className="cursor-pointer hover:bg-secondary/60"
                      data-testid={`agency-agent-row-${a.agent_id}`}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <StatusDot status={a.status} />
                          <div>
                            <div className="font-medium text-sm">
                              {a.agent_name ?? "—"}
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
                        {fmtNumber(a.leads_count)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNumber(a.enrolled_count)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(a.conversion_rate ?? 0).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoney(a.estimated_revenue)}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "inline-flex items-center gap-0.5 text-xs font-medium",
                            positive ? "text-ghw-forest" : "text-destructive",
                          )}
                        >
                          {positive ? (
                            <ArrowUpRight className="h-3 w-3" />
                          ) : (
                            <ArrowDownRight className="h-3 w-3" />
                          )}
                          {Math.abs(a.trend_pct ?? 0).toFixed(1)}%
                        </span>
                      </TableCell>
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onViewAgent(a)}
                          className="h-7 text-xs"
                          data-testid={`agency-view-${a.agent_id}`}
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

// ─── Alerts row (3 cards) ────────────────────────────────────────────────

function AlertsRow({
  alerts,
  loading,
}: {
  alerts: AgencyAlertsResponse | undefined;
  loading: boolean;
}) {
  const stale = alerts?.stale_leads ?? [];
  const bday = alerts?.birthday_windows ?? [];
  const renew = alerts?.renewals_due ?? [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <AlertCard
        title="Stale Leads"
        Icon={AlertTriangle}
        emptyMessage="No follow-up backlog. Nice."
        footer={
          stale.length > 0
            ? `${stale.length} agent${stale.length === 1 ? "" : "s"} need follow-up`
            : null
        }
        loading={loading}
        viewAllHref="/clients?status=stale"
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
      </AlertCard>

      <AlertCard
        title="Birthday Windows Open"
        Icon={Cake}
        emptyMessage="No open windows today."
        loading={loading}
        viewAllHref="/clients?birthday=open"
      >
        {bday.slice(0, 5).map((row) => (
          <Link
            key={row.lead_id}
            href={`/clients/${row.lead_id}`}
            className="block text-sm py-1.5 rounded -mx-1 px-1 hover:bg-secondary/40"
          >
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
          </Link>
        ))}
      </AlertCard>

      <AlertCard
        title="Renewals Due This Week"
        Icon={RefreshCw}
        emptyMessage="No renewals in the next 7 days."
        loading={loading}
        viewAllHref="/clients?renewals=30d"
      >
        {renew.slice(0, 5).map((row, i) => {
          const inner = (
            <>
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
            </>
          );
          return row.lead_id ? (
            <Link
              key={`${row.lead_id}-${i}`}
              href={`/clients/${row.lead_id}`}
              className="block text-sm py-1.5 rounded -mx-1 px-1 hover:bg-secondary/40"
            >
              {inner}
            </Link>
          ) : (
            <div
              key={`noid-${i}`}
              className="block text-sm py-1.5 rounded -mx-1 px-1"
            >
              {inner}
            </div>
          );
        })}
      </AlertCard>
    </div>
  );
}

function AlertCard({
  title,
  Icon,
  emptyMessage,
  footer,
  children,
  viewAllHref,
  loading,
}: {
  title: string;
  Icon: LucideIcon;
  emptyMessage: string;
  footer?: string | null;
  children: React.ReactNode;
  viewAllHref?: string;
  loading?: boolean;
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
        {viewAllHref && !isEmpty ? (
          <Link
            href={viewAllHref}
            className="inline-flex items-center mt-3 text-xs font-medium text-primary hover:underline"
          >
            View All <ArrowUpRight className="h-3 w-3 ml-0.5" />
          </Link>
        ) : null}
        {footer ? (
          <p className="text-[11px] text-muted-foreground mt-2">{footer}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
