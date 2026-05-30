"use client";

/**
 * TV Mode leaderboard — full-screen sales board for a wall display
 * (1080p / Chromecast / HDMI cast). Lives OUTSIDE the (authed)
 * route group so it gets only the root layout (no sidebar, no
 * header, no chrome). Auth still required: the edge middleware
 * gates the route by cookie presence and `<AuthBootstrap />` in
 * the root layout populates the auth store — we mirror the
 * (authed) layout's redirect-on-anon check inline so a stale
 * session client-side bounces to /login.
 *
 * Real-time UX:
 *  - Poll `/api/leaderboard?period=&limit=200` every 30s.
 *  - Diff previous rows vs new rows by `agent_name`.
 *  - If `policies_count` went up for any agent, queue a
 *    celebration banner + confetti burst for that agent.
 *  - Show celebrations one at a time, 8 seconds each.
 *  - On round-number milestones (10, 25, 50, 100) the banner
 *    sub-line calls out the milestone; otherwise it shows
 *    "Keep crushing it!"
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Award, Crown, Medal } from "lucide-react";
import confetti from "canvas-confetti";

import { cn } from "@/lib/utils";
import { commissions as commissionsApi } from "@/lib/api";
import { useAuthStore } from "@/stores";
import type {
  LeaderboardResponse,
  LeaderboardRow,
} from "@/lib/api/commissions";

const POLL_MS = 30_000;
const CELEBRATION_MS = 8_000;
const MILESTONES = new Set([10, 25, 50, 100]);

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

type Period = "week" | "month" | "ytd" | "all";

const PERIODS: readonly { value: Period; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];

interface Celebration {
  id: string;
  agentName: string;
  policiesCount: number;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function LeaderboardTVPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);

  // Bounce off-anon users back to /login. Edge middleware already
  // gates by cookie presence; this catches the case where the
  // cookie is present but /api/auth/me came back 401 (server-side
  // invalidated session).
  React.useEffect(() => {
    if (status === "anon") {
      router.replace("/login?redirect_to=/leaderboard/tv");
    }
  }, [status, router]);

  if (status === "unknown") {
    return (
      <div className="min-h-screen bg-[#0B1F3A] grid place-items-center">
        <p className="text-white/60 text-lg tracking-widest uppercase">
          Loading…
        </p>
      </div>
    );
  }
  if (status === "anon") {
    return null;
  }

  return <TVBoard />;
}

// ─── Board ────────────────────────────────────────────────────────────────

function TVBoard() {
  const [period, setPeriod] = React.useState<Period>("month");
  const [rows, setRows] = React.useState<LeaderboardRow[]>([]);
  const [lastFetchedAt, setLastFetchedAt] = React.useState<Date | null>(null);
  const [now, setNow] = React.useState(() => new Date());
  const previousRowsRef = React.useRef<LeaderboardRow[]>([]);
  const [queue, setQueue] = React.useState<Celebration[]>([]);
  const [current, setCurrent] = React.useState<Celebration | null>(null);

  // Wall clock + "X seconds ago" tick. 1s resolution.
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(t);
  }, []);

  // Polling loop. Period change re-mounts the effect so cadence
  // resets to a fresh tick after the user switches tabs.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function fetchOnce() {
      try {
        const resp: LeaderboardResponse =
          await commissionsApi.getLeaderboard(period, 200);
        if (cancelled) return;
        const newRows = resp.rows ?? [];
        const prev = previousRowsRef.current;
        // Diff — surface any agent whose policies_count went up.
        const newCelebrations: Celebration[] = [];
        for (const prevRow of prev) {
          const currRow = newRows.find(
            (r) => r.agent_name === prevRow.agent_name,
          );
          if (
            currRow &&
            currRow.policies_count > prevRow.policies_count
          ) {
            newCelebrations.push({
              id: `${currRow.agent_name}-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 7)}`,
              agentName: currRow.agent_name,
              policiesCount: currRow.policies_count,
            });
          }
        }
        previousRowsRef.current = newRows;
        setRows(newRows);
        setLastFetchedAt(new Date());
        if (newCelebrations.length > 0) {
          setQueue((q) => [...q, ...newCelebrations]);
        }
      } catch {
        // Silent on poll failure — the next tick retries. Don't
        // tear down the board for a transient blip; a wall display
        // showing an error screen is worse than a stale board.
      }
    }

    fetchOnce();
    timer = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [period]);

  // Drive the celebration queue. While no celebration is on
  // screen, pull the next from the queue; mount it for
  // CELEBRATION_MS then dismiss + look for the next.
  React.useEffect(() => {
    if (current !== null) return;
    if (queue.length === 0) return;
    const next = queue[0];
    if (!next) return;
    setCurrent(next);
    setQueue((q) => q.slice(1));
  }, [current, queue]);

  React.useEffect(() => {
    if (!current) return;
    // Confetti fires on banner mount.
    confetti({
      particleCount: 150,
      spread: 100,
      origin: { y: 0.3 },
      colors: ["#E8730A", "#FFD700", "#FFFFFF", "#0B1F3A"],
    });
    const t = setTimeout(() => setCurrent(null), CELEBRATION_MS);
    return () => clearTimeout(t);
  }, [current]);

  const topThree = rows.slice(0, 3);
  const rest = rows.slice(3);

  return (
    <div className="min-h-screen bg-[#0B1F3A] text-white font-sans overflow-x-hidden">
      <Header
        period={period}
        setPeriod={setPeriod}
        now={now}
      />

      <main className="pt-20 pb-16 px-6 md:px-10 max-w-[1920px] mx-auto">
        {topThree.length === 0 ? (
          <EmptyBoard />
        ) : (
          <>
            <Podium top={topThree} />
            <Rankings rows={rest} />
          </>
        )}
      </main>

      <Footer lastFetchedAt={lastFetchedAt} now={now} />

      <CelebrationBanner celebration={current} />
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────

function Header({
  period,
  setPeriod,
  now,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  now: Date;
}) {
  return (
    <header className="fixed top-0 inset-x-0 h-20 bg-[#0B1F3A]/95 backdrop-blur border-b border-white/10 z-30">
      <div className="h-full max-w-[1920px] mx-auto px-6 md:px-10 grid grid-cols-3 items-center">
        {/* Left — wordmark */}
        <div className="flex items-center gap-3">
          <span className="text-3xl font-black tracking-tight text-[#E8730A]">
            GHW
          </span>
          <span className="text-xs uppercase tracking-widest text-white/40 hidden md:inline">
            Medicare
          </span>
        </div>

        {/* Center — title */}
        <div className="text-center">
          <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-white">
            SALES LEADERBOARD
          </h1>
        </div>

        {/* Right — clock + period selector */}
        <div className="flex items-center justify-end gap-4">
          <div className="text-right hidden md:block">
            <div className="text-2xl font-bold tabular-nums text-white">
              {formatClock(now)}
            </div>
            <div className="text-xs uppercase tracking-widest text-white/50 tabular-nums">
              {formatDate(now)}
            </div>
          </div>
          <PeriodTabs period={period} setPeriod={setPeriod} />
        </div>
      </div>
    </header>
  );
}

function PeriodTabs({
  period,
  setPeriod,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Period filter"
      className="inline-flex items-center gap-1 p-1 rounded-full bg-white/5 border border-white/10"
    >
      {PERIODS.map((p) => {
        const selected = p.value === period;
        return (
          <button
            key={p.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => setPeriod(p.value)}
            className={cn(
              "px-3 md:px-4 h-9 text-xs md:text-sm font-bold uppercase tracking-widest rounded-full transition-colors",
              selected
                ? "bg-[#E8730A] text-[#0B1F3A] shadow-lg"
                : "text-white/60 hover:text-white",
            )}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Podium ───────────────────────────────────────────────────────────────

const RANK_STYLES = [
  // 1st — gold
  {
    Icon: Crown,
    iconClass: "text-[#FFD700]",
    avatarClass: "bg-gradient-to-br from-[#FFD700] to-[#E8730A]",
    borderClass: "border-[#FFD700]/40",
    label: "GOLD",
  },
  // 2nd — silver
  {
    Icon: Medal,
    iconClass: "text-zinc-300",
    avatarClass: "bg-gradient-to-br from-zinc-300 to-zinc-500",
    borderClass: "border-zinc-300/40",
    label: "SILVER",
  },
  // 3rd — bronze
  {
    Icon: Award,
    iconClass: "text-[#E8730A]",
    avatarClass: "bg-gradient-to-br from-[#E8730A] to-[#9C4A0E]",
    borderClass: "border-[#E8730A]/40",
    label: "BRONZE",
  },
] as const;

function Podium({ top }: { top: LeaderboardRow[] }) {
  // Display order: 2nd | 1st | 3rd — 1st in the center, taller.
  // Falls back gracefully if there are fewer than 3 agents.
  const first = top[0];
  const second = top[1];
  const third = top[2];

  return (
    <section
      className="grid grid-cols-1 md:grid-cols-3 gap-6 md:items-end mb-10"
      aria-label="Top 3 agents"
    >
      <div className="md:order-1">
        {second ? <PodiumCard row={second} variant="medium" /> : <PodiumGhost />}
      </div>
      <div className="md:order-2">
        {first ? <PodiumCard row={first} variant="large" /> : <PodiumGhost />}
      </div>
      <div className="md:order-3">
        {third ? <PodiumCard row={third} variant="small" /> : <PodiumGhost />}
      </div>
    </section>
  );
}

function PodiumCard({
  row,
  variant,
}: {
  row: LeaderboardRow;
  variant: "small" | "medium" | "large";
}) {
  const style = RANK_STYLES[row.rank - 1];
  if (!style) return null;
  const Icon = style.Icon;
  const isLarge = variant === "large";

  return (
    <div
      className={cn(
        "rounded-2xl border bg-[#0F2A4D] text-center px-6 transition-all",
        style.borderClass,
        isLarge
          ? "py-10 md:py-14 shadow-2xl shadow-[#E8730A]/10"
          : variant === "medium"
            ? "py-8 md:py-10"
            : "py-6 md:py-8",
      )}
    >
      <Icon
        className={cn(
          "mx-auto mb-4",
          style.iconClass,
          isLarge ? "h-16 w-16" : "h-12 w-12",
        )}
      />
      <div
        className={cn(
          "mx-auto rounded-full grid place-items-center text-white font-black mb-4 ring-4 ring-white/10",
          style.avatarClass,
          isLarge ? "h-24 w-24 text-3xl" : "h-20 w-20 text-2xl",
        )}
      >
        {initials(row.agent_name)}
      </div>
      <div className="space-y-1">
        <p
          className={cn(
            "font-bold text-white truncate",
            isLarge ? "text-2xl md:text-3xl" : "text-xl md:text-2xl",
          )}
          title={row.agent_name}
        >
          {row.agent_name}
        </p>
        <p className="text-xs uppercase tracking-widest text-white/40">
          #{row.rank} · {style.label}
        </p>
      </div>
      <div className="mt-6 space-y-1">
        <p
          className={cn(
            "font-black tabular-nums text-[#E8730A]",
            isLarge ? "text-6xl md:text-7xl" : "text-5xl md:text-6xl",
          )}
        >
          {row.policies_count}
        </p>
        <p className="text-xs uppercase tracking-widest text-white/40">
          Policies
        </p>
      </div>
      {row.agent_split > 0 ? (
        <div className="mt-4 pt-4 border-t border-white/10">
          <p className="text-2xl font-bold tabular-nums text-white/80">
            {USD.format(row.agent_split)}
          </p>
          <p className="text-[10px] uppercase tracking-widest text-white/40 mt-1">
            Commission
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PodiumGhost() {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0F2A4D]/40 py-12 text-center">
      <p className="text-white/30 text-sm uppercase tracking-widest">
        —
      </p>
    </div>
  );
}

// ─── Rankings ─────────────────────────────────────────────────────────────

function Rankings({ rows }: { rows: LeaderboardRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-2xl border border-white/10 overflow-hidden">
      <table className="w-full" aria-label="Rankings 4th and below">
        <thead>
          <tr className="bg-white/5 text-xs uppercase tracking-widest text-white/50">
            <th className="text-left px-6 py-4 w-24">Rank</th>
            <th className="text-left px-6 py-4">Agent</th>
            <th className="text-right px-6 py-4">Policies</th>
            <th className="text-right px-6 py-4">Commission</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.agent_name + row.rank}
              className={cn(
                "border-t border-white/5 text-lg",
                i % 2 === 0 ? "bg-[#0F2A4D]" : "bg-[#13315B]",
              )}
            >
              <td className="px-6 py-5">
                <span className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-[#E8730A]/15 text-[#E8730A] text-xl font-black tabular-nums">
                  {row.rank}
                </span>
              </td>
              <td className="px-6 py-5">
                <p className="font-bold text-white text-2xl truncate">
                  {row.agent_name}
                </p>
              </td>
              <td className="px-6 py-5 text-right tabular-nums text-2xl font-bold text-white">
                {row.policies_count}
              </td>
              <td className="px-6 py-5 text-right tabular-nums text-2xl font-bold text-[#E8730A]">
                {row.agent_split > 0 ? USD.format(row.agent_split) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function EmptyBoard() {
  return (
    <div className="text-center py-32">
      <p className="text-white/60 text-3xl font-bold uppercase tracking-widest">
        No sales yet this period
      </p>
      <p className="text-white/40 text-sm mt-3 uppercase tracking-widest">
        First policy will fire confetti
      </p>
    </div>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────

function Footer({
  lastFetchedAt,
  now,
}: {
  lastFetchedAt: Date | null;
  now: Date;
}) {
  const secondsAgo = lastFetchedAt
    ? Math.max(0, Math.floor((now.getTime() - lastFetchedAt.getTime()) / 1000))
    : null;
  return (
    <footer className="fixed bottom-0 inset-x-0 h-12 bg-[#0B1F3A]/95 backdrop-blur border-t border-white/10 z-30">
      <div className="h-full max-w-[1920px] mx-auto px-6 md:px-10 grid grid-cols-3 items-center text-xs uppercase tracking-widest text-white/40">
        <div className="flex items-center gap-2">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-[#E8730A] opacity-75 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#E8730A]" />
          </span>
          Live · Updates every 30 seconds
        </div>
        <div className="text-center text-white/30">
          GHW Medicare Agent Portal
        </div>
        <div className="text-right tabular-nums">
          {secondsAgo === null
            ? "Loading…"
            : `Last updated ${secondsAgo}s ago`}
        </div>
      </div>
    </footer>
  );
}

// ─── Celebration banner ──────────────────────────────────────────────────

function CelebrationBanner({
  celebration,
}: {
  celebration: Celebration | null;
}) {
  // We mount the banner persistently and toggle the translate
  // class so the slide-up dismissal animation runs even after we
  // null out `celebration` — guarded with a separate "open" state.
  const [open, setOpen] = React.useState(false);
  const [latched, setLatched] = React.useState<Celebration | null>(null);

  React.useEffect(() => {
    if (celebration) {
      setLatched(celebration);
      // Tick after mount so the initial translate-y(-100%) lands
      // before the transition runs.
      requestAnimationFrame(() => setOpen(true));
    } else {
      setOpen(false);
      // Hold onto `latched` long enough for the slide-up to finish.
      const t = setTimeout(() => setLatched(null), 700);
      return () => clearTimeout(t);
    }
  }, [celebration]);

  if (!latched) return null;

  const isMilestone = MILESTONES.has(latched.policiesCount);
  const subline = isMilestone
    ? `${latched.policiesCount}${ordinalSuffix(latched.policiesCount)} Policy! 🎯`
    : "Keep crushing it! 🔥";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed top-0 inset-x-0 z-50 transition-transform duration-[600ms] ease-out",
        open ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <div className="bg-gradient-to-r from-[#FFD700] via-[#E8730A] to-[#9C4A0E] py-10 md:py-14 text-center shadow-2xl">
        <div className="text-6xl md:text-7xl mb-2" aria-hidden="true">
          🏆
        </div>
        <div className="text-3xl md:text-4xl font-black tracking-widest text-[#0B1F3A]">
          POLICY WRITTEN!
        </div>
        <div className="mt-2 text-2xl md:text-3xl font-bold text-white">
          {latched.agentName}
        </div>
        <div className="mt-1 text-base md:text-lg font-semibold text-[#0B1F3A]/80">
          {subline}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase() || "?";
}

function formatClock(d: Date): string {
  // 12-hour with leading-zero minutes + uppercase AM/PM.
  return d
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toUpperCase();
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
