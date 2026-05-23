import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  CheckCircle2,
  Calendar,
  RefreshCw as RenewIcon,
  AlertCircle,
  Clock,
  ArrowRight,
  DollarSign,
  X as XIcon,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const TYPE_META = {
  renewal_due:       { icon: RenewIcon,    label: "Renewal" },
  birthday_window:   { icon: AlertCircle,  label: "Birthday" },
  stale_lead:        { icon: Clock,        label: "Stale" },
  appointment_today: { icon: Calendar,     label: "Appointment" },
  lead_transferred:  { icon: ArrowRight,   label: "Transfer" },
  commission_gap:    { icon: DollarSign,   label: "Commission" },
};

function relTime(iso) {
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

export default function NotificationPanel({ open, onOpenChange, onChange }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const res = await api.get("/notifications");
      setItems(res.data?.notifications || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to load notifications");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (filter === "unread") return items.filter((n) => !n.is_read);
    return items;
  }, [items, filter]);

  async function markRead(notif) {
    // Optimistic flip.
    setItems((prev) =>
      prev.map((n) =>
        n.notification_id === notif.notification_id
          ? { ...n, is_read: true, read_at: new Date().toISOString() }
          : n,
      ),
    );
    onChange?.();
    try {
      await api.patch(`/notifications/${notif.notification_id}/read`);
    } catch {
      // Revert.
      setItems((prev) =>
        prev.map((n) =>
          n.notification_id === notif.notification_id
            ? { ...n, is_read: false, read_at: null }
            : n,
        ),
      );
    }
  }

  async function markAll() {
    setMarkingAll(true);
    const snapshot = items;
    setItems((prev) =>
      prev.map((n) => ({ ...n, is_read: true, read_at: n.read_at || new Date().toISOString() })),
    );
    try {
      await api.patch("/notifications/read-all");
      toast.success("All notifications marked as read");
      onChange?.();
    } catch (err) {
      setItems(snapshot);
      toast.error(err?.response?.data?.detail || "Failed");
    } finally {
      setMarkingAll(false);
    }
  }

  async function remove(notif, evt) {
    evt?.stopPropagation();
    const snapshot = items;
    setItems((prev) =>
      prev.filter((n) => n.notification_id !== notif.notification_id),
    );
    try {
      await api.delete(`/notifications/${notif.notification_id}`);
      onChange?.();
    } catch (err) {
      setItems(snapshot);
      toast.error(err?.response?.data?.detail || "Failed to delete");
    }
  }

  function handleClick(notif) {
    if (!notif.is_read) markRead(notif);
    if (notif.link) {
      onOpenChange(false);
      navigate(notif.link);
    }
  }

  const anyUnread = items.some((n) => !n.is_read);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="px-5 py-4 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-[#e85d2f]" />
              Notifications
            </SheetTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={markAll}
              disabled={!anyUnread || markingAll}
              data-testid="notif-mark-all-read"
            >
              Mark all read
            </Button>
          </div>
          <div className="flex gap-1">
            {[
              { id: "all", label: "All" },
              { id: "unread", label: "Unread" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className="px-3 py-1 rounded-full text-xs font-medium transition-colors"
                style={
                  filter === tab.id
                    ? { background: "#e85d2f", color: "white" }
                    : { background: "transparent", color: "hsl(var(--muted-foreground))" }
                }
                data-testid={`notif-filter-${tab.id}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-5 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 rounded bg-secondary/40 animate-pulse" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
              <div>You're all caught up.</div>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((n) => {
                const meta = TYPE_META[n.type] || { icon: Bell, label: "Notification" };
                const Icon = meta.icon;
                return (
                  <li
                    key={n.notification_id}
                    className="group"
                  >
                    <button
                      type="button"
                      onClick={() => handleClick(n)}
                      className={`w-full text-left flex items-start gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors ${
                        !n.is_read
                          ? "border-l-2 border-l-[#2563eb]"
                          : "border-l-2 border-l-transparent"
                      }`}
                      data-testid={`notif-row-${n.notification_id}`}
                    >
                      <Icon
                        className="w-4 h-4 text-[#e85d2f] mt-0.5 flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div
                          className={`text-sm truncate ${
                            !n.is_read ? "font-semibold" : "font-medium"
                          }`}
                        >
                          {n.title}
                        </div>
                        {n.body && (
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {n.body}
                          </div>
                        )}
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1 flex items-center gap-2">
                          <span>{meta.label}</span>
                          <span>·</span>
                          <span>{relTime(n.created_at)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => remove(n, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-rose-600 transition-opacity"
                        aria-label="Delete notification"
                        data-testid={`notif-delete-${n.notification_id}`}
                      >
                        <XIcon className="w-3.5 h-3.5" />
                      </button>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {loading && (
          <div className="px-5 py-2 border-t border-border text-[10px] text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Fetching…
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
