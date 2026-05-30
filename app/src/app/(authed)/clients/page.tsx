"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  type Row,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Filter,
  Inbox,
  Search,
  Sparkles,
  Tag as TagIcon,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { leads as leadsApi } from "@/lib/api";
import type { Lead, LeadStatus } from "@/types";

// ─── Constants ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

const STATUS_OPTIONS: { value: LeadStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "appointment_set", label: "Appointment set" },
  { value: "enrolled", label: "Enrolled" },
  { value: "lost", label: "Lost" },
  { value: "not_interested", label: "Not interested" },
  { value: "do_not_contact", label: "Do not contact" },
];

const STATUS_BADGE: Record<LeadStatus, string> = {
  new: "bg-primary/15 text-primary ring-primary/30",
  contacted: "bg-chart-4/15 text-chart-4 ring-chart-4/30",
  qualified: "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30",
  appointment_set: "bg-ghw-copper/20 text-ghw-copper ring-ghw-copper/30",
  enrolled: "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30",
  lost: "bg-muted text-muted-foreground ring-border",
  not_interested: "bg-muted text-muted-foreground ring-border",
  do_not_contact: "bg-destructive/15 text-destructive ring-destructive/30",
};

// ─── AI score → color ──────────────────────────────────────────────────────
// Spec: 0-39 red, 40-69 amber, 70-100 green.

function scoreTint(score: number | null): string {
  if (score == null) return "bg-muted text-muted-foreground ring-border";
  if (score >= 70) return "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30";
  if (score >= 40)
    return "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30";
  return "bg-destructive/15 text-destructive ring-destructive/30";
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function leadFullName(l: Lead): string {
  const name = `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim();
  return name || l.email || "—";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  if (Number.isNaN(diffMs)) return "—";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function statusLabel(s: LeadStatus): string {
  return s.replace(/_/g, " ");
}

// ─── Filters state ────────────────────────────────────────────────────────

interface FiltersState {
  search: string;
  status: LeadStatus | "all";
  tags: string[];
  skip: number;
}

const INITIAL_FILTERS: FiltersState = {
  search: "",
  status: "all",
  tags: [],
  skip: 0,
};

// ─── Page ─────────────────────────────────────────────────────────────────

export default function ClientsPage() {
  const router = useRouter();
  const [filters, setFilters] = React.useState<FiltersState>(INITIAL_FILTERS);
  const debouncedSearch = useDebouncedValue(filters.search, 300);

  // Resetting skip when filter inputs change so a page-2 user
  // doesn't get an empty page when narrowing the result set.
  React.useEffect(() => {
    setFilters((prev) =>
      prev.skip === 0 ? prev : { ...prev, skip: 0 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filters.status, filters.tags.join(",")]);

  const query = useQuery({
    queryKey: [
      "leads",
      "list",
      {
        q: debouncedSearch,
        status: filters.status,
        tags: filters.tags,
        skip: filters.skip,
      },
    ],
    queryFn: () =>
      leadsApi.listLeads({
        q: debouncedSearch || undefined,
        status: filters.status === "all" ? undefined : filters.status,
        tags: filters.tags.length > 0 ? filters.tags : undefined,
        limit: PAGE_SIZE,
        skip: filters.skip,
      }),
    placeholderData: keepPreviousData,
  });

  const rows: Lead[] = query.data?.leads ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(filters.skip / PAGE_SIZE) + 1;
  const isLoading = query.isLoading;
  const isFetching = query.isFetching && !query.isLoading;

  const handleRowClick = React.useCallback(
    (lead: Lead) => router.push(`/clients/${lead.id}`),
    [router],
  );

  return (
    <div className="p-4 md:p-8 max-w-[1600px] mx-auto">
      {/* Header */}
      <header className="mb-5 md:mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-eyebrow">CRM</span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-display">
              Clients
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isLoading
                ? "Loading…"
                : `${total.toLocaleString()} record${total === 1 ? "" : "s"}`}
              {isFetching ? " · refreshing" : null}
            </p>
          </div>
        </div>
      </header>

      <FiltersBar filters={filters} setFilters={setFilters} />

      {/* Desktop table */}
      <div className="hidden md:block">
        <LeadsTable
          rows={rows}
          loading={isLoading}
          onRowClick={handleRowClick}
        />
      </div>

      {/* Mobile cards */}
      <div className="md:hidden mt-4">
        <LeadsCardList
          rows={rows}
          loading={isLoading}
          onRowClick={handleRowClick}
        />
      </div>

      <PaginationBar
        page={currentPage}
        totalPages={totalPages}
        total={total}
        loadedCount={rows.length}
        onPrev={() =>
          setFilters((p) => ({
            ...p,
            skip: Math.max(0, p.skip - PAGE_SIZE),
          }))
        }
        onNext={() =>
          setFilters((p) => ({
            ...p,
            skip: Math.min((totalPages - 1) * PAGE_SIZE, p.skip + PAGE_SIZE),
          }))
        }
        disabled={isLoading}
      />
    </div>
  );
}

// ─── Filters bar ──────────────────────────────────────────────────────────

function FiltersBar({
  filters,
  setFilters,
}: {
  filters: FiltersState;
  setFilters: React.Dispatch<React.SetStateAction<FiltersState>>;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 mb-4"
      data-testid="clients-filters"
    >
      {/* Search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search by name, email, phone, MBI…"
          value={filters.search}
          onChange={(e) =>
            setFilters((p) => ({ ...p, search: e.target.value }))
          }
          className="pl-9"
        />
      </div>

      {/* Status */}
      <Select
        value={filters.status}
        onValueChange={(v) =>
          setFilters((p) => ({ ...p, status: v as LeadStatus | "all" }))
        }
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Tags */}
      <TagFilterPopover
        tags={filters.tags}
        onChange={(tags) => setFilters((p) => ({ ...p, tags }))}
      />

      {/* Reset */}
      {(filters.search ||
        filters.status !== "all" ||
        filters.tags.length > 0) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters(INITIAL_FILTERS)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4 mr-1" />
          Reset
        </Button>
      )}
    </div>
  );
}

function TagFilterPopover({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = React.useState("");

  function add() {
    const next = input.trim().toLowerCase();
    if (!next || tags.includes(next)) return;
    onChange([...tags, next]);
    setInput("");
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <TagIcon className="h-4 w-4" />
          Tags
          {tags.length > 0 ? (
            <Badge variant="secondary" className="ml-1 px-1.5">
              {tags.length}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] space-y-3">
        <div className="space-y-2">
          <Label htmlFor="tag-input" className="text-xs">
            Filter by tag
          </Label>
          <div className="flex gap-2">
            <Input
              id="tag-input"
              placeholder="hot-lead"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              className="h-8"
            />
            <Button size="sm" onClick={add} disabled={!input.trim()}>
              Add
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Leads must carry ALL selected tags.
          </p>
        </div>
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border/60">
            {tags.map((t) => (
              <Badge
                key={t}
                variant="secondary"
                className="gap-1 cursor-pointer hover:bg-secondary/80"
                onClick={() => onChange(tags.filter((x) => x !== t))}
              >
                {t}
                <X className="h-3 w-3" />
              </Badge>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ─── Desktop table (TanStack + virtualization) ─────────────────────────────

function LeadsTable({
  rows,
  loading,
  onRowClick,
}: {
  rows: Lead[];
  loading: boolean;
  onRowClick: (lead: Lead) => void;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [selection, setSelection] = React.useState<Record<string, boolean>>({});

  const columns = React.useMemo<ColumnDef<Lead>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
            aria-label={`Select ${leadFullName(row.original)}`}
          />
        ),
        enableSorting: false,
        size: 40,
      },
      {
        id: "ai_score",
        accessorKey: "ai_score",
        header: ({ column }) => (
          <ColHeader column={column} label="AI" align="center" />
        ),
        cell: ({ row }) => {
          const score = row.original.ai_score;
          return (
            <div className="flex justify-center">
              <span
                className={cn(
                  "inline-flex items-center justify-center w-9 h-7 rounded-full text-[11px] font-semibold tabular-nums ring-1",
                  scoreTint(score),
                )}
                title={row.original.ai_score_reason ?? undefined}
              >
                {score ?? "—"}
              </span>
            </div>
          );
        },
        sortingFn: (a, b) =>
          (a.original.ai_score ?? -1) - (b.original.ai_score ?? -1),
        size: 70,
      },
      {
        id: "name",
        accessorFn: (lead) => leadFullName(lead),
        header: ({ column }) => <ColHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">
              {leadFullName(row.original)}
            </div>
            {row.original.email ? (
              <div className="text-[11px] text-muted-foreground truncate">
                {row.original.email}
              </div>
            ) : null}
          </div>
        ),
        size: 220,
      },
      {
        accessorKey: "phone",
        header: ({ column }) => <ColHeader column={column} label="Phone" />,
        cell: ({ row }) => (
          <span className="tabular-nums text-sm text-muted-foreground">
            {row.original.phone ?? "—"}
          </span>
        ),
        size: 140,
      },
      {
        accessorKey: "state",
        header: ({ column }) => <ColHeader column={column} label="State" />,
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.state ?? "—"}
          </span>
        ),
        size: 70,
      },
      {
        accessorKey: "status",
        header: ({ column }) => <ColHeader column={column} label="Status" />,
        cell: ({ row }) => (
          <StatusBadge status={row.original.status} />
        ),
        size: 130,
      },
      {
        accessorKey: "lead_source",
        header: ({ column }) => <ColHeader column={column} label="Source" />,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground truncate">
            {row.original.lead_source ?? row.original.source ?? "—"}
          </span>
        ),
        size: 130,
      },
      {
        accessorKey: "tags",
        header: () => <span className="text-xs uppercase tracking-widest text-muted-foreground">Tags</span>,
        cell: ({ row }) => <TagCluster tags={row.original.tags ?? []} />,
        enableSorting: false,
        size: 200,
      },
      {
        accessorKey: "updated_at",
        header: ({ column }) => (
          <ColHeader column={column} label="Updated" />
        ),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {relativeTime(row.original.updated_at)}
          </span>
        ),
        size: 110,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <Link
            href={`/clients/${row.original.id}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
            aria-label="View"
          >
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        ),
        enableSorting: false,
        size: 50,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, rowSelection: selection },
    onSortingChange: setSorting,
    onRowSelectionChange: setSelection,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
  });

  const containerRef = React.useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 56,
    overscan: 12,
  });

  if (loading) return <TableSkeleton />;
  if (rows.length === 0) return <EmptyState />;

  const items = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = items.length
    ? totalSize - (items[items.length - 1]?.end ?? 0)
    : 0;

  return (
    <Card className="overflow-hidden">
      <div
        ref={containerRef}
        className="overflow-auto"
        style={{ maxHeight: "calc(100vh - 360px)" }}
      >
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <colgroup>
            {columns.map((c, i) => (
              <col key={i} style={{ width: c.size }} />
            ))}
          </colgroup>
          <thead className="bg-secondary/40 backdrop-blur sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="px-3 py-3 text-left text-xs uppercase tracking-widest text-muted-foreground font-medium"
                  >
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 ? (
              <tr style={{ height: paddingTop }}>
                <td colSpan={columns.length} />
              </tr>
            ) : null}
            {items.map((vRow) => {
              const row = tableRows[vRow.index];
              if (!row) return null;
              return (
                <VirtualRow
                  key={row.id}
                  row={row}
                  onClick={() => onRowClick(row.original)}
                />
              );
            })}
            {paddingBottom > 0 ? (
              <tr style={{ height: paddingBottom }}>
                <td colSpan={columns.length} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function VirtualRow({
  row,
  onClick,
}: {
  row: Row<Lead>;
  onClick: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      data-state={row.getIsSelected() ? "selected" : undefined}
      className={cn(
        "border-b border-border/60 cursor-pointer transition-colors hover:bg-secondary/40",
        row.getIsSelected() ? "bg-primary/5" : "",
      )}
    >
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} className="px-3 py-3 align-middle">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
}

function ColHeader<T>({
  column,
  label,
  align = "left",
}: {
  column: import("@tanstack/react-table").Column<T, unknown>;
  label: string;
  align?: "left" | "center";
}) {
  const sort = column.getIsSorted();
  const canSort = column.getCanSort();
  if (!canSort) {
    return (
      <span className="text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
    );
  }
  return (
    <button
      onClick={() => column.toggleSorting()}
      className={cn(
        "inline-flex items-center gap-1 text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors",
        align === "center" ? "justify-center w-full" : "",
      )}
    >
      {label}
      <ArrowUpDown
        className={cn(
          "h-3 w-3 transition-opacity",
          sort === false ? "opacity-40" : "opacity-100 text-foreground",
        )}
      />
      {sort === "asc" ? <span className="sr-only">ascending</span> : null}
      {sort === "desc" ? <span className="sr-only">descending</span> : null}
    </button>
  );
}

// ─── Mobile card list ─────────────────────────────────────────────────────

function LeadsCardList({
  rows,
  loading,
  onRowClick,
}: {
  rows: Lead[];
  loading: boolean;
  onRowClick: (lead: Lead) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-md" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) return <EmptyState />;
  return (
    <div className="space-y-2">
      {rows.map((lead) => (
        <button
          type="button"
          key={lead.id}
          onClick={() => onRowClick(lead)}
          className="w-full text-left rounded-lg border border-border/70 bg-card hover:bg-secondary/40 transition-colors p-3 active:scale-[0.99]"
        >
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "inline-flex items-center justify-center w-10 h-7 rounded-full text-[11px] font-semibold tabular-nums ring-1 flex-shrink-0",
                scoreTint(lead.ai_score),
              )}
            >
              {lead.ai_score ?? "—"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm truncate">
                  {leadFullName(lead)}
                </span>
                <StatusBadge status={lead.status} />
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                {lead.phone ? (
                  <span className="tabular-nums">{lead.phone}</span>
                ) : null}
                {lead.state ? <span>· {lead.state}</span> : null}
                <span className="ml-auto whitespace-nowrap">
                  {relativeTime(lead.updated_at)}
                </span>
              </div>
              {(lead.tags ?? []).length > 0 ? (
                <div className="mt-1.5">
                  <TagCluster tags={lead.tags} />
                </div>
              ) : null}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Pagination footer ────────────────────────────────────────────────────

function PaginationBar({
  page,
  totalPages,
  total,
  loadedCount,
  onPrev,
  onNext,
  disabled,
}: {
  page: number;
  totalPages: number;
  total: number;
  loadedCount: number;
  onPrev: () => void;
  onNext: () => void;
  disabled: boolean;
}) {
  if (total === 0) return null;
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const noResultsOnPage = loadedCount === 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
      <p className="text-xs text-muted-foreground">
        {noResultsOnPage ? (
          "—"
        ) : (
          <>
            <span className="tabular-nums">
              {from.toLocaleString()}–{to.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="tabular-nums">{total.toLocaleString()}</span>
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={disabled || page <= 1}
        >
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          Page {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={disabled || page >= totalPages}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Pieces ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LeadStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] font-semibold uppercase tracking-wider rounded-full px-2 py-0.5 ring-1 capitalize",
        STATUS_BADGE[status],
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

function TagCluster({ tags }: { tags: string[] }) {
  const visible = tags.slice(0, 3);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((t) => (
        <Badge
          key={t}
          variant="outline"
          className="text-[10px] px-1.5 py-0 h-5 font-normal capitalize"
        >
          {t}
        </Badge>
      ))}
      {overflow > 0 ? (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 h-5 font-normal text-muted-foreground"
        >
          +{overflow}
        </Badge>
      ) : null}
    </div>
  );
}

function TableSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="p-3 space-y-1.5">
        {Array.from({ length: 14 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded" />
        ))}
      </div>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="p-10 md:p-14 text-center">
        <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
        <p className="font-medium text-sm">No leads match.</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          Try widening your filters, or hit{" "}
          <Filter className="h-3 w-3 inline-block" /> Reset to start over.
        </p>
      </CardContent>
    </Card>
  );
}
