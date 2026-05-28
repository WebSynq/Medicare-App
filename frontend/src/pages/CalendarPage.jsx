import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Calendar as BigCalendar, dateFnsLocalizer, Views } from "react-big-calendar";
import {
  format,
  parse,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  endOfWeek,
  startOfDay,
  endOfDay,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  addDays,
  subDays,
  getDay,
  isToday,
  isSameDay,
  isThisWeek,
  isAfter,
  parseISO,
} from "date-fns";
import enUS from "date-fns/locale/en-US";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  CalendarDays,
  CheckCircle2,
  XCircle,
  Download,
  X as XIcon,
  DollarSign,
  User as UserIcon,
  Clock,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import NewAppointmentSheet from "@/components/NewAppointmentSheet";
import { api } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";

// react-big-calendar's CSS — page-local import so it only loads here.
import "react-big-calendar/lib/css/react-big-calendar.css";
import "./CalendarPage.css";


// ── date-fns localizer (US, week starts Sunday) ─────────────────────────
const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});


// ── Event colour map (one per appointment type) ─────────────────────────
const TYPE_COLOR = {
  initial_consultation: "#1565C0", // blue
  follow_up: "#2E7D32",            // green
  annual_review: "#E65100",        // orange
  enrollment: "#6A1B9A",           // purple
  plan_review: "#00695C",          // teal
  other: "#616161",                // gray
};

const TYPE_LABEL = {
  initial_consultation: "Initial Consultation",
  plan_review: "Plan Review",
  enrollment: "Enrollment",
  annual_review: "Annual Review",
  follow_up: "Follow-up",
  other: "Other",
};

const STATUS_LABEL = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No Show",
};

function fmtMoney(v) {
  if (v == null || Number.isNaN(v)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}


// ── Date / time helpers ─────────────────────────────────────────────────
function parseDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
}

function formatTime12h(d) {
  if (!d) return "";
  return format(d, "h:mm a");
}

// Compute the inclusive [start, end] dates we need to fetch for the
// current view. Each view's window is widened a bit so the calendar's
// "spillover" cells (last week of previous month visible in month view,
// etc.) also show appointments.
function viewWindow(date, view) {
  if (view === Views.MONTH) {
    const startMonth = startOfMonth(date);
    const endMonth = endOfMonth(date);
    return {
      start: startOfWeek(startMonth, { weekStartsOn: 0 }),
      end: endOfWeek(endMonth, { weekStartsOn: 0 }),
    };
  }
  if (view === Views.WEEK) {
    return {
      start: startOfWeek(date, { weekStartsOn: 0 }),
      end: endOfWeek(date, { weekStartsOn: 0 }),
    };
  }
  if (view === Views.DAY) {
    return { start: startOfDay(date), end: endOfDay(date) };
  }
  // Agenda — react-big-calendar's default is a 30-day forward window.
  return { start: startOfDay(date), end: endOfDay(addDays(date, 30)) };
}


// ── Mobile detection (md breakpoint = 768px) ────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 768,
  );
  useEffect(() => {
    function onResize() {
      setM(window.innerWidth < 768);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return m;
}


// ── Custom toolbar — replaces the rbc default ───────────────────────────
// rbc passes: { date, view, views, label, onNavigate, onView }
function CalendarToolbar({
  date,
  view,
  onNavigate,
  onView,
  label,
  onNewAppointment,
  isMobile,
}) {
  // Period label: rbc's default `label` is good for month/day but the
  // week label is "May 22 – 28" without year — append year for clarity.
  const periodLabel = useMemo(() => {
    if (view === Views.WEEK) {
      const start = startOfWeek(date, { weekStartsOn: 0 });
      const end = endOfWeek(date, { weekStartsOn: 0 });
      const sameMonth = start.getMonth() === end.getMonth();
      const fmtStart = sameMonth ? "MMM d" : "MMM d";
      const fmtEnd = sameMonth ? "d, yyyy" : "MMM d, yyyy";
      return `${format(start, fmtStart)} – ${format(end, fmtEnd)}`;
    }
    if (view === Views.DAY) return format(date, "EEEE, MMM d, yyyy");
    if (view === Views.MONTH) return format(date, "MMMM yyyy");
    return label; // agenda
  }, [date, view, label]);

  return (
    <div className="cal-toolbar">
      <div className="cal-toolbar-row cal-toolbar-nav">
        <div className="inline-flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onNavigate("PREV")}
            aria-label="Previous"
            data-testid="cal-prev"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onNavigate("TODAY")}
            data-testid="cal-today"
          >
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onNavigate("NEXT")}
            aria-label="Next"
            data-testid="cal-next"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <div className="cal-toolbar-label text-sm font-semibold">
          {periodLabel}
        </div>

        {!isMobile && <CalendarViewToolbarRight
          view={view}
          onView={onView}
          onNewAppointment={onNewAppointment}
        />}
      </div>

      {isMobile && (
        <div className="cal-toolbar-row cal-toolbar-views">
          <CalendarViewToolbarRight
            view={view}
            onView={onView}
            onNewAppointment={onNewAppointment}
            stacked
          />
        </div>
      )}
    </div>
  );
}

function CalendarViewToolbarRight({ view, onView, onNewAppointment, stacked }) {
  const buttons = [
    { v: Views.MONTH, label: "Month" },
    { v: Views.WEEK, label: "Week" },
    { v: Views.DAY, label: "Day" },
    { v: Views.AGENDA, label: "Agenda" },
  ];
  return (
    <div className={`inline-flex items-center gap-2 ${stacked ? "flex-wrap" : ""}`}>
      <div className="inline-flex rounded-md border border-border overflow-hidden">
        {buttons.map((b) => (
          <button
            key={b.v}
            type="button"
            onClick={() => onView(b.v)}
            className={
              "px-3 py-1.5 text-xs transition-colors " +
              (view === b.v
                ? "bg-[#0B2545] text-white"
                : "bg-background text-foreground/70 hover:bg-secondary")
            }
            data-testid={`cal-view-${b.v}`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onNewAppointment}
        className="bg-[#e85d2f] hover:bg-[#c84416]"
        data-testid="cal-new-appt"
      >
        <Plus className="w-3.5 h-3.5 mr-1" />
        New Appointment
      </Button>
    </div>
  );
}


// ── Appointment detail sheet (event click) ──────────────────────────────
function AppointmentDetailSheet({ open, onOpenChange, appointment, onChanged }) {
  const [busy, setBusy] = useState(false);

  if (!appointment) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md" />
      </Sheet>
    );
  }

  const start = parseDateTime(
    appointment.appointment_date,
    appointment.appointment_time,
  );
  const color = TYPE_COLOR[appointment.type] || TYPE_COLOR.other;

  async function patchStatus(next) {
    setBusy(true);
    try {
      await api.patch(`/appointments/${appointment.appointment_id}`, {
        status: next,
      });
      toast.success(
        next === "completed" ? "Marked complete" : "Cancelled",
      );
      onChanged?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Update failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadIcs() {
    window.open(
      `${process.env.REACT_APP_BACKEND_URL}/api/appointments/${appointment.appointment_id}/ics`,
    );
  }

  const canMutate = appointment.status === "scheduled";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="text-xl">{appointment.client_name}</SheetTitle>
          <SheetDescription>Appointment details</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            <Badge
              className="rounded-full border-0 text-white text-[11px]"
              style={{ background: color }}
            >
              {TYPE_LABEL[appointment.type] || appointment.type}
            </Badge>
            <Badge variant="outline" className="rounded-full text-[11px] capitalize">
              {STATUS_LABEL[appointment.status] || appointment.status}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Date
              </div>
              <div className="font-medium">
                {start ? format(start, "EEE, MMM d, yyyy") : "—"}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Time
              </div>
              <div className="font-medium tabular-nums">
                {start ? format(start, "h:mm a") : "—"}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Duration
              </div>
              <div className="font-medium tabular-nums">
                {appointment.duration_minutes} min
              </div>
            </div>
            {appointment.estimated_commission != null && (
              <div>
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  Est. Commission
                </div>
                <div className="font-medium tabular-nums flex items-center gap-0.5">
                  <DollarSign className="w-3.5 h-3.5" />
                  {fmtMoney(appointment.estimated_commission)}
                </div>
              </div>
            )}
            <div className="col-span-2">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Agent
              </div>
              <div className="font-medium flex items-center gap-1.5">
                <UserIcon className="w-3.5 h-3.5" />
                {appointment.agent_name || appointment.agent_email || "—"}
              </div>
            </div>
          </div>

          {appointment.notes && (
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">
                Notes
              </div>
              <div className="text-sm whitespace-pre-wrap bg-secondary/40 rounded-md p-3">
                {appointment.notes}
              </div>
            </div>
          )}

          {appointment.lead_id && (
            <Link
              to={`/clients/${appointment.lead_id}`}
              className="inline-flex items-center text-xs text-[#1565C0] hover:underline"
              onClick={() => onOpenChange(false)}
            >
              Open client profile →
            </Link>
          )}

          <div className="pt-2 border-t border-border space-y-2">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={downloadIcs}
              data-testid="apptdet-ics"
            >
              <Download className="w-4 h-4 mr-2" /> Add to Calendar (.ics)
            </Button>
            {canMutate && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => patchStatus("completed")}
                  disabled={busy}
                  data-testid="apptdet-complete"
                >
                  <CheckCircle2 className="w-4 h-4 mr-2 text-emerald-600" />
                  Mark Complete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start text-rose-700 hover:text-rose-800"
                  onClick={() => patchStatus("cancelled")}
                  disabled={busy}
                  data-testid="apptdet-cancel"
                >
                  <XCircle className="w-4 h-4 mr-2" />
                  Cancel Appointment
                </Button>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}


// ── Right sidebar (desktop only) ────────────────────────────────────────
function RightSidebar({ appointments, onPickAppointment }) {
  const now = useMemo(() => new Date(), []);

  const todays = useMemo(() => {
    return appointments
      .filter((a) => {
        const d = parseDateTime(a.appointment_date, a.appointment_time);
        return d && isToday(d);
      })
      .sort((a, b) =>
        (a.appointment_time || "").localeCompare(b.appointment_time || ""),
      );
  }, [appointments]);

  const thisWeek = useMemo(() => {
    const inWeek = appointments.filter((a) => {
      const d = parseDateTime(a.appointment_date, a.appointment_time);
      return d && isThisWeek(d, { weekStartsOn: 0 });
    });
    return {
      total: inWeek.length,
      completed: inWeek.filter((a) => a.status === "completed").length,
      upcoming: inWeek.filter((a) => a.status === "scheduled").length,
    };
  }, [appointments]);

  const nextAppt = useMemo(() => {
    const futureScheduled = appointments
      .filter((a) => {
        if (a.status !== "scheduled") return false;
        const d = parseDateTime(a.appointment_date, a.appointment_time);
        return d && isAfter(d, now);
      })
      .sort((a, b) => {
        const da = parseDateTime(a.appointment_date, a.appointment_time);
        const db = parseDateTime(b.appointment_date, b.appointment_time);
        return da - db;
      });
    return futureScheduled[0] || null;
  }, [appointments, now]);

  return (
    <aside className="cal-sidebar">
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Today
          </div>
          {todays.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No appointments today
            </div>
          ) : (
            <ul className="space-y-2">
              {todays.map((a) => (
                <li key={a.appointment_id}>
                  <button
                    type="button"
                    onClick={() => onPickAppointment(a)}
                    className="w-full text-left rounded-md p-2 hover:bg-secondary/50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">
                        {a.client_name}
                      </div>
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: TYPE_COLOR[a.type] || TYPE_COLOR.other }}
                        aria-hidden="true"
                      />
                    </div>
                    <div className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTime12h(parseDateTime(a.appointment_date, a.appointment_time))}
                      {" · "}
                      {TYPE_LABEL[a.type] || a.type}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-1">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            This Week
          </div>
          <div className="text-2xl font-bold tabular-nums" style={{ fontFamily: "Outfit" }}>
            {thisWeek.total}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {thisWeek.upcoming} upcoming · {thisWeek.completed} completed
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Next Appointment
          </div>
          {!nextAppt ? (
            <div className="text-sm text-muted-foreground">
              No upcoming appointments
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onPickAppointment(nextAppt)}
              className="w-full text-left rounded-md p-2 hover:bg-secondary/50 transition-colors"
            >
              <div className="text-sm font-medium truncate">
                {nextAppt.client_name}
              </div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {(() => {
                  const d = parseDateTime(nextAppt.appointment_date, nextAppt.appointment_time);
                  if (!d) return "—";
                  return `${format(d, "EEE, MMM d")} · ${formatTime12h(d)}`;
                })()}
              </div>
              <Badge
                className="mt-1.5 rounded-full border-0 text-white text-[10px]"
                style={{ background: TYPE_COLOR[nextAppt.type] || TYPE_COLOR.other }}
              >
                {TYPE_LABEL[nextAppt.type] || nextAppt.type}
              </Badge>
            </button>
          )}
        </CardContent>
      </Card>
    </aside>
  );
}


// ── Main page ───────────────────────────────────────────────────────────
export default function CalendarPage() {
  const isMobile = useIsMobile();
  const { selectedAgent } = useAgent();
  const [view, setView] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 768
      ? Views.AGENDA
      : Views.WEEK,
  );
  const [date, setDate] = useState(new Date());
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);

  // Sheet state.
  const [newOpen, setNewOpen] = useState(false);
  const [prefillDate, setPrefillDate] = useState(null);
  const [prefillTime, setPrefillTime] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailAppt, setDetailAppt] = useState(null);

  const win = useMemo(() => viewWindow(date, view), [date, view]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        start_date: format(win.start, "yyyy-MM-dd"),
        end_date: format(win.end, "yyyy-MM-dd"),
        limit: 1000,
      };
      const res = await api.get("/appointments", { params });
      setAppointments(res.data?.appointments || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to load calendar");
      setAppointments([]);
    } finally {
      setLoading(false);
    }
  }, [win.start, win.end]);

  useEffect(() => {
    load();
  }, [load, selectedAgent]);

  // Build rbc events. Only appointments — birthday + renewal alerts
  // intentionally NOT pulled (those are action queues, not events).
  const events = useMemo(() => {
    const out = [];
    for (const a of appointments) {
      const start = parseDateTime(a.appointment_date, a.appointment_time);
      if (!start) continue;
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + (a.duration_minutes || 30));
      const color = TYPE_COLOR[a.type] || TYPE_COLOR.other;
      out.push({
        id: a.appointment_id,
        title: `${a.client_name} · ${formatTime12h(start)}`,
        start,
        end,
        allDay: false,
        color,
        appointment: a,
      });
    }
    return out;
  }, [appointments]);

  function eventPropGetter(event) {
    const active = event.appointment?.status === "scheduled";
    return {
      style: {
        backgroundColor: event.color,
        borderColor: event.color,
        opacity: active ? 1 : 0.55,
        color: "white",
      },
    };
  }

  function handleSelectSlot(slotInfo) {
    setPrefillDate(slotInfo.start);
    setPrefillTime(format(slotInfo.start, "HH:mm"));
    setNewOpen(true);
  }

  function handleSelectEvent(event) {
    setDetailAppt(event.appointment);
    setDetailOpen(true);
  }

  function openNewBlank() {
    setPrefillDate(null);
    setPrefillTime("");
    setNewOpen(true);
  }

  return (
    <div className="min-h-full bg-secondary/30 py-6">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-4">
          <h1 className="text-2xl font-bold" style={{ fontFamily: "Outfit" }}>
            Calendar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your scheduled appointments. Click a slot to book.
          </p>
          <ImpersonationBanner />
        </div>

        <div className="cal-layout">
          <Card className="cal-main">
            <CardContent className="p-3 sm:p-4">
              <BigCalendar
                localizer={localizer}
                events={events}
                date={date}
                view={view}
                onNavigate={setDate}
                onView={setView}
                views={[Views.MONTH, Views.WEEK, Views.DAY, Views.AGENDA]}
                selectable
                onSelectSlot={handleSelectSlot}
                onSelectEvent={handleSelectEvent}
                eventPropGetter={eventPropGetter}
                startAccessor="start"
                endAccessor="end"
                step={30}
                timeslots={2}
                style={{ height: isMobile ? "70vh" : "75vh" }}
                components={{
                  toolbar: (tbProps) => (
                    <CalendarToolbar
                      {...tbProps}
                      onNewAppointment={openNewBlank}
                      isMobile={isMobile}
                    />
                  ),
                }}
              />
              {loading && (
                <div className="text-[11px] text-muted-foreground mt-2">
                  Loading…
                </div>
              )}
            </CardContent>
          </Card>

          {!isMobile && (
            <RightSidebar
              appointments={appointments}
              onPickAppointment={(a) => {
                setDetailAppt(a);
                setDetailOpen(true);
              }}
            />
          )}
        </div>
      </div>

      <NewAppointmentSheet
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={load}
        prefillDate={prefillDate}
        prefillTime={prefillTime}
      />

      <AppointmentDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        appointment={detailAppt}
        onChanged={load}
      />
    </div>
  );
}
