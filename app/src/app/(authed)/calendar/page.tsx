"use client";

/**
 * Calendar page — full appointment grid + sidebar + Google Calendar
 * connect indicator. Closes the WS1 `/calendar` 404 gap.
 *
 * The page orchestrates state across the calendar view, the three
 * modals, and the right-rail sidebar — fetching uses a React Query
 * cache so view-change refetches dedupe naturally with the sidebar
 * stats and the modals' optimistic refreshes.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Views } from "react-big-calendar";
import { Calendar as CalendarIcon, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { appointments as appointmentsApi, calendars as calendarsApi } from "@/lib/api";
import { useAuthStore } from "@/stores";
import type { Appointment } from "@/types";
import type { AppointmentListResponse } from "@/lib/api/appointments";
import type { GoogleCalendarStatus } from "@/lib/api/calendars";

import { CalendarView, type RbcView } from "./_calendar-view";
import { AppointmentSidebar } from "./_sidebar";
import {
  AppointmentDetailModal,
  CreateAppointmentModal,
  RescheduleModal,
} from "./_modals";
import { viewWindow, type CalendarViewName } from "./_helpers";

function rbcToName(v: RbcView): CalendarViewName {
  if (v === Views.MONTH) return "month";
  if (v === Views.WEEK) return "week";
  if (v === Views.DAY) return "day";
  return "agenda";
}

export default function CalendarPage() {
  // CRA defaults to AGENDA on mobile, WEEK on desktop. We can't read
  // window.innerWidth before render in Next.js (would mismatch SSR
  // hydration), so default to WEEK and let the user switch — the rbc
  // toolbar's responsive layout keeps the small screens usable.
  const [view, setView] = React.useState<RbcView>(Views.WEEK);
  const [date, setDate] = React.useState<Date>(() => new Date());

  // Self-scope by default so admin/owner roles see only their own
  // appointments unless they impersonate an agent (which is wired
  // server-side via the X-Agent-ID header on the axios client).
  // Mirrors the CRA pattern in CalendarPage.jsx:686.
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const window_ = React.useMemo(
    () => viewWindow(date, rbcToName(view)),
    [date, view],
  );

  const startISO = format(window_.start, "yyyy-MM-dd");
  const endISO = format(window_.end, "yyyy-MM-dd");

  const apptQuery = useQuery<AppointmentListResponse>({
    queryKey: ["appointments", "calendar", startISO, endISO, currentUserId],
    queryFn: () =>
      appointmentsApi.listAppointments({
        start_date: startISO,
        end_date: endISO,
        limit: 1000,
        ...(currentUserId ? { agent_id: currentUserId } : {}),
      }),
  });

  const appointments = apptQuery.data?.appointments ?? [];

  // Modal state.
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createPrefill, setCreatePrefill] = React.useState<Date | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [detailAppt, setDetailAppt] = React.useState<Appointment | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = React.useState(false);
  const [rescheduleAppt, setRescheduleAppt] = React.useState<Appointment | null>(
    null,
  );

  function openCreateBlank() {
    setCreatePrefill(null);
    setCreateOpen(true);
  }

  function openCreateFromSlot(slotStart: Date) {
    setCreatePrefill(slotStart);
    setCreateOpen(true);
  }

  function openDetail(appt: Appointment) {
    setDetailAppt(appt);
    setDetailOpen(true);
  }

  function openReschedule(appt: Appointment) {
    // Detail modal stays mounted under the reschedule dialog so
    // dismissing reschedule returns to the detail view.
    setRescheduleAppt(appt);
    setRescheduleOpen(true);
  }

  function refresh() {
    apptQuery.refetch();
  }

  return (
    <div className="min-h-full py-6">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <CalendarIcon className="w-4 h-4 text-primary" />
              <p className="text-eyebrow">Schedule</p>
            </div>
            <h1 className="text-2xl font-bold tracking-tight font-display">
              Calendar
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Your scheduled appointments. Click a slot to book.
            </p>
          </div>
          <GoogleStatusBadge />
        </div>

        {/* Calendar + sidebar */}
        <div className="flex flex-col lg:flex-row gap-4">
          <Card className="flex-1">
            <CardContent className="p-3 sm:p-4">
              <CalendarView
                appointments={appointments}
                view={view}
                setView={setView}
                date={date}
                setDate={setDate}
                onSelectEvent={openDetail}
                onSelectSlot={openCreateFromSlot}
                onCreateBlank={openCreateBlank}
                loading={apptQuery.isLoading}
              />
            </CardContent>
          </Card>

          <AppointmentSidebar
            appointments={appointments}
            onPick={openDetail}
          />
        </div>
      </div>

      <CreateAppointmentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refresh}
        prefillDate={createPrefill}
      />

      <AppointmentDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        appointment={detailAppt}
        onChanged={refresh}
        onReschedule={openReschedule}
      />

      <RescheduleModal
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        appointment={rescheduleAppt}
        onChanged={refresh}
      />
    </div>
  );
}

// ─── Google Calendar status (inline) ─────────────────────────────────────

function GoogleStatusBadge() {
  const statusQuery = useQuery<GoogleCalendarStatus>({
    queryKey: ["calendar", "google", "status"],
    queryFn: () => calendarsApi.getGoogleStatus(),
    // Status rarely changes — once on mount is enough. The connect
    // button manually invalidates the cache via refetch after the
    // OAuth round-trip completes (user comes back to the tab).
    staleTime: 60_000,
  });
  const [connecting, setConnecting] = React.useState(false);

  const status = statusQuery.data;
  const connected = status?.connected === true;

  async function startConnect() {
    setConnecting(true);
    try {
      const { authorization_url } = await calendarsApi.startGoogleConnect();
      // Bounce the browser through Google OAuth. Backend's callback
      // closes the window — when the user returns to this tab we
      // re-query for status.
      window.open(authorization_url, "_blank");
      // Optimistic: re-check status on next focus. If the user
      // completes OAuth in the new tab we'll see `connected: true`
      // the next time this tab regains focus.
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Could not start Google connect");
    } finally {
      setConnecting(false);
    }
  }

  // Refetch on tab focus so the badge flips immediately after the user
  // completes the OAuth flow in the popup tab.
  React.useEffect(() => {
    function onFocus() {
      statusQuery.refetch();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [statusQuery]);

  if (statusQuery.isLoading) {
    return (
      <Button variant="outline" disabled>
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Checking Google…
      </Button>
    );
  }

  if (connected) {
    return (
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full",
            "bg-ghw-forest/15 text-ghw-forest border border-ghw-forest/30",
          )}
          data-testid="google-connected-badge"
        >
          <Check className="w-3.5 h-3.5" />
          Google Calendar Connected
        </span>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      onClick={startConnect}
      disabled={connecting}
      data-testid="google-connect-btn"
    >
      <CalendarIcon className="w-4 h-4 mr-2" />
      {connecting ? "Connecting…" : "Connect Google Calendar"}
    </Button>
  );
}
