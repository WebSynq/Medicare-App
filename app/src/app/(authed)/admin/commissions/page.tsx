"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { adminCommissions as adminCommissionsApi, isApiError } from "@/lib/api";
import type {
  AgentCommissionRow,
  CommissionStatus,
} from "@/lib/api/admin-commissions";
import {
  useAuthStore,
  selectHasAgencyScope,
  selectIsSuperAdmin,
} from "@/stores/auth";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

type StatusFilter = "all" | CommissionStatus;

const STATUS_LABELS: Record<CommissionStatus, string> = {
  current: "Current",
  stale: "Stale",
  no_data: "No Data",
};

const STATUS_DOTS: Record<CommissionStatus, string> = {
  current: "bg-ghw-forest",
  stale: "bg-ghw-copper",
  no_data: "bg-muted-foreground",
};

const ACCOUNT_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  pending: "secondary",
  rejected: "destructive",
};

type SortKey =
  | "full_name"
  | "agency_name"
  | "total_uploads"
  | "last_upload"
  | "commission_status";

const SORT_FNS: Record<SortKey, (a: AgentCommissionRow, b: AgentCommissionRow) => number> = {
  full_name: (a, b) => (a.full_name || "").localeCompare(b.full_name || ""),
  agency_name: (a, b) =>
    (a.agency_name || "").localeCompare(b.agency_name || ""),
  total_uploads: (a, b) => a.total_uploads - b.total_uploads,
  last_upload: (a, b) =>
    (a.last_upload ?? "").localeCompare(b.last_upload ?? ""),
  commission_status: (a, b) => {
    const order: Record<CommissionStatus, number> = {
      current: 0,
      stale: 1,
      no_data: 2,
    };
    return (order[a.commission_status] ?? 3) - (order[b.commission_status] ?? 3);
  },
};

function exportCSV(agents: AgentCommissionRow[]): void {
  const headers = [
    "Name",
    "Email",
    "Agency",
    "Account Status",
    "Total Uploads",
    "Digested",
    "Not Recognized",
    "Rejected",
    "Last Upload",
    "Commission Status",
  ];
  const rows = agents.map((a) => [
    a.full_name,
    a.email,
    a.agency_name,
    a.account_status,
    a.total_uploads,
    a.digested_count,
    a.not_recognized_count,
    a.rejected_count,
    a.last_upload ? new Date(a.last_upload).toLocaleDateString() : "",
    a.commission_status,
  ]);
  const csv = [headers, ...rows]
    .map((r) =>
      r
        .map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`)
        .join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `agent-commissions-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AdminCommissionsPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const allowed = status === "authed" && (hasAgencyScope || isSuperAdmin);

  React.useEffect(() => {
    if (status === "authed" && !allowed) {
      router.replace("/dashboard");
    }
  }, [status, allowed, router]);

  if (status !== "authed" || !allowed) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <AdminCommissionsBody />;
}

function AdminCommissionsBody() {
  const [search, setSearch] = React.useState("");
  const [sortKey, setSortKey] = React.useState<SortKey>("commission_status");
  const [sortDir, setSortDir] = React.useState<1 | -1>(1);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");

  const query = useQuery({
    queryKey: ["admin-commissions"],
    queryFn: adminCommissionsApi.getAll,
  });

  React.useEffect(() => {
    if (query.error) {
      toast.error(
        isApiError(query.error)
          ? query.error.message
          : "Could not load agent commission data.",
      );
    }
  }, [query.error]);

  const agents = React.useMemo(
    () => query.data?.agents ?? [],
    [query.data],
  );
  const summary = query.data?.summary;

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents
      .filter((a) => {
        if (statusFilter !== "all" && a.commission_status !== statusFilter) {
          return false;
        }
        if (!q) return true;
        return (
          (a.full_name || "").toLowerCase().includes(q) ||
          (a.email || "").toLowerCase().includes(q) ||
          (a.agency_name || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => SORT_FNS[sortKey](a, b) * sortDir);
  }, [agents, search, statusFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  const cards = [
    {
      label: "Total Agents",
      value: summary?.total_agents ?? 0,
      sub: "Registered in system",
      filter: "all" as StatusFilter,
    },
    {
      label: "Current",
      value: summary?.current ?? 0,
      sub: "Uploaded within 30 days",
      filter: "current" as StatusFilter,
      dot: "bg-ghw-forest",
    },
    {
      label: "Stale",
      value: summary?.stale ?? 0,
      sub: "No upload in 30+ days",
      filter: "stale" as StatusFilter,
      dot: "bg-ghw-copper",
    },
    {
      label: "No Data",
      value: summary?.no_data ?? 0,
      sub: "Never uploaded — follow up",
      filter: "no_data" as StatusFilter,
      dot: "bg-muted-foreground",
    },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-display">
            Agent Commissions
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Full roster — upload activity and commission status for all
            agents.{" "}
            <span className="text-ghw-copper font-medium">
              YTD figures available after Comtrack API key is connected.
            </span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => exportCSV(filtered)}
          disabled={query.isLoading || filtered.length === 0}
        >
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Export CSV
        </Button>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => {
          const active = statusFilter === c.filter;
          return (
            <Card
              key={c.label}
              role="button"
              tabIndex={0}
              onClick={() =>
                setStatusFilter(
                  statusFilter === c.filter && c.filter !== "all"
                    ? "all"
                    : c.filter,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setStatusFilter(
                    statusFilter === c.filter && c.filter !== "all"
                      ? "all"
                      : c.filter,
                  );
                }
              }}
              className={cn(
                "cursor-pointer transition-all",
                active ? "ring-2 ring-primary" : "hover:shadow-md",
              )}
            >
              <CardContent className="p-4 space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {c.dot && (
                    <span className={cn("w-2 h-2 rounded-full", c.dot)} />
                  )}
                  <span className="uppercase tracking-widest">{c.label}</span>
                </div>
                <p className="text-3xl font-bold tabular-nums">
                  {query.isLoading ? "—" : c.value}
                </p>
                <p className="text-xs text-muted-foreground">{c.sub}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between gap-4 px-5 pt-4 pb-3">
            <h3 className="text-sm font-semibold">
              {statusFilter === "all"
                ? `All Agents (${filtered.length})`
                : `${STATUS_LABELS[statusFilter]} (${filtered.length})`}
            </h3>
            <Input
              placeholder="Search name, email, agency…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs h-8 text-sm"
            />
          </div>
          {query.isLoading ? (
            <div className="px-5 pb-5 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-10">
              No agents match your filter.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHeader
                      sortKey="full_name"
                      currentKey={sortKey}
                      dir={sortDir}
                      onToggle={toggleSort}
                    >
                      Agent
                    </SortHeader>
                    <TableHead>Email</TableHead>
                    <SortHeader
                      sortKey="agency_name"
                      currentKey={sortKey}
                      dir={sortDir}
                      onToggle={toggleSort}
                    >
                      Agency
                    </SortHeader>
                    <TableHead className="text-right">YTD</TableHead>
                    <SortHeader
                      sortKey="total_uploads"
                      currentKey={sortKey}
                      dir={sortDir}
                      onToggle={toggleSort}
                      align="right"
                    >
                      Uploads
                    </SortHeader>
                    <SortHeader
                      sortKey="last_upload"
                      currentKey={sortKey}
                      dir={sortDir}
                      onToggle={toggleSort}
                    >
                      Last Upload
                    </SortHeader>
                    <SortHeader
                      sortKey="commission_status"
                      currentKey={sortKey}
                      dir={sortDir}
                      onToggle={toggleSort}
                    >
                      Status
                    </SortHeader>
                    <TableHead>Account</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((agent) => (
                    <TableRow key={agent.id}>
                      <TableCell className="font-medium text-sm">
                        {agent.full_name || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {agent.email}
                      </TableCell>
                      <TableCell className="text-xs">
                        {agent.agency_name || "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                        {agent.ytd_commission != null ? (
                          USD.format(agent.ytd_commission)
                        ) : (
                          <span className="italic">Pending</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="font-medium">
                          {agent.total_uploads}
                        </span>
                        {agent.total_uploads > 0 && (
                          <span className="text-[10px] text-muted-foreground ml-1">
                            ({agent.digested_count}✓
                            {agent.not_recognized_count > 0 &&
                              ` ${agent.not_recognized_count}⚠`}
                            {agent.rejected_count > 0 &&
                              ` ${agent.rejected_count}✗`}
                            )
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtDate(agent.last_upload)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "w-2 h-2 rounded-full flex-shrink-0",
                              STATUS_DOTS[agent.commission_status],
                            )}
                          />
                          <Badge variant="outline" className="text-[10px]">
                            {STATUS_LABELS[agent.commission_status]}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            ACCOUNT_BADGE_VARIANT[agent.account_status] ??
                            "outline"
                          }
                          className="text-[10px] capitalize"
                        >
                          {agent.account_status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SortHeader({
  sortKey,
  currentKey,
  dir,
  onToggle,
  align,
  children,
}: {
  sortKey: SortKey;
  currentKey: SortKey;
  dir: 1 | -1;
  onToggle: (key: SortKey) => void;
  align?: "right";
  children: React.ReactNode;
}) {
  const active = currentKey === sortKey;
  const arrow = active ? (dir === 1 ? " ↑" : " ↓") : " ↕";
  return (
    <TableHead
      className={cn(
        "cursor-pointer select-none hover:text-foreground transition-colors",
        align === "right" && "text-right",
      )}
      onClick={() => onToggle(sortKey)}
    >
      {children}
      <span className="text-muted-foreground">{arrow}</span>
    </TableHead>
  );
}
