import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Trophy, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";

const REFRESH_MS = 60_000;

function fmtUSD(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(val);
}

// Gold / silver / bronze badge styles for the top three.
const PODIUM = {
  1: { bg: "bg-gradient-to-br from-amber-300 to-yellow-500", text: "text-yellow-900", label: "🥇" },
  2: { bg: "bg-gradient-to-br from-slate-200 to-slate-400", text: "text-slate-800", label: "🥈" },
  3: { bg: "bg-gradient-to-br from-amber-600 to-orange-700", text: "text-amber-50", label: "🥉" },
};

function RankBadge({ rank }) {
  const podium = PODIUM[rank];
  if (podium) {
    return (
      <div
        className={`w-9 h-9 rounded-full grid place-items-center ${podium.bg} ${podium.text} text-sm font-bold shadow-sm`}
        aria-label={`Rank ${rank}`}
      >
        {podium.label}
      </div>
    );
  }
  return (
    <div className="w-9 h-9 rounded-full grid place-items-center bg-secondary text-secondary-foreground text-sm font-mono">
      {rank}
    </div>
  );
}

function SkeletonRow() {
  return (
    <TableRow>
      <TableCell colSpan={5}>
        <div className="h-9 rounded bg-secondary/60 animate-pulse" />
      </TableCell>
    </TableRow>
  );
}

export default function Leaderboard() {
  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState("all");
  const [limit, setLimit] = useState(25);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/leaderboard", {
        params: { period, limit },
      });
      setRows(data.rows || []);
      setRefreshedAt(new Date());
    } catch (e) {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [period, limit]);

  // Initial + dependency-triggered fetch
  useEffect(() => {
    load();
  }, [load]);

  // 60s auto-refresh for production-display mode
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1200px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Trophy className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Production
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Agency Leaderboard
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Production rankings by revenue
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-36 h-9" data-testid="leaderboard-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="week">Last 7 days</SelectItem>
                <SelectItem value="month">Last 30 days</SelectItem>
                <SelectItem value="ytd">Year to date</SelectItem>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(limit)}
              onValueChange={(v) => setLimit(Number(v))}
            >
              <SelectTrigger className="w-28 h-9" data-testid="leaderboard-limit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">Top 10</SelectItem>
                <SelectItem value="25">Top 25</SelectItem>
                <SelectItem value="1000">All</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={load}
              className="h-9 w-9 grid place-items-center rounded-md border border-border hover:bg-secondary transition"
              aria-label="Refresh"
              data-testid="leaderboard-refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <Card className="border-border bg-surface" data-testid="leaderboard-card">
          <CardContent className="p-5">
            <div className="overflow-x-auto w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Rank</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Policies</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Gap</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && rows.length === 0 && (
                    <>
                      <SkeletonRow />
                      <SkeletonRow />
                      <SkeletonRow />
                      <SkeletonRow />
                      <SkeletonRow />
                    </>
                  )}
                  {!loading && rows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center py-12 text-muted-foreground"
                      >
                        No production records yet. Import the tracker to populate
                        the board.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => (
                    <TableRow
                      key={r.agent_name + r.rank}
                      className={r.is_self ? "bg-[#e85d2f]/5" : ""}
                      data-testid={`leaderboard-row-${r.rank}`}
                    >
                      <TableCell>
                        <RankBadge rank={r.rank} />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{r.agent_name}</div>
                        {r.is_self && (
                          <Badge className="mt-1 rounded-full bg-[#e85d2f]/15 text-[#e85d2f] border-0 text-[10px]">
                            you
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.policies_count}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {fmtUSD(r.revenue_total)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${
                          r.audit_gap == null || r.audit_gap === 0
                            ? ""
                            : r.audit_gap < 0
                              ? "text-red-600 font-medium"
                              : "text-emerald-600 font-medium"
                        }`}
                      >
                        {r.audit_gap == null
                          ? "—"
                          : r.audit_gap === 0
                            ? "$0.00"
                            : (r.audit_gap < 0 ? "−" : "+") +
                              fmtUSD(Math.abs(r.audit_gap))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground mt-3 text-right">
          {refreshedAt
            ? `Updated ${refreshedAt.toLocaleTimeString()} · auto-refreshes every 60s`
            : "Auto-refreshes every 60s"}
        </p>
      </main>
    </div>
  );
}
