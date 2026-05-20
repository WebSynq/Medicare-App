import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronRight,
  Eye,
  ListChecks,
  ShieldCheck,
  TrendingUp,
  Users2,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";
import ScrollableCard from "@/components/ScrollableCard";

const ROLE_BADGE = {
  admin: "bg-[#e85d2f] text-white",
  agent: "bg-blue-100 text-blue-900",
  compliance: "bg-purple-100 text-purple-900",
  sales_manager: "bg-teal-100 text-teal-900",
  coach: "bg-emerald-100 text-emerald-900",
  director: "bg-amber-100 text-amber-900",
};

function roleLabel(r) {
  if (!r) return "—";
  return r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return iso;
  }
}

function initials(name) {
  const parts = (name || "?").split(/\s+|@/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

function scoreColor(score) {
  if (score >= 80) return { ring: "#10b981", text: "text-emerald-700" };
  if (score >= 60) return { ring: "#f59e0b", text: "text-amber-700" };
  return { ring: "#e11d48", text: "text-rose-700" };
}

// SVG donut for the health score. Stroke-dasharray trick — the
// outer ring fills proportionally to the 0–100 value.
function HealthRing({ score }) {
  const radius = 56;
  const circ = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * circ;
  const { ring, text } = scoreColor(pct);
  return (
    <div className="relative w-36 h-36" data-testid="agency-health-ring">
      <svg width="144" height="144" viewBox="0 0 144 144">
        <circle cx="72" cy="72" r={radius} stroke="rgba(0,0,0,0.06)"
                strokeWidth="12" fill="none" />
        <circle
          cx="72" cy="72" r={radius}
          stroke={ring} strokeWidth="12" fill="none"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ * 0.25}
          strokeLinecap="round"
          transform="rotate(-90 72 72)"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className={`text-3xl font-bold tabular-nums ${text}`}
               style={{ fontFamily: "Outfit" }}>
            {pct}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Health
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AgencyAdmin() {
  const navigate = useNavigate();
  const { setSelectedAgent } = useAgent();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activity, setActivity] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/agency/stats");
      setStats(data);
      setActivity(data?.recent_activity || []);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Could not load agency stats",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const { data } = await api.get("/agency/activity?limit=50");
      setActivity(data?.items || []);
    } catch {
      // keep previous list
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh activity every 60s per spec. We keep this separate
  // from the heavier /stats fetch so the rest of the page doesn't
  // flicker every minute.
  useEffect(() => {
    const t = setInterval(loadActivity, 60_000);
    return () => clearInterval(t);
  }, [loadActivity]);

  function impersonate(card) {
    setSelectedAgent({
      id: card.id,
      full_name: card.name,
      agent_name: card.name,
    });
    toast.success(`Viewing as ${card.name}`);
    navigate("/dashboard");
  }

  const score = stats?.health_score ?? 0;
  const pipelineEntries = useMemo(() => {
    const order = ["new", "contacted", "qualified", "appointment_set", "enrolled"];
    return order.map((k) => ({
      key: k,
      label: k === "appointment_set" ? "Appt Set" : k[0].toUpperCase() + k.slice(1),
      value: (stats?.pipeline_by_stage || {})[k] || 0,
    }));
  }, [stats]);
  const maxStage = Math.max(1, ...pipelineEntries.map((p) => p.value));

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-[#e85d2f]" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Agency
              </p>
            </div>
            <h1 className="text-2xl font-bold tracking-tight"
                style={{ fontFamily: "Outfit" }}>
              Command Center
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Agency-wide health, activity, compliance, and pipeline.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {/* Row 1 — Health score */}
        <Card className="bg-surface mb-4">
          <CardContent className="p-5 flex flex-wrap items-start gap-6">
            <HealthRing score={score} />
            <div className="flex-1 min-w-[260px] space-y-3">
              <div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground">
                  Agency Health Score
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Composite of SOA compliance, TCPA consent, revenue
                  vs. last month, and active agents this week.
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {(stats?.health_factors || []).map((f) => {
                  const pct = (f.points / f.max) * 100;
                  return (
                    <div key={f.name} className="text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium">{f.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {f.points} / {f.max}
                        </span>
                      </div>
                      <div className="h-2 rounded bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${Math.max(2, pct)}%`,
                            background:
                              "linear-gradient(90deg, #e85d2f 0%, #c84416 100%)",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              {(stats?.health_pulling_down || []).length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
                  <div className="font-semibold text-amber-900 mb-1">
                    What&rsquo;s pulling your score down
                  </div>
                  <ul className="space-y-0.5 text-amber-900/85">
                    {stats.health_pulling_down.map((f) => (
                      <li key={f.name}>
                        • {f.name} — {f.points} / {f.max}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Row 2 — Quick KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <KpiCard
            label="Active Today"
            value={stats?.active_agents_today ?? 0}
            icon={Users2}
            accent
          />
          <KpiCard
            label="Leads This Week"
            value={stats?.leads_this_week ?? 0}
            icon={ListChecks}
          />
          <KpiCard
            label="Apps MTD"
            value={stats?.apps_this_month ?? 0}
            icon={TrendingUp}
          />
          <KpiCard
            label="Revenue MTD"
            value={fmtMoney(stats?.revenue_mtd || 0)}
            icon={TrendingUp}
            money
          />
        </div>

        {/* Row 3 — Two columns: pipeline + compliance */}
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <Card className="bg-surface">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold tracking-tight"
                    style={{ fontFamily: "Outfit" }}>
                  Pipeline
                </h3>
              </div>
              <div className="space-y-2">
                {pipelineEntries.map((s) => (
                  <div key={s.key} className="text-xs">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium">{s.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {s.value}
                      </span>
                    </div>
                    <div className="h-3 rounded bg-secondary overflow-hidden">
                      <div
                        className="h-full rounded"
                        style={{
                          width: `${(s.value / maxStage) * 100}%`,
                          background:
                            "linear-gradient(90deg, #e85d2f 0%, #c84416 100%)",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {stats?.stalled_leads?.length > 0 && (
                <div className="mt-4 text-xs">
                  <div className="font-semibold mb-1 text-amber-700 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Stalled (no movement in 7+ days)
                  </div>
                  <ul className="space-y-0.5">
                    {stats.stalled_leads.slice(0, 6).map((l) => (
                      <li
                        key={l.id}
                        className="flex items-center justify-between"
                      >
                        <span className="truncate">{l.name}</span>
                        <span className="text-muted-foreground capitalize">
                          {l.stage.replace("_", " ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-surface">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-tight"
                    style={{ fontFamily: "Outfit" }}>
                  Compliance
                </h3>
                <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                  <a href="/settings?tab=compliance">
                    Open <ChevronRight className="w-3 h-3 ml-0.5" />
                  </a>
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <ComplianceMini
                  label="SOA rate"
                  value={`${stats?.compliance?.soa_rate_pct ?? 0}%`}
                  tone="success"
                />
                <ComplianceMini
                  label="TCPA rate"
                  value={`${stats?.compliance?.tcpa_rate_pct ?? 0}%`}
                  tone={
                    (stats?.compliance?.tcpa_rate_pct ?? 0) >= 90
                      ? "success" : "warn"
                  }
                />
                <ComplianceMini
                  label="Non-compliant"
                  value={stats?.compliance?.non_compliant_leads ?? 0}
                  tone={(stats?.compliance?.non_compliant_leads ?? 0) > 0 ? "danger" : "success"}
                />
                <ComplianceMini
                  label="Total leads"
                  value={stats?.compliance?.total_leads ?? 0}
                />
              </div>
              <Button asChild variant="outline" size="sm" className="w-full">
                <a href="/settings?tab=compliance">
                  <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
                  Export CMS Report
                </a>
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Row 4 — Agent status board */}
        <Card className="bg-surface mb-4">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold tracking-tight mb-3"
                style={{ fontFamily: "Outfit" }}>
              Agent Status Board
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(stats?.agent_cards || []).map((c) => {
                const isAdmin = c.role === "admin";
                const dot = c.active_today ? "bg-emerald-500" : "bg-gray-400";
                const avatarBg = isAdmin ? "#e85d2f" : "#3b82f6";
                return (
                  <div
                    key={c.id}
                    className="rounded-lg border border-border p-3 bg-background"
                    data-testid={`agent-card-${c.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="w-10 h-10 rounded-full grid place-items-center text-white text-sm font-bold flex-shrink-0"
                        style={{ background: avatarBg }}
                        aria-hidden="true"
                      >
                        {initials(c.name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">
                            {c.name}
                          </span>
                          <span className={`w-2 h-2 rounded-full ${dot} flex-shrink-0`} />
                        </div>
                        <Badge
                          className={`rounded-full border-0 text-[10px] mt-1 ${
                            ROLE_BADGE[c.role] || "bg-secondary text-foreground/80"
                          }`}
                        >
                          {roleLabel(c.role)}
                        </Badge>
                        <div className="text-[11px] text-muted-foreground mt-1">
                          {c.active_today
                            ? "Active today"
                            : c.last_seen
                              ? `Last seen ${fmtRelative(c.last_seen)}`
                              : "No activity yet"}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px] mt-3 pt-3 border-t border-border">
                      <div>
                        <div className="text-muted-foreground">Leads /wk</div>
                        <div className="font-semibold tabular-nums">
                          {c.leads_this_week}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Apps MTD</div>
                        <div className="font-semibold tabular-nums">
                          {c.apps_mtd}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Rev MTD</div>
                        <div className="font-semibold tabular-nums">
                          {fmtMoney(c.revenue_mtd)}
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full mt-3 h-7 text-xs"
                      onClick={() => impersonate(c)}
                      data-testid={`agent-card-impersonate-${c.id}`}
                    >
                      <Eye className="w-3 h-3 mr-1" /> View Workspace
                    </Button>
                  </div>
                );
              })}
              {!loading && (stats?.agent_cards || []).length === 0 && (
                <div className="col-span-full text-xs text-muted-foreground py-6 text-center">
                  No active team members yet.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Row 5 — Live activity feed */}
        <ScrollableCard
          title="Live Activity"
          count={activity.length}
          height="380px"
          loading={loading || activityLoading}
          isEmpty={!loading && activity.length === 0}
          emptyState="No activity logged yet."
          testId="agency-activity-card"
          headerAction={
            <Button size="sm" variant="ghost" onClick={loadActivity}
                    className="h-7 text-xs">
              <Activity className="w-3 h-3 mr-1" /> Refresh
            </Button>
          }
        >
          <ul className="p-4 space-y-2">
            {activity.map((e, i) => (
              <li key={i} className="flex items-start gap-3 text-xs">
                <div className="w-1.5 h-1.5 rounded-full bg-[#e85d2f] mt-1.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{e.description}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {fmtRelative(e.timestamp)}
                    {e.actor_email ? ` · ${e.actor_email}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </ScrollableCard>
      </main>
    </div>
  );
}

function KpiCard({ label, value, icon: Icon, accent = false, money = false }) {
  return (
    <Card className="bg-surface">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div
          className={`mt-2 tabular-nums ${accent ? "text-[#e85d2f]" : "text-foreground"}`}
          style={{
            fontFamily: "Outfit",
            fontSize: money ? 22 : 30,
            fontWeight: 700,
          }}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function ComplianceMini({ label, value, tone }) {
  const text = {
    success: "text-emerald-700",
    danger: "text-rose-700",
    warn: "text-amber-700",
  }[tone] || "text-foreground";
  return (
    <div className="rounded-md border border-border p-3 bg-background">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`text-xl font-semibold tabular-nums mt-1 ${text}`}
           style={{ fontFamily: "Outfit" }}>
        {value}
      </div>
    </div>
  );
}
