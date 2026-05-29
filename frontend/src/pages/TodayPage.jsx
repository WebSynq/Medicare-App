import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Sparkles,
  Phone,
  CalendarClock,
  Snowflake,
  CalendarDays,
  ArrowUpRight,
  Cake,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, auth, COMMAND_CENTER_ROLES } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";
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
  const [brief, setBrief] = useState(null);

  // Privileged-role + not-impersonating = agency view. When impersonating
  // an agent we fall back to the regular Today page so leadership can
  // see exactly what their agent sees.
  const { selectedAgent } = useAgent();
  const me = auth.getUser();
  const isAgencyView =
    !selectedAgent && COMMAND_CENTER_ROLES.has(me?.role || "");

  useEffect(() => {
    // Skip the per-agent /today/actions fetch in agency view — the
    // summary cards pull from /agency-dashboard endpoints instead.
    if (isAgencyView) {
      setLoading(false);
      return;
    }
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
  }, [isAgencyView]);

  // AI priority list — independent fetch so a brief failure doesn't
  // block the rest of the page. Skipped in agency view (privileged
  // roles see agency-wide summaries instead).
  useEffect(() => {
    if (isAgencyView) return;
    let alive = true;
    (async () => {
      try {
        const res = await api.get("/brief/today");
        if (!alive) return;
        setBrief(res.data);
      } catch {
        if (alive) setBrief(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isAgencyView]);

  if (isAgencyView) {
    return <AgencyTodaySummary />;
  }

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
  const mtdCommission = Number(data?.mtd_commission) || 0;
  const newLeadsToday = Number(data?.new_leads_today) || 0;
  const appsSubmittedToday = Number(data?.apps_submitted_today) || 0;

  const mtdCommissionLabel = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(mtdCommission);

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <AIBriefWidget brief={brief} />

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
            {mtdCommission > 0 && (
              <span
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium tabular-nums"
                style={{ background: "rgba(22,163,74,0.15)", color: "#166534" }}
                data-testid="today-pill-mtd-commission"
              >
                <span className="font-bold">{mtdCommissionLabel}</span>
                Est. MTD
              </span>
            )}
          </div>
        </div>

        {/* Daily KPI cards — Feature B. Sit between the summary pills
            (action-bucket counts) and the call-list grid below. Numbers
            scope to the caller via /today/actions's agent_filter. */}
        <div
          className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4"
          data-testid="today-kpi-cards"
        >
          <Card className="border-l-4" style={{ borderLeftColor: "#2563eb" }}>
            <CardContent className="p-4">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                New Leads Today
              </p>
              <p
                className="text-3xl font-bold tabular-nums mt-1"
                data-testid="kpi-new-leads-today"
              >
                {newLeadsToday}
              </p>
            </CardContent>
          </Card>
          <Card className="border-l-4" style={{ borderLeftColor: "#16a34a" }}>
            <CardContent className="p-4">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Apps Submitted Today
              </p>
              <p
                className="text-3xl font-bold tabular-nums mt-1"
                data-testid="kpi-apps-submitted-today"
              >
                {appsSubmittedToday}
              </p>
            </CardContent>
          </Card>
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

          {/* Section 2: Renewals due. Backend now joins policies → leads
              so r.lead_id is the canonical leads.id (or null when no
              match) — we only render View Client when it's set so we
              never ship a broken /clients/null link. */}
          <SectionCard
            title="Renewals in Next 30 Days"
            kind="renewals"
            height="280px"
            isEmpty={!loading && renewals.length === 0}
            emptyState="No renewals due in the next 30 days."
            testId="today-renewals-section"
          >
            {renewals.map((r, i) => (
              <Row
                key={`renewal-${r.lead_id || "orphan"}-${r.renewal_date}-${i}`}
                testId={`today-renewal-${r.lead_id || "orphan"}-${i}`}
              >
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
                {r.lead_id && <ViewClientButton leadId={r.lead_id} />}
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

// ── Agency summary view ──────────────────────────────────────────────────
// What leadership sees when they hit /today WITHOUT impersonating an
// agent. Four summary cards — no merged client lists, no individual
// task items. Each card deep-links into the Command Center drill-down
// or the Calendar so they can investigate from there.

function AgencyTodaySummary() {
  const [kpis, setKpis] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [todaysAppts, setTodaysAppts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // KPIs power the count-side of each card; /alerts gives us the
        // distinct-agents-affected count for stale + birthday windows;
        // /appointments filtered to today gives us today's roll-up
        // (admins / owners / coaches see all rows by virtue of being
        // in FULL_AGENCY_SCOPE_ROLES, no override header needed).
        const [kRes, alRes, apRes] = await Promise.allSettled([
          api.get("/agency-dashboard/kpis?period=mtd"),
          api.get("/agency-dashboard/alerts"),
          api.get("/appointments"),
        ]);
        if (!alive) return;
        if (kRes.status === "fulfilled") setKpis(kRes.value.data);
        if (alRes.status === "fulfilled") setAlerts(alRes.value.data);
        if (apRes.status === "fulfilled") {
          const todayIso = new Date().toISOString().slice(0, 10);
          const list = (apRes.value.data?.appointments || []).filter(
            (a) =>
              a.appointment_date === todayIso && a.status === "scheduled",
          );
          setTodaysAppts(list);
        }
      } catch (err) {
        toast.error(
          err?.response?.data?.detail || "Failed to load agency summary",
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const mtdCommission = Number(kpis?.revenue?.this_period) || 0;
  const mtdCommissionLabel = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(mtdCommission);

  const bdayOpen = kpis?.birthday_windows?.open_now ?? 0;
  const bdayAgentCount = useMemo(() => {
    const set = new Set();
    (alerts?.birthday_windows || []).forEach((b) =>
      b.agent_name && set.add(b.agent_name),
    );
    return set.size;
  }, [alerts]);

  const renewals30 = kpis?.renewals?.due_30_days ?? 0;

  const staleAgents = (alerts?.stale_leads || []).length;
  const staleLeadCount = (alerts?.stale_leads || []).reduce(
    (acc, r) => acc + (r.count || 0),
    0,
  );

  const todayAppointmentCount = todaysAppts.length;
  const todayAppointmentAgentCount = new Set(
    todaysAppts.map((a) => a.agent_id),
  ).size;

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1100px] mx-auto w-full">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-[#e85d2f]" />
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Agency Today
            </p>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Today
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Agency-wide summary of what needs attention right now.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {mtdCommission > 0 && (
              <span
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium tabular-nums"
                style={{ background: "rgba(22,163,74,0.15)", color: "#166534" }}
                data-testid="today-pill-mtd-commission"
              >
                <span className="font-bold">{mtdCommissionLabel}</span>
                Est. Agency MTD
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3" data-testid="today-agency-summary">
          <SummaryCard
            icon={Cake}
            iconBg="bg-red-100"
            iconColor="text-red-700"
            title="Urgent Birthday Windows"
            body={
              loading
                ? "Loading…"
                : bdayOpen === 0
                ? "No open windows today."
                : `${bdayOpen} client${bdayOpen === 1 ? "" : "s"}${
                    bdayAgentCount > 0
                      ? ` across ${bdayAgentCount} agent${
                          bdayAgentCount === 1 ? "" : "s"
                        }`
                      : ""
                  } have open windows`
            }
            linkLabel="View All in Command Center"
            linkTo="/agency-dashboard"
          />
          <SummaryCard
            icon={CalendarClock}
            iconBg="bg-amber-100"
            iconColor="text-amber-700"
            title="Renewals Due This Month"
            body={
              loading
                ? "Loading…"
                : renewals30 === 0
                ? "No renewals due in the next 30 days."
                : `${renewals30} policies renewing in the next 30 days`
            }
            linkLabel="View All in Command Center"
            linkTo="/agency-dashboard"
          />
          <SummaryCard
            icon={Snowflake}
            iconBg="bg-blue-100"
            iconColor="text-blue-700"
            title="Stale Leads Needing Contact"
            body={
              loading
                ? "Loading…"
                : staleLeadCount === 0
                ? "No backlog — every agent is current."
                : `${staleLeadCount} lead${
                    staleLeadCount === 1 ? "" : "s"
                  } not contacted in 7+ days`
            }
            subline={
              staleAgents > 0
                ? `${staleAgents} agent${
                    staleAgents === 1 ? "" : "s"
                  } need follow-up`
                : null
            }
            linkLabel="View All in Command Center"
            linkTo="/agency-dashboard"
          />
          <SummaryCard
            icon={CalendarDays}
            iconBg="bg-emerald-100"
            iconColor="text-emerald-700"
            title="Today's Appointments (Agency-Wide)"
            body={
              loading
                ? "Loading…"
                : todayAppointmentCount === 0
                ? "No appointments scheduled for today."
                : `${todayAppointmentCount} appointment${
                    todayAppointmentCount === 1 ? "" : "s"
                  }${
                    todayAppointmentAgentCount > 0
                      ? ` scheduled today across ${todayAppointmentAgentCount} agent${
                          todayAppointmentAgentCount === 1 ? "" : "s"
                        }`
                      : ""
                  }`
            }
            linkLabel="View in Calendar"
            linkTo="/calendar"
          />
        </div>

        <p className="mt-6 text-xs text-muted-foreground italic">
          Switch to an agent's view using the Agent Switcher to see their
          individual Today page.
        </p>
      </main>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  iconBg,
  iconColor,
  title,
  body,
  subline,
  linkLabel,
  linkTo,
}) {
  return (
    <Card>
      <CardContent className="p-5 flex items-start gap-4">
        <div
          className={`w-10 h-10 rounded-lg ${iconBg} ${iconColor} grid place-items-center flex-shrink-0`}
        >
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground mt-1">{body}</p>
          {subline ? (
            <p className="text-xs text-muted-foreground mt-1">{subline}</p>
          ) : null}
          <Link
            to={linkTo}
            className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-[#e85d2f] hover:underline"
          >
            {linkLabel} <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// AI Brief widget — top-of-page priority list. Hides itself when the
// brief is empty (silent on "nothing to do" days, per spec).
// ─────────────────────────────────────────────────────────────────────────
function _briefBadge(level) {
  const map = {
    urgent: { bg: "rgba(220,38,38,0.12)", text: "#991b1b", label: "URGENT" },
    high: { bg: "rgba(217,119,6,0.12)", text: "#92400e", label: "HIGH" },
    moderate: { bg: "rgba(37,99,235,0.12)", text: "#1e40af", label: "MODERATE" },
    low: { bg: "rgba(75,85,99,0.12)", text: "#374151", label: "LOW" },
  };
  return map[level] || map.low;
}

function AIBriefWidget({ brief }) {
  if (!brief) return null;
  const calls = brief.top_calls || [];
  if (calls.length === 0) return null;
  const generatedLabel = brief.generated_at
    ? new Date(brief.generated_at).toLocaleString()
    : "";
  const top = calls.slice(0, 3);
  const remainder = calls.length - top.length;
  return (
    <Card
      className="mb-6"
      style={{ borderLeft: "4px solid #1B4332" }}
      data-testid="ai-brief-widget"
    >
      <CardContent className="p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#1B4332]" />
            <h3 className="text-sm font-semibold">
              Your AI Priority List — {brief.date}
            </h3>
          </div>
          <span className="text-xs text-muted-foreground">
            Generated {generatedLabel}
          </span>
        </div>
        <ol className="space-y-3">
          {top.map((c, i) => {
            const badge = _briefBadge(c.urgency_level);
            return (
              <li
                key={c.lead_id || `brief-${i}`}
                className="flex items-start gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
                data-testid={`ai-brief-row-${i}`}
              >
                <div className="text-xs text-muted-foreground w-5 pt-1 tabular-nums">
                  {i + 1}.
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{c.name}</span>
                    <span
                      className="text-[10px] font-bold rounded-full px-2 py-0.5"
                      style={{ background: badge.bg, color: badge.text }}
                    >
                      [{c.score}] {badge.label}
                    </span>
                  </div>
                  <div className="text-sm mt-0.5">{c.reason}</div>
                  {c.phone && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {c.phone}
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {c.lead_id && (
                    <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                      <Link to={`/clients/${c.lead_id}`}>
                        Open Profile <ArrowUpRight className="w-3 h-3 ml-1" />
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {remainder > 0 && (
          <div className="mt-3 text-xs text-muted-foreground">
            + {remainder} more priority {remainder === 1 ? "call" : "calls"} on
            your list — open the full Clients view to see them.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
