"use client";

/**
 * Overview tab — the Financial Command Center's headline view.
 *
 * Lays out:
 *   - 6 KPI cards (Expected MTD / Received MTD / Gap MTD /
 *     Collection Rate / Outstanding / Overpaid)
 *   - 12-month revenue chart (Expected vs Received bars)
 *   - 3-card row: Revenue by Carrier (donut), Revenue by Product
 *     (donut), Top Agents by Revenue (progress list)
 *   - Aging report (4 buckets + drill-down table)
 *   - Agent Commission Breakdown table (sortable; serves the
 *     QuickBooks-parity hole the spec flagged)
 *   - Recent Disputes summary (top 5)
 *
 * Ports `frontend/src/pages/AccountingDashboard.jsx` OverviewTab
 * section-for-section with theme-aware colors (CRA hardcoded
 * #e85d2f, etc. — we use the project's CSS variables so the dark
 * navy theme reads consistently).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CircleAlert,
  PercentCircle,
  RefreshCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { cn } from "@/lib/utils";
import { accounting } from "@/lib/api";
import type {
  AccountingPeriod,
  AccountingSummary,
  AgingBucketKey,
  AgingResponse,
  DisputesResponse,
  RevenueByAgentRow,
} from "@/lib/api/accounting";

import {
  fmt,
  fmtNum,
  fmtPct,
  fmtShort,
  PERIOD_OPTIONS,
} from "./_helpers";
import { DisputeStatusBadge } from "./_status-badges";

/** Donut palette — drives Carrier + Product slices. Uses the
 *  project's CSS variables (the chart-* set is wired through
 *  tailwind.config) so dark/light themes stay coherent. */
const DONUT_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--ghw-forest))",
];

interface OverviewTabProps {
  period: AccountingPeriod;
  setPeriod: (p: AccountingPeriod) => void;
  /** Click handler for carrier-donut slices — focuses that
   *  carrier in the Ledger tab. */
  onCarrierClick: (carrier: string) => void;
  onJumpDisputes: () => void;
}

export function OverviewTab({
  period,
  setPeriod,
  onCarrierClick,
  onJumpDisputes,
}: OverviewTabProps) {
  const [activeBucket, setActiveBucket] =
    React.useState<AgingBucketKey | null>(null);

  const summaryQuery = useQuery<AccountingSummary>({
    queryKey: ["accounting", "summary", period],
    queryFn: () => accounting.getSummary(period),
  });

  const agingQuery = useQuery<AgingResponse>({
    queryKey: ["accounting", "aging"],
    queryFn: () => accounting.getAging(),
  });

  const disputesQuery = useQuery<DisputesResponse>({
    queryKey: ["accounting", "disputes"],
    queryFn: () => accounting.getDisputes(),
  });

  const data = summaryQuery.data;
  const loading = summaryQuery.isLoading;
  const recentDisputes = (disputesQuery.data?.items ?? []).slice(0, 5);

  function refreshAll() {
    summaryQuery.refetch();
    agingQuery.refetch();
    disputesQuery.refetch();
  }

  return (
    <div className="space-y-4">
      {/* Period selector + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          value={period}
          onValueChange={(v) => setPeriod(v as AccountingPeriod)}
        >
          <SelectTrigger
            className="w-32 h-9"
            data-testid="accounting-period"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={loading}
          data-testid="accounting-refresh"
        >
          <RefreshCcw
            className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          title="Expected MTD"
          value={fmtShort(data?.expected_mtd)}
          accent="text-primary"
          loading={loading}
        />
        <KpiCard
          title="Received MTD"
          value={fmtShort(data?.received_mtd)}
          accent="text-ghw-forest"
          loading={loading}
        />
        <KpiCard
          title="Gap MTD"
          value={fmtShort(data?.gap_mtd)}
          accent={
            (data?.gap_mtd ?? 0) > 0 ? "text-destructive" : "text-foreground"
          }
          loading={loading}
        />
        <KpiCard
          title="Collection Rate"
          value={fmtPct(data?.collection_rate_pct)}
          accent={collectionAccent(data?.collection_rate_pct)}
          Icon={PercentCircle}
          loading={loading}
        />
        <KpiCard
          title="Outstanding"
          value={fmtShort(data?.outstanding_total)}
          accent="text-ghw-copper"
          loading={loading}
        />
        <KpiCard
          title="Overpaid"
          value={fmtShort(data?.overpaid_total)}
          accent="text-primary"
          subtitle="To be returned"
          loading={loading}
        />
      </div>

      {/* Monthly revenue chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Revenue — last 12 months</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="w-full h-[280px]">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.revenue_by_month ?? []}>
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <ReTooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      fontSize: 11,
                      borderRadius: 6,
                    }}
                    formatter={(v) =>
                      typeof v === "number" ? fmt(v) : String(v)
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar
                    dataKey="expected"
                    name="Expected"
                    fill="hsl(var(--primary))"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="received"
                    name="Received"
                    fill="hsl(var(--chart-1))"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Carrier / Product / Top Agents */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Revenue by Carrier</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="w-full h-[240px]">
              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={(data?.revenue_by_carrier ?? []).slice(0, 5)}
                      dataKey="expected"
                      nameKey="carrier"
                      innerRadius={50}
                      outerRadius={85}
                      paddingAngle={2}
                      style={{ cursor: "pointer" }}
                      onClick={(slice) => {
                        // Recharts v3 hands the slice's payload back via
                        // `payload` (the row we passed in). v2 passed the
                        // row directly — CRA's pattern is `p?.carrier`,
                        // ours has to peel one more layer.
                        const row = (slice as { payload?: { carrier?: string } })
                          .payload;
                        if (row?.carrier) onCarrierClick(row.carrier);
                      }}
                    >
                      {(data?.revenue_by_carrier ?? [])
                        .slice(0, 5)
                        .map((_, i) => (
                          <Cell
                            key={i}
                            fill={DONUT_COLORS[i % DONUT_COLORS.length]}
                          />
                        ))}
                    </Pie>
                    <ReTooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 11,
                        borderRadius: 6,
                      }}
                      formatter={(v) =>
                        typeof v === "number" ? fmt(v) : String(v)
                      }
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground text-center mt-1">
              Click a slice to filter the ledger
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Revenue by Product</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="w-full h-[240px]">
              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={(data?.revenue_by_product ?? []).slice(0, 7)}
                      dataKey="expected"
                      nameKey="product"
                      innerRadius={50}
                      outerRadius={85}
                      paddingAngle={2}
                    >
                      {(data?.revenue_by_product ?? [])
                        .slice(0, 7)
                        .map((_, i) => (
                          <Cell
                            key={i}
                            fill={DONUT_COLORS[i % DONUT_COLORS.length]}
                          />
                        ))}
                    </Pie>
                    <ReTooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 11,
                        borderRadius: 6,
                      }}
                      formatter={(v) =>
                        typeof v === "number" ? fmt(v) : String(v)
                      }
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Top Agents by Revenue</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
              {(data?.revenue_by_agent ?? []).slice(0, 8).map((a) => {
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
                        className="h-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {!loading && (data?.revenue_by_agent ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  No agent revenue in this period.
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Aging report */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CircleAlert className="w-4 h-4 text-ghw-copper" />
            Aging Report
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <AgingGrid
            aging={agingQuery.data}
            loading={agingQuery.isLoading}
            active={activeBucket}
            onToggle={(k) =>
              setActiveBucket((prev) => (prev === k ? null : k))
            }
          />
          {activeBucket && agingQuery.data ? (
            <AgingDrillDown
              policies={agingQuery.data.buckets[activeBucket].policies}
            />
          ) : null}
        </CardContent>
      </Card>

      {/* Agent commission breakdown — spec's QuickBooks-parity slot.
          Backed by /summary's revenue_by_agent (period-scoped). The
          spec also asked for Advance Total / Earned Total columns;
          those don't exist on the backend payload yet — the schema
          would need an advance-vs-earned classification on each
          production_records row. Surfaced in the WS3 report as a
          tracked follow-up. */}
      <AgentCommissionBreakdown
        rows={data?.revenue_by_agent ?? []}
        loading={loading}
      />

      {/* Recent disputes — top 5, with deep link into the Disputes tab */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">
            Recent Disputes ({disputesQuery.data?.items.length ?? 0})
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={onJumpDisputes}
            data-testid="overview-view-disputes"
          >
            View All Disputes
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {disputesQuery.isLoading ? (
            <div className="p-6">
              <Skeleton className="h-20 w-full" />
            </div>
          ) : recentDisputes.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">
              No open disputes.
            </p>
          ) : (
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
                {recentDisputes.map((d) => (
                  <TableRow key={d.dispute_id}>
                    <TableCell className="text-xs">{d.carrier}</TableCell>
                    <TableCell className="text-xs">
                      {d.client_name || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {d.agent_name || "—"}
                    </TableCell>
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function collectionAccent(rate: number | undefined): string {
  const v = rate ?? 0;
  if (v >= 90) return "text-ghw-forest";
  if (v >= 75) return "text-ghw-copper";
  return "text-destructive";
}

// ─── KPI card ────────────────────────────────────────────────────────────

interface KpiCardProps {
  title: string;
  value: string;
  accent?: string;
  subtitle?: string;
  Icon?: React.ComponentType<{ className?: string }>;
  loading?: boolean;
}

function KpiCard({
  title,
  value,
  accent,
  subtitle,
  Icon,
  loading,
}: KpiCardProps) {
  return (
    <Card data-testid={`kpi-${title.replace(/\s+/g, "-").toLowerCase()}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              {title}
            </div>
            {loading ? (
              <Skeleton className="h-7 w-20 mt-1" />
            ) : (
              <div
                className={cn(
                  "mt-1 text-2xl font-bold tabular-nums truncate font-display",
                  accent,
                )}
              >
                {value}
              </div>
            )}
            {subtitle ? (
              <div className="text-xs text-muted-foreground mt-1">
                {subtitle}
              </div>
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

// ─── Aging ──────────────────────────────────────────────────────────────

const AGING_CARDS: readonly {
  key: AgingBucketKey;
  label: string;
  color: string;
}[] = [
  { key: "current", label: "0–30 days", color: "text-foreground" },
  { key: "days_31_60", label: "31–60 days", color: "text-ghw-copper" },
  { key: "days_61_90", label: "61–90 days", color: "text-orange-600" },
  { key: "days_90_plus", label: "90+ days", color: "text-destructive" },
];

function AgingGrid({
  aging,
  loading,
  active,
  onToggle,
}: {
  aging: AgingResponse | undefined;
  loading: boolean;
  active: AgingBucketKey | null;
  onToggle: (k: AgingBucketKey) => void;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {AGING_CARDS.map((c) => {
        const bucket = aging?.buckets[c.key];
        const isActive = active === c.key;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onToggle(c.key)}
            className={cn(
              "text-left rounded-lg border p-3 transition-colors",
              isActive
                ? "border-primary/60 bg-secondary/40"
                : "border-border hover:border-primary/40",
            )}
            data-testid={`aging-${c.key}`}
          >
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              {c.label}
            </div>
            {loading ? (
              <Skeleton className="h-6 w-16 mt-1" />
            ) : (
              <div
                className={cn(
                  "text-xl font-bold tabular-nums mt-1 font-display",
                  c.color,
                )}
              >
                {fmtShort(bucket?.amount)}
              </div>
            )}
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {bucket?.count ?? 0} policies
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AgingDrillDown({
  policies,
}: {
  policies: AgingResponse["buckets"][AgingBucketKey]["policies"];
}) {
  return (
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
          {policies.map((p, i) => (
            <TableRow key={p.policy_id || i}>
              <TableCell className="text-xs">{p.client_name ?? "—"}</TableCell>
              <TableCell className="text-xs">{p.carrier ?? "—"}</TableCell>
              <TableCell className="text-xs">{p.product ?? "—"}</TableCell>
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
  );
}

// ─── Agent Commission Breakdown ─────────────────────────────────────────

type AgentSortKey = "agent_name" | "policy_count" | "expected" | "received" | "gap";
type SortDir = "asc" | "desc";

function AgentCommissionBreakdown({
  rows,
  loading,
}: {
  rows: RevenueByAgentRow[];
  loading: boolean;
}) {
  const [sortKey, setSortKey] = React.useState<AgentSortKey>("expected");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");

  const sorted = React.useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(k: AgentSortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  function indicator(k: AgentSortKey) {
    if (k !== sortKey) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Agent Commission Breakdown</CardTitle>
        <p className="text-xs text-muted-foreground">
          Period-scoped roll-up. Sortable.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6">
            <Skeleton className="h-20 w-full" />
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground p-6 text-center">
            No agent activity in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    onClick={() => toggleSort("agent_name")}
                    className="cursor-pointer select-none"
                  >
                    Agent{indicator("agent_name")}
                  </TableHead>
                  <TableHead
                    onClick={() => toggleSort("policy_count")}
                    className="cursor-pointer select-none text-right"
                  >
                    Policies{indicator("policy_count")}
                  </TableHead>
                  <TableHead
                    onClick={() => toggleSort("expected")}
                    className="cursor-pointer select-none text-right"
                  >
                    Expected{indicator("expected")}
                  </TableHead>
                  <TableHead
                    onClick={() => toggleSort("received")}
                    className="cursor-pointer select-none text-right"
                  >
                    Received{indicator("received")}
                  </TableHead>
                  <TableHead
                    onClick={() => toggleSort("gap")}
                    className="cursor-pointer select-none text-right"
                  >
                    Gap{indicator("gap")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((row) => (
                  <TableRow key={row.agent_id || row.agent_name}>
                    <TableCell className="text-xs">{row.agent_name}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmtNum(row.policy_count)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(row.expected)}
                    </TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      {fmt(row.received)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-xs text-right tabular-nums",
                        row.gap > 0 && "text-destructive",
                      )}
                    >
                      {fmt(row.gap)}
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
