"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarPlus,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  appointments as appointmentsApi,
  isApiError,
  leads as leadsApi,
} from "@/lib/api";
import type {
  Appointment,
  AppointmentOutcome,
  AppointmentStatus,
  AppointmentType,
  BookingType,
  Lead,
} from "@/types";

const APPT_TYPE_OPTIONS: { value: AppointmentType; label: string }[] = [
  { value: "initial_consultation", label: "Initial consultation" },
  { value: "plan_review", label: "Plan review" },
  { value: "enrollment", label: "Enrollment" },
  { value: "annual_review", label: "Annual review" },
  { value: "follow_up", label: "Follow-up" },
  { value: "other", label: "Other" },
];

const STATUS_OPTIONS: { value: AppointmentStatus; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "no_show", label: "No show" },
  { value: "cancelled", label: "Cancelled" },
];

export function statusLabel(s: AppointmentStatus): string {
  return s === "no_show" ? "No Show" : s.charAt(0).toUpperCase() + s.slice(1);
}

export function outcomeLabel(o: AppointmentOutcome): string {
  switch (o) {
    case "no_show":
      return "No Show";
    case "not_sold":
      return "Not Sold";
    default:
      return o.charAt(0).toUpperCase() + o.slice(1);
  }
}

export function bookingLabel(b: BookingType): string {
  switch (b) {
    case "va":
      return "VA";
    case "ae":
      return "AE";
    case "autobook":
      return "Autobook";
    case "manual":
      return "Self";
  }
}

function shortDate(date: string): string {
  try {
    return new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return date;
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ─── Create dialog ─────────────────────────────────────────────────────────

export function CreateAppointmentDialog({
  open,
  onOpenChange,
  initialDate,
  initialTime,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDate?: string;
  initialTime?: string;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<"linked" | "walkin">("linked");
  const [selectedLead, setSelectedLead] = React.useState<Lead | null>(null);
  const [walkInName, setWalkInName] = React.useState("");
  const [walkInEmail, setWalkInEmail] = React.useState("");
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [duration, setDuration] = React.useState(30);
  const [type, setType] = React.useState<AppointmentType>("initial_consultation");
  const [meetingType, setMeetingType] = React.useState<"phone" | "video" | "">("");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setDate(initialDate ?? "");
      setTime(initialTime ?? "");
    } else {
      setMode("linked");
      setSelectedLead(null);
      setWalkInName("");
      setWalkInEmail("");
      setDate("");
      setTime("");
      setDuration(30);
      setType("initial_consultation");
      setMeetingType("");
      setNotes("");
    }
  }, [open, initialDate, initialTime]);

  const createMutation = useMutation({
    mutationFn: () => {
      const payload: Parameters<typeof appointmentsApi.createAppointment>[0] = {
        appointment_date: date,
        appointment_time: time,
        duration_minutes: duration,
        type,
        ...(notes ? { notes } : {}),
        ...(meetingType ? { meeting_type: meetingType } : {}),
      };
      if (mode === "linked") {
        if (!selectedLead) {
          throw new Error("Pick a client first");
        }
        payload.lead_id = selectedLead.id;
      } else {
        payload.client_name = walkInName.trim();
        if (walkInEmail.trim()) payload.client_email = walkInEmail.trim();
      }
      return appointmentsApi.createAppointment(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success("Appointment booked.");
      onOpenChange(false);
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Couldn't create.";
      toast.error(msg);
    },
  });

  const canSubmit =
    !!date &&
    !!time &&
    duration > 0 &&
    (mode === "linked" ? !!selectedLead : walkInName.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New appointment</DialogTitle>
          <DialogDescription>
            Book a slot on your calendar. Walk-ins skip the lead pick.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={mode === "linked" ? "default" : "outline"}
              onClick={() => setMode("linked")}
              className="flex-1"
            >
              Existing client
            </Button>
            <Button
              size="sm"
              variant={mode === "walkin" ? "default" : "outline"}
              onClick={() => setMode("walkin")}
              className="flex-1"
            >
              Walk-in
            </Button>
          </div>

          {mode === "linked" ? (
            <LeadTypeahead
              selected={selectedLead}
              onSelect={setSelectedLead}
            />
          ) : (
            <>
              <Field label="Client name">
                <Input
                  value={walkInName}
                  onChange={(e) => setWalkInName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Email (optional)">
                <Input
                  type="email"
                  value={walkInEmail}
                  onChange={(e) => setWalkInEmail(e.target.value)}
                  placeholder="jane@example.com"
                />
              </Field>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Time">
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
            <Field label="Duration (min)">
              <Input
                type="number"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value) || 30)}
                min={5}
                max={480}
              />
            </Field>
            <Field label="Type">
              <Select
                value={type}
                onValueChange={(v) => setType(v as AppointmentType)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPT_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Meeting type">
            <Select
              value={meetingType || "_unset"}
              onValueChange={(v) =>
                setMeetingType(v === "_unset" ? "" : (v as "phone" | "video"))
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_unset">—</SelectItem>
                <SelectItem value="phone">Phone</SelectItem>
                <SelectItem value="video">Video</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Notes (optional)">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <CalendarPlus className="h-3.5 w-3.5 mr-1.5" />
            )}
            Book
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Lead typeahead ────────────────────────────────────────────────────────

function LeadTypeahead({
  selected,
  onSelect,
}: {
  selected: Lead | null;
  onSelect: (lead: Lead | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const debounced = useDebouncedValue(query, 250);
  const searchQuery = useQuery({
    queryKey: ["leads", "typeahead", debounced],
    queryFn: () => leadsApi.listLeads({ q: debounced, limit: 12 }),
    enabled: open && debounced.trim().length > 1,
  });

  if (selected) {
    return (
      <div className="rounded-md border border-border bg-secondary/40 p-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm">
            {selected.first_name} {selected.last_name}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {selected.email || selected.phone || "—"}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onSelect(null)}
          className="h-7 text-xs"
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">Client</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-start text-xs text-muted-foreground h-9"
          >
            <Search className="h-3.5 w-3.5 mr-1.5" />
            Search clients…
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[340px] p-2" align="start">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, email, or phone"
            className="h-9"
            autoFocus
          />
          <div className="mt-2 max-h-72 overflow-y-auto">
            {searchQuery.isFetching ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (searchQuery.data?.leads ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                {debounced.trim().length > 1
                  ? "No matches."
                  : "Type to search."}
              </p>
            ) : (
              <ul className="space-y-1">
                {searchQuery.data?.leads.map((lead) => (
                  <li key={lead.id}>
                    <button
                      onClick={() => {
                        onSelect(lead);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-secondary text-sm"
                    >
                      <div className="font-medium truncate">
                        {lead.first_name} {lead.last_name}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {lead.email || lead.phone || "—"}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── Edit / outcome dialog ─────────────────────────────────────────────────

const OUTCOME_BUTTONS: { value: AppointmentOutcome; label: string }[] = [
  { value: "showed", label: "Showed" },
  { value: "no_show", label: "No Show" },
  { value: "sold", label: "Sold" },
  { value: "not_sold", label: "Not Sold" },
];

export function EditAppointmentDialog({
  appointment,
  onOpenChange,
}: {
  appointment: Appointment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [duration, setDuration] = React.useState(30);
  const [status, setStatus] = React.useState<AppointmentStatus>("scheduled");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (appointment) {
      setDate(appointment.appointment_date);
      setTime(appointment.appointment_time);
      setDuration(appointment.duration_minutes);
      setStatus(appointment.status);
      setNotes(appointment.notes ?? "");
    }
  }, [appointment]);

  const patchMutation = useMutation({
    mutationFn: () => {
      if (!appointment) throw new Error("no appointment");
      const payload: Parameters<typeof appointmentsApi.patchAppointment>[1] = {};
      if (date !== appointment.appointment_date) payload.appointment_date = date;
      if (duration !== appointment.duration_minutes)
        payload.duration_minutes = duration;
      if (status !== appointment.status) payload.status = status;
      const trimmedNotes = (notes ?? "").trim();
      const existingNotes = (appointment.notes ?? "").trim();
      if (trimmedNotes !== existingNotes) payload.notes = trimmedNotes;
      return appointmentsApi.patchAppointment(
        appointment.appointment_id,
        payload,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success("Saved.");
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Save failed."),
  });

  const outcomeMutation = useMutation({
    mutationFn: (outcome: AppointmentOutcome) => {
      if (!appointment) throw new Error("no appointment");
      return appointmentsApi.setAppointmentOutcome(appointment.appointment_id, {
        outcome,
      });
    },
    onSuccess: (data, outcome) => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success(`Marked ${outcomeLabel(outcome)}.`);
      if (outcome === "sold" && data.lead_id) {
        router.push(`/applications?lead_id=${data.lead_id}`);
      }
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Couldn't set outcome."),
  });

  return (
    <Dialog open={!!appointment} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {appointment?.client_name || "Appointment"}
          </DialogTitle>
          <DialogDescription>
            {appointment
              ? `Currently ${statusLabel(appointment.status)} · ${bookingLabel(
                  appointment.booking_type,
                )} booking`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {appointment ? (
          <div className="space-y-4">
            <div>
              <Label className="text-[11px] text-muted-foreground">
                Outcome
              </Label>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                {OUTCOME_BUTTONS.map((b) => (
                  <Button
                    key={b.value}
                    variant={
                      appointment.outcome === b.value ? "default" : "outline"
                    }
                    size="sm"
                    onClick={() => outcomeMutation.mutate(b.value)}
                    disabled={outcomeMutation.isPending}
                    className={cn(
                      "text-xs",
                      b.value === "sold" &&
                        appointment.outcome !== "sold" &&
                        "border-ghw-forest/40 text-ghw-forest hover:bg-ghw-forest/10",
                      b.value === "no_show" &&
                        appointment.outcome !== "no_show" &&
                        "border-destructive/40 text-destructive hover:bg-destructive/10",
                    )}
                  >
                    {outcomeMutation.isPending &&
                    outcomeMutation.variables === b.value ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                    )}
                    {b.label}
                  </Button>
                ))}
              </div>
              {appointment.outcome === "sold" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs mt-2 w-full"
                  onClick={() =>
                    appointment.lead_id &&
                    router.push(`/applications?lead_id=${appointment.lead_id}`)
                  }
                  disabled={!appointment.lead_id}
                >
                  <ChevronRight className="h-3 w-3 mr-1" />
                  Go to application
                </Button>
              ) : null}
            </div>

            <div className="border-t border-border pt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date">
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
                <Field label="Time">
                  <Input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    disabled
                  />
                </Field>
                <Field label="Duration (min)">
                  <Input
                    type="number"
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value) || 30)}
                    min={5}
                    max={480}
                  />
                </Field>
                <Field label="Status">
                  <Select
                    value={status}
                    onValueChange={(v) => setStatus(v as AppointmentStatus)}
                  >
                    <SelectTrigger className="h-9">
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
                </Field>
              </div>
              <Field label="Notes">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                />
              </Field>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={() => patchMutation.mutate()}
            disabled={patchMutation.isPending}
          >
            {patchMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Cancel dialog ─────────────────────────────────────────────────────────

export function CancelAppointmentDialog({
  appointment,
  onOpenChange,
}: {
  appointment: Appointment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      if (!appointment) throw new Error("no appointment");
      return appointmentsApi.cancelAppointment(appointment.appointment_id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success("Appointment cancelled.");
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Cancel failed."),
  });

  return (
    <Dialog open={!!appointment} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cancel appointment?</DialogTitle>
          <DialogDescription>
            {appointment
              ? `${appointment.client_name} on ${shortDate(
                  appointment.appointment_date,
                )} at ${appointment.appointment_time}. This is a soft cancel — the row stays in your history.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            )}
            Cancel appointment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
