"use client";

/**
 * Carriers tab — one card per carrier with YTD financials, a
 * collection-rate progress bar, and quick actions:
 *  - View Ledger → calls onViewLedger(carrier_name) to deep-link
 *    into the Ledger tab pre-filtered to this carrier.
 *  - Create Dispute → only shown when gap_ytd > $500. Links to the
 *    Disputes tab; the create-dispute flow happens there so the
 *    modal lives next to the rest of the dispute state.
 *
 * Ports `AccountingDashboard.jsx` CarriersTab — same 3-col grid,
 * same per-card metric layout. Theme-aware colors via Tailwind
 * tokens instead of CRA's hardcoded gradients.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { accounting } from "@/lib/api";
import type { CarriersResponse, CarrierRow } from "@/lib/api/accounting";

import { fmt, fmtDate, fmtPct } from "./_helpers";

interface CarriersTabProps {
  onViewLedger: (carrierName: string) => void;
  onCreateDispute: () => void;
}

export function CarriersTab({
  onViewLedger,
  onCreateDispute,
}: CarriersTabProps) {
  const query = useQuery<CarriersResponse>({
    queryKey: ["accounting", "carriers"],
    queryFn: () => accounting.getCarriers(),
  });

  const carriers = query.data?.carriers ?? [];
  const loading = query.isLoading;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {carriers.length} carrier{carriers.length === 1 ? "" : "s"} · YTD
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={loading}
        >
          <RefreshCcw
            className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {loading && carriers.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-lg" />
          ))}
        </div>
      ) : carriers.length === 0 ? (
        <p className="text-sm text-muted-foreground p-6 text-center">
          No carrier activity yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {carriers.map((c) => (
            <CarrierCard
              key={c.carrier_name}
              carrier={c}
              onViewLedger={() => onViewLedger(c.carrier_name)}
              onCreateDispute={onCreateDispute}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CarrierCard({
  carrier: c,
  onViewLedger,
  onCreateDispute,
}: {
  carrier: CarrierRow;
  onViewLedger: () => void;
  onCreateDispute: () => void;
}) {
  const pct =
    c.expected_ytd > 0
      ? Math.min(100, (c.received_ytd / c.expected_ytd) * 100)
      : 0;
  const showCreateDispute = (c.gap_ytd ?? 0) > 500;
  return (
    <Card data-testid={`carrier-card-${c.carrier_name}`}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold truncate font-display">
            {c.carrier_name}
          </h3>
          <Badge variant="outline" className="text-[10px]">
            {c.total_policies} polic{c.total_policies === 1 ? "y" : "ies"}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-1 text-xs">
          <Metric label="Expected YTD" value={fmt(c.expected_ytd)} />
          <Metric label="Received YTD" value={fmt(c.received_ytd)} />
          <Metric
            label="Gap"
            value={fmt(c.gap_ytd)}
            valueClass={
              (c.gap_ytd ?? 0) > 0 ? "text-destructive" : undefined
            }
          />
          <Metric label="Collection" value={fmtPct(c.collection_rate)} />
        </div>
        <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
          <div
            className={cn(
              "h-full",
              pct >= 90
                ? "bg-ghw-forest"
                : pct >= 75
                  ? "bg-ghw-copper"
                  : "bg-destructive",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-[11px] text-muted-foreground">
          Last payment {fmtDate(c.last_payment_date)} · avg{" "}
          {c.avg_days_to_pay == null ? "—" : `${c.avg_days_to_pay}d`} to pay
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={onViewLedger}
            data-testid={`carrier-ledger-${c.carrier_name}`}
          >
            View Ledger
          </Button>
          {showCreateDispute ? (
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={onCreateDispute}
              data-testid={`carrier-dispute-${c.carrier_name}`}
            >
              Create Dispute
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={cn("font-semibold tabular-nums", valueClass)}>
        {value}
      </div>
    </div>
  );
}
