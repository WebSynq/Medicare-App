"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Users,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  calendars as calendarsApi,
  isApiError,
} from "@/lib/api";
import { useAuthStore, selectHasAgencyScope } from "@/stores/auth";
import type {
  Calendar,
  CalendarSourceLabel,
  CalendarType,
} from "@/types";

const TYPE_LABEL: Record<CalendarType, string> = {
  individual: "Individual",
  round_robin: "Round-robin",
  group: "Group",
};

const TYPE_TINT: Record<CalendarType, string> = {
  individual: "bg-primary/15 text-primary border-primary/30",
  round_robin: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
  group: "bg-chart-4/15 text-chart-4 border-chart-4/30",
};

const SOURCE_TINT: Record<CalendarSourceLabel, string> = {
  autobook: "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30",
  va: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  ae: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
  manual: "bg-muted text-muted-foreground border-border",
};

export function CalendarsSettingsTab() {
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [distributionFor, setDistributionFor] = React.useState<Calendar | null>(
    null,
  );

  const query = useQuery({
    queryKey: ["calendars", "list"],
    queryFn: () => calendarsApi.listCalendars(),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <Card>
        <CardContent className="p-5 flex flex-wrap items-start gap-3 justify-between">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              Calendars
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Individual calendars host your personal slots. Round-robin
              calendars distribute bookings across a team via deficit-
              weighted assignment.
            </p>
          </div>
          {hasAgencyScope ? (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New calendar
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : query.isError || (query.data?.calendars ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <CalendarDays className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-sm">
              {query.isError
                ? "Couldn't load calendars."
                : "No calendars yet."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {hasAgencyScope
                ? "Create your first calendar above."
                : "Ask your agency admin to create one."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {query.data?.calendars.map((cal) => (
            <CalendarRow
              key={cal.id}
              calendar={cal}
              canManage={hasAgencyScope}
              onOpenDistribution={() => setDistributionFor(cal)}
            />
          ))}
        </ul>
      )}

      <CreateCalendarDialog open={createOpen} onOpenChange={setCreateOpen} />
      <DistributionDialog
        calendar={distributionFor}
        onOpenChange={(o) => !o && setDistributionFor(null)}
      />
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────

function CalendarRow({
  calendar,
  canManage,
  onOpenDistribution,
}: {
  calendar: Calendar;
  canManage: boolean;
  onOpenDistribution: () => void;
}) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => calendarsApi.deactivateCalendar(calendar.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calendars"] });
      toast.success("Calendar deactivated.");
      setConfirmDelete(false);
    },
    onError: (err) => {
      if (isApiError(err)) {
        const detail = err.body?.detail;
        const blocking =
          typeof detail === "object" && detail !== null
            ? detail.blocking_appointments
            : undefined;
        if (typeof blocking === "number" && blocking > 0) {
          toast.error(
            `${blocking} upcoming appointment${blocking === 1 ? "" : "s"} still reference this calendar. Reschedule or cancel them first.`,
          );
          return;
        }
        toast.error(err.message);
      } else {
        toast.error("Couldn't deactivate.");
      }
    },
  });

  return (
    <li>
      <Card
        className={cn(
          "border-border/70",
          !calendar.is_active && "opacity-60",
        )}
      >
        <CardContent className="p-4 flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h4 className="text-sm font-semibold">{calendar.name}</h4>
              <Badge
                variant="outline"
                className={cn("text-[10px]", TYPE_TINT[calendar.type])}
              >
                {TYPE_LABEL[calendar.type]}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] uppercase tracking-wider",
                  SOURCE_TINT[calendar.source_label],
                )}
              >
                {calendar.source_label}
              </Badge>
              {!calendar.is_active ? (
                <Badge
                  variant="outline"
                  className="bg-muted text-muted-foreground text-[10px]"
                >
                  inactive
                </Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">/book/{calendar.slug}</code>
              {calendar.type !== "individual" ? (
                <>
                  {" "}
                  · {calendar.member_ids.length} member
                  {calendar.member_ids.length === 1 ? "" : "s"}
                </>
              ) : null}
            </p>
          </div>

          {canManage ? (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {calendar.type === "round_robin" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onOpenDistribution}
                  className="text-xs h-8"
                >
                  <Users className="h-3 w-3 mr-1" />
                  Distribution
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                className="h-8 text-destructive hover:bg-destructive/10"
                disabled={!calendar.is_active}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Deactivate {calendar.name}?</DialogTitle>
            <DialogDescription>
              Soft delete — the row stays for history; bookings on this URL
              stop. Active future appointments block this action.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              )}
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

// ─── Create dialog ─────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9-]+$/;

function CreateCalendarDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<CalendarType>("individual");
  const [slug, setSlug] = React.useState("");
  const [sourceLabel, setSourceLabel] =
    React.useState<CalendarSourceLabel>("manual");

  React.useEffect(() => {
    if (!open) {
      setName("");
      setType("individual");
      setSlug("");
      setSourceLabel("manual");
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      calendarsApi.createCalendar({
        name: name.trim(),
        type,
        slug: slug.trim(),
        source_label: sourceLabel,
        // Send a sensible default member list. Admin can edit after.
        member_ids: type === "individual" ? [] : [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calendars"] });
      toast.success("Calendar created.");
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err) && err.status === 409) {
        toast.error("That slug is already in use.");
        return;
      }
      toast.error(isApiError(err) ? err.message : "Create failed.");
    },
  });

  const slugValid = SLUG_RE.test(slug) && slug.length >= 3 && slug.length <= 60;
  const canSubmit = name.trim().length > 0 && slugValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New calendar</DialogTitle>
          <DialogDescription>
            Individual hosts personal slots. Round-robin distributes bookings
            across a team. Members can be added after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Tim Arnold — Open hours"
              maxLength={120}
            />
          </Field>
          <Field label="Type">
            <Select
              value={type}
              onValueChange={(v) => setType(v as CalendarType)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="individual">Individual</SelectItem>
                <SelectItem value="round_robin">Round-robin</SelectItem>
                <SelectItem value="group">Group</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Slug (URL path)">
            <Input
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().slice(0, 60))
              }
              placeholder="tim-arnold"
              className="font-mono"
            />
            <p
              className={cn(
                "text-[10px]",
                slug && !slugValid
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              3–60 chars, lowercase letters, digits, and hyphens only.
              Becomes /book/{slug || "your-slug"}.
            </p>
          </Field>
          <Field label="Source label (color tag on calendar view)">
            <Select
              value={sourceLabel}
              onValueChange={(v) =>
                setSourceLabel(v as CalendarSourceLabel)
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Self booked (gray)</SelectItem>
                <SelectItem value="autobook">Autobook (green)</SelectItem>
                <SelectItem value="va">VA booked (purple)</SelectItem>
                <SelectItem value="ae">AE booked (orange)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit || mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1.5" />
            )}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Distribution dialog (round-robin) ─────────────────────────────────────

function DistributionDialog({
  calendar,
  onOpenChange,
}: {
  calendar: Calendar | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [weights, setWeights] = React.useState<Record<string, number>>({});

  const distributionQuery = useQuery({
    queryKey: ["calendars", calendar?.id, "distribution"],
    queryFn: () => {
      if (!calendar) throw new Error("no calendar");
      return calendarsApi.getDistribution(calendar.id);
    },
    enabled: !!calendar,
  });

  React.useEffect(() => {
    if (distributionQuery.data) {
      const seed: Record<string, number> = {};
      for (const m of distributionQuery.data.members) {
        seed[m.user_id] = m.weight;
      }
      setWeights(seed);
    }
  }, [distributionQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!calendar) throw new Error("no calendar");
      return calendarsApi.patchDistribution(calendar.id, { weights });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calendars", calendar?.id, "distribution"] });
      qc.invalidateQueries({ queryKey: ["calendars", "list"] });
      toast.success("Distribution saved.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Save failed."),
  });

  const resetMutation = useMutation({
    mutationFn: () => {
      if (!calendar) throw new Error("no calendar");
      return calendarsApi.resetDistribution(calendar.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calendars", calendar?.id, "distribution"] });
      toast.success("Assignment counts reset to zero.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Reset failed."),
  });

  return (
    <Dialog open={!!calendar} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Distribution — {calendar?.name}</DialogTitle>
          <DialogDescription>
            Round-robin uses deficit-weighted assignment. Higher weight = more
            bookings. Deficit shows how far behind (positive) or ahead
            (negative) of expected share each member is.
          </DialogDescription>
        </DialogHeader>

        {distributionQuery.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : distributionQuery.data ? (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_60px_70px_70px] gap-2 px-2 text-[10px] uppercase tracking-widest text-muted-foreground">
              <div>Member</div>
              <div className="text-right">Weight</div>
              <div className="text-right">Bookings</div>
              <div className="text-right">Deficit</div>
            </div>
            {distributionQuery.data.members.map((m) => (
              <div
                key={m.user_id}
                className="grid grid-cols-[1fr_60px_70px_70px] gap-2 items-center px-2 py-2 rounded-md border border-border/40"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{m.full_name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {m.is_available_now ? (
                      <span className="text-ghw-forest">available</span>
                    ) : (
                      <span>off hours</span>
                    )}
                  </p>
                </div>
                <Input
                  type="number"
                  min={1}
                  max={5}
                  value={weights[m.user_id] ?? m.weight}
                  onChange={(e) =>
                    setWeights((p) => ({
                      ...p,
                      [m.user_id]: Math.max(
                        1,
                        Math.min(5, Number(e.target.value) || 1),
                      ),
                    }))
                  }
                  className="h-8 text-right tabular-nums"
                />
                <div className="text-right text-xs tabular-nums">
                  {m.assignment_count}
                </div>
                <div
                  className={cn(
                    "text-right text-xs tabular-nums font-medium",
                    m.deficit > 0.1
                      ? "text-ghw-forest"
                      : m.deficit < -0.1
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {m.deficit > 0 ? "+" : ""}
                  {m.deficit.toFixed(2)}
                </div>
              </div>
            ))}
            <div className="text-[11px] text-muted-foreground px-2 pt-1">
              Total weight {distributionQuery.data.totals.total_weight} ·{" "}
              {distributionQuery.data.totals.total_assignments} total bookings ·{" "}
              {distributionQuery.data.totals.available_now} available now
            </div>
          </div>
        ) : null}

        <DialogFooter className="flex flex-wrap gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
            className="text-xs"
          >
            {resetMutation.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3 mr-1" />
            )}
            Reset counts
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save weights
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

