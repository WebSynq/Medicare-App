"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  Building2,
  CreditCard,
  Loader2,
  Save,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { agency as agencyApi, isApiError } from "@/lib/api";
import type { AgencyUsage } from "@/types";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function billingStatusTint(status: string): string {
  switch (status) {
    case "active":
      return "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30";
    case "trialing":
      return "bg-primary/15 text-primary border-primary/30";
    case "past_due":
      return "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30";
    case "suspended":
    case "cancelled":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export function AgencySettingsTab() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["agency", "settings"],
    queryFn: () => agencyApi.getSettings(),
  });
  const usageQuery = useQuery({
    queryKey: ["agency", "usage"],
    queryFn: () => agencyApi.getUsage(),
  });

  const [name, setName] = React.useState("");

  React.useEffect(() => {
    if (settingsQuery.data) setName(settingsQuery.data.name);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => agencyApi.patchSettings({ name: name.trim() }),
    onSuccess: (data) => {
      qc.setQueryData(["agency", "settings"], data);
      toast.success("Agency saved.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Save failed."),
  });

  if (settingsQuery.isLoading) {
    return <Skeleton className="h-96 w-full max-w-3xl" />;
  }
  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Couldn&apos;t load agency settings.
        </CardContent>
      </Card>
    );
  }

  const s = settingsQuery.data;
  const dirty = name.trim() !== s.name;

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardContent className="p-5 md:p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Agency</h3>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!dirty || !name.trim() || saveMutation.isPending}
              size="sm"
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 md:p-6 space-y-4">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Plan &amp; billing</h3>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Tier, billing status, and price are managed by the platform team.
            Contact support to upgrade or downgrade.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <InfoTile label="Tier" value={<span className="capitalize">{s.tier}</span>} />
            <InfoTile
              label="Status"
              value={
                <Badge
                  variant="outline"
                  className={cn("text-[10px] capitalize", billingStatusTint(s.billing_status))}
                >
                  {s.billing_status.replace("_", " ")}
                </Badge>
              }
            />
            <InfoTile
              label="Monthly base"
              value={USD.format((s.monthly_base_amount_cents ?? 0) / 100)}
            />
            <InfoTile
              label="Seats"
              value={`${s.seats_active} / ${s.seats_max === -1 ? "∞" : s.seats_max}`}
            />
            <InfoTile
              label="Email FROM"
              value={
                s.from_email ? (
                  <>
                    {s.from_email}{" "}
                    {s.email_domain_verified ? (
                      <Badge
                        variant="outline"
                        className="bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30 text-[9px] ml-1"
                      >
                        verified
                      </Badge>
                    ) : null}
                  </>
                ) : (
                  "Platform default"
                )
              }
            />
            <InfoTile
              label="Trial ends"
              value={
                s.trial_ends_at
                  ? new Date(s.trial_ends_at).toLocaleDateString()
                  : "—"
              }
            />
          </div>
        </CardContent>
      </Card>

      <UsageCard
        loading={usageQuery.isLoading}
        usage={usageQuery.data}
        isError={usageQuery.isError}
      />
    </div>
  );
}

function InfoTile({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-md bg-secondary/30 p-3 border border-border/40">
      <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
        {label}
      </p>
      <p className="font-medium mt-0.5 truncate">{value}</p>
    </div>
  );
}

function UsageCard({
  loading,
  usage,
  isError,
}: {
  loading: boolean;
  usage: AgencyUsage | undefined;
  isError: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-5 md:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Usage this period</h3>
          {usage?.billing_period ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {usage.billing_period}
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : isError || !usage ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            Couldn&apos;t load usage.
          </p>
        ) : (
          <div className="space-y-2.5">
            <UsageBar
              label="AI calls"
              value={usage.usage.ai_calls_total}
              limit={usage.limits.ai_calls_included}
            />
            <UsageBar
              label="Emails sent"
              value={usage.usage.emails_sent}
              limit={usage.limits.emails_included}
            />
            <UsageBar
              label="App intakes"
              value={usage.usage.app_intakes}
              limit={usage.limits.app_intakes_included}
            />
            <UsageBar
              label="Storage"
              value={usage.usage.storage_gb}
              limit={usage.limits.storage_gb_included}
              unit="GB"
              fractional
            />
            <UsageBar
              label="Seats used"
              value={usage.seats.active}
              limit={usage.seats.max === -1 ? -1 : usage.seats.max}
            />

            {usage.usage.total_overage_usd != null &&
            usage.usage.total_overage_usd > 0 ? (
              <div className="rounded-md bg-ghw-copper/10 border border-ghw-copper/30 p-3 mt-3">
                <p className="text-xs">
                  <span className="font-semibold text-ghw-copper">
                    {USD.format(usage.usage.total_overage_usd)}
                  </span>{" "}
                  in overage charges this period.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageBar({
  label,
  value,
  limit,
  unit,
  fractional,
}: {
  label: string;
  value: number;
  limit: number;
  unit?: string;
  fractional?: boolean;
}) {
  const unlimited = limit === -1;
  const pct = unlimited
    ? 0
    : limit > 0
      ? Math.min(100, Math.round((value / limit) * 100))
      : 0;
  const over = !unlimited && pct >= 100;
  const near = !unlimited && pct >= 80 && pct < 100;

  function fmt(v: number) {
    if (fractional) return v.toFixed(2);
    return v.toLocaleString();
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs mb-1">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {fmt(value)}
          {unit ? ` ${unit}` : ""}
          {unlimited ? (
            <span className="ml-1 text-[10px]"> / unlimited</span>
          ) : (
            <>
              {" "}
              / {fmt(limit)}
              {unit ? ` ${unit}` : ""}
            </>
          )}
        </span>
      </div>
      {!unlimited ? (
        <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full",
              over
                ? "bg-destructive"
                : near
                  ? "bg-ghw-copper"
                  : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
