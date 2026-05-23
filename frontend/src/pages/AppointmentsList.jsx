import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import {
  CalendarClock,
  Plus,
  ArrowUpRight,
  X as XIcon,
  CalendarDays,
  Search,
  DollarSign,
  CheckCircle2,
  TrendingUp,
  Calendar as CalendarIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ScrollableCard from "@/components/ScrollableCard";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import { api } from "@/lib/api";

function fmtMoney(v) {
  if (v == null || Number.isNaN(v)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
}

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No Show" },
];

const STATUS_BADGE = {
  scheduled: "bg-emerald-100 text-emerald-900",
  completed: "bg-blue-100 text-blue-900",
  cancelled: "bg-gray-200 text-gray-700",
  no_show: "bg-rose-100 text-rose-900",
};

const TYPE_OPTIONS = [
  { value: "initial_consultation", label: "Initial Consultation" },
  { value: "plan_review", label: "Plan Review" },
  { value: "enrollment", label: "Enrollment" },
  { value: "annual_review", label: "Annual Review" },
  { value: "follow_up", label: "Follow-up" },
  { value: "other", label: "Other" },
];
const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((t) => [t.value, t.label]));

const DATE_RANGES = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
];

// 8 AM – 8 PM in 30-min increments — matches the spec.
function buildTimeSlots() {
  const slots = [];
  for (let h = 8; h <= 20; h++) {
    for (const m of [0, 30]) {
      // 20:30 would push past 8pm, keep the bound inclusive of 20:00 only.
      if (h === 20 && m > 0) continue;
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}
const TIME_SLOTS = buildTimeSlots();

function rangeBounds(range) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (range === "today") {
    const iso = format(today, "yyyy-MM-dd");
    return { from: iso, to: iso };
  }
  if (range === "week") {
    const end = new Date(today);
    end.setDate(end.getDate() + 7);
    return { from: format(today, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd") };
  }
  if (range === "month") {
    const end = new Date(today);
    end.setDate(end.getDate() + 30);
    return { from: format(today, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd") };
  }
  return { from: null, to: null };
}

// Tiny debounce for the client typeahead — no need for a util.
function useDebouncedValue(value, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function ClientTypeahead({ selected, onSelect }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debouncedQ = useDebouncedValue(q, 250);

  useEffect(() => {
    if (!debouncedQ || debouncedQ.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get("/leads", { params: { q: debouncedQ } });
        if (!alive) return;
        // /leads returns an array of leads. Trim to top 6 for the menu.
        setResults((res.data || []).slice(0, 6));
      } catch {
        if (alive) setResults([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [debouncedQ]);

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 bg-secondary/30">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {selected.first_name} {selected.last_name}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {selected.phone || selected.email || "no contact"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="text-xs text-muted-foreground hover:text-foreground p-1"
          aria-label="Clear client"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <Popover open={open && results.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search clients by name…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            className="pl-8 h-10"
            data-testid="appt-client-search"
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="max-h-[260px] overflow-y-auto py-1">
          {loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Searching…
            </div>
          )}
          {!loading && results.length === 0 && q.length >= 2 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No matches.
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onSelect(r);
                setOpen(false);
                setQ("");
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-secondary/50"
              data-testid={`appt-client-${r.id}`}
            >
              <div className="font-medium truncate">
                {r.first_name} {r.last_name}
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                {[r.phone, r.email].filter(Boolean).join(" · ") || "—"}
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NewAppointmentSheet({ open, onOpenChange, onCreated }) {
  // clientName is always present; linkedLead is the (optional) CRM
  // record we're attaching the appointment to. Booking against a
  // walk-in prospect who isn't in the system yet sends just
  // client_name with lead_id omitted — the backend stores lead_id=null
  // and the SPA hides the View Client button for those rows.
  const [clientName, setClientName] = useState("");
  const [linkedLead, setLinkedLead] = useState(null);
  const [date, setDate] = useState(null);
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(30);
  const [type, setType] = useState("initial_consultation");
  const [notes, setNotes] = useState("");
  const [commission, setCommission] = useState("");
  const [estimatedPreview, setEstimatedPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  // Reset state on close so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setClientName("");
      setLinkedLead(null);
      setDate(null);
      setTime("");
      setDuration(30);
      setType("initial_consultation");
      setNotes("");
      setCommission("");
      setEstimatedPreview(null);
      setSaving(false);
    }
  }, [open]);

  // When a lead is picked, ask the backend for the same commission
  // estimate it would stamp on save. Skipped for walk-ins (no lead).
  useEffect(() => {
    if (!linkedLead?.id) {
      setEstimatedPreview(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await api.post("/appointments/estimate", {
          lead_id: linkedLead.id,
        });
        if (!alive) return;
        setEstimatedPreview(res.data?.estimated_commission ?? null);
      } catch {
        if (alive) setEstimatedPreview(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [linkedLead?.id]);

  function handleLeadSelect(lead) {
    setLinkedLead(lead);
    if (lead) {
      const full = `${lead.first_name || ""} ${lead.last_name || ""}`.trim();
      setClientName(full || lead.email || "");
    }
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    const name = clientName.trim();
    if (!name) {
      toast.error("Client name is required");
      return;
    }
    if (!date) {
      toast.error("Pick a date");
      return;
    }
    if (!time) {
      toast.error("Pick a time");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        client_name: name,
        appointment_date: format(date, "yyyy-MM-dd"),
        appointment_time: time,
        duration_minutes: Number(duration) || 30,
        type,
      };
      if (linkedLead) payload.lead_id = linkedLead.id;
      if (notes.trim()) payload.notes = notes.trim();
      const c = parseFloat(commission);
      if (Number.isFinite(c) && c >= 0) payload.estimated_commission = c;
      await api.post("/appointments", payload);
      toast.success("Appointment scheduled");
      onCreated?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to schedule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle>New Appointment</SheetTitle>
          <SheetDescription>
            Schedule a call or meeting. Linking to an existing client is
            optional — leave it blank for walk-ins or prospects not yet
            in the system.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Client Name *
            </label>
            <Input
              type="text"
              placeholder="e.g. Mira Holt"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              maxLength={200}
              className="h-10"
              data-testid="appt-client-name"
              required
            />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Link to existing client (optional)
            </label>
            <ClientTypeahead selected={linkedLead} onSelect={handleLeadSelect} />
            {linkedLead && (linkedLead.current_plan || linkedLead.current_carrier) && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Current plan: {linkedLead.current_carrier || "—"} ·{" "}
                {linkedLead.current_plan || "—"}
              </p>
            )}
            {linkedLead && estimatedPreview != null && (
              <div
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
                style={{ background: "rgba(22,163,74,0.12)", color: "#166534" }}
                data-testid="appt-estimate-pill"
              >
                <DollarSign className="w-3 h-3" />
                Est. Commission: {fmtMoney(estimatedPreview)}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Date *
              </label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    type="button"
                    className="w-full justify-start h-10 font-normal"
                    data-testid="appt-date-trigger"
                  >
                    <CalendarDays className="w-4 h-4 mr-2" />
                    {date ? format(date, "MMM d, yyyy") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={date}
                    onSelect={setDate}
                    disabled={(d) => {
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      return d < today;
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Time *
              </label>
              <Select value={time} onValueChange={setTime}>
                <SelectTrigger className="h-10" data-testid="appt-time">
                  <SelectValue placeholder="Pick a time" />
                </SelectTrigger>
                <SelectContent>
                  {TIME_SLOTS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Duration
              </label>
              <Select
                value={String(duration)}
                onValueChange={(v) => setDuration(Number(v))}
              >
                <SelectTrigger className="h-10" data-testid="appt-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">60 minutes</SelectItem>
                  <SelectItem value="90">90 minutes</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Type
              </label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="h-10" data-testid="appt-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Notes
            </label>
            <Textarea
              rows={3}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What you'll cover, prep notes, etc."
              data-testid="appt-notes"
            />
            <p className="text-[10px] text-muted-foreground mt-1 text-right">
              {notes.length}/500
            </p>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Estimated Commission (optional)
            </label>
            <Input
              type="number"
              min={0}
              step="0.01"
              placeholder="$0.00"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              data-testid="appt-commission"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1 bg-[#e85d2f] hover:bg-[#c84416]"
              disabled={saving || !clientName.trim()}
              data-testid="appt-submit"
            >
              {saving ? "Scheduling…" : "Schedule"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function formatTimeDisplay(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, "0")} ${period}`;
}

function formatDateDisplay(iso) {
  if (!iso) return "";
  try {
    return format(new Date(iso + "T12:00:00"), "MMM d, yyyy");
  } catch {
    return iso;
  }
}

// today/week/month all roll into the backend's "mtd" stats window —
// those user-facing ranges are too narrow to be useful as standalone
// rollups, and the stats bar's job is to give the agent a recent-month
// pulse. "all" passes through unchanged.
function rangeFilterToStatsPeriod(range) {
  return range === "all" ? "all" : "mtd";
}

const TYPE_LABEL_SHORT = {
  initial_consultation: "Consultation",
  plan_review: "Plan Review",
  enrollment: "Enrollment",
  annual_review: "Annual Review",
  follow_up: "Follow-up",
  other: "Other",
};

function StatCard({ icon: Icon, label, value }) {
  return (
    <Card className="bg-surface">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div
          className="text-2xl font-bold tabular-nums tracking-tight"
          style={{ fontFamily: "Outfit" }}
          data-testid={`appt-stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AppointmentsList() {
  const [appts, setAppts] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [rangeFilter, setRangeFilter] = useState("week");
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter !== "all") params.status = statusFilter;
      // For "today" we can use the date= filter exactly; for week/month
      // we fetch broader and filter client-side since the API takes a
      // single date param. "all" hits the full list (bounded by limit).
      if (rangeFilter === "today") {
        params.date = format(new Date(), "yyyy-MM-dd");
      }
      const res = await api.get("/appointments", { params });
      let rows = res.data?.appointments || [];
      if (rangeFilter !== "all" && rangeFilter !== "today") {
        const { from, to } = rangeBounds(rangeFilter);
        rows = rows.filter(
          (a) => a.appointment_date >= from && a.appointment_date <= to,
        );
      }
      setAppts(rows);
    } catch (e) {
      toast.error("Failed to load appointments");
      setAppts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, rangeFilter]);

  // Revenue stats. Re-fetches whenever the range filter changes so the
  // bar always reflects the period the user is looking at, and also on
  // demand via the bumpable statsTick (e.g. after a new appointment
  // is created). Failures silently zero the bar — we don't toast the
  // user, the table is more important.
  const [statsTick, setStatsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const period = rangeFilterToStatsPeriod(rangeFilter);
        const res = await api.get("/appointments/revenue-stats", {
          params: { period },
        });
        if (!alive) return;
        setStats(res.data);
      } catch {
        if (alive) setStats(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [rangeFilter, statsTick]);

  const refreshAll = () => {
    load();
    setStatsTick((t) => t + 1);
  };

  async function cancel(appt) {
    if (!window.confirm(`Cancel ${appt.client_name}'s appointment on ${formatDateDisplay(appt.appointment_date)}?`)) {
      return;
    }
    try {
      await api.delete(`/appointments/${appt.appointment_id}`);
      toast.success("Appointment cancelled");
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Cancel failed");
    }
  }

  const isEmpty = !loading && appts.length === 0;

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <CalendarClock className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Calendar
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Appointments
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Scheduled calls and meetings with clients.
            </p>
            <ImpersonationBanner />
          </div>
          <Button
            onClick={() => setSheetOpen(true)}
            className="bg-[#e85d2f] hover:bg-[#c84416]"
            data-testid="appt-new-btn"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            New Appointment
          </Button>
        </div>

        {/* Stats bar — appointment counts + commission totals for the
            current filter window. Re-fetches whenever rangeFilter
            changes; today/week/month all map to backend "mtd" and
            "all" passes through. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3" data-testid="appt-stats-bar">
          <StatCard
            icon={CalendarIcon}
            label="Appointments"
            value={(stats?.total_appointments ?? 0).toLocaleString()}
          />
          <StatCard
            icon={CheckCircle2}
            label="Completed"
            value={(stats?.completed_appointments ?? 0).toLocaleString()}
          />
          <StatCard
            icon={DollarSign}
            label="Est. Commission"
            value={fmtMoney(stats?.total_estimated_commission ?? 0)}
          />
          <StatCard
            icon={TrendingUp}
            label="Avg per Appointment"
            value={fmtMoney(stats?.avg_commission_per_appointment ?? 0)}
          />
        </div>

        {stats && (stats.by_type || []).length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 mb-3"
            data-testid="appt-stats-by-type"
          >
            {(stats.by_type || [])
              .filter((b) => b.count > 0)
              .map((b) => (
                <span
                  key={b.type}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-foreground/80 text-[11px]"
                >
                  <span className="font-medium">
                    {TYPE_LABEL_SHORT[b.type] || b.type}:
                  </span>
                  <span>
                    {b.count} {b.count === 1 ? "appt" : "appts"}
                  </span>
                  {b.avg_commission > 0 && (
                    <span className="text-muted-foreground">
                      · {fmtMoney(b.avg_commission)} avg
                    </span>
                  )}
                </span>
              ))}
          </div>
        )}

        <Card className="bg-surface mb-3">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40 h-10" data-testid="appt-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={rangeFilter} onValueChange={setRangeFilter}>
                <SelectTrigger className="w-40 h-10" data-testid="appt-range-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_RANGES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <ScrollableCard
          title="Appointments"
          count={appts.length}
          height="calc(100vh - 320px)"
          loading={loading}
          isEmpty={isEmpty}
          emptyState="No appointments yet. Schedule your first one."
          testId="appt-list-card"
        >
          <div className="overflow-x-auto w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {appts.map((a) => (
                  <TableRow key={a.appointment_id} data-testid={`appt-row-${a.appointment_id}`}>
                    <TableCell className="font-medium">{a.client_name}</TableCell>
                    <TableCell className="text-sm">
                      {formatDateDisplay(a.appointment_date)}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {formatTimeDisplay(a.appointment_time)}
                    </TableCell>
                    <TableCell>
                      <Badge className="rounded-full bg-secondary text-foreground/80 border-0 text-[10px]">
                        {TYPE_LABEL[a.type] || a.type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`rounded-full capitalize ${
                          STATUS_BADGE[a.status] || "bg-secondary"
                        }`}
                      >
                        {a.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[260px] truncate">
                      {a.notes || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        {a.lead_id && (
                          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                            <Link to={`/clients/${a.lead_id}`}>
                              View
                              <ArrowUpRight className="w-3 h-3 ml-1" />
                            </Link>
                          </Button>
                        )}
                        {a.status === "scheduled" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-rose-700 hover:text-rose-800"
                            onClick={() => cancel(a)}
                            data-testid={`appt-cancel-${a.appointment_id}`}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollableCard>
      </main>

      <NewAppointmentSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCreated={refreshAll}
      />
    </div>
  );
}
