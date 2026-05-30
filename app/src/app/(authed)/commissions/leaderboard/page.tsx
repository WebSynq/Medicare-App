"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Award,
  Crown,
  Medal,
  TrendingUp,
  Trophy,
  User,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { commissions as commissionsApi } from "@/lib/api";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import type { LeaderboardRow } from "@/lib/api/commissions";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const PERIODS = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "ytd", label: "Year-to-date" },
  { value: "all", label: "All time" },
] as const;

type Period = (typeof PERIODS)[number]["value"];

export default function LeaderboardPage() {
  const [period, setPeriod] = React.useState<Period>("month");

  const query = useQuery({
    queryKey: ["leaderboard", period, 50],
    queryFn: () => commissionsApi.getLeaderboard(period, 50),
  });

  const rows = query.data?.rows ?? [];
  const selfRow = rows.find((r) => r.is_self) ?? null;

  return (
    <div className="space-y-6">
      {/* Section header lives on the Commissions layout. */}
      <ImpersonationBanner />

      <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
        <TabsList>
          {PERIODS.map((p) => (
            <TabsTrigger key={p.value} value={p.value}>
              {p.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {query.isLoading ? (
        <LoadingSkeleton />
      ) : query.isError ? (
        <ErrorState />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {selfRow ? <YourRowCard row={selfRow} /> : null}

          <PodiumRow rows={rows.slice(0, 3)} />

          <RestList rows={rows.slice(3)} />
        </>
      )}
    </div>
  );
}

// ─── Self card ─────────────────────────────────────────────────────────────

function YourRowCard({ row }: { row: LeaderboardRow }) {
  return (
    <Card className="border-primary/40 ring-2 ring-primary/20">
      <CardContent className="p-4 md:p-5">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center">
            <User className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-primary uppercase tracking-widest">
              Your rank
            </p>
            <p className="text-sm font-bold truncate">
              {row.agent_name}{" "}
              <span className="text-xs text-muted-foreground font-normal">
                · #{row.rank}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <StatCell label="Earnings" value={USD.format(row.agent_split)} accent />
            <StatCell label="Policies" value={String(row.policies_count)} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Podium ────────────────────────────────────────────────────────────────

const MEDAL_TINT = [
  // 1st — gold
  {
    icon: Crown,
    iconClass: "text-yellow-500",
    ringClass: "ring-yellow-500/40 bg-gradient-to-b from-yellow-500/10 to-transparent",
    label: "Gold",
  },
  // 2nd — silver
  {
    icon: Medal,
    iconClass: "text-zinc-400",
    ringClass: "ring-zinc-400/40 bg-gradient-to-b from-zinc-400/10 to-transparent",
    label: "Silver",
  },
  // 3rd — bronze
  {
    icon: Award,
    iconClass: "text-ghw-copper",
    ringClass: "ring-ghw-copper/40 bg-gradient-to-b from-ghw-copper/10 to-transparent",
    label: "Bronze",
  },
] as const;

function PodiumRow({ rows }: { rows: LeaderboardRow[] }) {
  // Display order: 2nd, 1st, 3rd — visually higher 1st in the middle
  // on md+. Mobile stacks naturally in rank order.
  const ordered = [rows[1], rows[0], rows[2]].filter(Boolean) as LeaderboardRow[];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:items-end">
      {ordered.map((row) => {
        const rank = row.rank;
        const tier = MEDAL_TINT[rank - 1];
        if (!tier) return null;
        return (
          <PodiumCard
            key={row.agent_name + rank}
            row={row}
            tier={tier}
            tall={rank === 1}
          />
        );
      })}
    </div>
  );
}

function PodiumCard({
  row,
  tier,
  tall,
}: {
  row: LeaderboardRow;
  tier: (typeof MEDAL_TINT)[number];
  tall: boolean;
}) {
  const Icon = tier.icon;
  return (
    <Card
      className={cn(
        "relative ring-2 border-transparent",
        tier.ringClass,
        tall ? "md:py-2" : "",
        row.is_self && "outline outline-2 outline-primary outline-offset-2",
      )}
    >
      <CardContent
        className={cn(
          "p-5 text-center space-y-2",
          tall ? "md:p-6" : "",
        )}
      >
        <Icon className={cn("h-9 w-9 mx-auto", tier.iconClass)} />
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            #{row.rank} · {tier.label}
          </p>
          <p
            className={cn(
              "font-bold truncate mt-0.5",
              tall ? "text-base" : "text-sm",
            )}
            title={row.agent_name}
          >
            {row.agent_name}
            {row.is_self ? (
              <Badge
                variant="outline"
                className="ml-1.5 text-[9px] bg-primary/15 text-primary border-primary/30"
              >
                YOU
              </Badge>
            ) : null}
          </p>
        </div>
        <div className="flex items-center justify-center gap-4 pt-2 border-t border-border/50">
          <StatCell
            label="Earnings"
            value={USD.format(row.agent_split)}
            accent
          />
          <StatCell label="Policies" value={String(row.policies_count)} />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Rest of the list ──────────────────────────────────────────────────────

function RestList({ rows }: { rows: LeaderboardRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40">
          <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
            <th className="text-left px-3 py-2 w-12">#</th>
            <th className="text-left px-3 py-2">Agent</th>
            <th className="text-right px-3 py-2 hidden sm:table-cell">Policies</th>
            <th className="text-right px-3 py-2">Earnings</th>
            <th className="text-right px-3 py-2 hidden md:table-cell">
              Audit gap
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RestRow key={row.agent_name + row.rank} row={row} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function RestRow({ row }: { row: LeaderboardRow }) {
  return (
    <tr
      className={cn(
        "border-b border-border/60 hover:bg-secondary/40 transition-colors",
        row.is_self && "bg-primary/10 ring-1 ring-primary/20",
      )}
    >
      <td className="px-3 py-3 text-xs text-muted-foreground tabular-nums">
        {row.rank}
      </td>
      <td className="px-3 py-3">
        <p className="font-medium text-sm truncate">
          {row.agent_name}
          {row.is_self ? (
            <Badge
              variant="outline"
              className="ml-1.5 text-[9px] bg-primary/15 text-primary border-primary/30"
            >
              YOU
            </Badge>
          ) : null}
        </p>
        <p className="text-[11px] text-muted-foreground sm:hidden">
          {row.policies_count} polic{row.policies_count === 1 ? "y" : "ies"}
        </p>
      </td>
      <td className="px-3 py-3 hidden sm:table-cell text-right text-sm tabular-nums">
        {row.policies_count}
      </td>
      <td className="px-3 py-3 text-right text-sm font-semibold tabular-nums text-primary">
        {USD.format(row.agent_split)}
      </td>
      <td className="px-3 py-3 hidden md:table-cell text-right text-xs tabular-nums">
        {row.audit_gap > 0 ? (
          <span className="text-ghw-copper">{USD.format(row.audit_gap)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

// ─── Small helpers ─────────────────────────────────────────────────────────

function StatCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "font-bold tabular-nums",
          accent ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <>
      <Skeleton className="h-16 w-full" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="p-12 text-center">
        <Trophy className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
        <p className="font-medium text-sm">No production records this period.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Once carrier statements get processed for this window, agents will
          appear here.
        </p>
      </CardContent>
    </Card>
  );
}

function ErrorState() {
  return (
    <Card>
      <CardContent className="p-12 text-center text-destructive">
        <TrendingUp className="h-10 w-10 mx-auto mb-3" />
        <p className="font-medium text-sm">Couldn&apos;t load leaderboard.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Try again in a minute, or check the audit log if the issue persists.
        </p>
      </CardContent>
    </Card>
  );
}

