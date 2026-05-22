import { useEffect, useMemo, useState } from "react";
import { PieChart as PieIcon, TrendingUp, Sparkles } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import ScrollableCard from "@/components/ScrollableCard";
import { api } from "@/lib/api";

const PERIOD_TABS = [
  { value: "mtd", label: "MTD" },
  { value: "ytd", label: "YTD" },
  { value: "last30", label: "Last 30" },
  { value: "last90", label: "Last 90" },
  { value: "all", label: "All Time" },
];

const TOTAL_COLOR = "#2563eb"; // blue-600
const ENROLLED_COLOR = "#e85d2f"; // GHW accent

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function SummaryCard({ icon: Icon, label, primary, secondary }) {
  return (
    <Card className="bg-surface">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div
          className="text-2xl font-bold tracking-tight truncate"
          style={{ fontFamily: "Outfit" }}
          title={primary || ""}
        >
          {primary || "—"}
        </div>
        {secondary && (
          <div className="text-xs text-muted-foreground mt-1">{secondary}</div>
        )}
      </CardContent>
    </Card>
  );
}

function PeriodTabs({ value, onChange }) {
  return (
    <div
      role="tablist"
      className="inline-flex flex-wrap items-center gap-1 rounded-md border border-border bg-surface p-1"
    >
      {PERIOD_TABS.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className="px-3 py-1.5 text-xs font-medium rounded transition-colors"
            style={
              active
                ? { background: "#e85d2f", color: "white" }
                : { color: "hsl(var(--muted-foreground))" }
            }
            data-testid={`leadsrc-period-${t.value}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <div className="font-semibold mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: p.color }}
          />
          <span className="text-muted-foreground capitalize">{p.name}:</span>
          <span className="font-medium tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function LeadSourceReport() {
  const [period, setPeriod] = useState("mtd");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get("/dashboard/lead-sources", {
          params: { period },
        });
        if (!alive) return;
        setData(res.data);
      } catch (err) {
        toast.error(
          err?.response?.data?.detail || "Failed to load lead source report",
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [period]);

  // Wrap in useMemo so the array reference is stable across renders when
  // `data` doesn't change — the chartRows useMemo below depends on this
  // value, and a fresh `[]` literal on every render would defeat the
  // memoization (react-hooks/exhaustive-deps catches this).
  const sources = useMemo(() => data?.sources || [], [data]);
  const top = sources.find((s) => s.source === data?.top_source);
  const best = sources.find((s) => s.source === data?.best_converting);

  // Cap the chart at top 12 sources so a long-tail of one-off referrers
  // doesn't squash the bars; the table still shows everything below.
  const chartRows = useMemo(() => sources.slice(0, 12), [sources]);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <PieIcon className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Reports
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Lead Source Report
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Where leads come from and which sources convert best.
            </p>
            <ImpersonationBanner />
          </div>
          <PeriodTabs value={period} onChange={setPeriod} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <SummaryCard
            icon={Sparkles}
            label="Top Source"
            primary={top?.source}
            secondary={top ? `${top.total} leads` : "No data yet"}
          />
          <SummaryCard
            icon={TrendingUp}
            label="Best Converting"
            primary={best?.source}
            secondary={
              best
                ? `${fmtPct(best.conversion_rate)} (${best.enrolled}/${best.total})`
                : "No conversions yet"
            }
          />
        </div>

        <Card className="bg-surface mb-4">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h3
                className="text-sm font-semibold tracking-tight"
                style={{ fontFamily: "Outfit" }}
              >
                Total vs Enrolled by Source
              </h3>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm"
                    style={{ background: TOTAL_COLOR }}
                  />
                  Total
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm"
                    style={{ background: ENROLLED_COLOR }}
                  />
                  Enrolled
                </span>
              </div>
            </div>
            {loading && chartRows.length === 0 ? (
              <div className="h-56 rounded bg-secondary/40 animate-pulse" />
            ) : chartRows.length === 0 ? (
              <div className="h-56 grid place-items-center text-xs text-muted-foreground">
                No leads in this period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={chartRows}
                  margin={{ top: 8, right: 16, left: 0, bottom: 24 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                  />
                  <XAxis
                    dataKey="source"
                    fontSize={11}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    interval={0}
                    angle={-25}
                    textAnchor="end"
                    height={50}
                  />
                  <YAxis
                    allowDecimals={false}
                    fontSize={11}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ display: "none" }} />
                  <Bar
                    dataKey="total"
                    name="Total"
                    fill={TOTAL_COLOR}
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="enrolled"
                    name="Enrolled"
                    fill={ENROLLED_COLOR}
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <ScrollableCard
          title="By Source"
          count={sources.length}
          height="auto"
          loading={loading && sources.length === 0}
          isEmpty={!loading && sources.length === 0}
          emptyState="No leads in this period."
          bodyClassName="!h-auto"
          testId="leadsrc-table"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Total Leads</TableHead>
                <TableHead className="text-right">Enrolled</TableHead>
                <TableHead className="text-right">Conversion Rate</TableHead>
                <TableHead className="text-right">Avg Days to Enroll</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => (
                <TableRow
                  key={s.source}
                  data-testid={`leadsrc-row-${s.source}`}
                  className={
                    s.source === "Unknown" ? "text-muted-foreground" : ""
                  }
                >
                  <TableCell className="font-medium">{s.source}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.total}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.enrolled}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtPct(s.conversion_rate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {s.avg_days_to_enroll != null
                      ? `${s.avg_days_to_enroll}d`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollableCard>
      </main>
    </div>
  );
}
