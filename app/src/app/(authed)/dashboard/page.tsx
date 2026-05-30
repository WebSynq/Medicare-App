"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Cake,
  CalendarClock,
  CheckCircle2,
  Clock,
  DollarSign,
  FileText,
  Flame,
  Phone,
  RefreshCw,
  Snowflake,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { today as todayApi } from "@/lib/api";
import { useAuthStore } from "@/stores";
import { QuoteCard } from "@/components/dashboard/quote-card";
import type {
  BriefTopCall,
  DailyBrief,
  LeadUrgencyLevel,
  TodayActionsResponse,
  TodayAppointment,
  TodayRenewalDue,
  TodayStaleLead,
  TodayUrgentCall,
  UserRole,
} from "@/types";

import { AgencySection } from "./_agency-section";
import { PERIOD_TABS, type Period } from "./_period";

// ─── Role gate ────────────────────────────────────────────────────────────
// Mirrors CRA Layout.jsx's COMMAND_CENTER_ROLES_SET (lines 530-532) and
// the backend agency_dashboard_router AGENCY_ROLES. Update all three
// together if leadership composition changes.
const COMMAND_CENTER_ROLES: readonly UserRole[] = [
  "owner",
  "admin",
  "coach",
  "sales_manager",
  "compliance",
  "accounting",
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatLongDate(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatTime12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr ?? "0");
  const m = Number(mStr ?? "0");
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function currentMinutesUTC(): number {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function minutesFromHHMM(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(":");
  return (Number(hStr ?? "0") || 0) * 60 + (Number(mStr ?? "0") || 0);
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

// ─── Urgency styling ──────────────────────────────────────────────────────

const URGENCY_STYLE: Record<
  LeadUrgencyLevel,
  { bg: string; text: string; ring: string; label: string }
> = {
  urgent: {
    bg: "bg-destructive/15",
    text: "text-destructive",
    ring: "ring-destructive/30",
    label: "Urgent",
  },
  high: {
    bg: "bg-primary/15",
    text: "text-primary",
    ring: "ring-primary/30",
    label: "High",
  },
  moderate: {
    bg: "bg-ghw-copper/15",
    text: "text-ghw-copper",
    ring: "ring-ghw-copper/30",
    label: "Moderate",
  },
  low: {
    bg: "bg-muted",
    text: "text-muted-foreground",
    ring: "ring-border",
    label: "Low",
  },
};

// ─── Page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  // Role gate for the agency section. Agents always see the agent
  // section above; leadership roles see both. Selectors are tightly
  // scoped so this component only re-renders when the role changes.
  const role = useAuthStore((s) => s.user?.role ?? null);
  const showAgency =
    role !== null && COMMAND_CENTER_ROLES.includes(role);

  // Period state lives on the page so the header's period selector
  // drives every query in the agency section below. Default to MTD
  // — matches CRA's first-paint behavior.
  const [period, setPeriod] = React.useState<Period>("mtd");

  const actionsQuery = useQuery<TodayActionsResponse>({
    queryKey: ["today", "actions"],
    queryFn: todayApi.getActions,
  });

  const briefQuery = useQuery<DailyBrief>({
    queryKey: ["today", "brief"],
    queryFn: todayApi.getBrief,
    // Brief failures are non-fatal — the action center still renders
    // useful data without the AI priority list.
    retry: false,
  });

  const data = actionsQuery.data;
  const isLoading = actionsQuery.isLoading;
  const isError = actionsQuery.isError;

  // Appointment bucketing happens client-side off the local UTC
  // clock so it stays accurate without re-fetching mid-day.
  const buckets = React.useMemo(
    () => bucketAppointments(data?.todays_appointments ?? []),
    [data],
  );

  return (
    <div className="max-w-[1500px] mx-auto p-4 md:p-6">
      {/* Header */}
      <header className="mb-6 md:mb-8">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-eyebrow">Action Center</span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-display">
              Today
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {data ? (
                formatLongDate(data.today)
              ) : (
                <SkeletonText w="180px" />
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {data && data.mtd_commission > 0 ? (
              <MtdPill amount={data.mtd_commission} />
            ) : null}
            {/* Period selector — drives the Agency Overview queries.
                Hidden for agent roles since the agency section isn't
                rendered for them. */}
            {showAgency ? (
              <PeriodTabs value={period} onChange={setPeriod} />
            ) : null}
          </div>
        </div>
      </header>

      {/* Daily Inspiration — sits above the KPI row per spec.
          Independent query so a quote-API outage doesn't block the
          action center. */}
      <QuoteCard />

      {isError ? (
        <ErrorBanner onRetry={() => actionsQuery.refetch()} />
      ) : (
        <>
          {/* KPI row */}
          <section
            className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-6 md:mb-8"
            data-testid="today-kpi-row"
          >
            <KpiCard
              label="New Leads Today"
              value={data?.new_leads_today ?? null}
              Icon={Flame}
              accent="text-primary"
              loading={isLoading}
              testId="kpi-new-leads"
            />
            <KpiCard
              label="Apps Submitted Today"
              value={data?.apps_submitted_today ?? null}
              Icon={FileText}
              accent="text-ghw-forest"
              loading={isLoading}
              testId="kpi-apps-submitted"
            />
            <KpiCard
              label="Appointments Today"
              value={data?.summary.appointments_count ?? null}
              Icon={CalendarClock}
              accent="text-ghw-copper"
              loading={isLoading}
              testId="kpi-appts"
            />
          </section>

          {/* Main 2-column grid; collapses on mobile */}
          <section className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 md:gap-6">
            <PriorityListCard
              brief={briefQuery.data}
              loading={briefQuery.isLoading}
              error={briefQuery.isError}
            />
            <div className="space-y-4">
              <AppointmentsBucketCard
                buckets={buckets}
                loading={isLoading}
              />
              <UrgentCallsBucketCard
                rows={data?.urgent_calls ?? []}
                count={data?.summary.urgent_count ?? 0}
                loading={isLoading}
              />
              <StaleLeadsBucketCard
                rows={data?.stale_leads ?? []}
                count={data?.summary.stale_count ?? 0}
                loading={isLoading}
              />
              <RenewalsBucketCard
                rows={data?.renewals_due ?? []}
                count={data?.summary.renewals_count ?? 0}
                loading={isLoading}
              />
            </div>
          </section>
        </>
      )}

      {/* Agency Overview — leadership-only second half. Sits below the
          agent's own day so owners/admins still get their personal
          action items at the top of the page. */}
      {showAgency ? <AgencySection period={period} /> : null}
    </div>
  );
}

// ─── Period tabs (header control) ─────────────────────────────────────────

function PeriodTabs({
  value,
  onChange,
}: {
  value: Period;
  onChange: (next: Period) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Agency period filter"
      className="inline-flex items-center gap-1 p-1 rounded-full bg-secondary"
      data-testid="agency-period-tabs"
    >
      {PERIOD_TABS.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.value)}
            className={cn(
              "px-3.5 h-8 text-xs font-medium rounded-full transition-colors tabular-nums",
              selected
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`agency-period-${t.value}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Header pieces ────────────────────────────────────────────────────────

function MtdPill({ amount }: { amount: number }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium tabular-nums bg-ghw-forest/15 text-ghw-forest ring-1 ring-ghw-forest/30"
      data-testid="today-mtd-commission"
    >
      <DollarSign className="h-3.5 w-3.5" />
      <span className="font-bold">{USD.format(amount)}</span>
      Est. MTD
    </span>
  );
}

function SkeletonText({ w }: { w: string }) {
  return (
    <span
      className="inline-block animate-pulse bg-muted rounded h-3 align-middle"
      style={{ width: w }}
    />
  );
}

function ErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 md:p-5 flex items-start gap-3">
      <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">Couldn&apos;t load your Today.</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          The action center failed to fetch. Try again, and if it keeps
          failing tell ops.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
        Retry
      </Button>
    </div>
  );
}

// ─── KPI card ─────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  Icon,
  accent,
  loading,
  testId,
}: {
  label: string;
  value: number | null;
  Icon: LucideIcon;
  accent: string;
  loading: boolean;
  testId?: string;
}) {
  return (
    <Card data-testid={testId} className="border-border/70">
      <CardContent className="p-4 md:p-5">
        <div className="flex items-center justify-between text-xs uppercase tracking-widest text-muted-foreground mb-2">
          <span>{label}</span>
          <Icon className={cn("h-4 w-4", accent)} />
        </div>
        {loading ? (
          <Skeleton className="h-9 w-16" />
        ) : (
          <p className="text-3xl md:text-4xl font-bold tabular-nums font-display">
            {value ?? 0}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Priority list (daily brief) ──────────────────────────────────────────

function PriorityListCard({
  brief,
  loading,
  error,
}: {
  brief: DailyBrief | undefined;
  loading: boolean;
  error: boolean;
}) {
  const calls = brief?.top_calls ?? [];

  return (
    <Card data-testid="today-priority-list" className="border-border/70">
      <CardContent className="p-0">
        <div className="px-5 md:px-6 py-4 flex items-center justify-between border-b border-border/60">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI Priority List
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {brief
                ? `${brief.total_priority} priority · ${brief.total_urgent} urgent`
                : loading
                  ? "Loading your brief…"
                  : "Today's top calls"}
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] hidden sm:inline-flex">
            Top {calls.length || "10"}
          </Badge>
        </div>

        {loading ? (
          <div className="p-5 md:p-6 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        ) : error ? (
          <EmptyBlock
            icon={AlertTriangle}
            title="Brief unavailable"
            description="Your AI brief didn't load. Check your connection and refresh."
          />
        ) : calls.length === 0 ? (
          <EmptyBlock
            icon={CheckCircle2}
            title="You're caught up"
            description="No priority calls today. Good place to prospect."
          />
        ) : (
          <ScrollArea className="max-h-[600px]">
            <ol className="divide-y divide-border/60">
              {calls.map((call, idx) => (
                <PriorityCallRow key={call.lead_id} call={call} rank={idx + 1} />
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function PriorityCallRow({
  call,
  rank,
}: {
  call: BriefTopCall;
  rank: number;
}) {
  const style = URGENCY_STYLE[call.urgency_level];
  return (
    <li className="px-5 md:px-6 py-3 flex items-start gap-3 hover:bg-secondary/40 transition-colors">
      <div
        className={cn(
          "h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ring-1 tabular-nums text-sm font-semibold",
          style.bg,
          style.text,
          style.ring,
        )}
      >
        {rank}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{call.name}</span>
          <Badge variant="outline" className={cn("text-[10px]", style.text)}>
            {style.label} · {call.score}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {call.reason}
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {call.phone ? (
          <Button asChild size="sm" variant="outline" className="h-8 text-xs">
            <a href={`tel:${call.phone}`}>
              <Phone className="h-3 w-3 mr-1" />
              <span className="hidden sm:inline">Call</span>
            </a>
          </Button>
        ) : null}
        <Button asChild size="sm" variant="ghost" className="h-8 text-xs">
          <Link href={`/clients/${call.lead_id}`}>
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </Button>
      </div>
    </li>
  );
}

// ─── Appointment buckets ──────────────────────────────────────────────────

interface AppointmentBuckets {
  upcoming: TodayAppointment[];
  earlier: TodayAppointment[];
  followup: TodayAppointment[];
}

function bucketAppointments(rows: TodayAppointment[]): AppointmentBuckets {
  const nowMin = currentMinutesUTC();
  const upcoming: TodayAppointment[] = [];
  const earlier: TodayAppointment[] = [];
  // "Follow-up" surfaces post-meeting items that need an outcome
  // stamp. The /today/actions projection currently doesn't carry
  // the appointment's outcome field, so we approximate "needs a
  // follow-up touch" with appointments that started >60 min ago and
  // have a notes blob attached (an agent who took notes presumably
  // ran the call). Replace with a real outcome read once the
  // backend projection widens.
  const followup: TodayAppointment[] = [];
  for (const appt of rows) {
    const apptMin = minutesFromHHMM(appt.time);
    if (apptMin > nowMin) {
      upcoming.push(appt);
    } else if (nowMin - apptMin > 60 && appt.notes) {
      followup.push(appt);
    } else {
      earlier.push(appt);
    }
  }
  upcoming.sort((a, b) => minutesFromHHMM(a.time) - minutesFromHHMM(b.time));
  earlier.sort((a, b) => minutesFromHHMM(b.time) - minutesFromHHMM(a.time));
  return { upcoming, earlier, followup };
}

function AppointmentsBucketCard({
  buckets,
  loading,
}: {
  buckets: AppointmentBuckets;
  loading: boolean;
}) {
  const total =
    buckets.upcoming.length + buckets.earlier.length + buckets.followup.length;
  const nextUp = buckets.upcoming[0];
  return (
    <BucketShell
      title="Today's Appointments"
      icon={CalendarClock}
      accent="border-l-ghw-copper"
      loading={loading}
      countLabel={`${total} total`}
      href="/appointments"
    >
      <BucketRow
        label="Upcoming"
        count={buckets.upcoming.length}
        Icon={Clock}
        emphasis="text-primary"
      />
      <BucketRow
        label="Earlier today"
        count={buckets.earlier.length}
        Icon={AlertTriangle}
        emphasis="text-destructive"
      />
      <BucketRow
        label="Needs follow-up"
        count={buckets.followup.length}
        Icon={RefreshCw}
        emphasis="text-ghw-copper"
      />
      {nextUp ? (
        <>
          <Separator className="my-2" />
          <NextUpRow appt={nextUp} />
        </>
      ) : null}
    </BucketShell>
  );
}

function NextUpRow({ appt }: { appt: TodayAppointment }) {
  return (
    <Link
      href={appt.lead_id ? `/clients/${appt.lead_id}` : "/appointments"}
      className="block rounded-md hover:bg-secondary/40 transition-colors -mx-2 px-2 py-1.5"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="uppercase tracking-widest">Next up</span>
        <span className="tabular-nums">{formatTime12h(appt.time)}</span>
      </div>
      <p className="text-sm font-medium truncate mt-0.5">
        {appt.client_name ?? "Untitled appointment"}
      </p>
    </Link>
  );
}

function BucketRow({
  label,
  count,
  Icon,
  emphasis,
}: {
  label: string;
  count: number;
  Icon: LucideIcon;
  emphasis: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2 text-sm">
        <Icon className={cn("h-3.5 w-3.5", emphasis)} />
        <span>{label}</span>
      </div>
      <span
        className={cn(
          "tabular-nums text-sm font-semibold",
          count === 0 ? "text-muted-foreground" : emphasis,
        )}
      >
        {count}
      </span>
    </div>
  );
}

// ─── Other buckets ────────────────────────────────────────────────────────

function UrgentCallsBucketCard({
  rows,
  count,
  loading,
}: {
  rows: TodayUrgentCall[];
  count: number;
  loading: boolean;
}) {
  const top = rows.slice(0, 3);
  return (
    <BucketShell
      title="Birthday Window Open"
      icon={Cake}
      accent="border-l-destructive"
      loading={loading}
      countLabel={`${count} open`}
      href="/clients/birthday-rule"
    >
      {top.length === 0 ? (
        <EmptyInline message="No open windows today." />
      ) : (
        top.map((r) => (
          <BucketLeadRow
            key={r.lead_id}
            href={`/clients/${r.lead_id}`}
            name={r.full_name}
            secondary={[r.current_carrier, r.current_plan]
              .filter(Boolean)
              .join(" · ")}
            badge={`${r.days_remaining_in_window} d left`}
            badgeClass="bg-destructive/15 text-destructive ring-destructive/30"
          />
        ))
      )}
    </BucketShell>
  );
}

function StaleLeadsBucketCard({
  rows,
  count,
  loading,
}: {
  rows: TodayStaleLead[];
  count: number;
  loading: boolean;
}) {
  const top = rows.slice(0, 3);
  return (
    <BucketShell
      title="Stale Leads"
      icon={Snowflake}
      accent="border-l-chart-4"
      loading={loading}
      countLabel={`${count} cooling`}
      href="/clients/pipeline"
    >
      {top.length === 0 ? (
        <EmptyInline message="Nothing's gone cold." />
      ) : (
        top.map((r) => (
          <BucketLeadRow
            key={r.lead_id}
            href={`/clients/${r.lead_id}`}
            name={r.full_name}
            secondary={r.status}
            badge={`${r.days_since_contact} d`}
            badgeClass="bg-chart-4/15 text-chart-4 ring-chart-4/30"
          />
        ))
      )}
    </BucketShell>
  );
}

function RenewalsBucketCard({
  rows,
  count,
  loading,
}: {
  rows: TodayRenewalDue[];
  count: number;
  loading: boolean;
}) {
  const top = rows.slice(0, 3);
  return (
    <BucketShell
      title="Renewals Due"
      icon={RefreshCw}
      accent="border-l-primary"
      loading={loading}
      countLabel={`${count} this month`}
      href="/clients/renewals"
    >
      {top.length === 0 ? (
        <EmptyInline message="No renewals in the next 30 days." />
      ) : (
        top.map((r, i) => (
          <BucketLeadRow
            key={`${r.lead_id ?? "noid"}-${i}`}
            href={r.lead_id ? `/clients/${r.lead_id}` : "/clients/renewals"}
            name={r.full_name}
            secondary={[r.carrier, r.product_label]
              .filter(Boolean)
              .join(" · ")}
            badge={`${r.days_until_renewal} d`}
            badgeClass="bg-primary/15 text-primary ring-primary/30"
          />
        ))
      )}
    </BucketShell>
  );
}

// ─── Shared bucket primitives ─────────────────────────────────────────────

function BucketShell({
  title,
  icon: Icon,
  accent,
  loading,
  countLabel,
  href,
  children,
}: {
  title: string;
  icon: LucideIcon;
  accent: string;
  loading: boolean;
  countLabel: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("border-l-4", accent)}>
      <CardContent className="p-4 md:p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            {title}
          </h3>
          {href ? (
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Link href={href}>
                {countLabel}
                <ArrowUpRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {countLabel}
            </span>
          )}
        </div>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded" />
            ))}
          </div>
        ) : (
          <div className="space-y-1">{children}</div>
        )}
      </CardContent>
    </Card>
  );
}

function BucketLeadRow({
  href,
  name,
  secondary,
  badge,
  badgeClass,
}: {
  href: string;
  name: string;
  secondary?: string;
  badge: string;
  badgeClass: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-2 rounded-md hover:bg-secondary/40 -mx-1 px-1.5 py-1.5 transition-colors"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{name}</div>
        {secondary ? (
          <div className="text-[11px] text-muted-foreground truncate capitalize">
            {secondary.replace(/_/g, " ")}
          </div>
        ) : null}
      </div>
      <span
        className={cn(
          "inline-flex items-center text-[10px] font-semibold rounded-full px-2 py-0.5 ring-1 tabular-nums flex-shrink-0",
          badgeClass,
        )}
      >
        {badge}
      </span>
    </Link>
  );
}

function EmptyInline({ message }: { message: string }) {
  return (
    <p className="text-xs text-muted-foreground py-2 text-center">{message}</p>
  );
}

function EmptyBlock({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="p-8 md:p-10 text-center space-y-3">
      <Icon className="h-8 w-8 text-muted-foreground mx-auto" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
          {description}
        </p>
      </div>
    </div>
  );
}
