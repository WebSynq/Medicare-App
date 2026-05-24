import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import {
  CalendarClock,
  Plus,
  ArrowUpRight,
  X as XIcon,
  CalendarDays,
  Search,
  DollarSign,
  CheckCircle2,
  TrendingUp,
  Calendar as CalendarIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ScrollableCard from "@/components/ScrollableCard";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import NewAppointmentSheet from "@/components/NewAppointmentSheet";
import { api } from "@/lib/api";

function fmtMoney(v) {
  if (v == null || Number.isNaN(v)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No Show" },
];

const STATUS_BADGE = {
  scheduled: "bg-emerald-100 text-emerald-900",
  completed: "bg-blue-100 text-blue-900",
  cancelled: "bg-gray-200 text-gray-700",
  no_show: "bg-rose-100 text-rose-900",
};

const TYPE_OPTIONS = [
  { value: "initial_consultation", label: "Initial Consultation" },
  { value: "plan_review", label: "Plan Review" },
  { value: "enrollment", label: "Enrollment" },
  { value: "annual_review", label: "Annual Review" },
  { value: "follow_up", label: "Follow-up" },
  { value: "other", label: "Other" },
];
const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((t) => [t.value, t.label]));

const DATE_RANGES = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
];

function rangeBounds(range) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (range === "today") {
    const iso = format(today, "yyyy-MM-dd");
    return { from: iso, to: iso };
  }
  if (range === "week") {
    const end = new Date(today);
    end.setDate(end.getDate() + 7);
    return { from: format(today, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd") };
  }
  if (range === "month") {
    const end = new Date(today);
    end.setDate(end.getDate() + 30);
    return { from: format(today, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd") };
  }
  return { from: null, to: null };
}

// NewAppointmentSheet + its ClientTypeahead helpers were extracted to
// frontend/src/components/NewAppointmentSheet.jsx so the CalendarPage
// can reuse the same booking sheet on slot-click. Imported below.

function formatTimeDisplay(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, "0")} ${period}`;
}

function formatDateDisplay(iso) {
  if (!iso) return "";
  try {
    return format(new Date(iso + "T12:00:00"), "MMM d, yyyy");
  } catch {
    return iso;
  }
}

// today/week/month all roll into the backend's "mtd" stats window —
// those user-facing ranges are too narrow to be useful as standalone
// rollups, and the stats bar's job is to give the agent a recent-month
// pulse. "all" passes through unchanged.
function rangeFilterToStatsPeriod(range) {
  return range === "all" ? "all" : "mtd";
}

const TYPE_LABEL_SHORT = {
  initial_consultation: "Consultation",
  plan_review: "Plan Review",
  enrollment: "Enrollment",
  annual_review: "Annual Review",
  follow_up: "Follow-up",
  other: "Other",
};

function StatCard({ icon: Icon, label, value }) {
  return (
    <Card className="bg-surface">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div
          className="text-2xl font-bold tabular-nums tracking-tight"
          style={{ fontFamily: "Outfit" }}
          data-testid={`appt-stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AppointmentsList() {
  const [appts, setAppts] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [rangeFilter, setRangeFilter] = useState("week");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const prefillLeadId = searchParams.get("lead_id");

  // Auto-open the booking sheet when the page is navigated to with
  // ?lead_id=X (e.g. from the Pipeline "Book Appointment" CTA). Strip
  // the param afterwards so refreshing the page doesn't reopen the
  // sheet over and over.
  useEffect(() => {
    if (prefillLeadId) {
      setSheetOpen(true);
      searchParams.delete("lead_id");
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter !== "all") params.status = statusFilter;
      // For "today" we can use the date= filter exactly; for week/month
      // we fetch broader and filter client-side since the API takes a
      // single date param. "all" hits the full list (bounded by limit).
      if (rangeFilter === "today") {
        params.date = format(new Date(), "yyyy-MM-dd");
      }
      const res = await api.get("/appointments", { params });
      let rows = res.data?.appointments || [];
      if (rangeFilter !== "all" && rangeFilter !== "today") {
        const { from, to } = rangeBounds(rangeFilter);
        rows = rows.filter(
          (a) => a.appointment_date >= from && a.appointment_date <= to,
        );
      }
      setAppts(rows);
    } catch (e) {
      toast.error("Failed to load appointments");
      setAppts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, rangeFilter]);

  // Revenue stats. Re-fetches whenever the range filter changes so the
  // bar always reflects the period the user is looking at, and also on
  // demand via the bumpable statsTick (e.g. after a new appointment
  // is created). Failures silently zero the bar — we don't toast the
  // user, the table is more important.
  const [statsTick, setStatsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const period = rangeFilterToStatsPeriod(rangeFilter);
        const res = await api.get("/appointments/revenue-stats", {
          params: { period },
        });
        if (!alive) return;
        setStats(res.data);
      } catch {
        if (alive) setStats(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [rangeFilter, statsTick]);

  const refreshAll = () => {
    load();
    setStatsTick((t) => t + 1);
  };

  async function cancel(appt) {
    if (!window.confirm(`Cancel ${appt.client_name}'s appointment on ${formatDateDisplay(appt.appointment_date)}?`)) {
      return;
    }
    try {
      await api.delete(`/appointments/${appt.appointment_id}`);
      toast.success("Appointment cancelled");
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Cancel failed");
    }
  }

  const isEmpty = !loading && appts.length === 0;

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <CalendarClock className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Calendar
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Appointments
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Scheduled calls and meetings with clients.
            </p>
            <ImpersonationBanner />
          </div>
          <Button
            onClick={() => setSheetOpen(true)}
            className="bg-[#e85d2f] hover:bg-[#c84416]"
            data-testid="appt-new-btn"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            New Appointment
          </Button>
        </div>

        {/* Stats bar — appointment counts + commission totals for the
            current filter window. Re-fetches whenever rangeFilter
            changes; today/week/month all map to backend "mtd" and
            "all" passes through. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3" data-testid="appt-stats-bar">
          <StatCard
            icon={CalendarIcon}
            label="Appointments"
            value={(stats?.total_appointments ?? 0).toLocaleString()}
          />
          <StatCard
            icon={CheckCircle2}
            label="Completed"
            value={(stats?.completed_appointments ?? 0).toLocaleString()}
          />
          <StatCard
            icon={DollarSign}
            label="Est. Commission"
            value={fmtMoney(stats?.total_estimated_commission ?? 0)}
          />
          <StatCard
            icon={TrendingUp}
            label="Avg per Appointment"
            value={fmtMoney(stats?.avg_commission_per_appointment ?? 0)}
          />
        </div>

        {stats && (stats.by_type || []).length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 mb-3"
            data-testid="appt-stats-by-type"
          >
            {(stats.by_type || [])
              .filter((b) => b.count > 0)
              .map((b) => (
                <span
                  key={b.type}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-foreground/80 text-[11px]"
                >
                  <span className="font-medium">
                    {TYPE_LABEL_SHORT[b.type] || b.type}:
                  </span>
                  <span>
                    {b.count} {b.count === 1 ? "appt" : "appts"}
                  </span>
                  {b.avg_commission > 0 && (
                    <span className="text-muted-foreground">
                      · {fmtMoney(b.avg_commission)} avg
                    </span>
                  )}
                </span>
              ))}
          </div>
        )}

        <Card className="bg-surface mb-3">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40 h-10" data-testid="appt-status-filter">
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
              <Select value={rangeFilter} onValueChange={setRangeFilter}>
                <SelectTrigger className="w-40 h-10" data-testid="appt-range-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_RANGES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <ScrollableCard
          title="Appointments"
          count={appts.length}
          height="calc(100vh - 320px)"
          loading={loading}
          isEmpty={isEmpty}
          emptyState="No appointments yet. Schedule your first one."
          testId="appt-list-card"
        >
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {appts.map((a) => (
                  <TableRow key={a.appointment_id} data-testid={`appt-row-${a.appointment_id}`}>
                    <TableCell className="font-medium">{a.client_name}</TableCell>
                    <TableCell className="text-sm">
                      {formatDateDisplay(a.appointment_date)}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {formatTimeDisplay(a.appointment_time)}
                    </TableCell>
                    <TableCell>
                      <Badge className="rounded-full bg-secondary text-foreground/80 border-0 text-[10px]">
                        {TYPE_LABEL[a.type] || a.type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`rounded-full capitalize ${
                          STATUS_BADGE[a.status] || "bg-secondary"
                        }`}
                      >
                        {a.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[260px] truncate">
                      {a.notes || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 w-7 p-0"
                          onClick={() => {
                            // window.open hits the API origin via the
                            // full backend URL; cookie auth (SameSite=None;
                            // Secure) rides along. Server returns the file
                            // with Content-Disposition: attachment so the
                            // tab closes immediately after download.
                            window.open(
                              `${process.env.REACT_APP_BACKEND_URL}/api/appointments/${a.appointment_id}/ics`,
                            );
                          }}
                          title="Add to Calendar"
                          aria-label="Download .ics"
                          data-testid={`appt-ics-${a.appointment_id}`}
                        >
                          <CalendarIcon className="w-3.5 h-3.5" />
                        </Button>
                        {a.lead_id && (
                          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                            <Link to={`/clients/${a.lead_id}`}>
                              View
                              <ArrowUpRight className="w-3 h-3 ml-1" />
                            </Link>
                          </Button>
                        )}
                        {a.status === "scheduled" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-rose-700 hover:text-rose-800"
                            onClick={() => cancel(a)}
                            data-testid={`appt-cancel-${a.appointment_id}`}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollableCard>
      </main>

      <NewAppointmentSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCreated={refreshAll}
        prefillLeadId={prefillLeadId}
      />
    </div>
  );
}
