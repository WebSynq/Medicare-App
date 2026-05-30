"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Award,
  Crown,
  Inbox,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
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

const PERIODS = [
  { value: "mtd", label: "Month-to-date" },
  { value: "last30", label: "Last 30 days" },
  { value: "last90", label: "Last 90 days" },
  { value: "ytd", label: "Year-to-date" },
  { value: "all", label: "All time" },
] as const;

type Period = (typeof PERIODS)[number]["value"];

export default function LeadSourcesPage() {
  const [period, setPeriod] = React.useState<Period>("mtd");

  const query = useQuery({
    queryKey: ["reports", "lead-sources", period],
    queryFn: () => dashboardApi.getLeadSources(period),
  });

  return (
    <div className="space-y-6">
      {/* Section title is on the Reports layout. */}
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
            Couldn&apos;t load report.
          </CardContent>
        </Card>
      ) : query.data.sources.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-sm">No leads in this window.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Try a wider date range.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <HighlightCards
            topSource={query.data.top_source}
            bestConverting={query.data.best_converting}
            sources={query.data.sources}
          />

          <Card>
            <CardContent className="p-4 md:p-5 space-y-3">
              <h3 className="text-sm font-semibold">Source volume</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={query.data.sources}
                    margin={{ left: 0, right: 8, top: 8 }}
                  >
                    <CartesianGrid
                      stroke="hsl(var(--border))"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="source"
                      tick={{
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                      stroke="hsl(var(--border))"
                      angle={-15}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis
                      tick={{
                        fontSize: 10,
                        fill: "hsl(var(--muted-foreground))",
                      }}
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
                    <Bar dataKey="total" fill="hsl(var(--primary))" />
                    <Bar
                      dataKey="enrolled"
                      fill="hsl(140 50% 50%)"
                      name="enrolled"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <SourcesTable sources={query.data.sources} />
        </>
      )}
    </div>
  );
}

function HighlightCards({
  topSource,
  bestConverting,
  sources,
}: {
  topSource: string | null;
  bestConverting: string | null;
  sources: { source: string; total: number; conversion_rate: number }[];
}) {
  const total = sources.reduce((s, r) => s + r.total, 0);
  const totalEnrolled = sources.reduce(
    (s, r) => s + Math.round(r.total * r.conversion_rate),
    0,
  );
  const topVol = topSource
    ? sources.find((s) => s.source === topSource)?.total ?? 0
    : 0;
  const bestRate = bestConverting
    ? sources.find((s) => s.source === bestConverting)?.conversion_rate ?? 0
    : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <HiTile
        icon={<TrendingUp />}
        label="Total leads"
        value={total.toLocaleString()}
      />
      <HiTile
        icon={<Award />}
        label="Total enrolled"
        value={totalEnrolled.toLocaleString()}
        hint={total > 0 ? `${Math.round((totalEnrolled / total) * 100)}% overall` : undefined}
      />
      <HiTile
        icon={<Crown />}
        label="Top source"
        value={topSource ?? "—"}
        hint={topVol > 0 ? `${topVol.toLocaleString()} leads` : undefined}
        accent
      />
      <HiTile
        icon={<Award />}
        label="Best converting"
        value={bestConverting ?? "—"}
        hint={bestRate > 0 ? `${(bestRate * 100).toFixed(0)}%` : undefined}
        accent
      />
    </div>
  );
}

function HiTile({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="h-3.5 w-3.5">{icon}</span>
          <span className="text-[10px] uppercase tracking-widest">{label}</span>
        </div>
        <p
          className={cn(
            "text-base font-bold truncate",
            accent ? "text-primary" : "",
          )}
        >
          {value}
        </p>
        {hint ? (
          <p className="text-[10px] text-muted-foreground truncate">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SourcesTable({
  sources,
}: {
  sources: {
    source: string;
    total: number;
    enrolled: number;
    conversion_rate: number;
    avg_days_to_enroll: number | null;
  }[];
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40">
          <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
            <th className="text-left px-3 py-2">Source</th>
            <th className="text-right px-3 py-2">Leads</th>
            <th className="text-right px-3 py-2">Enrolled</th>
            <th className="text-right px-3 py-2">Conv %</th>
            <th className="text-right px-3 py-2 hidden md:table-cell">
              Avg days
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr
              key={s.source}
              className="border-b border-border/60 hover:bg-secondary/40"
            >
              <td className="px-3 py-3 font-medium">{s.source}</td>
              <td className="px-3 py-3 text-right tabular-nums">
                {s.total.toLocaleString()}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">
                {s.enrolled.toLocaleString()}
              </td>
              <td className="px-3 py-3 text-right">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] tabular-nums",
                    s.conversion_rate >= 0.5
                      ? "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
                      : s.conversion_rate >= 0.2
                        ? "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
                        : "bg-muted text-muted-foreground border-border",
                  )}
                >
                  {(s.conversion_rate * 100).toFixed(0)}%
                </Badge>
              </td>
              <td className="px-3 py-3 text-right hidden md:table-cell tabular-nums text-xs">
                {s.avg_days_to_enroll != null
                  ? s.avg_days_to_enroll.toFixed(1)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
