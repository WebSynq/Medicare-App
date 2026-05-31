"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  CalendarDays,
  Phone,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { renewals as renewalsApi, isApiError } from "@/lib/api";
import type {
  EnrollmentCountdown,
  RenewalAlertRow,
} from "@/lib/api/renewals";
import { ImpersonationBanner } from "@/components/impersonation-banner";

type ProductFilter = "all" | "ma" | "pdp" | "medsupp";

const PRODUCT_OPTIONS: { value: ProductFilter; label: string }[] = [
  { value: "all", label: "All products" },
  { value: "ma", label: "Medicare Advantage" },
  { value: "pdp", label: "Prescription Drug Plan" },
  { value: "medsupp", label: "Medicare Supplement" },
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

function productMatches(filter: ProductFilter, row: RenewalAlertRow): boolean {
  if (filter === "all") return true;
  const value = (row.product_type ?? row.product_label ?? "")
    .toString()
    .toLowerCase();
  if (filter === "ma")
    return ["ma", "medicare advantage", "medicare_advantage"].includes(value);
  if (filter === "pdp")
    return ["pdp", "prescription drug plan", "prescription_drug"].includes(
      value,
    );
  if (filter === "medsupp")
    return [
      "med_supp",
      "medsupp",
      "medicare supplement",
      "med supp",
    ].includes(value);
  return true;
}

export default function RenewalCalendarPage() {
  const [productFilter, setProductFilter] = React.useState<ProductFilter>("all");

  const query = useQuery({
    queryKey: ["renewals", "alerts"],
    queryFn: renewalsApi.getAlerts,
  });

  React.useEffect(() => {
    if (query.error) {
      toast.error(
        isApiError(query.error)
          ? query.error.message
          : "Could not load renewals",
      );
    }
  }, [query.error]);

  const rows: RenewalAlertRow[] = React.useMemo(
    () =>
      (query.data?.renewal_alerts ?? []).filter((row) =>
        productMatches(productFilter, row),
      ),
    [query.data, productFilter],
  );

  return (
    <div className="max-w-[1400px] mx-auto space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <CalendarClock className="h-4 w-4 text-primary" />
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Calendar
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight font-display">
            Renewal Calendar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Policy anniversaries inside the next 90 days plus AEP and OEP
            countdowns.
          </p>
          <ImpersonationBanner />
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/calendar">
              <CalendarDays className="h-3.5 w-3.5 mr-1.5" />
              Calendar View
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5 mr-1.5",
                query.isFetching && "animate-spin",
              )}
            />
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CountdownCard
          title="Annual Enrollment Period"
          window="Oct 15 – Dec 7"
          countdown={query.data?.aep_countdown}
          label="AEP"
          loading={query.isLoading}
        />
        <CountdownCard
          title="Open Enrollment Period"
          window="Jan 1 – Mar 31"
          countdown={query.data?.oep_countdown}
          label="OEP"
          loading={query.isLoading}
        />
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="text-xs text-muted-foreground">
            MA clients on file:{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {query.data?.total_ma_clients ?? 0}
            </span>
            {" · "}
            PDP:{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {query.data?.total_pdp_clients ?? 0}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Filter</span>
            <Select
              value={productFilter}
              onValueChange={(v) => setProductFilter(v as ProductFilter)}
            >
              <SelectTrigger className="w-44 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRODUCT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <h3 className="text-sm font-semibold">Upcoming Renewals</h3>
            <Badge variant="outline" className="text-xs">
              {query.isLoading ? "…" : rows.length}
            </Badge>
          </div>
          {query.isLoading ? (
            <div className="px-5 pb-5 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-8 text-center">
              No renewals in the next 90 days for this filter.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead>Renewal</TableHead>
                    <TableHead className="text-right">Days Until</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, i) => (
                    <TableRow key={row.lead_id ?? `${row.full_name}-${i}`}>
                      <TableCell className="font-medium text-sm">
                        {row.full_name || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.product_label || row.product_type || "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.carrier || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtDate(row.effective_date)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {fmtDate(row.renewal_date)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm font-semibold">
                        {row.days_until_renewal}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.lead_id && (
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                          >
                            <Link href={`/clients/${row.lead_id}`}>
                              <Phone className="h-3 w-3 mr-1" />
                              Contact
                            </Link>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CountdownCard({
  title,
  window,
  countdown,
  label,
  loading,
}: {
  title: string;
  window: string;
  countdown: EnrollmentCountdown | undefined;
  label: string;
  loading: boolean;
}) {
  if (loading) {
    return <Skeleton className="h-20 w-full" />;
  }
  const active = countdown?.is_active ?? false;
  return (
    <Card className={cn(active && "border-primary/60 bg-primary/5")}>
      <CardContent className="p-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            {title}
          </div>
          <div className="text-sm font-semibold mt-0.5">{window}</div>
        </div>
        {active ? (
          <Badge className="rounded-full bg-primary text-primary-foreground animate-pulse">
            {label} ACTIVE
          </Badge>
        ) : (
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">
              {countdown?.days_until ?? "—"}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              days until {label}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
