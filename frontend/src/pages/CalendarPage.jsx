import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Calendar as BigCalendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay, addDays } from "date-fns";
import enUS from "date-fns/locale/en-US";
import {
  CalendarDays,
  ArrowUpRight,
  X as XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import { api } from "@/lib/api";

// react-big-calendar's stylesheet. Imported here only — its class names
// (.rbc-*) are unique enough that they don't bleed onto pages that
// don't render the calendar, but keeping the import local makes the
// dependency obvious and dead-codes nicely if the page is split.
import "react-big-calendar/lib/css/react-big-calendar.css";
import "./CalendarPage.css";

// ── Localizer ────────────────────────────────────────────────────────────
const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});

// ── Colour anchors (kept in sync with the Today action centre legend) ──
const COLORS = {
  appointment: "#16a34a",      // green-600
  appointmentMuted: "#9ca3af", // gray-400 for completed/cancelled/no-show
  renewal: "#d97706",          // amber-600
  birthday: "#dc2626",         // red-600
};

const TYPE_LABEL = {
  initial_consultation: "Initial Consultation",
  plan_review: "Plan Review",
  enrollment: "Enrollment",
  annual_review: "Annual Review",
  follow_up: "Follow-up",
  other: "Other",
};

function parseDateTime(dateStr, timeStr) {
  // dateStr "2026-06-15", timeStr "10:30" — local-time interpretation
  // matches how BigCalendar's date-fns localizer reads dates.
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
}

function parseDateOnly(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// react-big-calendar treats `end` as exclusive for all-day events, so we
// bump by one day to include the closing day visually.
function endOfAllDay(date) {
  return addDays(date, 1);
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 768,
  );
  useEffect(() => {
    function onResize() {
      setIsMobile(window.innerWidth < 768);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className="inline-block w-2.5 h-2.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function EventDetailDialog({ event, onClose }) {
  if (!event) return null;
  const r = event.resource || {};
  const kind = r.kind;
  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ background: event.color }}
            />
            {event.title}
          </DialogTitle>
          <DialogDescription>
            {format(event.start, "EEEE, MMM d, yyyy")}
            {!event.allDay && ` · ${format(event.start, "h:mm a")}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          {kind === "appointment" && (
            <>
              <DetailRow label="Type" value={TYPE_LABEL[r.type] || r.type} />
              <DetailRow
                label="Duration"
                value={r.duration_minutes ? `${r.duration_minutes} minutes` : "—"}
              />
              <DetailRow
                label="Status"
                value={(r.status || "").replace("_", " ")}
                capitalize
              />
              {r.notes && <DetailRow label="Notes" value={r.notes} multiline />}
            </>
          )}
          {kind === "renewal" && (
            <>
              <DetailRow label="Carrier" value={r.carrier || "—"} />
              <DetailRow label="Product" value={r.product_label || "—"} />
              <DetailRow
                label="Days until renewal"
                value={r.days_until_renewal ?? "—"}
              />
            </>
          )}
          {kind === "birthday" && (
            <>
              <DetailRow
                label="Window"
                value={`${event.start.toLocaleDateString()} – ${addDays(event.end, -1).toLocaleDateString()}`}
              />
              <DetailRow
                label="Days remaining"
                value={r.days_remaining_in_window ?? "—"}
              />
              {r.phone && <DetailRow label="Phone" value={r.phone} />}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            <XIcon className="w-3.5 h-3.5 mr-1" />
            Close
          </Button>
          {r.lead_id && (
            <Button asChild size="sm" className="bg-[#e85d2f] hover:bg-[#c84416]">
              <Link to={`/clients/${r.lead_id}`}>
                View Client
                <ArrowUpRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, value, multiline, capitalize }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 items-start">
      <span className="text-[11px] uppercase tracking-widest text-muted-foreground pt-0.5">
        {label}
      </span>
      <span
        className={`text-sm ${multiline ? "whitespace-pre-wrap" : "truncate"} ${
          capitalize ? "capitalize" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export default function CalendarPage() {
  const isMobile = useIsMobile();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("month");
  const [date, setDate] = useState(new Date());
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        // Three sources in parallel. Settle, not all — a partial outage
        // (e.g. /renewals/alerts erroring) shouldn't blank the page;
        // we just drop the failing kind from the calendar.
        const [apptRes, renewalRes, birthdayRes] = await Promise.allSettled([
          api.get("/appointments"),
          api.get("/renewals/alerts"),
          api.get("/birthday-rule/alerts"),
        ]);

        const out = [];

        if (apptRes.status === "fulfilled") {
          const list = apptRes.value.data?.appointments || [];
          for (const a of list) {
            const start = parseDateTime(a.appointment_date, a.appointment_time);
            if (!start) continue;
            const end = new Date(start);
            end.setMinutes(end.getMinutes() + (a.duration_minutes || 30));
            const active = a.status === "scheduled";
            out.push({
              id: `appt-${a.appointment_id}`,
              title: `${a.client_name} — ${TYPE_LABEL[a.type] || a.type || "Appointment"}`,
              start,
              end,
              allDay: false,
              color: active ? COLORS.appointment : COLORS.appointmentMuted,
              resource: { kind: "appointment", ...a },
            });
          }
        }

        if (renewalRes.status === "fulfilled") {
          const list = renewalRes.value.data?.renewal_alerts || [];
          for (const r of list) {
            const d = parseDateOnly(r.renewal_date);
            if (!d) continue;
            out.push({
              id: `renewal-${r.lead_id}-${r.renewal_date}`,
              title: `${r.full_name} renewal`,
              start: d,
              end: endOfAllDay(d),
              allDay: true,
              color: COLORS.renewal,
              resource: { kind: "renewal", ...r },
            });
          }
        }

        if (birthdayRes.status === "fulfilled") {
          // Spec: urgent (window-open) entries only — soon/upcoming are
          // reminders rather than calendar events.
          const urgent = birthdayRes.value.data?.urgent || [];
          for (const b of urgent) {
            const opens = parseDateOnly(b.window_opens);
            const closes = parseDateOnly(b.window_closes);
            if (!opens || !closes) continue;
            out.push({
              id: `bday-${b.lead_id}`,
              title: `${b.full_name} birthday window`,
              start: opens,
              end: endOfAllDay(closes),
              allDay: true,
              color: COLORS.birthday,
              resource: { kind: "birthday", ...b },
            });
          }
        }

        if (!alive) return;
        setEvents(out);
        if (
          apptRes.status === "rejected" &&
          renewalRes.status === "rejected" &&
          birthdayRes.status === "rejected"
        ) {
          toast.error("Couldn't load any calendar data");
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const eventPropGetter = useCallback((event) => {
    return {
      style: {
        backgroundColor: event.color,
        border: "none",
        color: "white",
        borderRadius: 4,
        fontSize: 12,
        padding: "2px 6px",
      },
    };
  }, []);

  // On phones we lock to the month view — week/agenda are unreadable in
  // the narrow column layout. Desktop keeps the full set.
  const views = useMemo(
    () => (isMobile ? ["month"] : ["month", "week", "agenda"]),
    [isMobile],
  );

  // Re-clamp the active view if the viewport shrinks while user is on
  // week / agenda so we don't end up rendering a hidden view.
  useEffect(() => {
    if (isMobile && view !== "month") {
      setView("month");
    }
  }, [isMobile, view]);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <CalendarDays className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Schedule
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Calendar
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Appointments, renewals, and birthday windows in one view.
            </p>
            <ImpersonationBanner />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <LegendDot color={COLORS.appointment} label="Appointment" />
            <LegendDot color={COLORS.renewal} label="Renewal" />
            <LegendDot color={COLORS.birthday} label="Birthday window" />
          </div>
        </div>

        <Card className="bg-surface">
          <CardContent className="p-3 md:p-4">
            {loading && events.length === 0 ? (
              <div className="h-[600px] rounded bg-secondary/40 animate-pulse" />
            ) : (
              <div className="ghw-calendar" style={{ height: "min(75vh, 720px)" }}>
                <BigCalendar
                  localizer={localizer}
                  events={events}
                  startAccessor="start"
                  endAccessor="end"
                  view={view}
                  onView={setView}
                  date={date}
                  onNavigate={setDate}
                  views={views}
                  popup
                  eventPropGetter={eventPropGetter}
                  onSelectEvent={setSelected}
                  messages={{
                    today: "Today",
                    previous: "Back",
                    next: "Next",
                    month: "Month",
                    week: "Week",
                    agenda: "Agenda",
                    noEventsInRange: "No events in this range.",
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {events.length === 0 && !loading && (
          <div className="mt-3 text-xs text-muted-foreground text-center">
            No appointments, renewals, or birthday windows yet — add some
            from the Today page or schedule a call from Appointments.
          </div>
        )}
      </main>

      <EventDetailDialog event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
