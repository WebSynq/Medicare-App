"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Quote as QuoteIcon, RefreshCw } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { quote as quoteApi } from "@/lib/api";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily Inspiration card — sits at the top of /dashboard above
 * the KPI row.
 *
 * Fetches from Quotable.io with a 24-hour staleTime so the same
 * quote rides through the session. The Refresh icon invalidates
 * the cache and pulls a new quote on click. When the upstream is
 * down or rate-limits, the API helper falls back to one of five
 * hardcoded inspirational quotes — the card still renders, just
 * loses the "live" badge.
 */
export function QuoteCard() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["dashboard", "daily-quote"],
    queryFn: () => quoteApi.getDailyQuote(),
    staleTime: DAY_MS,
    gcTime: DAY_MS,
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ["dashboard", "daily-quote"] });
  }

  return (
    <Card
      className={cn(
        "relative overflow-hidden mb-6 md:mb-8",
        // Gold accent on the left edge + soft gold glow that reads
        // intentional on the navy canvas without dominating the KPI
        // cards underneath.
        "border-l-4 border-l-primary bg-elevated",
      )}
    >
      <div
        aria-hidden
        className="absolute -top-24 -right-24 h-64 w-64 rounded-full opacity-10 blur-3xl pointer-events-none"
        style={{ background: "hsl(var(--primary))" }}
      />

      <CardContent className="relative p-5 md:p-7">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-foreground-subtle font-medium">
              Daily Inspiration
            </span>
            {query.data?.live === false ? (
              <span className="text-[9px] uppercase tracking-wider text-foreground-subtle/70 italic">
                · offline pick
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={query.isFetching}
            aria-label="Refresh quote"
            className={cn(
              "h-7 w-7 rounded-md flex items-center justify-center",
              "text-foreground-muted hover:text-primary hover:bg-accent-hover",
              "transition-colors disabled:opacity-50",
            )}
          >
            {query.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {query.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-32 ml-auto mt-3" />
          </div>
        ) : query.data ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <QuoteIcon
                className="h-5 w-5 text-primary/40 flex-shrink-0 mt-1"
                aria-hidden
              />
              <blockquote className="font-display italic text-lg md:text-xl leading-snug text-foreground">
                {query.data.content}
              </blockquote>
            </div>
            <p className="text-right text-sm font-medium text-primary pr-1">
              — {query.data.author}
            </p>
          </div>
        ) : (
          <p className="text-sm text-foreground-muted italic">
            Couldn&apos;t load today&apos;s quote.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
