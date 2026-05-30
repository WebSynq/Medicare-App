"use client";

/**
 * react-big-calendar wrapper + custom toolbar.
 *
 * Lives in its own client component so the stock CSS import stays
 * out of the page barrel — Next.js App Router allows third-party
 * CSS imports from any client component, and confining it here
 * means the CSS only loads when this view actually mounts.
 *
 * Dark-theme overrides for `.rbc-*` classes live in
 * `app/src/app/globals.css` since they have to be global (Next.js
 * won't let component-scoped global CSS files outside CSS modules).
 *
 * Color is driven by `booking_type` (CRA's C4 spec) — agents read
 * the source of every appointment at a glance.
 */

import * as React from "react";
import {
  Calendar as BigCalendar,
  dateFnsLocalizer,
  Views,
  type View,
  type EventProps,
} from "react-big-calendar";
import {
  format,
  parse,
  startOfWeek,
  getDay,
} from "date-fns";
import { enUS } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Appointment } from "@/types";

import {
  BOOKING_TYPE_COLOR,
  BOOKING_TYPE_LABEL,
  bookingColor,
  parseDateTime,
} from "./_helpers";

// Side-effect — stock rbc CSS. Bundled with this client component
// chunk so it only loads on /calendar.
import "react-big-calendar/lib/css/react-big-calendar.css";

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  color: string;
  appointment: Appointment;
}

// rbc's View string union is what onView passes back; the spec's
// `CalendarViewName` is the same shape so we cast as needed.
export type RbcView = View;

interface CalendarViewProps {
  appointments: Appointment[];
  view: RbcView;
  setView: (v: RbcView) => void;
  date: Date;
  setDate: (d: Date) => void;
  onSelectEvent: (a: Appointment) => void;
  onSelectSlot: (slotStart: Date) => void;
  onCreateBlank: () => void;
  loading: boolean;
}

export function CalendarView({
  appointments,
  view,
  setView,
  date,
  setDate,
  onSelectEvent,
  onSelectSlot,
  onCreateBlank,
  loading,
}: CalendarViewProps) {
  const events = React.useMemo<CalendarEvent[]>(() => {
    const out: CalendarEvent[] = [];
    for (const a of appointments) {
      const start = parseDateTime(a.appointment_date, a.appointment_time);
      if (!start) continue;
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + (a.duration_minutes || 30));
      out.push({
        id: a.appointment_id,
        title: `${a.client_name} · ${formatTime12h(start)}`,
        start,
        end,
        allDay: false,
        color: bookingColor(a.booking_type),
        appointment: a,
      });
    }
    return out;
  }, [appointments]);

  const eventPropGetter = React.useCallback(
    (event: CalendarEvent) => {
      const active = event.appointment?.status === "scheduled";
      return {
        style: {
          backgroundColor: event.color,
          borderColor: event.color,
          opacity: active ? 1 : 0.55,
          color: "white",
        },
      };
    },
    [],
  );

  return (
    <div>
      {/* Booking-source legend — same as CRA */}
      <div
        className="flex flex-wrap items-center gap-3 mb-3 text-xs"
        data-testid="calendar-booking-type-legend"
      >
        <span className="text-muted-foreground uppercase tracking-widest">
          Source
        </span>
        {(Object.keys(BOOKING_TYPE_COLOR) as Array<
          keyof typeof BOOKING_TYPE_COLOR
        >).map((k) => (
          <span
            key={k}
            className="inline-flex items-center gap-1.5"
            data-testid={`legend-${k}`}
          >
            <span
              aria-hidden
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ background: BOOKING_TYPE_COLOR[k] }}
            />
            <span className="text-foreground/80">
              {BOOKING_TYPE_LABEL[k]}
            </span>
          </span>
        ))}
      </div>

      <BigCalendar
        localizer={localizer}
        events={events}
        date={date}
        view={view}
        onNavigate={(d: Date) => setDate(d)}
        onView={(v: View) => setView(v)}
        views={[Views.MONTH, Views.WEEK, Views.DAY, Views.AGENDA]}
        selectable
        onSelectSlot={(slot) => onSelectSlot(slot.start as Date)}
        onSelectEvent={(event) =>
          onSelectEvent((event as CalendarEvent).appointment)
        }
        eventPropGetter={(event) =>
          eventPropGetter(event as CalendarEvent)
        }
        startAccessor="start"
        endAccessor="end"
        step={30}
        timeslots={2}
        style={{ height: "75vh" }}
        components={{
          toolbar: (tbProps) => (
            <CalendarToolbar
              date={tbProps.date}
              view={tbProps.view}
              label={tbProps.label}
              onNavigate={tbProps.onNavigate}
              onView={tbProps.onView}
              onNewAppointment={onCreateBlank}
            />
          ),
          event: EventPill,
        }}
      />

      {loading ? (
        <div className="text-[11px] text-muted-foreground mt-2">Loading…</div>
      ) : null}
    </div>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────

function CalendarToolbar({
  date,
  view,
  label,
  onNavigate,
  onView,
  onNewAppointment,
}: {
  date: Date;
  view: View;
  label: string;
  onNavigate: (action: "PREV" | "NEXT" | "TODAY" | "DATE") => void;
  onView: (v: View) => void;
  onNewAppointment: () => void;
}) {
  const periodLabel = React.useMemo(() => {
    if (view === Views.WEEK) {
      const start = startOfWeek(date, { weekStartsOn: 0 });
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const sameMonth = start.getMonth() === end.getMonth();
      const fmtStart = "MMM d";
      const fmtEnd = sameMonth ? "d, yyyy" : "MMM d, yyyy";
      return `${format(start, fmtStart)} – ${format(end, fmtEnd)}`;
    }
    if (view === Views.DAY) return format(date, "EEEE, MMM d, yyyy");
    if (view === Views.MONTH) return format(date, "MMMM yyyy");
    return label;
  }, [date, view, label]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
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

      <div className="text-sm font-semibold tabular-nums">{periodLabel}</div>

      <div className="inline-flex items-center gap-2">
        <ViewSwitcher view={view} onView={onView} />
        <Button
          type="button"
          size="sm"
          onClick={onNewAppointment}
          data-testid="cal-new-appt"
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          New Appointment
        </Button>
      </div>
    </div>
  );
}

function ViewSwitcher({
  view,
  onView,
}: {
  view: View;
  onView: (v: View) => void;
}) {
  const buttons: { v: View; label: string }[] = [
    { v: Views.MONTH, label: "Month" },
    { v: Views.WEEK, label: "Week" },
    { v: Views.DAY, label: "Day" },
    { v: Views.AGENDA, label: "Agenda" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden">
      {buttons.map((b) => (
        <button
          key={String(b.v)}
          type="button"
          onClick={() => onView(b.v)}
          className={cn(
            "px-3 py-1.5 text-xs transition-colors",
            view === b.v
              ? "bg-primary text-primary-foreground"
              : "bg-background text-foreground/70 hover:bg-secondary",
          )}
          data-testid={`cal-view-${b.v}`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

// ─── Event pill renderer ──────────────────────────────────────────────────

function EventPill({ event }: EventProps<CalendarEvent>) {
  return (
    <div className="truncate font-medium text-[12px]">{event.title}</div>
  );
}

function formatTime12h(d: Date): string {
  return format(d, "h:mm a");
}
