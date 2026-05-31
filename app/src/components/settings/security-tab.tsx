"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, History, LogOut, ShieldAlert, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { profile as profileApi } from "@/lib/api";

function timeAgo(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    const min = Math.round(diff / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function parseUA(ua: string | null): string {
  if (!ua) return "Unknown device";
  // Lightweight UA snippet — enough to recognise "your laptop vs your phone".
  if (/iPhone|iPad/i.test(ua)) return "iPhone / iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return ua.slice(0, 60);
}

export function SecuritySettingsTab() {
  const query = useQuery({
    queryKey: ["profile", "sessions"],
    queryFn: () => profileApi.getSessions(),
  });

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardContent className="p-5 md:p-6 space-y-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Recent sign-ins</h3>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Last 10 successful logins. If you don&apos;t recognize one, change
            your password immediately on the Profile tab and contact your
            agency admin.
          </p>

          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded" />
              ))}
            </div>
          ) : query.isError ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Couldn&apos;t load.
            </p>
          ) : (query.data?.sessions ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No sign-ins on record yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(query.data?.sessions ?? []).map((s, i) => (
                <li
                  key={i}
                  className="py-2.5 flex flex-wrap items-center gap-3 text-sm"
                >
                  <Smartphone className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-xs truncate">
                      {parseUA(s.user_agent)}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {new Date(s.timestamp).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}{" "}
                      · {timeAgo(s.timestamp)}
                    </p>
                  </div>
                  {s.ip_address ? (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
                      <Globe className="h-3 w-3" />
                      {s.ip_address}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Bulk-revoke placeholder.
       *
       * Backend has no `/sessions/revoke-all` endpoint today; JWT
       * auth without a server-side session store relies on the
       * user's `token_version` to invalidate sessions, and that's
       * bumped automatically on password change. Until a dedicated
       * revoke endpoint ships, point the user at the password-change
       * flow — which is the closest functional equivalent. */}
      <Card>
        <CardContent className="p-5 md:p-6 space-y-2">
          <div className="flex items-center gap-2">
            <LogOut className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Sign out other sessions</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            A dedicated revoke endpoint is a tracked follow-up. For now,
            changing your password on the Profile tab immediately invalidates
            every other JWT issued before the change.
          </p>
          <Button
            variant="outline"
            disabled
            className="opacity-60 cursor-not-allowed"
            data-testid="security-revoke-all"
          >
            <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
            Sign out everywhere
            <span className="ml-2 text-[10px] uppercase tracking-widest text-muted-foreground">
              Coming soon
            </span>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
