"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Calendar as RBCalendar,
  dateFnsLocalizer,
  type Event as RBCEvent,
  type SlotInfo,
  type View,
} from "react-big-calendar";
import {
  format as dateFormat,
  getDay,
  parse as dateParse,
  startOfWeek,
} from "date-fns";
import { enUS } from "date-fns/locale";
import { CalendarRange, Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { appointments as appointmentsApi } from "@/lib/api";
import {
  CancelAppointmentDialog,
  CreateAppointmentDialog,
  EditAppointmentDialog,
} from "@/components/appointments/dialogs";
import type { Appointment, BookingType } from "@/types";

import "react-big-calendar/lib/css/react-big-calendar.css";
import "@/components/calendar/calendar-theme.css";

// ─── Localizer ─────────────────────────────────────────────────────────────

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format: dateFormat,
  parse: dateParse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});

// ─── Color spec ────────────────────────────────────────────────────────────

interface BookingColor {
  bg: string;
  text: string;
  ring: string;
  dot: string;
  label: string;
}

// Inline-style RGB used by RBC's event chip background and the
// legend dot. Pulled from globals.css so dark-mode swaps are
// automatic for *border* and *outline*; event chip colors are
// fixed values to guarantee the green/purple/orange/gray reads
// the same under either theme.
const BOOKING_COLORS: Record<BookingType, BookingColor> = {
  autobook: {
    // GHW forest green
    bg: "rgba(45, 90, 61, 0.85)",
    text: "#e8f5ec",
    ring: "rgba(45, 90, 61, 0.4)",
    dot: "bg-ghw-forest",
    label: "Autobook",
  },
  va: {
    // Purple = VA booked (per spec)
    bg: "rgba(124, 58, 237, 0.85)",
    text: "#f3eaff",
    ring: "rgba(124, 58, 237, 0.4)",
    dot: "bg-[hsl(var(--chart-4))]",
    label: "VA booked",
  },
  ae: {
    // GHW copper for AE booked
    bg: "rgba(193, 124, 60, 0.9)",
    text: "#fdf3e8",
    ring: "rgba(193, 124, 60, 0.4)",
    dot: "bg-ghw-copper",
    label: "AE booked",
  },
  manual: {
    // Muted gray for self-booked
    bg: "rgba(120, 120, 130, 0.7)",
    text: "#f4f4f5",
    ring: "rgba(120, 120, 130, 0.4)",
    dot: "bg-muted-foreground",
    label: "Self booked",
  },
};

// ─── Event mapping ─────────────────────────────────────────────────────────

interface AppointmentEvent extends RBCEvent {
  id: string;
  appointment: Appointment;
}

function appointmentToEvent(a: Appointment): AppointmentEvent | null {
  try {
    const start = new Date(`${a.appointment_date}T${a.appointment_time}:00`);
    if (isNaN(start.getTime())) return null;
    const end = new Date(start.getTime() + a.duration_minutes * 60_000);
    const time = start.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    return {
      id: a.appointment_id,
      title: `${time} · ${a.client_name || "Unknown"}`,
      start,
      end,
      appointment: a,
    };
  } catch {
    return null;
  }
}

// ─── Range helpers ─────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function rangeForView(view: View, anchor: Date): { start: string; end: string } {
  const start = new Date(anchor);
  const end = new Date(anchor);
  if (view === "month") {
    start.setDate(1);
    start.setDate(start.getDate() - 7); // RBC shows previous month tail
    end.setMonth(end.getMonth() + 1, 0);
    end.setDate(end.getDate() + 7);
  } else if (view === "week") {
    const day = start.getDay();
    start.setDate(start.getDate() - day);
    end.setDate(start.getDate() + 6);
  } else if (view === "day") {
    // already a single day
  } else {
    // agenda: ~30 day window
    end.setDate(end.getDate() + 30);
  }
  return { start: isoDate(start), end: isoDate(end) };
}

// ─── Page ──────────────────────────────────────────────────────────────────

const VIEWS: View[] = ["month", "week", "day"];

export default function CalendarPage() {
  const [view, setView] = React.useState<View>("month");
  const [anchor, setAnchor] = React.useState<Date>(() => new Date());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createInitial, setCreateInitial] = React.useState<{
    date?: string;
    time?: string;
  }>({});
  const [editing, setEditing] = React.useState<Appointment | null>(null);
  const [cancelling, setCancelling] = React.useState<Appointment | null>(null);

  const range = React.useMemo(() => rangeForView(view, anchor), [view, anchor]);

  const apptsQuery = useQuery({
    queryKey: ["appointments", "calendar", range],
    queryFn: () =>
      appointmentsApi.listAppointments({
        start_date: range.start,
        end_date: range.end,
        limit: 1000,
      }),
  });

  const events = React.useMemo<AppointmentEvent[]>(() => {
    const rows = apptsQuery.data?.appointments ?? [];
    return rows
      .map(appointmentToEvent)
      .filter((e): e is AppointmentEvent => e !== null);
  }, [apptsQuery.data]);

  const eventPropGetter = React.useCallback((event: AppointmentEvent) => {
    const color = BOOKING_COLORS[event.appointment.booking_type];
    const cancelled = event.appointment.status === "cancelled";
    return {
      style: {
        backgroundColor: color.bg,
        color: color.text,
        opacity: cancelled ? 0.45 : 1,
        textDecoration: cancelled ? "line-through" : "none",
        border: "none",
        boxShadow: `0 1px 2px ${color.ring}`,
      },
    };
  }, []);

  function handleSelectEvent(event: AppointmentEvent) {
    setEditing(event.appointment);
  }

  function handleSelectSlot(slot: SlotInfo) {
    setCreateInitial({
      date: isoDate(slot.start as Date),
      time: (slot.start as Date).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
    setCreateOpen(true);
  }

  function handleNewClick() {
    setCreateInitial({ date: isoDate(anchor) });
    setCreateOpen(true);
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Calendar</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your bookings — color-coded by source. Click any event to edit;
            click an empty slot to book.
          </p>
        </div>
        <Button onClick={handleNewClick}>
          <Plus className="h-4 w-4 mr-1.5" />
          New appointment
        </Button>
      </header>

      <ImpersonationBanner />

      <Legend />

      <Card className="border-border/70">
        <CardContent className="p-3 md:p-4 relative">
          {apptsQuery.isFetching ? (
            <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5 text-xs text-muted-foreground bg-background/80 backdrop-blur px-2 py-1 rounded">
              <Loader2 className="h-3 w-3 animate-spin" />
              loading
            </div>
          ) : null}
          <div className="h-[680px]">
            <RBCalendar
              localizer={localizer}
              events={events}
              startAccessor="start"
              endAccessor="end"
              view={view}
              onView={setView}
              date={anchor}
              onNavigate={setAnchor}
              views={VIEWS}
              selectable
              onSelectEvent={handleSelectEvent}
              onSelectSlot={handleSelectSlot}
              eventPropGetter={eventPropGetter}
              popup
              step={30}
              timeslots={2}
              dayLayoutAlgorithm="no-overlap"
            />
          </div>
        </CardContent>
      </Card>

      <CreateAppointmentDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setCreateInitial({});
        }}
        initialDate={createInitial.date}
        initialTime={createInitial.time}
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

// ─── Legend ────────────────────────────────────────────────────────────────

function Legend() {
  const entries = Object.entries(BOOKING_COLORS) as [
    BookingType,
    BookingColor,
  ][];
  return (
    <Card className="border-border/70">
      <CardContent className="p-3 flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5 mr-2">
          <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">
            Booking source
          </span>
        </div>
        {entries.map(([key, color]) => (
          <div key={key} className="flex items-center gap-1.5">
            <span
              className={cn("h-2.5 w-2.5 rounded-sm", color.dot)}
              aria-hidden
            />
            <Badge variant="outline" className="text-[10px]">
              {color.label}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
