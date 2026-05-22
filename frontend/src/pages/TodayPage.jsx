import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Sparkles,
  Phone,
  CalendarClock,
  Snowflake,
  CalendarDays,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import ScrollableCard from "@/components/ScrollableCard";

// Bucket colour anchors. Used for the left-border accent on each section
// and the matching summary pill at the top of the page.
const BUCKETS = {
  urgent: {
    label: "Urgent Calls",
    border: "#dc2626", // red-600
    pillBg: "rgba(220,38,38,0.12)",
    pillText: "#991b1b",
  },
  renewals: {
    label: "Renewals",
    border: "#d97706", // amber-600
    pillBg: "rgba(217,119,6,0.12)",
    pillText: "#92400e",
  },
  stale: {
    label: "Stale Leads",
    border: "#2563eb", // blue-600
    pillBg: "rgba(37,99,235,0.12)",
    pillText: "#1e40af",
  },
  appointments: {
    label: "Appointments",
    border: "#16a34a", // emerald-600
    pillBg: "rgba(22,163,74,0.12)",
    pillText: "#166534",
  },
};

function SummaryPill({ count, kind, suffix }) {
  const c = BUCKETS[kind];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium tabular-nums"
      style={{ background: c.pillBg, color: c.pillText }}
      data-testid={`today-pill-${kind}`}
    >
      <span className="font-bold">{count}</span>
      {suffix}
    </span>
  );
}

function SectionCard({ title, kind, height, children, isEmpty, emptyState, testId }) {
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ borderLeft: `4px solid ${BUCKETS[kind].border}` }}
    >
      <ScrollableCard
        title={title}
        height={height}
        isEmpty={isEmpty}
        emptyState={emptyState}
        testId={testId}
      >
        {children}
      </ScrollableCard>
    </div>
  );
}

function Row({ children, testId }) {
  return (
    <div
      className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-b-0 hover:bg-secondary/30 transition-colors"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function ViewClientButton({ leadId, label = "View Client" }) {
  return (
    <Button asChild size="sm" variant="outline" className="h-8 text-xs">
      <Link to={`/clients/${leadId}`}>
        {label}
        <ArrowUpRight className="w-3 h-3 ml-1" />
      </Link>
    </Button>
  );
}

function todayDateLabel(isoDate) {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return isoDate;
  }
}

export default function TodayPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get("/today/actions");
        if (!alive) return;
        setData(res.data);
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Failed to load today's actions");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const summary = data?.summary || {
    urgent_count: 0,
    renewals_count: 0,
    stale_count: 0,
    appointments_count: 0,
  };
  const urgent = data?.urgent_calls || [];
  const renewals = data?.renewals_due || [];
  const stale = data?.stale_leads || [];
  const appts = data?.todays_appointments || [];

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-[#e85d2f]" />
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Action Center
            </p>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Today
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {todayDateLabel(data?.today)}
          </p>
          <ImpersonationBanner />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <SummaryPill count={summary.urgent_count} kind="urgent" suffix="Urgent Calls" />
            <SummaryPill count={summary.renewals_count} kind="renewals" suffix="Renewals" />
            <SummaryPill count={summary.stale_count} kind="stale" suffix="Stale Leads" />
            <SummaryPill count={summary.appointments_count} kind="appointments" suffix="Appointments" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Section 1: Urgent birthday-window calls */}
          <SectionCard
            title="Urgent: Birthday Windows Open"
            kind="urgent"
            height="280px"
            isEmpty={!loading && urgent.length === 0}
            emptyState="No open birthday windows today — great news."
            testId="today-urgent-section"
          >
            {urgent.map((r) => (
              <Row key={r.lead_id} testId={`today-urgent-${r.lead_id}`}>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{r.full_name}</div>
                  <div className="flex flex-wrap items-center gap-2 mt-0.5">
                    <Badge
                      className="rounded-full text-[10px] border-0"
                      style={{ background: "rgba(220,38,38,0.12)", color: "#991b1b" }}
                    >
                      {r.days_remaining_in_window} days left
                    </Badge>
                    {(r.current_plan || r.current_carrier) && (
                      <span className="text-[11px] text-muted-foreground truncate">
                        {[r.current_carrier, r.current_plan].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0 flex items-center gap-2">
                  {r.phone && (
                    <Button asChild size="sm" className="h-8 text-xs bg-[#dc2626] hover:bg-[#b91c1c]">
                      <a href={`tel:${r.phone}`}>
                        <Phone className="w-3 h-3 mr-1" />
                        Call Now
                      </a>
                    </Button>
                  )}
                  <ViewClientButton leadId={r.lead_id} />
                </div>
              </Row>
            ))}
          </SectionCard>

          {/* Section 2: Renewals due */}
          <SectionCard
            title="Renewals in Next 30 Days"
            kind="renewals"
            height="280px"
            isEmpty={!loading && renewals.length === 0}
            emptyState="No renewals due in the next 30 days."
            testId="today-renewals-section"
          >
            {renewals.map((r) => (
              <Row key={`${r.lead_id}-${r.renewal_date}`} testId={`today-renewal-${r.lead_id}`}>
                <CalendarClock className="w-4 h-4 text-[#d97706] flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{r.full_name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {[r.carrier, r.product_label].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Badge
                  className="rounded-full text-[10px] border-0 flex-shrink-0"
                  style={{ background: "rgba(217,119,6,0.12)", color: "#92400e" }}
                >
                  {r.days_until_renewal} days
                </Badge>
                <ViewClientButton leadId={r.lead_id} />
              </Row>
            ))}
          </SectionCard>

          {/* Section 3: Stale leads */}
          <SectionCard
            title="Stale Leads — No Contact in 7+ Days"
            kind="stale"
            height="280px"
            isEmpty={!loading && stale.length === 0}
            emptyState="No stale leads — you're on top of it."
            testId="today-stale-section"
          >
            {stale.map((r) => (
              <Row key={r.lead_id} testId={`today-stale-${r.lead_id}`}>
                <Snowflake className="w-4 h-4 text-[#2563eb] flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{r.full_name}</div>
                  <div className="flex flex-wrap items-center gap-2 mt-0.5">
                    <Badge
                      className="rounded-full text-[10px] border-0 capitalize"
                      style={{ background: "rgba(37,99,235,0.12)", color: "#1e40af" }}
                    >
                      {r.status}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {r.days_since_contact} days since contact
                    </span>
                  </div>
                </div>
                <Button asChild size="sm" variant="outline" className="h-8 text-xs flex-shrink-0">
                  <Link to={`/leads/${r.lead_id}`}>
                    View Lead
                    <ArrowUpRight className="w-3 h-3 ml-1" />
                  </Link>
                </Button>
              </Row>
            ))}
          </SectionCard>

          {/* Section 4: Today's appointments */}
          <SectionCard
            title="Today's Appointments"
            kind="appointments"
            height="220px"
            isEmpty={!loading && appts.length === 0}
            emptyState={
              <span>
                No appointments scheduled for today.
                <br />
                <span className="text-[10px] text-muted-foreground/70">
                  Appointments coming soon.
                </span>
              </span>
            }
            testId="today-appointments-section"
          >
            {appts.map((a) => (
              <Row key={a.appointment_id} testId={`today-appt-${a.appointment_id}`}>
                <CalendarDays className="w-4 h-4 text-[#16a34a] flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{a.client_name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {a.time}
                    {a.notes ? ` · ${a.notes}` : ""}
                  </div>
                </div>
                <ViewClientButton leadId={a.lead_id} />
              </Row>
            ))}
          </SectionCard>
        </div>
      </main>
    </div>
  );
}
