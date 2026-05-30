"use client";

/**
 * Right-rail appointment summary cards — Today / This Week stats /
 * Next upcoming. Click any row to open the detail modal.
 *
 * Ports the CRA CalendarPage.jsx RightSidebar.
 */

import * as React from "react";
import {
  format,
  isAfter,
  isSameDay,
  isThisWeek,
} from "date-fns";
import { Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Appointment } from "@/types";

import {
  BOOKING_TYPE_COLOR,
  BOOKING_TYPE_LABEL,
  bookingColor,
  parseDateTime,
} from "./_helpers";

interface AppointmentSidebarProps {
  appointments: Appointment[];
  onPick: (appointment: Appointment) => void;
}

export function AppointmentSidebar({
  appointments,
  onPick,
}: AppointmentSidebarProps) {
  const now = React.useMemo(() => new Date(), []);

  const todays = React.useMemo(() => {
    return (appointments ?? [])
      .filter((a) => {
        const d = parseDateTime(a.appointment_date, a.appointment_time);
        return d != null && isSameDay(d, now);
      })
      .sort((a, b) =>
        (a.appointment_time || "").localeCompare(b.appointment_time || ""),
      );
  }, [appointments, now]);

  const thisWeek = React.useMemo(() => {
    const inWeek = (appointments ?? []).filter((a) => {
      const d = parseDateTime(a.appointment_date, a.appointment_time);
      return d != null && isThisWeek(d, { weekStartsOn: 0 });
    });
    return {
      total: inWeek.length,
      completed: inWeek.filter((a) => a.status === "completed").length,
      upcoming: inWeek.filter((a) => a.status === "scheduled").length,
    };
  }, [appointments]);

  const nextAppt = React.useMemo(() => {
    const future = (appointments ?? [])
      .filter((a) => {
        if (a.status !== "scheduled") return false;
        const d = parseDateTime(a.appointment_date, a.appointment_time);
        return d != null && isAfter(d, now);
      })
      .sort((a, b) => {
        const da = parseDateTime(a.appointment_date, a.appointment_time);
        const db = parseDateTime(b.appointment_date, b.appointment_time);
        if (!da || !db) return 0;
        return da.getTime() - db.getTime();
      });
    return future[0] ?? null;
  }, [appointments, now]);

  return (
    <aside className="space-y-3 w-full lg:w-72 flex-shrink-0">
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
            <ul className="space-y-1">
              {todays.map((a) => {
                const start = parseDateTime(
                  a.appointment_date,
                  a.appointment_time,
                );
                return (
                  <li key={a.appointment_id}>
                    <button
                      type="button"
                      onClick={() => onPick(a)}
                      className="w-full text-left rounded-md p-2 hover:bg-secondary/50 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium truncate">
                          {a.client_name}
                        </div>
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ background: bookingColor(a.booking_type) }}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {start ? format(start, "h:mm a") : "—"}
                        {" · "}
                        {BOOKING_TYPE_LABEL[a.booking_type] ?? "Manual"}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-1">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            This Week
          </div>
          <div className="text-2xl font-bold tabular-nums font-display">
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
              onClick={() => onPick(nextAppt)}
              className="w-full text-left rounded-md p-2 hover:bg-secondary/50 transition-colors"
            >
              <div className="text-sm font-medium truncate">
                {nextAppt.client_name}
              </div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {(() => {
                  const d = parseDateTime(
                    nextAppt.appointment_date,
                    nextAppt.appointment_time,
                  );
                  if (!d) return "—";
                  return `${format(d, "EEE, MMM d")} · ${format(d, "h:mm a")}`;
                })()}
              </div>
              <Badge
                className="mt-1.5 rounded-full border-0 text-white text-[10px]"
                style={{ background: bookingColor(nextAppt.booking_type) }}
              >
                {BOOKING_TYPE_LABEL[nextAppt.booking_type] ?? "Manual"}
              </Badge>
            </button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Legend
          </div>
          <ul className="space-y-1">
            {(Object.keys(BOOKING_TYPE_COLOR) as Array<
              keyof typeof BOOKING_TYPE_COLOR
            >).map((k) => (
              <li
                key={k}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full"
                  style={{ background: BOOKING_TYPE_COLOR[k] }}
                  aria-hidden="true"
                />
                <span className="text-foreground/80">
                  {BOOKING_TYPE_LABEL[k]}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </aside>
  );
}
