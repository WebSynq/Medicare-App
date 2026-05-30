"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { policies as policiesApi } from "@/lib/api";
import { CommissionCalculator } from "@/components/commissions/calculator";
import type { Lead, PolicyRecord } from "@/types";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function policyStatusTint(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "active") return "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30";
  if (s === "pending") return "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30";
  if (s === "terminated" || s === "cancelled" || s === "lapsed") {
    return "bg-destructive/15 text-destructive border-destructive/30";
  }
  return "bg-muted text-muted-foreground border-border";
}

export function PoliciesTab({ lead }: { lead: Lead }) {
  const query = useQuery({
    queryKey: ["policies", lead.id],
    queryFn: () => policiesApi.listByLead(lead.id),
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 md:gap-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            Policies
            {query.data ? (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                ({query.data.policies.length})
              </span>
            ) : null}
          </h3>
        </div>

        {query.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded" />
            ))}
          </div>
        ) : query.isError || query.data?.policies.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <Wallet className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-sm">
                {query.isError
                  ? "Couldn't load policies."
                  : "No policies on file."}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Submitted applications land here as policy rows.
              </p>
            </CardContent>
          </Card>
        ) : (
          query.data?.policies.map((p, i) => (
            <PolicyCard key={`${p.id}-${i}`} policy={p} />
          ))
        )}
      </div>

      <div>
        <CommissionCalculator
          defaultState={lead.state ?? ""}
          leadId={lead.id}
          leadSource={lead.lead_source}
        />
      </div>
    </div>
  );
}

function PolicyCard({ policy }: { policy: PolicyRecord }) {
  const premiumLabel = (() => {
    const v = policy.premium;
    if (v == null) return "—";
    const n = typeof v === "string" ? Number(v) : v;
    if (Number.isFinite(n)) return USD.format(Number(n));
    return String(v);
  })();
  return (
    <Card className="border-border/70">
      <CardContent className="p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">
              {policy.product_label ?? policy.product_type ?? "Policy"}
            </h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {policy.carrier ?? "Unknown carrier"}
              {policy.plan_type ? ` · ${policy.plan_type}` : ""}
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] capitalize",
              policyStatusTint(policy.policy_status),
            )}
          >
            {policy.policy_status ?? "—"}
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div>
            <div className="text-muted-foreground">Premium</div>
            <div className="font-medium tabular-nums">{premiumLabel}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Effective</div>
            <div className="font-medium">{policy.effective_date ?? "—"}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
