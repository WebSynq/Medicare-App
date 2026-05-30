"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  CalendarPlus,
  CalendarRange,
  CheckCircle2,
  ChevronRight,
  Inbox,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  appointments as appointmentsApi,
  isApiError,
  leads as leadsApi,
} from "@/lib/api";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import type {
  Appointment,
  AppointmentOutcome,
  AppointmentStatus,
  AppointmentType,
  BookingType,
  Lead,
} from "@/types";

// ─── Constants ─────────────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: AppointmentStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "no_show", label: "No show" },
  { value: "cancelled", label: "Cancelled" },
];

const BOOKING_TYPE_OPTIONS: { value: BookingType | "all"; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "autobook", label: "Autobook" },
  { value: "va", label: "VA booked" },
  { value: "ae", label: "AE booked" },
  { value: "manual", label: "Self booked" },
];

const APPT_TYPE_OPTIONS: { value: AppointmentType; label: string }[] = [
  { value: "initial_consultation", label: "Initial consultation" },
  { value: "plan_review", label: "Plan review" },
  { value: "enrollment", label: "Enrollment" },
  { value: "annual_review", label: "Annual review" },
  { value: "follow_up", label: "Follow-up" },
  { value: "other", label: "Other" },
];

const STATUS_TINT: Record<AppointmentStatus, string> = {
  scheduled: "bg-primary/15 text-primary ring-primary/30",
  completed: "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30",
  no_show: "bg-destructive/15 text-destructive ring-destructive/30",
  cancelled: "bg-muted text-muted-foreground ring-border",
};

const BOOKING_TINT: Record<BookingType, string> = {
  // Color spec from the Calendar phase: green=autobook, purple=VA,
  // orange=AE, gray=self booked (manual).
  autobook: "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30",
  va: "bg-chart-4/20 text-chart-4 ring-chart-4/30",
  ae: "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30",
  manual: "bg-muted text-muted-foreground ring-border",
};

const OUTCOME_TINT: Record<AppointmentOutcome, string> = {
  sold: "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30",
  showed: "bg-primary/15 text-primary ring-primary/30",
  not_sold: "bg-muted text-muted-foreground ring-border",
  no_show: "bg-destructive/15 text-destructive ring-destructive/30",
};

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const APPT_TYPE_LABEL: Record<string, string> = APPT_TYPE_OPTIONS.reduce(
  (acc, t) => ({ ...acc, [t.value]: t.label }),
  {} as Record<string, string>,
);

function statusLabel(s: AppointmentStatus): string {
  return s === "no_show" ? "No Show" : s.charAt(0).toUpperCase() + s.slice(1);
}

function outcomeLabel(o: AppointmentOutcome): string {
  switch (o) {
    case "no_show":
      return "No Show";
    case "not_sold":
      return "Not Sold";
    default:
      return o.charAt(0).toUpperCase() + o.slice(1);
  }
}

function bookingLabel(b: BookingType): string {
  switch (b) {
    case "va":
      return "VA";
    case "ae":
      return "AE";
    case "autobook":
      return "Autobook";
    case "manual":
      return "Self";
  }
}

function formatLocalDateTime(date: string, time: string): string {
  try {
    const d = new Date(`${date}T${time}:00`);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return `${date} ${time}`;
  }
}

function shortDate(date: string): string {
  try {
    return new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return date;
  }
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function AppointmentsPage() {
  const [statusFilter, setStatusFilter] = React.useState<
    AppointmentStatus | "all"
  >("all");
  const [bookingFilter, setBookingFilter] = React.useState<
    BookingType | "all"
  >("all");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Appointment | null>(null);
  const [cancelling, setCancelling] = React.useState<Appointment | null>(null);

  const params = React.useMemo(
    () => ({
      ...(statusFilter !== "all" ? { status: statusFilter } : {}),
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      limit: 500,
    }),
    [statusFilter, startDate, endDate],
  );

  const apptsQuery = useQuery({
    queryKey: ["appointments", "list", params],
    queryFn: () => appointmentsApi.listAppointments(params),
    placeholderData: keepPreviousData,
  });

  // booking_type isn't a server-side filter (the backend doesn't
  // index on it yet) — filter client-side after the fetch. The list
  // is already capped at 500 rows so the work is negligible.
  const rows = React.useMemo(() => {
    const all = apptsQuery.data?.appointments ?? [];
    if (bookingFilter === "all") return all;
    return all.filter((a) => a.booking_type === bookingFilter);
  }, [apptsQuery.data, bookingFilter]);

  function clearFilters() {
    setStatusFilter("all");
    setBookingFilter("all");
    setStartDate("");
    setEndDate("");
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Appointments</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every booking on your calendar — past, present, and future.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New appointment
        </Button>
      </header>

      <ImpersonationBanner />

      <RevenueStatsBar />

      <Card>
        <CardContent className="p-3 md:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={statusFilter}
              onValueChange={(v) =>
                setStatusFilter(v as AppointmentStatus | "all")
              }
            >
              <SelectTrigger className="h-9 w-[180px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={bookingFilter}
              onValueChange={(v) =>
                setBookingFilter(v as BookingType | "all")
              }
            >
              <SelectTrigger className="h-9 w-[180px]">
                <SelectValue placeholder="Booking source" />
              </SelectTrigger>
              <SelectContent>
                {BOOKING_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <DateRangePopover
              start={startDate}
              end={endDate}
              onStart={setStartDate}
              onEnd={setEndDate}
            />

            {(statusFilter !== "all" ||
              bookingFilter !== "all" ||
              startDate ||
              endDate) ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="text-xs h-9"
              >
                <X className="h-3 w-3 mr-1" />
                Clear filters
              </Button>
            ) : null}

            <div className="ml-auto text-xs text-muted-foreground tabular-nums">
              {apptsQuery.isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <>
                  {rows.length}
                  {bookingFilter !== "all" &&
                  rows.length !== (apptsQuery.data?.total ?? 0) ? (
                    <> of {apptsQuery.data?.total ?? 0}</>
                  ) : null}{" "}
                  appointment{rows.length === 1 ? "" : "s"}
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <AppointmentsTable
        rows={rows}
        loading={apptsQuery.isLoading}
        onEdit={(a) => setEditing(a)}
        onCancel={(a) => setCancelling(a)}
      />

      <CreateAppointmentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <EditAppointmentDialog
        appointment={editing}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <CancelAppointmentDialog
        appointment={cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
      />
    </div>
  );
}

// ─── Revenue stats bar ─────────────────────────────────────────────────────

function RevenueStatsBar() {
  const [period, setPeriod] = React.useState<"mtd" | "ytd" | "last30" | "last90" | "all">(
    "mtd",
  );
  const q = useQuery({
    queryKey: ["appointments", "revenue-stats", period],
    queryFn: () => appointmentsApi.getRevenueStats(period),
  });

  return (
    <Card className="border-border/70">
      <CardContent className="p-4 md:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Revenue</h2>
          </div>
          <Select value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mtd">Month-to-date</SelectItem>
              <SelectItem value="ytd">Year-to-date</SelectItem>
              <SelectItem value="last30">Last 30 days</SelectItem>
              <SelectItem value="last90">Last 90 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {q.isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : q.data ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile
              label="Booked"
              value={String(q.data.total_appointments)}
              hint={`${q.data.completed_appointments} completed`}
            />
            <StatTile
              label="Total est."
              value={USD.format(q.data.total_estimated_commission)}
              hint={`${q.data.appointments_with_commission} estimated`}
              accent
            />
            <StatTile
              label="Avg per appt"
              value={USD.format(q.data.avg_commission_per_appointment)}
            />
            <StatTile
              label="Avg per completed"
              value={USD.format(q.data.avg_commission_per_completed)}
              hint={
                q.data.top_appointment
                  ? `Top: ${q.data.top_appointment.client_name ?? "—"}`
                  : undefined
              }
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatTile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-md bg-secondary/30 p-3 border border-border/40">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "text-lg font-bold tabular-nums mt-0.5",
          accent ? "text-primary" : "",
        )}
      >
        {value}
      </div>
      {hint ? (
        <div className="text-[10px] text-muted-foreground truncate mt-0.5">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// ─── Date range popover ────────────────────────────────────────────────────

function DateRangePopover({
  start,
  end,
  onStart,
  onEnd,
}: {
  start: string;
  end: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
}) {
  const label = start || end
    ? `${start || "Any"} → ${end || "Any"}`
    : "Date range";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 text-xs">
          <CalendarRange className="h-3.5 w-3.5 mr-1.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="start">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">From</Label>
          <Input
            type="date"
            value={start}
            onChange={(e) => onStart(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">To</Label>
          <Input
            type="date"
            value={end}
            onChange={(e) => onEnd(e.target.value)}
            className="h-9"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Table ─────────────────────────────────────────────────────────────────

function AppointmentsTable({
  rows,
  loading,
  onEdit,
  onCancel,
}: {
  rows: Appointment[];
  loading: boolean;
  onEdit: (a: Appointment) => void;
  onCancel: (a: Appointment) => void;
}) {
  const router = useRouter();
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "when", desc: false },
  ]);

  const columns = React.useMemo<ColumnDef<Appointment>[]>(
    () => [
      {
        id: "client",
        header: "Client",
        accessorKey: "client_name",
        cell: ({ row }) => {
          const a = row.original;
          return (
            <div className="min-w-0">
              {a.lead_id ? (
                <Link
                  href={`/clients/${a.lead_id}`}
                  className="font-medium text-sm hover:text-primary truncate block"
                >
                  {a.client_name || "—"}
                </Link>
              ) : (
                <span className="font-medium text-sm truncate block">
                  {a.client_name || "—"}{" "}
                  <span className="text-[10px] text-muted-foreground">
                    walk-in
                  </span>
                </span>
              )}
              {a.client_email ? (
                <div className="text-[11px] text-muted-foreground truncate">
                  {a.client_email}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "when",
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1 text-left"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Date / time
            <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        accessorFn: (a) => `${a.appointment_date}T${a.appointment_time}`,
        cell: ({ row }) => {
          const a = row.original;
          return (
            <span className="text-sm tabular-nums whitespace-nowrap">
              {formatLocalDateTime(a.appointment_date, a.appointment_time)}
            </span>
          );
        },
      },
      {
        id: "type",
        header: "Type",
        accessorKey: "type",
        cell: ({ row }) => (
          <Badge variant="outline" className="text-[10px] capitalize">
            {APPT_TYPE_LABEL[row.original.type] ?? row.original.type}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorKey: "status",
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase tracking-wider ring-1",
              STATUS_TINT[row.original.status],
            )}
          >
            {statusLabel(row.original.status)}
          </Badge>
        ),
      },
      {
        id: "outcome",
        header: "Outcome",
        accessorKey: "outcome",
        cell: ({ row }) => {
          const o = row.original.outcome;
          if (!o) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          const isEnum = (
            ["showed", "no_show", "sold", "not_sold"] as const
          ).includes(o as AppointmentOutcome);
          if (!isEnum) {
            return <span className="text-xs truncate">{o}</span>;
          }
          return (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] uppercase tracking-wider ring-1",
                OUTCOME_TINT[o as AppointmentOutcome],
              )}
            >
              {outcomeLabel(o as AppointmentOutcome)}
            </Badge>
          );
        },
      },
      {
        id: "booking_type",
        header: "Source",
        accessorKey: "booking_type",
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase tracking-wider ring-1",
              BOOKING_TINT[row.original.booking_type],
            )}
          >
            {bookingLabel(row.original.booking_type)}
          </Badge>
        ),
      },
      {
        id: "agent",
        header: "Agent",
        accessorKey: "agent_name",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground truncate">
            {row.original.agent_name || "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const a = row.original;
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel className="text-xs">
                    Actions
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onEdit(a)}>
                    Edit / Outcome
                  </DropdownMenuItem>
                  {a.lead_id ? (
                    <DropdownMenuItem
                      onClick={() => router.push(`/clients/${a.lead_id}`)}
                    >
                      View client
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onCancel(a)}
                    className="text-destructive focus:text-destructive"
                    disabled={a.status === "cancelled"}
                  >
                    Cancel appointment
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [onEdit, onCancel, router],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (loading) {
    return (
      <Card>
        <CardContent className="p-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium text-sm">No appointments match.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Loosen the filters or book a new appointment.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <Card className="overflow-hidden hidden md:block">
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
                      : flexRender(h.column.columnDef.header, h.getContext())}
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
                  <td key={cell.id} className="px-3 py-3 align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {rows.map((a) => (
          <MobileAppointmentCard
            key={a.appointment_id}
            appointment={a}
            onEdit={() => onEdit(a)}
            onCancel={() => onCancel(a)}
          />
        ))}
      </div>
    </>
  );
}

function MobileAppointmentCard({
  appointment: a,
  onEdit,
  onCancel,
}: {
  appointment: Appointment;
  onEdit: () => void;
  onCancel: () => void;
}) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {a.lead_id ? (
              <Link
                href={`/clients/${a.lead_id}`}
                className="font-semibold text-sm hover:text-primary truncate block"
              >
                {a.client_name || "—"}
              </Link>
            ) : (
              <span className="font-semibold text-sm truncate block">
                {a.client_name || "—"}
              </span>
            )}
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {formatLocalDateTime(a.appointment_date, a.appointment_time)}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                Edit / Outcome
              </DropdownMenuItem>
              {a.lead_id ? (
                <DropdownMenuItem asChild>
                  <Link href={`/clients/${a.lead_id}`}>View client</Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onCancel}
                className="text-destructive focus:text-destructive"
                disabled={a.status === "cancelled"}
              >
                Cancel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase tracking-wider ring-1",
              STATUS_TINT[a.status],
            )}
          >
            {statusLabel(a.status)}
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase tracking-wider ring-1",
              BOOKING_TINT[a.booking_type],
            )}
          >
            {bookingLabel(a.booking_type)}
          </Badge>
          <Badge variant="outline" className="text-[10px] capitalize">
            {APPT_TYPE_LABEL[a.type] ?? a.type}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Create dialog ─────────────────────────────────────────────────────────

function CreateAppointmentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<"linked" | "walkin">("linked");
  const [selectedLead, setSelectedLead] = React.useState<Lead | null>(null);
  const [walkInName, setWalkInName] = React.useState("");
  const [walkInEmail, setWalkInEmail] = React.useState("");
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [duration, setDuration] = React.useState(30);
  const [type, setType] = React.useState<AppointmentType>("initial_consultation");
  const [meetingType, setMeetingType] = React.useState<"phone" | "video" | "">("");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setMode("linked");
      setSelectedLead(null);
      setWalkInName("");
      setWalkInEmail("");
      setDate("");
      setTime("");
      setDuration(30);
      setType("initial_consultation");
      setMeetingType("");
      setNotes("");
    }
  }, [open]);

  const createMutation = useMutation({
    mutationFn: () => {
      const payload: Parameters<typeof appointmentsApi.createAppointment>[0] = {
        appointment_date: date,
        appointment_time: time,
        duration_minutes: duration,
        type,
        ...(notes ? { notes } : {}),
        ...(meetingType ? { meeting_type: meetingType } : {}),
      };
      if (mode === "linked") {
        if (!selectedLead) {
          throw new Error("Pick a client first");
        }
        payload.lead_id = selectedLead.id;
      } else {
        payload.client_name = walkInName.trim();
        if (walkInEmail.trim()) payload.client_email = walkInEmail.trim();
      }
      return appointmentsApi.createAppointment(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success("Appointment booked.");
      onOpenChange(false);
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Couldn't create.";
      toast.error(msg);
    },
  });

  const canSubmit =
    !!date &&
    !!time &&
    duration > 0 &&
    (mode === "linked" ? !!selectedLead : walkInName.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New appointment</DialogTitle>
          <DialogDescription>
            Book a slot on your calendar. Walk-ins skip the lead pick.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={mode === "linked" ? "default" : "outline"}
              onClick={() => setMode("linked")}
              className="flex-1"
            >
              Existing client
            </Button>
            <Button
              size="sm"
              variant={mode === "walkin" ? "default" : "outline"}
              onClick={() => setMode("walkin")}
              className="flex-1"
            >
              Walk-in
            </Button>
          </div>

          {mode === "linked" ? (
            <LeadTypeahead
              selected={selectedLead}
              onSelect={setSelectedLead}
            />
          ) : (
            <>
              <Field label="Client name">
                <Input
                  value={walkInName}
                  onChange={(e) => setWalkInName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Email (optional)">
                <Input
                  type="email"
                  value={walkInEmail}
                  onChange={(e) => setWalkInEmail(e.target.value)}
                  placeholder="jane@example.com"
                />
              </Field>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Time">
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
            <Field label="Duration (min)">
              <Input
                type="number"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value) || 30)}
                min={5}
                max={480}
              />
            </Field>
            <Field label="Type">
              <Select
                value={type}
                onValueChange={(v) => setType(v as AppointmentType)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPT_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Meeting type">
            <Select
              value={meetingType || "_unset"}
              onValueChange={(v) =>
                setMeetingType(v === "_unset" ? "" : (v as "phone" | "video"))
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_unset">—</SelectItem>
                <SelectItem value="phone">Phone</SelectItem>
                <SelectItem value="video">Video</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Notes (optional)">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <CalendarPlus className="h-3.5 w-3.5 mr-1.5" />
            )}
            Book
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ─── Lead typeahead (for the create dialog) ────────────────────────────────

function LeadTypeahead({
  selected,
  onSelect,
}: {
  selected: Lead | null;
  onSelect: (lead: Lead | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const debounced = useDebouncedValue(query, 250);
  const searchQuery = useQuery({
    queryKey: ["leads", "typeahead", debounced],
    queryFn: () =>
      leadsApi.listLeads({ q: debounced, limit: 12 }),
    enabled: open && debounced.trim().length > 1,
  });

  if (selected) {
    return (
      <div className="rounded-md border border-border bg-secondary/40 p-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm">
            {selected.first_name} {selected.last_name}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {selected.email || selected.phone || "—"}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onSelect(null)}
          className="h-7 text-xs"
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">Client</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-start text-xs text-muted-foreground h-9"
          >
            <Search className="h-3.5 w-3.5 mr-1.5" />
            Search clients…
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[340px] p-2" align="start">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, email, or phone"
            className="h-9"
            autoFocus
          />
          <div className="mt-2 max-h-72 overflow-y-auto">
            {searchQuery.isFetching ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (searchQuery.data?.leads ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                {debounced.trim().length > 1
                  ? "No matches."
                  : "Type to search."}
              </p>
            ) : (
              <ul className="space-y-1">
                {searchQuery.data?.leads.map((lead) => (
                  <li key={lead.id}>
                    <button
                      onClick={() => {
                        onSelect(lead);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-secondary text-sm"
                    >
                      <div className="font-medium truncate">
                        {lead.first_name} {lead.last_name}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {lead.email || lead.phone || "—"}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── Edit / outcome dialog ─────────────────────────────────────────────────

const OUTCOME_BUTTONS: { value: AppointmentOutcome; label: string }[] = [
  { value: "showed", label: "Showed" },
  { value: "no_show", label: "No Show" },
  { value: "sold", label: "Sold" },
  { value: "not_sold", label: "Not Sold" },
];

function EditAppointmentDialog({
  appointment,
  onOpenChange,
}: {
  appointment: Appointment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [duration, setDuration] = React.useState(30);
  const [status, setStatus] = React.useState<AppointmentStatus>("scheduled");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (appointment) {
      setDate(appointment.appointment_date);
      setTime(appointment.appointment_time);
      setDuration(appointment.duration_minutes);
      setStatus(appointment.status);
      setNotes(appointment.notes ?? "");
    }
  }, [appointment]);

  const patchMutation = useMutation({
    mutationFn: () => {
      if (!appointment) throw new Error("no appointment");
      const payload: Parameters<typeof appointmentsApi.patchAppointment>[1] = {};
      if (date !== appointment.appointment_date) payload.appointment_date = date;
      if (duration !== appointment.duration_minutes)
        payload.duration_minutes = duration;
      if (status !== appointment.status) payload.status = status;
      const trimmedNotes = (notes ?? "").trim();
      const existingNotes = (appointment.notes ?? "").trim();
      if (trimmedNotes !== existingNotes) payload.notes = trimmedNotes;
      return appointmentsApi.patchAppointment(appointment.appointment_id, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success("Saved.");
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Save failed."),
  });

  const outcomeMutation = useMutation({
    mutationFn: (outcome: AppointmentOutcome) => {
      if (!appointment) throw new Error("no appointment");
      return appointmentsApi.setAppointmentOutcome(appointment.appointment_id, {
        outcome,
      });
    },
    onSuccess: (data, outcome) => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success(`Marked ${outcomeLabel(outcome)}.`);
      if (outcome === "sold" && data.lead_id) {
        router.push(`/applications?lead_id=${data.lead_id}`);
      }
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Couldn't set outcome."),
  });

  return (
    <Dialog open={!!appointment} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {appointment?.client_name || "Appointment"}
          </DialogTitle>
          <DialogDescription>
            {appointment
              ? `Currently ${statusLabel(appointment.status)} · ${
                  bookingLabel(appointment.booking_type)
                } booking`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {appointment ? (
          <div className="space-y-4">
            <div>
              <Label className="text-[11px] text-muted-foreground">
                Outcome
              </Label>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                {OUTCOME_BUTTONS.map((b) => (
                  <Button
                    key={b.value}
                    variant={
                      appointment.outcome === b.value ? "default" : "outline"
                    }
                    size="sm"
                    onClick={() => outcomeMutation.mutate(b.value)}
                    disabled={outcomeMutation.isPending}
                    className={cn(
                      "text-xs",
                      b.value === "sold" &&
                        appointment.outcome !== "sold" &&
                        "border-ghw-forest/40 text-ghw-forest hover:bg-ghw-forest/10",
                      b.value === "no_show" &&
                        appointment.outcome !== "no_show" &&
                        "border-destructive/40 text-destructive hover:bg-destructive/10",
                    )}
                  >
                    {outcomeMutation.isPending &&
                    outcomeMutation.variables === b.value ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                    )}
                    {b.label}
                  </Button>
                ))}
              </div>
              {appointment.outcome === "sold" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs mt-2 w-full"
                  onClick={() =>
                    appointment.lead_id &&
                    router.push(`/applications?lead_id=${appointment.lead_id}`)
                  }
                  disabled={!appointment.lead_id}
                >
                  <ChevronRight className="h-3 w-3 mr-1" />
                  Go to application
                </Button>
              ) : null}
            </div>

            <div className="border-t border-border pt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date">
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
                <Field label="Time">
                  <Input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    disabled
                  />
                </Field>
                <Field label="Duration (min)">
                  <Input
                    type="number"
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value) || 30)}
                    min={5}
                    max={480}
                  />
                </Field>
                <Field label="Status">
                  <Select
                    value={status}
                    onValueChange={(v) => setStatus(v as AppointmentStatus)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.filter((o) => o.value !== "all").map(
                        (o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Notes">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                />
              </Field>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={() => patchMutation.mutate()}
            disabled={patchMutation.isPending}
          >
            {patchMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Cancel confirm dialog ─────────────────────────────────────────────────

function CancelAppointmentDialog({
  appointment,
  onOpenChange,
}: {
  appointment: Appointment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      if (!appointment) throw new Error("no appointment");
      return appointmentsApi.cancelAppointment(appointment.appointment_id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success("Appointment cancelled.");
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Cancel failed."),
  });

  return (
    <Dialog open={!!appointment} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cancel appointment?</DialogTitle>
          <DialogDescription>
            {appointment
              ? `${appointment.client_name} on ${shortDate(
                  appointment.appointment_date,
                )} at ${appointment.appointment_time}. This is a soft cancel — the row stays in your history.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            )}
            Cancel appointment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
