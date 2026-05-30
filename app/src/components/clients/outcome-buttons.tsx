"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { appointments as appointmentsApi, isApiError } from "@/lib/api";
import type { Appointment, AppointmentOutcome } from "@/types";

/**
 * Outcome buttons row — shows under the page header when the lead
 * has any appointments. Targets the most recent appointment (by
 * date+time descending). Backed by Feature A:
 * POST /api/appointments/{id}/outcome.
 *
 * Side effects per outcome:
 *   Sold     → navigates to /applications?lead_id=<id>
 *   No Show  → backend fires the reschedule email automatically;
 *              we also open a local "log next step" dialog so the
 *              agent can stamp a follow-up note.
 *   Showed   → stamp only
 *   Not Sold → stamp only
 *   Reschedule → opens the same dialog as No Show but doesn't
 *              stamp an outcome; placeholder until the
 *              reschedule API surface lands.
 */
export function OutcomeButtonsRow({ leadId }: { leadId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [rescheduleOpen, setRescheduleOpen] = React.useState(false);

  const apptsQuery = useQuery({
    queryKey: ["appointments", { lead_id: leadId, limit: 25 }],
    queryFn: () => appointmentsApi.listAppointments({ lead_id: leadId, limit: 25 }),
  });

  const latestAppt = React.useMemo<Appointment | null>(() => {
    const rows = apptsQuery.data?.appointments ?? [];
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => {
      const ka = `${a.appointment_date} ${a.appointment_time}`;
      const kb = `${b.appointment_date} ${b.appointment_time}`;
      return kb.localeCompare(ka);
    });
    return sorted[0] ?? null;
  }, [apptsQuery.data]);

  const outcomeMutation = useMutation({
    mutationFn: ({
      apptId,
      outcome,
    }: {
      apptId: string;
      outcome: AppointmentOutcome;
    }) =>
      appointmentsApi.setAppointmentOutcome(apptId, { outcome }),
    onSuccess: (_data, { outcome }) => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      if (outcome === "sold") {
        router.push(`/applications?lead_id=${leadId}`);
        return;
      }
      if (outcome === "no_show") {
        setRescheduleOpen(true);
        toast.success("Marked no-show — reschedule email sent.");
        return;
      }
      toast.success(`Marked ${outcome.replace("_", " ")}.`);
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Couldn't stamp outcome.";
      toast.error(msg);
    },
  });

  if (apptsQuery.isLoading) {
    return (
      <div className="mt-4">
        <Skeleton className="h-14 w-full rounded-md" />
      </div>
    );
  }

  if (!latestAppt) return null;

  const isPending = outcomeMutation.isPending;
  const stamp = (outcome: AppointmentOutcome) =>
    outcomeMutation.mutate({ apptId: latestAppt.appointment_id, outcome });

  return (
    <>
      <Card className="mt-4 border-border/70">
        <CardContent className="p-3 md:p-4 flex flex-wrap items-center gap-2">
          <div className="mr-2 flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <CalendarClock className="h-4 w-4" />
            <span className="truncate">
              {formatApptHeader(latestAppt)}
            </span>
            {latestAppt.outcome ? (
              <span
                className={cn(
                  "ml-1 text-[10px] px-1.5 py-0.5 rounded-full ring-1 capitalize",
                  outcomeTint(latestAppt.outcome),
                )}
              >
                {latestAppt.outcome.replace("_", " ")}
              </span>
            ) : null}
          </div>

          <OutcomeButton
            label="Showed"
            onClick={() => stamp("showed")}
            disabled={isPending}
            variant="outline"
          />
          <OutcomeButton
            label="No Show"
            onClick={() => stamp("no_show")}
            disabled={isPending}
            variant="outline"
          />
          <OutcomeButton
            label="Sold"
            onClick={() => stamp("sold")}
            disabled={isPending}
            variant="default"
            className="bg-ghw-forest hover:bg-ghw-forest/90"
          />
          <OutcomeButton
            label="Not Sold"
            onClick={() => stamp("not_sold")}
            disabled={isPending}
            variant="outline"
          />
          <OutcomeButton
            label="Reschedule"
            onClick={() => setRescheduleOpen(true)}
            disabled={isPending}
            variant="ghost"
          />
        </CardContent>
      </Card>

      <Dialog open={rescheduleOpen} onOpenChange={setRescheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reschedule</DialogTitle>
            <DialogDescription>
              The client got a reschedule email automatically. Drop a
              note here if you need a personal follow-up, then open the
              calendar to book the new time.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Reschedule API surfaces land in a later phase. For now
            use the Notes tab to log next steps + the Calendar page
            to book.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRescheduleOpen(false)}
            >
              Close
            </Button>
            <Button onClick={() => router.push("/calendar")}>
              Open Calendar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OutcomeButton({
  label,
  onClick,
  disabled,
  variant,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  variant: "default" | "outline" | "ghost";
  className?: string;
}) {
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={onClick}
      disabled={disabled}
      className={cn("text-xs", className)}
    >
      {disabled ? (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      ) : null}
      {label}
    </Button>
  );
}

function outcomeTint(outcome: string): string {
  switch (outcome) {
    case "sold":
      return "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30";
    case "no_show":
      return "bg-destructive/15 text-destructive ring-destructive/30";
    case "showed":
      return "bg-primary/15 text-primary ring-primary/30";
    case "not_sold":
      return "bg-muted text-muted-foreground ring-border";
    default:
      return "bg-muted text-muted-foreground ring-border";
  }
}

function formatApptHeader(a: Appointment): string {
  const dateLabel = (() => {
    try {
      return new Date(a.appointment_date + "T12:00:00").toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric" },
      );
    } catch {
      return a.appointment_date;
    }
  })();
  return `Last appt ${dateLabel} · ${a.appointment_time}`;
}
