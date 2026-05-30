"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
  CalendarRange,
  Inbox,
  Loader2,
  MoreHorizontal,
  Plus,
  TrendingUp,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import { appointments as appointmentsApi } from "@/lib/api";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import {
  bookingLabel,
  CancelAppointmentDialog,
  CreateAppointmentDialog,
  EditAppointmentDialog,
  outcomeLabel,
  statusLabel,
} from "@/components/appointments/dialogs";
import type {
  Appointment,
  AppointmentOutcome,
  AppointmentStatus,
  AppointmentType,
  BookingType,
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
      {/* Section title + description live on the Appointments layout
          now. We keep the action button visible inline at the top of
          the Upcoming page since it's the primary CTA for this tab. */}
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New appointment
        </Button>
      </div>

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

      <CreateAppointmentDialog open={createOpen} onOpenChange={setCreateOpen} />
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
