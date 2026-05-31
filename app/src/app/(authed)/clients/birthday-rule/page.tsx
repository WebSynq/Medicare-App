"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Cake, Info, Phone, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { birthdayRule as birthdayRuleApi, isApiError } from "@/lib/api";
import type {
  BirthdayAlertsResponse,
  BirthdayLeadRow,
} from "@/lib/api/birthday-rule";
import { ImpersonationBanner } from "@/components/impersonation-banner";

type BucketKey = "urgent" | "soon" | "upcoming";

interface BucketMeta {
  key: BucketKey;
  title: string;
  subtitle: string;
  accent: string;
  badge: string;
  empty: string;
}

const BUCKETS: BucketMeta[] = [
  {
    key: "urgent",
    title: "Window Open Now",
    subtitle:
      "Birthday window is currently active — switch without underwriting.",
    accent: "border-l-4 border-destructive",
    badge: "bg-destructive/15 text-destructive border-destructive/30",
    empty: "No clients in an open window right now.",
  },
  {
    key: "soon",
    title: "Coming Up — 90 Days",
    subtitle: "Birthdays in the next 90 days — start the conversation now.",
    accent: "border-l-4 border-ghw-copper",
    badge: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
    empty: "No clients in this range.",
  },
  {
    key: "upcoming",
    title: "On The Horizon — 180 Days",
    subtitle: "Birthdays 90–180 days out — keep these on your radar.",
    accent: "border-l-4 border-primary",
    badge: "bg-primary/15 text-primary border-primary/30",
    empty: "No clients in this range.",
  },
];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function BirthdayRulePage() {
  const query = useQuery({
    queryKey: ["birthday-rule", "alerts"],
    queryFn: birthdayRuleApi.getAlerts,
  });

  React.useEffect(() => {
    if (query.error) {
      toast.error(
        isApiError(query.error)
          ? query.error.message
          : "Could not load birthday alerts",
      );
    }
  }, [query.error]);

  const data: BirthdayAlertsResponse | undefined = query.data;
  const loading = query.isLoading;

  return (
    <div className="max-w-[1400px] mx-auto space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Cake className="h-4 w-4 text-primary" />
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Illinois
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight font-display">
            Illinois Birthday Rule Tracker
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            63-day switch window after a client&rsquo;s birthday — no
            underwriting required.
          </p>
          <ImpersonationBanner />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5 mr-1.5", query.isFetching && "animate-spin")}
          />
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      <Card className="border-ghw-copper/40 bg-ghw-copper/10">
        <CardContent className="p-4 flex items-start gap-3 text-xs">
          <Info className="h-4 w-4 mt-0.5 text-ghw-copper flex-shrink-0" />
          <p className="leading-snug">
            Illinois law allows Med Supp clients to switch plans without
            underwriting during the 63 days following their birthday.
            Contact these clients now.
          </p>
        </CardContent>
      </Card>

      {BUCKETS.map((meta) => {
        const rows: BirthdayLeadRow[] = data ? data[meta.key] : [];
        return (
          <BucketSection
            key={meta.key}
            meta={meta}
            rows={rows}
            loading={loading}
          />
        );
      })}
    </div>
  );
}

function BucketSection({
  meta,
  rows,
  loading,
}: {
  meta: BucketMeta;
  rows: BirthdayLeadRow[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div>
            <h3 className="text-sm font-semibold">{meta.title}</h3>
            <p className="text-[11px] text-muted-foreground">
              {meta.subtitle}
            </p>
          </div>
          <Badge variant="outline" className="text-xs">
            {loading ? "…" : rows.length}
          </Badge>
        </div>
        <div className={cn("p-4 space-y-2", meta.accent)}>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              {meta.empty}
            </p>
          ) : (
            rows.map((row) => (
              <LeadRow key={row.lead_id} row={row} meta={meta} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LeadRow({
  row,
  meta,
}: {
  row: BirthdayLeadRow;
  meta: BucketMeta;
}) {
  const badgeText =
    meta.key === "urgent"
      ? `${row.days_remaining_in_window ?? 0} days left in window`
      : `${row.days_until_birthday} days until birthday`;

  return (
    <div className="rounded-md border border-border bg-card p-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/clients/${row.lead_id ?? ""}`}
            className="font-medium text-sm hover:text-primary truncate"
          >
            {row.full_name}
          </Link>
          <Badge variant="outline" className={cn("text-[10px]", meta.badge)}>
            {badgeText}
          </Badge>
        </div>
        <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <span>DOB: {fmtDate(row.date_of_birth)}</span>
          {row.current_plan && <span>Plan: {row.current_plan}</span>}
          {row.current_carrier && <span>Carrier: {row.current_carrier}</span>}
          {row.phone && <span>{row.phone}</span>}
          {row.agent_name && <span className="opacity-80">· {row.agent_name}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {row.phone && meta.key === "urgent" && (
          <Button asChild size="sm" className="h-7 text-xs">
            <a href={`tel:${row.phone}`}>
              <Phone className="h-3 w-3 mr-1" /> Call Now
            </a>
          </Button>
        )}
        {row.lead_id && (
          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
            <Link href={`/clients/${row.lead_id}`}>
              <Send className="h-3 w-3 mr-1" />
              {meta.key === "urgent" ? "Send SOA" : "Schedule"}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
