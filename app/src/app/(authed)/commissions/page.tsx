"use client";

import * as React from "react";
import Link from "next/link";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  Calculator,
  CheckCircle2,
  ChevronRight,
  Crown,
  DollarSign,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  Trophy,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  commissions as commissionsApi,
  isApiError,
} from "@/lib/api";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { CommissionCalculator } from "@/components/commissions/calculator";
import type { CommissionLiveRow, CommissionUpload } from "@/lib/api/commissions";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function n(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function CommissionsPage() {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Commissions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live ComTrack pulls, your YTD totals, statement uploads, and the
            commission calculator.
          </p>
        </div>
      </header>

      <ImpersonationBanner />

      <SummaryCards />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 md:gap-6">
        <div className="space-y-6 min-w-0">
          <Tabs defaultValue="live">
            <TabsList>
              <TabsTrigger value="live">Live ComTrack</TabsTrigger>
              <TabsTrigger value="history">Upload history</TabsTrigger>
            </TabsList>
            <TabsContent value="live" className="mt-4">
              <LivePanel />
            </TabsContent>
            <TabsContent value="history" className="mt-4">
              <HistoryPanel />
            </TabsContent>
          </Tabs>

          <UploadCard />
        </div>

        <div className="space-y-6">
          <CommissionCalculator />
          <LeaderboardPreview />
        </div>
      </div>
    </div>
  );
}

// ─── Summary cards ─────────────────────────────────────────────────────────

function SummaryCards() {
  const q = useQuery({
    queryKey: ["commissions", "summary"],
    queryFn: () => commissionsApi.getSummary(),
  });

  if (q.isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded" />
        ))}
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          Couldn&apos;t pull your commission summary. ComTrack may be
          unreachable; the live tab below will still try.
        </CardContent>
      </Card>
    );
  }

  const data = q.data;
  const ytdTotal = n(data.ytd_total);
  const ytdPaid = n(data.ytd_paid);
  const ytdPending = n(data.ytd_pending);
  const chargebacks = n(data.ytd_chargebacks);
  const thisMonth = n(data.this_month_total);
  const lastMonth = n(data.last_month_total);
  const monthDelta = thisMonth - lastMonth;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <SummaryCard
        icon={<DollarSign className="h-4 w-4" />}
        label="YTD total"
        value={USD.format(ytdTotal)}
        hint={data.mock ? "Mock data" : "From ComTrack"}
        accent
      />
      <SummaryCard
        icon={<CheckCircle2 className="h-4 w-4" />}
        label="YTD paid"
        value={USD.format(ytdPaid)}
        hint={
          ytdTotal > 0
            ? `${Math.round((ytdPaid / ytdTotal) * 100)}% of total`
            : undefined
        }
      />
      <SummaryCard
        icon={<Loader2 className="h-4 w-4" />}
        label="Pending"
        value={USD.format(ytdPending)}
        hint={
          chargebacks > 0
            ? `Less ${USD.format(chargebacks)} chargebacks`
            : undefined
        }
      />
      <SummaryCard
        icon={<Calculator className="h-4 w-4" />}
        label="This month"
        value={USD.format(thisMonth)}
        hint={
          lastMonth > 0
            ? `${monthDelta >= 0 ? "↑" : "↓"} ${USD.format(Math.abs(monthDelta))} vs last`
            : undefined
        }
      />
    </div>
  );
}

function SummaryCard({
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
    <Card className="border-border/70">
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          <span className="text-[10px] uppercase tracking-widest">{label}</span>
        </div>
        <div
          className={cn(
            "text-lg md:text-xl font-bold tabular-nums",
            accent ? "text-primary" : "",
          )}
        >
          {value}
        </div>
        {hint ? (
          <div className="text-[10px] text-muted-foreground truncate">
            {hint}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Live panel ────────────────────────────────────────────────────────────

function LivePanel() {
  const qc = useQueryClient();
  const [carrierFilter, setCarrierFilter] = React.useState<string>("all");
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "statement_date", desc: true },
  ]);

  const q = useQuery({
    queryKey: ["commissions", "live"],
    queryFn: () => commissionsApi.getLive(),
    placeholderData: keepPreviousData,
  });

  const refreshMutation = useMutation({
    mutationFn: () => commissionsApi.getLive({ refresh: true }),
    onSuccess: (data) => {
      qc.setQueryData(["commissions", "live"], data);
      toast.success("Refreshed from ComTrack.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Refresh failed."),
  });

  const rows = q.data?.rows ?? [];

  const carriers = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.carrier) set.add(r.carrier);
    }
    return Array.from(set).sort();
  }, [rows]);

  const filtered = React.useMemo(() => {
    if (carrierFilter === "all") return rows;
    return rows.filter((r) => r.carrier === carrierFilter);
  }, [rows, carrierFilter]);

  const total = React.useMemo(
    () => filtered.reduce((sum, r) => sum + n(r.amount), 0),
    [filtered],
  );

  const columns = React.useMemo<ColumnDef<CommissionLiveRow>[]>(
    () => [
      {
        id: "statement_date",
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Date
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        accessorKey: "statement_date",
        cell: ({ row }) => (
          <span className="text-xs tabular-nums whitespace-nowrap">
            {row.original.statement_date ?? "—"}
          </span>
        ),
      },
      {
        id: "carrier",
        header: "Carrier",
        accessorKey: "carrier",
        cell: ({ row }) => (
          <span className="text-sm truncate">{row.original.carrier ?? "—"}</span>
        ),
      },
      {
        id: "client",
        header: "Client",
        accessorKey: "client_name",
        cell: ({ row }) => (
          <span className="text-sm truncate">
            {row.original.client_name ?? "—"}
          </span>
        ),
      },
      {
        id: "product",
        header: "Product",
        accessorKey: "product",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground truncate">
            {row.original.product ?? "—"}
          </span>
        ),
      },
      {
        id: "policy_number",
        header: "Policy #",
        accessorKey: "policy_number",
        cell: ({ row }) => (
          <span className="text-xs tabular-nums truncate">
            {row.original.policy_number ?? "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorKey: "status",
        cell: ({ row }) => {
          const s = (row.original.status ?? "").toLowerCase();
          const tint =
            s === "paid"
              ? "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
              : s === "pending"
                ? "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
                : s === "chargeback" || s === "reversed"
                  ? "bg-destructive/15 text-destructive border-destructive/30"
                  : "bg-muted text-muted-foreground border-border";
          return (
            <Badge
              variant="outline"
              className={cn("text-[10px] capitalize", tint)}
            >
              {row.original.status ?? "—"}
            </Badge>
          );
        },
      },
      {
        id: "amount",
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1 ml-auto"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Amount
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        accessorFn: (r) => n(r.amount),
        cell: ({ row }) => (
          <span className="text-sm font-medium tabular-nums whitespace-nowrap text-right block">
            {USD_CENTS.format(n(row.original.amount))}
          </span>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <Card>
      <CardContent className="p-3 md:p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={carrierFilter} onValueChange={setCarrierFilter}>
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue placeholder="All carriers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All carriers</SelectItem>
              {carriers.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="h-9 text-xs"
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            )}
            Force refresh
          </Button>

          {q.data?.cache_hit ? (
            <Badge variant="outline" className="text-[10px]">
              Cached
            </Badge>
          ) : null}

          <div className="ml-auto text-xs text-muted-foreground tabular-nums">
            {q.isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                {filtered.length} row{filtered.length === 1 ? "" : "s"} ·{" "}
                <span className="font-semibold text-primary">
                  {USD_CENTS.format(total)}
                </span>
              </>
            )}
          </div>
        </div>

        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-sm">No live rows.</p>
            <p className="text-xs text-muted-foreground mt-1">
              ComTrack returned nothing for your agent name in the current window.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40">
                {table.getHeaderGroups().map((hg) => (
                  <tr
                    key={hg.id}
                    className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground"
                  >
                    {hg.headers.map((h) => (
                      <th key={h.id} className="text-left px-3 py-2">
                        {h.isPlaceholder
                          ? null
                          : flexRender(
                              h.column.columnDef.header,
                              h.getContext(),
                            )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/60 hover:bg-secondary/40 transition-colors"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2.5">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
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

// ─── History panel ─────────────────────────────────────────────────────────

function HistoryPanel() {
  const q = useQuery({
    queryKey: ["commissions", "history"],
    queryFn: () => commissionsApi.getHistory(),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded" />
        ))}
      </div>
    );
  }

  const uploads = q.data?.uploads ?? [];

  if (uploads.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium text-sm">No uploads yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Drop a carrier statement below to seed the history.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40">
          <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
            <th className="text-left px-3 py-2">File</th>
            <th className="text-left px-3 py-2 hidden md:table-cell">Carrier</th>
            <th className="text-left px-3 py-2 hidden md:table-cell">
              Statement date
            </th>
            <th className="text-left px-3 py-2">Uploaded</th>
            <th className="text-right px-3 py-2">Total</th>
            <th className="text-right px-3 py-2 hidden sm:table-cell">Status</th>
          </tr>
        </thead>
        <tbody>
          {uploads.map((u, i) => (
            <UploadRow key={u.id ?? i} upload={u} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function UploadRow({ upload }: { upload: CommissionUpload }) {
  const uploadedDate = upload.uploaded_at
    ? new Date(upload.uploaded_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
  const status = (upload.status ?? "").toLowerCase();
  const statusTint =
    status === "completed" || status === "processed" || status === "success"
      ? "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
      : status === "error" || status === "failed"
        ? "bg-destructive/15 text-destructive border-destructive/30"
        : "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30";
  return (
    <tr className="border-b border-border/60 hover:bg-secondary/40 transition-colors">
      <td className="px-3 py-3">
        <div className="font-medium text-sm truncate max-w-[260px]">
          {upload.filename ?? "—"}
        </div>
        <div className="text-[11px] text-muted-foreground truncate md:hidden">
          {upload.carrier ?? "—"} · {upload.statement_date ?? "—"}
        </div>
      </td>
      <td className="px-3 py-3 hidden md:table-cell text-sm">
        {upload.carrier ?? "—"}
      </td>
      <td className="px-3 py-3 hidden md:table-cell text-xs text-muted-foreground tabular-nums">
        {upload.statement_date ?? "—"}
      </td>
      <td className="px-3 py-3 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {uploadedDate}
      </td>
      <td className="px-3 py-3 text-right text-sm tabular-nums">
        {upload.total_amount != null
          ? USD_CENTS.format(n(upload.total_amount))
          : "—"}
      </td>
      <td className="px-3 py-3 text-right hidden sm:table-cell">
        {upload.status ? (
          <Badge
            variant="outline"
            className={cn("text-[10px] capitalize", statusTint)}
          >
            {upload.status}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

// ─── Upload card ───────────────────────────────────────────────────────────

function UploadCard() {
  const qc = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);

  const mutation = useMutation({
    mutationFn: (file: File) => commissionsApi.uploadStatement(file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commissions", "history"] });
      qc.invalidateQueries({ queryKey: ["commissions", "live"] });
      qc.invalidateQueries({ queryKey: ["commissions", "summary"] });
      toast.success("Statement uploaded and processed.");
      setSelectedFile(null);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Upload failed."),
  });

  function onPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setSelectedFile(file);
    e.target.value = "";
  }

  return (
    <Card className="border-border/70">
      <CardContent className="p-4 md:p-5">
        <div className="flex items-center gap-2 mb-3">
          <Upload className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Upload statement</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          PDF / CSV / XLSX up to 15 MB. Carrier statements run through ComTrack
          digestion on the backend.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.csv,.xlsx,.xls,.txt"
            onChange={onPicked}
            className="hidden"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={mutation.isPending}
          >
            <FileText className="h-3.5 w-3.5 mr-1.5" />
            {selectedFile ? "Replace file" : "Pick file"}
          </Button>
          {selectedFile ? (
            <>
              <span className="text-xs truncate">
                {selectedFile.name}{" "}
                <span className="text-muted-foreground">
                  ({Math.round(selectedFile.size / 1024)} KB)
                </span>
              </span>
              <Button
                size="sm"
                onClick={() => mutation.mutate(selectedFile)}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                )}
                Upload
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedFile(null)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Leaderboard preview widget ────────────────────────────────────────────

function LeaderboardPreview() {
  const [period, setPeriod] = React.useState<"week" | "month" | "ytd" | "all">(
    "month",
  );
  const q = useQuery({
    queryKey: ["leaderboard", period, 10],
    queryFn: () => commissionsApi.getLeaderboard(period, 10),
  });

  return (
    <Card className="border-border/70">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Leaderboard</h3>
          </div>
          <Select
            value={period}
            onValueChange={(v) => setPeriod(v as typeof period)}
          >
            <SelectTrigger className="h-8 w-[110px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
              <SelectItem value="ytd">YTD</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {q.isLoading ? (
          <div className="space-y-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full rounded" />
            ))}
          </div>
        ) : q.isError ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            Couldn&apos;t load.
          </p>
        ) : (q.data?.rows ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No production records yet.
          </p>
        ) : (
          <ol className="space-y-1">
            {q.data?.rows.slice(0, 10).map((row, i) => (
              <li
                key={row.agent_name + i}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded text-xs",
                  row.is_self
                    ? "bg-primary/10 ring-1 ring-primary/30"
                    : "hover:bg-secondary/40",
                )}
              >
                <span
                  className={cn(
                    "h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold tabular-nums",
                    i === 0
                      ? "bg-ghw-copper/30 text-ghw-copper"
                      : i === 1
                        ? "bg-muted-foreground/20 text-muted-foreground"
                        : i === 2
                          ? "bg-ghw-copper/15 text-ghw-copper"
                          : "bg-secondary text-muted-foreground",
                  )}
                >
                  {i === 0 ? <Crown className="h-3 w-3" /> : i + 1}
                </span>
                <span className="font-medium truncate flex-1">
                  {row.agent_name}
                  {row.is_self ? (
                    <span className="ml-1.5 text-[9px] text-primary uppercase tracking-wider">
                      you
                    </span>
                  ) : null}
                </span>
                <span className="font-semibold tabular-nums">
                  {USD.format(row.agent_split)}
                </span>
              </li>
            ))}
          </ol>
        )}

        <Link
          href="/leaderboard"
          className="block text-[11px] text-primary hover:underline text-center"
        >
          Full leaderboard
          <ChevronRight className="h-3 w-3 inline-block ml-0.5" />
        </Link>
      </CardContent>
    </Card>
  );
}
