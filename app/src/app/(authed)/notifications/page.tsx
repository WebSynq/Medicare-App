"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Bell,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  RefreshCw as RenewIcon,
  X as XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { isApiError, notifications as notifApi } from "@/lib/api";
import type { Notification } from "@/lib/api/notifications";

/**
 * In-app notifications page.
 *
 * Port of frontend/src/components/NotificationPanel.jsx — the CRA
 * renders it as a Sheet from the bell button; here it owns a real
 * route at /notifications, which the sidebar links to. List shape
 * (unread-first, capped 50) matches the backend
 * notifications_router.list_notifications response.
 *
 * Optimistic UI: mark-read / mark-all / delete flip locally first
 * and roll back on error. After every mutation we invalidate
 * `notifications-unread-count` so the sidebar badge updates without
 * waiting for the 60s poll tick.
 */

const TYPE_META: Record<
  string,
  { icon: typeof Bell; label: string }
> = {
  renewal_due: { icon: RenewIcon, label: "Renewal" },
  birthday_window: { icon: AlertCircle, label: "Birthday" },
  stale_lead: { icon: Clock, label: "Stale" },
  appointment_today: { icon: Calendar, label: "Appointment" },
  lead_transferred: { icon: ArrowRight, label: "Transfer" },
  commission_gap: { icon: DollarSign, label: "Commission" },
};

function relTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return new Date(iso).toLocaleDateString();
}

type Filter = "all" | "unread";

export default function NotificationsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [filter, setFilter] = React.useState<Filter>("all");

  const listQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: notifApi.listNotifications,
  });

  const items: Notification[] = React.useMemo(
    () => listQuery.data?.notifications ?? [],
    [listQuery.data],
  );
  const visible = React.useMemo(
    () => (filter === "unread" ? items.filter((n) => !n.is_read) : items),
    [items, filter],
  );
  const anyUnread = items.some((n) => !n.is_read);

  const invalidateBadge = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["notifications-unread-count"] });
  }, [qc]);

  const markReadMutation = useMutation({
    mutationFn: (id: string) => notifApi.markRead(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const prev = qc.getQueryData(["notifications"]);
      qc.setQueryData(["notifications"], (old: typeof listQuery.data) => {
        if (!old) return old;
        return {
          ...old,
          notifications: old.notifications.map((n) =>
            n.notification_id === id
              ? { ...n, is_read: true, read_at: new Date().toISOString() }
              : n,
          ),
        };
      });
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notifications"], ctx.prev);
      toast.error("Failed to mark as read");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      invalidateBadge();
    },
  });

  const markAllMutation = useMutation({
    mutationFn: notifApi.markAllRead,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const prev = qc.getQueryData(["notifications"]);
      const now = new Date().toISOString();
      qc.setQueryData(["notifications"], (old: typeof listQuery.data) => {
        if (!old) return old;
        return {
          ...old,
          notifications: old.notifications.map((n) => ({
            ...n,
            is_read: true,
            read_at: n.read_at ?? now,
          })),
        };
      });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notifications"], ctx.prev);
      toast.error(isApiError(err) ? err.message : "Failed");
    },
    onSuccess: () => {
      toast.success("All notifications marked as read");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      invalidateBadge();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => notifApi.deleteNotification(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const prev = qc.getQueryData(["notifications"]);
      qc.setQueryData(["notifications"], (old: typeof listQuery.data) => {
        if (!old) return old;
        return {
          ...old,
          notifications: old.notifications.filter(
            (n) => n.notification_id !== id,
          ),
        };
      });
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notifications"], ctx.prev);
      toast.error(isApiError(err) ? err.message : "Failed to delete");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      invalidateBadge();
    },
  });

  function handleRowClick(n: Notification) {
    if (!n.is_read) markReadMutation.mutate(n.notification_id);
    if (n.link) router.push(n.link);
  }

  return (
    <div className="p-6 md:p-10 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold font-display tracking-tight flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            Notifications
          </h1>
          <p className="text-sm text-muted-foreground">
            Renewals, birthday windows, stale leads, and today&rsquo;s
            appointments.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => markAllMutation.mutate()}
          disabled={!anyUnread || markAllMutation.isPending}
          data-testid="notif-mark-all-read"
        >
          Mark all read
        </Button>
      </div>

      <div className="flex gap-1">
        {(["all", "unread"] as const).map((tab) => {
          const active = filter === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium transition-colors capitalize",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-elevated text-muted-foreground hover:text-foreground",
              )}
              data-testid={`notif-filter-${tab}`}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {listQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : listQuery.isError ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {isApiError(listQuery.error)
            ? listQuery.error.message
            : "Failed to load notifications."}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="text-sm font-medium">You&rsquo;re all caught up.</p>
          <p className="text-xs">
            {filter === "unread"
              ? "Switch to All to see read items."
              : "New alerts will appear here as they fire."}
          </p>
        </div>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border bg-card">
          {visible.map((n) => {
            const meta = TYPE_META[n.type] ?? {
              icon: Bell,
              label: "Notification",
            };
            const Icon = meta.icon;
            return (
              <li key={n.notification_id} className="group">
                <div
                  className={cn(
                    "flex items-start gap-3 px-4 py-3 transition-colors border-l-2",
                    !n.is_read
                      ? "border-l-primary"
                      : "border-l-transparent",
                    n.link && "cursor-pointer hover:bg-elevated",
                  )}
                  role={n.link ? "button" : undefined}
                  tabIndex={n.link ? 0 : -1}
                  onClick={() => handleRowClick(n)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && n.link) {
                      e.preventDefault();
                      handleRowClick(n);
                    }
                  }}
                  data-testid={`notif-row-${n.notification_id}`}
                >
                  <Icon className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "text-sm truncate",
                        !n.is_read ? "font-semibold" : "font-medium",
                      )}
                    >
                      {n.title}
                    </div>
                    {n.body ? (
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {n.body}
                      </div>
                    ) : null}
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1 flex items-center gap-2">
                      <span>{meta.label}</span>
                      <span>·</span>
                      <span>{relTime(n.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {!n.is_read ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          markReadMutation.mutate(n.notification_id);
                        }}
                        className="h-7 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Mark read
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMutation.mutate(n.notification_id);
                      }}
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-400"
                      aria-label="Delete notification"
                      data-testid={`notif-delete-${n.notification_id}`}
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
