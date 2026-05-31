"use client";

/**
 * Notifications tab — per-user toggles for which notification types
 * the agent wants to receive.
 *
 * **Local-state only for now.** The backend doesn't yet expose a
 * `notification_prefs` field on `users` or on `/api/profile/me` —
 * the spec called for the UI to render with local state + a clear
 * "pending backend" indicator so agents can preview the panel and
 * agency owners can sign off on the categories before the backend
 * persistence lands. Preferences in this build:
 *   - Persist to `localStorage` (per-browser, per-user-id) so the
 *     toggle state survives page refresh
 *   - Surface a "Saved locally" banner above the controls so users
 *     don't assume the choices have crossed the network
 *
 * When the backend ships `GET/PATCH /api/profile/notification-prefs`
 * (or an extension of `/profile/me`), swap the storage layer for a
 * React Query mutation + delete the localStorage helper; the UI
 * doesn't change.
 */

import * as React from "react";
import { Bell, Cake, CalendarClock, FileSignature, Info, Mail, Snowflake, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores";

interface NotificationPref {
  key: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultOn: boolean;
}

const PREFS: readonly NotificationPref[] = [
  {
    key: "new_lead_assigned",
    label: "New lead assigned",
    description: "Email when a lead is routed to you (round-robin or manual assignment).",
    icon: UserPlus,
    defaultOn: true,
  },
  {
    key: "appointment_reminder",
    label: "Appointment reminders",
    description: "Email reminders 48h, 24h, and 1h before each scheduled appointment.",
    icon: CalendarClock,
    defaultOn: true,
  },
  {
    key: "birthday_window_alert",
    label: "Birthday window alerts",
    description: "Notify when a client's IL birthday-rule window opens (45 days out).",
    icon: Cake,
    defaultOn: true,
  },
  {
    key: "stale_lead_alert",
    label: "Stale lead alerts",
    description: "Daily digest of leads that haven't been contacted in 30+ days.",
    icon: Snowflake,
    defaultOn: true,
  },
  {
    key: "daily_brief_email",
    label: "Daily brief email",
    description: "Your AI-prioritized top 10 calls, delivered at 12:00 UTC every weekday.",
    icon: Mail,
    defaultOn: true,
  },
  {
    key: "soa_signed",
    label: "SOA signed",
    description: "Email when a client completes a Scope of Appointment signature.",
    icon: FileSignature,
    defaultOn: true,
  },
];

type PrefState = Record<string, boolean>;

function buildDefaults(): PrefState {
  const out: PrefState = {};
  for (const p of PREFS) out[p.key] = p.defaultOn;
  return out;
}

function storageKey(userId: string | null): string {
  return `ghw.notification-prefs.${userId ?? "anon"}`;
}

function loadPrefs(userId: string | null): PrefState {
  if (typeof window === "undefined") return buildDefaults();
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return buildDefaults();
    const parsed = JSON.parse(raw) as PrefState;
    // Merge defaults so adding a new pref to PREFS doesn't leave it
    // undefined for users whose stored payload predates it.
    return { ...buildDefaults(), ...parsed };
  } catch {
    return buildDefaults();
  }
}

function savePrefs(userId: string | null, state: PrefState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    // Storage disabled (private mode / quota) — silently no-op. The
    // toggles still work in-memory for the current session.
  }
}

export function NotificationsSettingsTab() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const status = useAuthStore((s) => s.status);
  const [prefs, setPrefs] = React.useState<PrefState>(buildDefaults);
  const [dirty, setDirty] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

  // Hydrate from localStorage AFTER mount so SSR doesn't mismatch.
  // useAuthStore.status starts "unknown" → "authed"; only read after.
  React.useEffect(() => {
    if (status === "unknown") return;
    setPrefs(loadPrefs(userId));
    setHydrated(true);
  }, [userId, status]);

  function toggle(key: string, value: boolean) {
    setPrefs((p) => ({ ...p, [key]: value }));
    setDirty(true);
  }

  function save() {
    savePrefs(userId, prefs);
    setDirty(false);
    toast.success("Saved locally", {
      description:
        "Backend persistence is on the way — preferences survive page refresh in the meantime.",
    });
  }

  function resetDefaults() {
    setPrefs(buildDefaults());
    setDirty(true);
  }

  if (!hydrated) {
    return <Skeleton className="h-96 w-full max-w-2xl" />;
  }

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Local-only banner — sets honest expectations until the
          backend prefs field ships. */}
      <div
        className="flex items-start gap-3 rounded-md border border-ghw-copper/30 bg-ghw-copper/10 p-3 text-xs"
        role="status"
      >
        <Info className="h-4 w-4 text-ghw-copper flex-shrink-0 mt-0.5" />
        <div className="text-foreground/85">
          <p className="font-semibold text-ghw-copper">
            Saved locally for now
          </p>
          <p className="mt-1">
            The backend `notification_prefs` field is a tracked follow-up.
            Your choices below persist to this browser (per user account)
            and survive a refresh — they don&apos;t yet stop the actual
            email sends. The categories themselves are wired and align
            with what the automation scheduler ships today.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-5 md:p-6 space-y-1">
          <div className="flex items-center gap-2 mb-2">
            <Bell className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Email notifications</h3>
          </div>

          <ul className="divide-y divide-border/60">
            {PREFS.map((pref) => {
              const Icon = pref.icon;
              const value = prefs[pref.key] ?? pref.defaultOn;
              return (
                <li
                  key={pref.key}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{pref.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {pref.description}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={value}
                    onCheckedChange={(v) => toggle(pref.key, v)}
                    aria-label={pref.label}
                    data-testid={`notif-toggle-${pref.key}`}
                  />
                </li>
              );
            })}
          </ul>

          <div className="flex items-center justify-between pt-4 border-t border-border/60">
            <Button
              variant="ghost"
              size="sm"
              onClick={resetDefaults}
              className="text-xs"
            >
              Reset to defaults
            </Button>
            <Button
              onClick={save}
              disabled={!dirty}
              size="sm"
              className={cn(!dirty && "opacity-60")}
              data-testid="notif-save"
            >
              Save preferences
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
