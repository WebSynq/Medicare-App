"use client";

/**
 * Status badges used across Overview, Ledger, Disputes, and the
 * Statements reconciliation results. Lifted into their own file so
 * every consumer can drop them in without duplicating the
 * class-name maps.
 */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LedgerStatus, DisputeStatus } from "@/lib/api/accounting";

const LEDGER_STATUS_CLS: Record<LedgerStatus, string> = {
  paid: "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30",
  pending: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
  gap: "bg-destructive/15 text-destructive border-destructive/30",
  underpaid: "bg-destructive/15 text-destructive border-destructive/30",
  overpaid: "bg-primary/15 text-primary border-primary/30",
  chargeback: "bg-purple-500/15 text-purple-500 border-purple-500/30",
  unmatched: "bg-muted text-muted-foreground border-border",
};

const DISPUTE_STATUS_CLS: Record<DisputeStatus, string> = {
  open: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
  in_progress: "bg-primary/15 text-primary border-primary/30",
  resolved: "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30",
  closed: "bg-muted text-muted-foreground border-border",
};

export function LedgerStatusBadge({ status }: { status: LedgerStatus | string }) {
  const cls =
    LEDGER_STATUS_CLS[status as LedgerStatus] ?? LEDGER_STATUS_CLS.pending;
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full capitalize border text-[11px] font-medium",
        cls,
      )}
    >
      {(status || "pending").replace(/_/g, " ")}
    </Badge>
  );
}

export function DisputeStatusBadge({
  status,
}: {
  status: DisputeStatus | string;
}) {
  const cls =
    DISPUTE_STATUS_CLS[status as DisputeStatus] ?? DISPUTE_STATUS_CLS.open;
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full capitalize border text-[11px] font-medium",
        cls,
      )}
    >
      {(status || "open").replace(/_/g, " ")}
    </Badge>
  );
}
