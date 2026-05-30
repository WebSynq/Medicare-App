"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Inbox,
  Loader2,
  RotateCcw,
  Save,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

/**
 * Round-Robin distribution viewer + editor.
 *
 * Lists every round_robin calendar in the agency. Pick one and the
 * page renders its distribution panel inline (weights 1-5, assignment
 * counts, deficit, "available now" status). Admin/owner can save
 * weight changes and reset assignment counts; agents see a read-only
 * view.
 */
export default function RoundRobinPage() {
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);

  const listQuery = useQuery({
    queryKey: ["calendars", "list", { type: "round_robin" }],
    queryFn: () => calendarsApi.listCalendars({ type: "round_robin" }),
  });

  const calendars = listQuery.data?.calendars ?? [];
  const [selectedId, setSelectedId] = React.useState<string>("");

  React.useEffect(() => {
    if (calendars.length > 0 && !selectedId) {
      setSelectedId(calendars[0]!.id);
    }
  }, [calendars, selectedId]);

  if (listQuery.isLoading) {
    return <Skeleton className="h-64 w-full max-w-3xl" />;
  }

  if (calendars.length === 0) {
    return (
      <Card className="max-w-3xl">
        <CardContent className="p-12 text-center">
          <Users className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium text-sm">No round-robin calendars yet.</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Create one in Settings → Calendars. Round-robin distributes
            bookings across multiple agents via deficit-weighted assignment
            — higher weight, more bookings.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/settings/calendars">Manage calendars</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const selected = calendars.find((c) => c.id === selectedId);

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <Users className="h-4 w-4 text-primary flex-shrink-0" />
          <p className="text-sm font-medium">Calendar</p>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="h-9 w-[260px]">
              <SelectValue placeholder="Pick a round-robin calendar…" />
            </SelectTrigger>
            <SelectContent>
              {calendars.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected ? (
            <div className="flex items-center gap-2 ml-auto text-xs text-muted-foreground">
              <code className="font-mono">/book/{selected.slug}</code>
              <Badge
                variant="outline"
                className="text-[10px] capitalize bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
              >
                {selected.source_label}
              </Badge>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {selected ? (
        <DistributionPanel
          calendarId={selected.id}
          canManage={hasAgencyScope}
        />
      ) : null}
    </div>
  );
}

function DistributionPanel({
  calendarId,
  canManage,
}: {
  calendarId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [weights, setWeights] = React.useState<Record<string, number>>({});

  const query = useQuery({
    queryKey: ["calendars", calendarId, "distribution"],
    queryFn: () => calendarsApi.getDistribution(calendarId),
  });

  React.useEffect(() => {
    if (query.data) {
      const seed: Record<string, number> = {};
      for (const m of query.data.members) seed[m.user_id] = m.weight;
      setWeights(seed);
    }
  }, [query.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      calendarsApi.patchDistribution(calendarId, { weights }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["calendars", calendarId, "distribution"],
      });
      qc.invalidateQueries({ queryKey: ["calendars", "list"] });
      toast.success("Distribution saved.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Save failed."),
  });

  const resetMutation = useMutation({
    mutationFn: () => calendarsApi.resetDistribution(calendarId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["calendars", calendarId, "distribution"],
      });
      toast.success("Assignment counts reset to zero.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Reset failed."),
  });

  if (query.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-destructive">
          <Inbox className="h-8 w-8 mx-auto mb-2" />
          Couldn&apos;t load distribution.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5 md:p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Member distribution</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Higher weight = more bookings. Deficit shows how far behind
            (positive) or ahead (negative) of expected share each member
            sits right now. {canManage ? "Weights take effect immediately on save." : "Read-only — admin/owner controls weights."}
          </p>
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_60px_70px_70px] gap-2 px-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            <div>Member</div>
            <div className="text-right">Weight</div>
            <div className="text-right">Bookings</div>
            <div className="text-right">Deficit</div>
          </div>
          {query.data.members.map((m) => (
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
                disabled={!canManage}
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
        </div>

        <div className="text-[11px] text-muted-foreground px-2">
          Total weight {query.data.totals.total_weight} ·{" "}
          {query.data.totals.total_assignments} total bookings ·{" "}
          {query.data.totals.available_now} available now
        </div>

        {canManage ? (
          <div className="flex justify-between items-center pt-3 border-t border-border flex-wrap gap-2">
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
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              size="sm"
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save weights
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
