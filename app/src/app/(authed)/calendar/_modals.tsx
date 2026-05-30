"use client";

/**
 * Three modals for the Calendar page:
 *
 * 1. AppointmentDetailModal — opens when an event is clicked. Shows
 *    fields + 6 outcome buttons (Showed / No Show / Sold / Not Sold /
 *    Cancelled / Reschedule) + ICS download + view-client deep link.
 *    The 4 strict outcomes go through POST /api/appointments/{id}/
 *    outcome (auto-flips status to completed/no_show, fires the no-
 *    show reschedule email, audits, etc.); Cancelled goes through
 *    PATCH with status="cancelled" since the outcome enum doesn't
 *    include it; Reschedule opens the Reschedule modal.
 *
 * 2. RescheduleModal — small dialog with a single date picker. PATCHes
 *    appointment_date only. Backend `AppointmentUpdate` doesn't accept
 *    `appointment_time`, so for time changes the agent has to cancel +
 *    rebook. Helper text spells that out.
 *
 * 3. CreateAppointmentModal — full form. Client search typeahead
 *    against /api/leads, datetime, duration, type, notes. Supports
 *    walk-ins (no lead_id → manual client_name).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  CheckCircle2,
  Clock,
  DollarSign,
  Download,
  Search,
  User as UserIcon,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { appointments as appointmentsApi, leads as leadsApi } from "@/lib/api";
import type {
  Appointment,
  AppointmentOutcome,
  AppointmentType,
  Lead,
} from "@/types";
import type { BookingType } from "@/types/calendar";

import {
  BOOKING_TYPE_COLOR,
  BOOKING_TYPE_LABEL,
  STATUS_LABEL,
  TYPE_LABEL,
  bookingColor,
  fmtMoney,
  parseDateTime,
} from "./_helpers";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

// ─── Detail modal ────────────────────────────────────────────────────────

interface DetailModalProps {
  open: boolean;
  onClose: () => void;
  appointment: Appointment | null;
  onChanged: () => void;
  onReschedule: (appointment: Appointment) => void;
}

const OUTCOMES: readonly {
  value: AppointmentOutcome;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  buttonClass: string;
}[] = [
  {
    value: "showed",
    label: "Showed",
    icon: CheckCircle2,
    buttonClass: "text-ghw-forest",
  },
  {
    value: "no_show",
    label: "No Show",
    icon: XCircle,
    buttonClass: "text-destructive",
  },
  {
    value: "sold",
    label: "Sold",
    icon: CheckCircle2,
    buttonClass: "text-primary",
  },
  {
    value: "not_sold",
    label: "Not Sold",
    icon: XCircle,
    buttonClass: "text-ghw-copper",
  },
];

export function AppointmentDetailModal({
  open,
  onClose,
  appointment,
  onChanged,
  onReschedule,
}: DetailModalProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  if (!appointment) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent />
      </Dialog>
    );
  }

  const start = parseDateTime(
    appointment.appointment_date,
    appointment.appointment_time,
  );
  const isMutable = appointment.status === "scheduled";

  async function applyOutcome(outcome: AppointmentOutcome) {
    if (!appointment) return;
    setBusy(true);
    try {
      await appointmentsApi.setAppointmentOutcome(
        appointment.appointment_id,
        { outcome },
      );
      toast.success(`Marked ${outcome.replace("_", " ")}`);
      onChanged();
      // Sold → close + bounce to /applications with the client pre-
      // selected so the agent can drop into the application flow
      // immediately. lead_id may be null for walk-ins; skip the deep
      // link in that case.
      if (outcome === "sold" && appointment.lead_id) {
        router.push(`/applications?client_id=${appointment.lead_id}`);
      }
      onClose();
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelAppointment() {
    if (!appointment) return;
    setBusy(true);
    try {
      // PATCH with status="cancelled" — same pattern as CRA. Distinct
      // from DELETE /appointments/{id} which removes the row entirely;
      // PATCH preserves it for the audit trail.
      await appointmentsApi.patchAppointment(appointment.appointment_id, {
        status: "cancelled",
      });
      toast.success("Appointment cancelled");
      onChanged();
      onClose();
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadIcs() {
    if (!appointment) return;
    // The ICS endpoint streams a text/ics file with a Content-
    // Disposition: attachment header — opening it in a new window
    // triggers the browser's "save calendar event" flow.
    window.open(
      `${BACKEND_URL}/api/appointments/${appointment.appointment_id}/ics`,
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">{appointment.client_name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="rounded-full capitalize text-[11px]"
            >
              {TYPE_LABEL[appointment.type] ?? appointment.type}
            </Badge>
            <Badge
              variant="outline"
              className="rounded-full capitalize text-[11px]"
            >
              {STATUS_LABEL[appointment.status] ?? appointment.status}
            </Badge>
            <Badge
              className="rounded-full border-0 text-white text-[11px]"
              style={{ background: bookingColor(appointment.booking_type) }}
              data-testid="appointment-detail-source"
            >
              {BOOKING_TYPE_LABEL[appointment.booking_type] ?? "Manual"}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Date">
              {start ? format(start, "EEE, MMM d, yyyy") : "—"}
            </FieldRow>
            <FieldRow label="Time">
              <span className="tabular-nums">
                {start ? format(start, "h:mm a") : "—"}
              </span>
            </FieldRow>
            <FieldRow label="Duration">
              <span className="tabular-nums">
                {appointment.duration_minutes} min
              </span>
            </FieldRow>
            {appointment.estimated_commission != null ? (
              <FieldRow label="Est. Commission">
                <span className="tabular-nums inline-flex items-center gap-0.5">
                  <DollarSign className="w-3.5 h-3.5" />
                  {fmtMoney(appointment.estimated_commission)}
                </span>
              </FieldRow>
            ) : null}
            <FieldRow label="Agent" colSpan={2}>
              <span className="flex items-center gap-1.5">
                <UserIcon className="w-3.5 h-3.5" />
                {appointment.agent_name || appointment.agent_email || "—"}
              </span>
            </FieldRow>
            {appointment.outcome ? (
              <FieldRow label="Outcome" colSpan={2}>
                <span className="capitalize">
                  {appointment.outcome.replace("_", " ")}
                </span>
              </FieldRow>
            ) : null}
          </div>

          {appointment.notes ? (
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">
                Notes
              </div>
              <div className="text-sm whitespace-pre-wrap bg-secondary/40 rounded-md p-3">
                {appointment.notes}
              </div>
            </div>
          ) : null}

          {/* Outcome row — 4 strict outcomes go through POST /outcome;
              Cancelled + Reschedule fall back to PATCH / a separate
              flow because the AppointmentOutcome enum is locked to 4. */}
          {isMutable ? (
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
                Outcome
              </div>
              <div className="grid grid-cols-2 gap-2">
                {OUTCOMES.map((o) => {
                  const Icon = o.icon;
                  return (
                    <Button
                      key={o.value}
                      type="button"
                      variant="outline"
                      onClick={() => applyOutcome(o.value)}
                      disabled={busy}
                      className="justify-start"
                      data-testid={`outcome-${o.value}`}
                    >
                      <Icon className={cn("w-4 h-4 mr-2", o.buttonClass)} />
                      {o.label}
                    </Button>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  onClick={cancelAppointment}
                  disabled={busy}
                  className="justify-start text-destructive"
                  data-testid="outcome-cancelled"
                >
                  <XCircle className="w-4 h-4 mr-2" />
                  Cancelled
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onReschedule(appointment)}
                  disabled={busy}
                  className="justify-start"
                  data-testid="outcome-reschedule"
                >
                  <Clock className="w-4 h-4 mr-2" />
                  Reschedule
                </Button>
              </div>
            </div>
          ) : null}

          <div className="pt-2 border-t border-border space-y-2">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={downloadIcs}
              data-testid="apptdet-ics"
            >
              <Download className="w-4 h-4 mr-2" /> Download .ics
            </Button>
            {appointment.lead_id ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => {
                  router.push(`/clients/${appointment.lead_id}`);
                  onClose();
                }}
              >
                <UserIcon className="w-4 h-4 mr-2" />
                Open client profile
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({
  label,
  colSpan = 1,
  children,
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <div className={colSpan === 2 ? "col-span-2" : ""}>
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="font-medium">{children}</div>
    </div>
  );
}

// ─── Reschedule modal ────────────────────────────────────────────────────

interface RescheduleModalProps {
  open: boolean;
  onClose: () => void;
  appointment: Appointment | null;
  onChanged: () => void;
}

export function RescheduleModal({
  open,
  onClose,
  appointment,
  onChanged,
}: RescheduleModalProps) {
  const [date, setDate] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open && appointment) setDate(appointment.appointment_date);
  }, [open, appointment]);

  async function save() {
    if (!appointment) return;
    if (!date) {
      toast.error("Pick a date");
      return;
    }
    setSaving(true);
    try {
      await appointmentsApi.patchAppointment(appointment.appointment_id, {
        appointment_date: date,
      });
      toast.success("Rescheduled");
      onChanged();
      onClose();
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Reschedule failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reschedule appointment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>New date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="reschedule-date"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Backend reschedule only changes the date. To move to a
            different time of day, cancel this appointment and book a
            new one.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving} data-testid="reschedule-save">
              {saving ? "Saving…" : "Reschedule"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create modal ────────────────────────────────────────────────────────

const APPOINTMENT_TYPES: readonly {
  value: AppointmentType;
  label: string;
}[] = [
  { value: "initial_consultation", label: "Initial Consultation" },
  { value: "plan_review", label: "Plan Review" },
  { value: "enrollment", label: "Enrollment" },
  { value: "annual_review", label: "Annual Review" },
  { value: "follow_up", label: "Follow-up" },
  { value: "other", label: "Other" },
];

const BOOKING_TYPES: readonly {
  value: BookingType;
  label: string;
}[] = (Object.keys(BOOKING_TYPE_COLOR) as Array<BookingType>).map(
  (k) => ({ value: k, label: BOOKING_TYPE_LABEL[k] }),
);

interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** From "click empty slot" — pre-fills date + time inputs. */
  prefillDate: Date | null;
}

export function CreateAppointmentModal({
  open,
  onClose,
  onCreated,
  prefillDate,
}: CreateModalProps) {
  const [lead, setLead] = React.useState<Lead | null>(null);
  const [walkInName, setWalkInName] = React.useState("");
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [duration, setDuration] = React.useState("30");
  const [type, setType] = React.useState<AppointmentType>("initial_consultation");
  const [bookingType, setBookingType] = React.useState<BookingType>("manual");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Reset form on open + apply prefill.
  React.useEffect(() => {
    if (!open) return;
    setLead(null);
    setWalkInName("");
    setNotes("");
    setDuration("30");
    setType("initial_consultation");
    setBookingType("manual");
    if (prefillDate) {
      setDate(format(prefillDate, "yyyy-MM-dd"));
      setTime(format(prefillDate, "HH:mm"));
    } else {
      const today = new Date();
      setDate(format(today, "yyyy-MM-dd"));
      setTime("09:00");
    }
  }, [open, prefillDate]);

  async function save() {
    if (!date || !time) {
      toast.error("Date and time are required");
      return;
    }
    if (!lead && !walkInName.trim()) {
      toast.error("Pick a client or enter a walk-in name");
      return;
    }
    setSaving(true);
    try {
      await appointmentsApi.createAppointment({
        ...(lead
          ? { lead_id: lead.id }
          : { client_name: walkInName.trim() }),
        appointment_date: date,
        appointment_time: time,
        duration_minutes: Number(duration) || 30,
        type,
        booking_type: bookingType,
        notes: notes.trim() || undefined,
      });
      toast.success("Appointment created");
      onCreated();
      onClose();
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e?.message || "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Appointment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Client</Label>
            <LeadTypeahead value={lead} onChange={setLead} />
            {!lead ? (
              <div className="mt-2">
                <Label className="text-[11px] text-muted-foreground">
                  Or walk-in (no lead in CRM yet)
                </Label>
                <Input
                  value={walkInName}
                  onChange={(e) => setWalkInName(e.target.value)}
                  placeholder="Walk-in client name"
                  data-testid="walkin-name"
                />
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                data-testid="create-date"
              />
            </div>
            <div>
              <Label>Time</Label>
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                data-testid="create-time"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Duration (min)</Label>
              <Input
                type="number"
                min={5}
                max={480}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
            <div>
              <Label>Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as AppointmentType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPOINTMENT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Source (booking_type)</Label>
            <Select
              value={bookingType}
              onValueChange={(v) => setBookingType(v as BookingType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOOKING_TYPES.map((b) => (
                  <SelectItem key={b.value} value={b.value}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving}
              data-testid="create-save"
            >
              {saving ? "Saving…" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Lead typeahead ──────────────────────────────────────────────────────

function LeadTypeahead({
  value,
  onChange,
}: {
  value: Lead | null;
  onChange: (lead: Lead | null) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Lead[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  // Debounced search — fire 300ms after typing stops.
  React.useEffect(() => {
    if (value) return;
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await leadsApi.listLeads({ q: query, limit: 8 });
        setResults(res.leads ?? []);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 mt-1">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {value.first_name} {value.last_name}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {value.email ?? value.phone ?? value.id}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(null);
            setQuery("");
            setResults([]);
          }}
          className="text-xs"
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="relative mt-1">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, email, or phone (2+ chars)"
        className="pl-9"
        data-testid="lead-typeahead"
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && (loading || results.length > 0) ? (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-md border border-border bg-card shadow-md max-h-60 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Searching…
            </div>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                  setQuery("");
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-secondary"
              >
                <div className="font-medium truncate">
                  {r.first_name} {r.last_name}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {r.email ?? r.phone ?? r.id}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
