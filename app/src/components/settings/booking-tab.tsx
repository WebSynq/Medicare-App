"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clipboard,
  ClipboardCheck,
  ExternalLink,
  Loader2,
  Save,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { isApiError, profile as profileApi } from "@/lib/api";
import type { WeekdayKey, WorkingHours } from "@/types";

const WEEKDAYS: { key: WeekdayKey; label: string }[] = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];

const DEFAULT_HOURS: WorkingHours = {
  monday: { enabled: true, start: "09:00", end: "17:00" },
  tuesday: { enabled: true, start: "09:00", end: "17:00" },
  wednesday: { enabled: true, start: "09:00", end: "17:00" },
  thursday: { enabled: true, start: "09:00", end: "17:00" },
  friday: { enabled: true, start: "09:00", end: "17:00" },
  saturday: { enabled: false, start: "09:00", end: "13:00" },
  sunday: { enabled: false, start: "09:00", end: "13:00" },
};

const MEETING_TYPE_OPTIONS = ["phone", "video", "in_person"];

export function BookingSettingsTab() {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["profile", "me"],
    queryFn: () => profileApi.getMe(),
  });

  const [draft, setDraft] = React.useState({
    is_enabled: true,
    bio: "",
    phone_number: "",
    video_link: "",
    appointment_duration: 30,
    buffer_minutes: 5,
    max_per_day: 8,
    advance_notice_hours: 2,
    booking_window_days: 30,
    meeting_types: ["phone"] as string[],
    working_hours: DEFAULT_HOURS,
  });

  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    const s = meQuery.data?.booking_settings;
    if (s) {
      setDraft({
        is_enabled: s.is_enabled ?? true,
        bio: s.bio ?? "",
        phone_number: s.phone_number ?? "",
        video_link: s.video_link ?? "",
        appointment_duration:
          s.duration_minutes ?? s.appointment_duration ?? 30,
        buffer_minutes: s.buffer_minutes ?? 5,
        max_per_day: s.max_bookings_per_day ?? s.max_per_day ?? 8,
        advance_notice_hours: s.advance_notice_hours ?? 2,
        booking_window_days: s.booking_window_days ?? 30,
        meeting_types: s.meeting_types ?? ["phone"],
        working_hours: (s.working_hours as WorkingHours | undefined) ?? DEFAULT_HOURS,
      });
    }
  }, [meQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      profileApi.patchBookingSettings({
        is_enabled: draft.is_enabled,
        bio: draft.bio,
        phone_number: draft.phone_number,
        video_link: draft.video_link,
        appointment_duration: draft.appointment_duration,
        buffer_minutes: draft.buffer_minutes,
        max_per_day: draft.max_per_day,
        advance_notice_hours: draft.advance_notice_hours,
        booking_window_days: draft.booking_window_days,
        meeting_types: draft.meeting_types,
        working_hours: draft.working_hours,
      }),
    onSuccess: (data) => {
      qc.setQueryData(["profile", "me"], data);
      toast.success("Booking settings saved.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Save failed."),
  });

  if (meQuery.isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  const slug = meQuery.data?.booking_settings?.slug ?? "";
  const publicUrl = slug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/book/${slug}`
    : "";

  async function copyLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard blocked.");
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Public link card */}
      {slug ? (
        <Card className="border-primary/30 ring-1 ring-primary/15">
          <CardContent className="p-5 space-y-2">
            <p className="text-[11px] text-muted-foreground uppercase tracking-widest">
              Your public booking link
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-sm font-mono break-all bg-secondary/40 rounded px-2 py-1 flex-1 min-w-[260px]">
                {publicUrl}
              </code>
              <Button variant="outline" size="sm" onClick={copyLink}>
                {copied ? (
                  <ClipboardCheck className="h-3 w-3 mr-1 text-ghw-forest" />
                ) : (
                  <Clipboard className="h-3 w-3 mr-1" />
                )}
                Copy
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Open
                </a>
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Slug is auto-generated and immutable. Disable the page below
              to take it offline.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Page settings */}
      <Card>
        <CardContent className="p-5 md:p-6 space-y-4">
          <h3 className="text-sm font-semibold">Page settings</h3>

          <div className="flex items-center gap-2">
            <Checkbox
              id="page-enabled"
              checked={draft.is_enabled}
              onCheckedChange={(v) =>
                setDraft((p) => ({ ...p, is_enabled: v === true }))
              }
            />
            <Label htmlFor="page-enabled" className="text-sm cursor-pointer">
              Public booking page is enabled
            </Label>
          </div>

          <Field label="Bio (shown on your public page)">
            <Textarea
              value={draft.bio}
              onChange={(e) =>
                setDraft((p) => ({ ...p, bio: e.target.value.slice(0, 1000) }))
              }
              rows={3}
              placeholder="One paragraph about your specialty…"
            />
            <p className="text-[10px] text-muted-foreground text-right">
              {draft.bio.length} / 1000
            </p>
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Phone number">
              <Input
                type="tel"
                value={draft.phone_number}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, phone_number: e.target.value }))
                }
              />
            </Field>
            <Field label="Video link (Zoom / Meet / etc.)">
              <Input
                type="url"
                value={draft.video_link}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, video_link: e.target.value }))
                }
                placeholder="https://"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* Meeting types */}
      <Card>
        <CardContent className="p-5 md:p-6 space-y-3">
          <h3 className="text-sm font-semibold">Meeting types</h3>
          <p className="text-xs text-muted-foreground">
            Which channels clients can pick when booking.
          </p>
          <div className="flex flex-wrap gap-2">
            {MEETING_TYPE_OPTIONS.map((mt) => {
              const active = draft.meeting_types.includes(mt);
              return (
                <Button
                  key={mt}
                  type="button"
                  variant={active ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    setDraft((p) => ({
                      ...p,
                      meeting_types: active
                        ? p.meeting_types.filter((x) => x !== mt)
                        : [...p.meeting_types, mt],
                    }))
                  }
                  className="capitalize"
                >
                  {mt.replace("_", " ")}
                </Button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Duration / buffer / caps */}
      <Card>
        <CardContent className="p-5 md:p-6 space-y-4">
          <h3 className="text-sm font-semibold">Timing</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Duration (min)">
              <Input
                type="number"
                min={15}
                max={240}
                value={draft.appointment_duration}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    appointment_duration: Number(e.target.value) || 30,
                  }))
                }
              />
            </Field>
            <Field label="Buffer (min)">
              <Input
                type="number"
                min={0}
                max={120}
                value={draft.buffer_minutes}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    buffer_minutes: Number(e.target.value) || 0,
                  }))
                }
              />
            </Field>
            <Field label="Max per day">
              <Input
                type="number"
                min={1}
                max={50}
                value={draft.max_per_day}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    max_per_day: Number(e.target.value) || 1,
                  }))
                }
              />
            </Field>
            <Field label="Advance notice (hours)">
              <Input
                type="number"
                min={0}
                max={720}
                value={draft.advance_notice_hours}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    advance_notice_hours: Number(e.target.value) || 0,
                  }))
                }
              />
            </Field>
            <Field label="Booking window (days)">
              <Input
                type="number"
                min={1}
                max={365}
                value={draft.booking_window_days}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    booking_window_days: Number(e.target.value) || 30,
                  }))
                }
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* Working hours */}
      <Card>
        <CardContent className="p-5 md:p-6 space-y-3">
          <h3 className="text-sm font-semibold">Working hours</h3>
          <div className="space-y-1.5">
            {WEEKDAYS.map(({ key, label }) => {
              const day = draft.working_hours[key] ?? DEFAULT_HOURS[key];
              return (
                <div
                  key={key}
                  className={cn(
                    "flex flex-wrap items-center gap-3 px-3 py-2 rounded-md border border-border/60",
                    !day.enabled && "opacity-60",
                  )}
                >
                  <Checkbox
                    id={`day-${key}`}
                    checked={day.enabled}
                    onCheckedChange={(v) =>
                      setDraft((p) => ({
                        ...p,
                        working_hours: {
                          ...p.working_hours,
                          [key]: { ...day, enabled: v === true },
                        },
                      }))
                    }
                  />
                  <Label
                    htmlFor={`day-${key}`}
                    className="w-10 text-xs font-medium uppercase cursor-pointer tracking-wider"
                  >
                    {label}
                  </Label>
                  <Input
                    type="time"
                    value={day.start}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        working_hours: {
                          ...p.working_hours,
                          [key]: { ...day, start: e.target.value },
                        },
                      }))
                    }
                    disabled={!day.enabled}
                    className="w-32 h-9"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={day.end}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        working_hours: {
                          ...p.working_hours,
                          [key]: { ...day, end: e.target.value },
                        },
                      }))
                    }
                    disabled={!day.enabled}
                    className="w-32 h-9"
                  />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5 mr-1.5" />
          )}
          Save booking settings
        </Button>
      </div>
    </div>
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
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
