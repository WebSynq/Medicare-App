"use client";

import * as React from "react";
import { use as usePromise } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Loader2,
  Phone,
  ShieldCheck,
  Video,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { book as bookApi, isApiError } from "@/lib/api";
import type {
  BookingReason,
  PublicBookingPayload,
} from "@/lib/api/book";

const REASONS: BookingReason[] = [
  "New to Medicare",
  "Plan Review",
  "Turning 65 Soon",
  "Employer to Medicare",
  "Cost & Coverage Questions",
  "Other",
];

export default function PublicBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = usePromise(params);

  const infoQuery = useQuery({
    queryKey: ["book", slug, "info"],
    queryFn: () => bookApi.getInfo(slug),
    retry: false,
  });

  if (infoQuery.isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4">
          <Skeleton className="h-12 w-72" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (infoQuery.isError || !infoQuery.data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="p-8 text-center space-y-2">
            <CalendarCheck className="h-10 w-10 text-muted-foreground mx-auto" />
            <h1 className="text-lg font-bold">Booking link not available</h1>
            <p className="text-sm text-muted-foreground">
              This booking page is offline or the link is invalid. Please reach
              out to the agent for a new link.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <BookingWizard slug={slug} info={infoQuery.data} />;
}

function BookingWizard({
  slug,
  info,
}: {
  slug: string;
  info: NonNullable<Awaited<ReturnType<typeof bookApi.getInfo>>>;
}) {
  const [step, setStep] = React.useState<0 | 1 | 2>(0);
  const [pickedDate, setPickedDate] = React.useState("");
  const [pickedTime, setPickedTime] = React.useState("");
  const [confirmation, setConfirmation] = React.useState<{
    date: string;
    time: string;
    meeting_type: "phone" | "video";
  } | null>(null);

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <AgentHeader info={info} />

        <ol className="flex items-center gap-2 text-xs">
          {["Pick a time", "Your details", "Confirmation"].map((label, i) => (
            <li key={i} className="flex items-center flex-1 min-w-0">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium whitespace-nowrap",
                  i === step
                    ? "bg-primary text-primary-foreground"
                    : i < step
                      ? "bg-ghw-forest/15 text-ghw-forest"
                      : "bg-secondary text-muted-foreground",
                )}
              >
                <span className="h-5 w-5 rounded-full flex items-center justify-center text-[10px] bg-background/40">
                  {i < step ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
                </span>
                {label}
              </div>
              {i < 2 ? (
                <div className="h-px flex-1 bg-border mx-2" />
              ) : null}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <Step1Slot
            slug={slug}
            info={info}
            picked={{ date: pickedDate, time: pickedTime }}
            onPick={({ date, time }) => {
              setPickedDate(date);
              setPickedTime(time);
            }}
            onNext={() => setStep(1)}
          />
        ) : step === 1 && confirmation == null ? (
          <Step2Form
            slug={slug}
            info={info}
            date={pickedDate}
            time={pickedTime}
            onBack={() => setStep(0)}
            onConfirmed={(conf) => {
              setConfirmation(conf);
              setStep(2);
            }}
          />
        ) : confirmation ? (
          <Step3Confirmation
            agentName={info.agent_name}
            confirmation={confirmation}
          />
        ) : null}

        <p className="text-[10px] text-muted-foreground text-center flex items-center justify-center gap-1">
          <ShieldCheck className="h-3 w-3" />
          Secure booking · No account required
        </p>
      </div>
    </div>
  );
}

// ─── Agent header ──────────────────────────────────────────────────────────

function AgentHeader({
  info,
}: {
  info: Awaited<ReturnType<typeof bookApi.getInfo>>;
}) {
  return (
    <Card>
      <CardContent className="p-6 text-center space-y-2">
        <div className="h-14 w-14 rounded-full bg-primary/20 flex items-center justify-center mx-auto">
          <CalendarDays className="h-7 w-7 text-primary" />
        </div>
        <h1 className="text-xl font-bold">
          Book a time with {info.agent_name}
        </h1>
        {info.bio ? (
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            {info.bio}
          </p>
        ) : null}
        <div className="flex items-center justify-center gap-3 flex-wrap pt-1">
          <Badge variant="outline" className="text-[10px]">
            {info.appointment_duration} min
          </Badge>
          {info.meeting_types.map((m) => (
            <Badge key={m} variant="outline" className="text-[10px] capitalize">
              {m === "phone" ? (
                <Phone className="h-2.5 w-2.5 mr-1" />
              ) : m === "video" ? (
                <Video className="h-2.5 w-2.5 mr-1" />
              ) : null}
              {m}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Step 1 — Pick a slot ──────────────────────────────────────────────────

function Step1Slot({
  slug,
  info,
  picked,
  onPick,
  onNext,
}: {
  slug: string;
  info: Awaited<ReturnType<typeof bookApi.getInfo>>;
  picked: { date: string; time: string };
  onPick: (next: { date: string; time: string }) => void;
  onNext: () => void;
}) {
  // Default to tomorrow when the agent has an advance-notice window.
  const minDate = React.useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + Math.ceil(info.advance_notice_hours / 24));
    return d.toISOString().slice(0, 10);
  }, [info.advance_notice_hours]);

  const maxDate = React.useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + info.booking_window_days);
    return d.toISOString().slice(0, 10);
  }, [info.booking_window_days]);

  const [date, setDate] = React.useState(picked.date || minDate);

  const slotsQuery = useQuery({
    queryKey: ["book", slug, "slots", date],
    queryFn: () => bookApi.getSlots(slug, date),
    enabled: date.length > 0,
  });

  return (
    <Card>
      <CardContent className="p-5 md:p-6 space-y-4">
        <div className="space-y-1">
          <Label className="text-xs font-medium">Date</Label>
          <Input
            type="date"
            value={date}
            min={minDate}
            max={maxDate}
            onChange={(e) => {
              setDate(e.target.value);
              onPick({ date: e.target.value, time: "" });
            }}
          />
          <p className="text-[10px] text-muted-foreground">
            Earliest {minDate}, up to {maxDate}.
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-xs font-medium">Available times</Label>
          {slotsQuery.isLoading ? (
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : slotsQuery.data?.slots && slotsQuery.data.slots.length > 0 ? (
            <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
              {slotsQuery.data.slots.map((slot) => (
                <Button
                  key={slot}
                  variant={picked.time === slot ? "default" : "outline"}
                  size="sm"
                  onClick={() => onPick({ date, time: slot })}
                  className="tabular-nums"
                >
                  {formatTime(slot)}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">
              {slotsQuery.data?.reason ?? "No times available on this day."}
            </p>
          )}
        </div>

        <div className="flex justify-end pt-3 border-t border-border">
          <Button
            onClick={onNext}
            disabled={!picked.date || !picked.time}
          >
            Continue
            <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function formatTime(hhmm: string): string {
  const parts = hhmm.split(":");
  const hh = Number(parts[0] ?? 0);
  const mm = parts[1] ?? "00";
  const period = hh >= 12 ? "PM" : "AM";
  const display = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  return `${display}:${mm} ${period}`;
}

// ─── Step 2 — Form + submit ────────────────────────────────────────────────

function Step2Form({
  slug,
  info,
  date,
  time,
  onBack,
  onConfirmed,
}: {
  slug: string;
  info: Awaited<ReturnType<typeof bookApi.getInfo>>;
  date: string;
  time: string;
  onBack: () => void;
  onConfirmed: (conf: {
    date: string;
    time: string;
    meeting_type: "phone" | "video";
  }) => void;
}) {
  // Fresh anti-replay token at submit time. Re-fetched if rejected.
  const tokenQuery = useQuery({
    queryKey: ["book", slug, "token"],
    queryFn: () => bookApi.getToken(slug),
  });

  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [meetingType, setMeetingType] = React.useState<"phone" | "video">(
    (info.meeting_types[0] as "phone" | "video") ?? "phone",
  );
  const [reason, setReason] = React.useState<BookingReason>("Plan Review");
  const [notes, setNotes] = React.useState("");
  // Honeypot — kept hidden via tabIndex/aria-hidden + visually clipped.
  const [website, setWebsite] = React.useState("");

  const submitMutation = useMutation({
    mutationFn: () => {
      if (!tokenQuery.data) {
        throw new Error("Token not ready");
      }
      const payload: PublicBookingPayload = {
        client_name: name.trim(),
        client_phone: phone.trim(),
        ...(email.trim() ? { client_email: email.trim() } : {}),
        date,
        time,
        meeting_type: meetingType,
        booking_reason: reason,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        token: tokenQuery.data.token,
        ...(website ? { website } : {}),
      };
      return bookApi.createBooking(slug, payload);
    },
    onSuccess: (data) => {
      onConfirmed({
        date: data.date,
        time: data.time,
        meeting_type: data.meeting_type,
      });
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Couldn't book.";
      toast.error(msg);
    },
  });

  const canSubmit =
    name.trim().length >= 2 &&
    phone.trim().length >= 7 &&
    !!tokenQuery.data;

  return (
    <Card>
      <CardContent className="p-5 md:p-6 space-y-4">
        <div className="rounded-md bg-secondary/40 p-3 flex items-center justify-between text-xs flex-wrap gap-2">
          <span>
            <span className="text-muted-foreground">Booking</span>{" "}
            <span className="font-semibold">
              {new Date(`${date}T${time}:00`).toLocaleString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="h-7 text-[10px]"
          >
            Change
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Full name *">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </Field>
          <Field label="Phone *">
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={20}
              required
            />
          </Field>
          <Field label="Email (optional)">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={320}
            />
          </Field>
          <Field label="Meeting type">
            <Select
              value={meetingType}
              onValueChange={(v) => setMeetingType(v as "phone" | "video")}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {info.meeting_types.includes("phone") ? (
                  <SelectItem value="phone">Phone</SelectItem>
                ) : null}
                {info.meeting_types.includes("video") ? (
                  <SelectItem value="video">Video</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field label="What's this about?">
          <Select
            value={reason}
            onValueChange={(v) => setReason(v as BookingReason)}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Anything else? (optional)">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, 500))}
            rows={3}
            placeholder="Tell the agent what's on your mind"
          />
        </Field>

        {/* Honeypot — hidden from real users + screen readers. Bots
            that auto-fill every field land in here and the backend
            returns a fake 200 without writing anything. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: "-9999px",
            width: 1,
            height: 1,
            overflow: "hidden",
          }}
        >
          <label>
            Website
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>
        </div>

        <div className="flex justify-between pt-3 border-t border-border">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            Back
          </Button>
          <Button
            onClick={() => submitMutation.mutate()}
            disabled={!canSubmit || submitMutation.isPending}
          >
            {submitMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <CalendarCheck className="h-3.5 w-3.5 mr-1.5" />
            )}
            Book it
          </Button>
        </div>
      </CardContent>
    </Card>
  );
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
      <Label className="text-xs font-medium">{label}</Label>
      {children}
    </div>
  );
}

// ─── Step 3 — Confirmation ─────────────────────────────────────────────────

function Step3Confirmation({
  agentName,
  confirmation,
}: {
  agentName: string;
  confirmation: {
    date: string;
    time: string;
    meeting_type: "phone" | "video";
  };
}) {
  return (
    <Card className="border-ghw-forest/40 ring-2 ring-ghw-forest/20">
      <CardContent className="p-8 text-center space-y-3">
        <div className="h-14 w-14 rounded-full bg-ghw-forest/20 flex items-center justify-center mx-auto">
          <CheckCircle2 className="h-7 w-7 text-ghw-forest" />
        </div>
        <h2 className="text-xl font-bold">You&apos;re booked!</h2>
        <p className="text-sm text-muted-foreground">
          {agentName} will{" "}
          {confirmation.meeting_type === "phone"
            ? "call you"
            : "send a video link"}{" "}
          on
        </p>
        <p className="text-base font-semibold">
          {new Date(
            `${confirmation.date}T${confirmation.time}:00`,
          ).toLocaleString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
        <div className="pt-3">
          <Badge
            variant="outline"
            className="bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
          >
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Confirmation sent
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground pt-2 max-w-md mx-auto">
          We&apos;ll send a reminder 24 hours and 1 hour before your
          appointment. To reschedule, reply to the confirmation email.
        </p>
      </CardContent>
    </Card>
  );
}
