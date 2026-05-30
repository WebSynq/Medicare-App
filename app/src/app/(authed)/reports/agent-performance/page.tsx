"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";

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

type SortField =
  | "leads_count"
  | "enrolled_count"
  | "conversion_rate"
  | "estimated_revenue"
  | "trend_pct";

export default function AgentPerformancePage() {
  const [period, setPeriod] = React.useState<Period>("mtd");
  const [sort, setSort] = React.useState<SortField>("estimated_revenue");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  const query = useQuery({
    queryKey: ["reports", "agent-performance", period],
    queryFn: () => dashboardApi.getAgentPerformance(period),
  });

  const sorted = React.useMemo(() => {
    const rows = query.data?.agents ?? [];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sort] ?? 0;
      const bv = b[sort] ?? 0;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [query.data, sort, sortDir]);

  function toggleSort(field: SortField) {
    if (sort === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setSortDir("desc");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
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
      </div>

      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError || !query.data ? (
        <Card>
          <CardContent className="p-10 text-center text-destructive">
            Couldn&apos;t load agent performance.
          </CardContent>
        </Card>
      ) : sorted.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <TrendingUp className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-sm">No agent activity this period.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40">
              <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
                <th className="text-left px-3 py-2">Agent</th>
                <SortHeader
                  label="Leads"
                  field="leads_count"
                  active={sort}
                  dir={sortDir}
                  onClick={toggleSort}
                />
                <SortHeader
                  label="Enrolled"
                  field="enrolled_count"
                  active={sort}
                  dir={sortDir}
                  onClick={toggleSort}
                />
                <SortHeader
                  label="Conv %"
                  field="conversion_rate"
                  active={sort}
                  dir={sortDir}
                  onClick={toggleSort}
                  hideUntil="sm"
                />
                <SortHeader
                  label="Trend"
                  field="trend_pct"
                  active={sort}
                  dir={sortDir}
                  onClick={toggleSort}
                  hideUntil="md"
                />
                <SortHeader
                  label="Revenue"
                  field="estimated_revenue"
                  active={sort}
                  dir={sortDir}
                  onClick={toggleSort}
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
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
        </Card>
      )}
    </div>
  );
}

function SortHeader({
  label,
  field,
  active,
  dir,
  onClick,
  hideUntil,
}: {
  label: string;
  field: SortField;
  active: SortField;
  dir: "asc" | "desc";
  onClick: (f: SortField) => void;
  hideUntil?: "sm" | "md";
}) {
  const isActive = active === field;
  return (
    <th
      className={cn(
        "text-right px-3 py-2",
        hideUntil === "sm" && "hidden sm:table-cell",
        hideUntil === "md" && "hidden md:table-cell",
      )}
    >
      <button
        onClick={() => onClick(field)}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {label}
        {isActive ? <span className="tabular-nums">{dir === "asc" ? "↑" : "↓"}</span> : null}
      </button>
    </th>
  );
}
