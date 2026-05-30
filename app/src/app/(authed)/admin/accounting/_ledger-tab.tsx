"use client";

/**
 * Ledger tab — paginated commission ledger across every agent.
 * Filters: carrier, agent_id, product, status. Client-name search
 * runs on the current page only (the backend `/ledger` doesn't
 * accept a search param yet; flagged in the WS3 report as a
 * follow-up).
 *
 * Ports `AccountingDashboard.jsx` LedgerTab — same filter bar,
 * same status badges, same row-expand pattern, same CSV export.
 * Carrier filter is hoisted to the parent so the Overview donut
 * can pre-populate it when the user clicks a slice.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Filter } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { accounting } from "@/lib/api";
import type {
  LedgerResponse,
  LedgerRow,
  LedgerStatus,
} from "@/lib/api/accounting";

import { downloadCsv, fmt, fmtDate } from "./_helpers";
import { LedgerStatusBadge } from "./_status-badges";

interface LedgerTabProps {
  carrierFilter: string;
  setCarrierFilter: (s: string) => void;
}

const STATUS_OPTIONS: readonly { value: LedgerStatus | "all"; label: string }[] = [
  { value: "all", label: "Any" },
  { value: "paid", label: "Paid" },
  { value: "pending", label: "Pending" },
  { value: "gap", label: "Gap" },
  { value: "overpaid", label: "Overpaid" },
  { value: "chargeback", label: "Chargeback" },
];

export function LedgerTab({ carrierFilter, setCarrierFilter }: LedgerTabProps) {
  const [agentFilter, setAgentFilter] = React.useState("");
  const [productFilter, setProductFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<LedgerStatus | "all">(
    "all",
  );
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const query = useQuery<LedgerResponse>({
    queryKey: [
      "accounting",
      "ledger",
      { carrierFilter, agentFilter, productFilter, statusFilter, page },
    ],
    queryFn: () =>
      accounting.getLedger({
        carrier: carrierFilter || undefined,
        agent_id: agentFilter || undefined,
        product: productFilter || undefined,
        status: statusFilter,
        page,
        limit: 50,
      }),
  });

  // Memoize the unwrapped items list so the search filter below
  // doesn't re-fire on every render (the `?? []` allocates fresh
  // when query.data is undefined).
  const items = React.useMemo(
    () => query.data?.items ?? [],
    [query.data],
  );
  const total = query.data?.total ?? 0;
  const pages = query.data?.pages ?? 1;
  const loading = query.isLoading;

  // Client-name search filters the current page only. The backend
  // doesn't accept a free-text client search param on /ledger yet;
  // when it does we should swap this for a server-side filter so
  // pagination respects the match set.
  const filtered = React.useMemo(() => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter((r) =>
      (r.client_name || "").toLowerCase().includes(q),
    );
  }, [items, search]);

  function clearFilters() {
    setCarrierFilter("");
    setAgentFilter("");
    setProductFilter("");
    setStatusFilter("all");
    setSearch("");
    setPage(1);
  }

  function exportCsv() {
    if (filtered.length === 0) {
      toast.message("Nothing to export.");
      return;
    }
    downloadCsv(`ledger_${Date.now()}.csv`, filtered, [
      { label: "Submission Date", get: (r) => r.submission_date ?? "" },
      { label: "Agent", get: (r) => r.agent_name ?? "" },
      { label: "Client", get: (r) => r.client_name ?? "" },
      { label: "Carrier", get: (r) => r.carrier ?? "" },
      { label: "Product", get: (r) => r.product_type ?? "" },
      { label: "Monthly Premium", get: (r) => r.monthly_premium },
      { label: "Expected", get: (r) => r.expected_commission },
      { label: "Received", get: (r) => r.received_commission ?? "" },
      { label: "Gap", get: (r) => r.gap_amount },
      { label: "Status", get: (r) => r.status },
    ]);
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-2">
          <FilterField label="Carrier">
            <Input
              value={carrierFilter}
              onChange={(e) => setCarrierFilter(e.target.value)}
              placeholder="Any"
              className="w-36 h-9"
              data-testid="ledger-carrier"
            />
          </FilterField>
          <FilterField label="Agent ID">
            <Input
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              placeholder="Any"
              className="w-36 h-9"
            />
          </FilterField>
          <FilterField label="Product">
            <Input
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              placeholder="MA, PDP…"
              className="w-32 h-9"
            />
          </FilterField>
          <FilterField label="Status">
            <Select
              value={statusFilter}
              onValueChange={(v) =>
                setStatusFilter(v as LedgerStatus | "all")
              }
            >
              <SelectTrigger className="w-36 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <div className="flex-1 min-w-[180px]">
            <Label className="text-[10px] uppercase tracking-widest">
              Client search (current page)
            </Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client name"
              className="h-9"
              data-testid="ledger-search"
            />
          </div>
          <Button variant="outline" size="sm" onClick={clearFilters}>
            <Filter className="w-3.5 h-3.5 mr-1" /> Clear
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={!filtered.length}
            data-testid="ledger-export"
          >
            <Download className="w-3.5 h-3.5 mr-1" /> Export CSV
          </Button>
        </CardContent>
      </Card>

      {/* Ledger table */}
      <Card>
        <CardContent className="p-0">
          <div className="px-4 pt-4 pb-2 text-xs text-muted-foreground">
            Commission Ledger — {total.toLocaleString()} record
            {total === 1 ? "" : "s"}
          </div>
          <div className="overflow-x-auto">
            {loading && items.length === 0 ? (
              <div className="p-6">
                <Skeleton className="h-32 w-full" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground p-6 text-center">
                No commission records match these filters.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Premium</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Gap</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r, i) => {
                    const key = `${r.policy_id ?? r.client_name ?? "row"}-${i}`;
                    return (
                      <LedgerRowView
                        key={key}
                        row={r}
                        rowKey={key}
                        expanded={expanded === key}
                        onToggle={() =>
                          setExpanded((prev) => (prev === key ? null : key))
                        }
                      />
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          Page {page} of {pages} · {total.toLocaleString()} records
        </div>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            data-testid="ledger-prev"
          >
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages || loading}
            onClick={() => setPage((p) => p + 1)}
            data-testid="ledger-next"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-[10px] uppercase tracking-widest">{label}</Label>
      {children}
    </div>
  );
}

function LedgerRowView({
  row,
  rowKey,
  expanded,
  onToggle,
}: {
  row: LedgerRow;
  rowKey: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-secondary/40"
        onClick={onToggle}
        data-testid={`ledger-row-${rowKey}`}
      >
        <TableCell className="text-xs">{fmtDate(row.submission_date)}</TableCell>
        <TableCell className="text-xs">{row.agent_name ?? "—"}</TableCell>
        <TableCell className="text-xs">{row.client_name ?? "—"}</TableCell>
        <TableCell className="text-xs">{row.carrier ?? "—"}</TableCell>
        <TableCell className="text-xs">{row.product_type ?? "—"}</TableCell>
        <TableCell className="text-xs text-right tabular-nums">
          {fmt(row.annual_premium)}
        </TableCell>
        <TableCell className="text-xs text-right tabular-nums">
          {fmt(row.expected_commission)}
        </TableCell>
        <TableCell className="text-xs text-right tabular-nums">
          {row.received_commission == null ? "—" : fmt(row.received_commission)}
        </TableCell>
        <TableCell className="text-xs text-right tabular-nums">
          {fmt(row.gap_amount)}
        </TableCell>
        <TableCell>
          <LedgerStatusBadge status={row.status} />
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={10} className="bg-secondary/30">
            <div className="flex flex-wrap gap-2 py-1">
              <span className="text-[11px] text-muted-foreground">
                Policy {row.policy_id || "—"} · effective{" "}
                {fmtDate(row.effective_date)}
              </span>
              {row.status === "gap" || row.status === "underpaid" ? (
                <Button size="sm" variant="outline" className="h-7 text-xs">
                  Create Dispute
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" className="h-7 text-xs">
                View Client Profile
              </Button>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
