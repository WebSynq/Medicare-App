/**
 * Military-themed Ops Console component.
 *
 * Lives in a sibling _-prefixed file so the page route remains a thin
 * shell — the page does the role gate then renders <OpsConsoleView />.
 * No PHI on screen — all numbers are aggregated counts.
 */
"use client";

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from "recharts";
import { toast } from "sonner";

import { isApiError, ops as opsApi } from "@/lib/api";
import {
  isOpsError,
  type BannedIp,
  type OpsActivityDay,
  type OpsAiSecurity,
  type OpsAutomations,
  type OpsCompliance,
  type OpsDataIntegrity,
  type OpsHealthResponse,
  type OpsSecurity,
  type OpsSystem,
  type OpsThreatLogEntry,
  type OpsUsage,
} from "@/lib/api/ops";
import {
  getSecurityEventsDetail,
  lookupIp,
  type BannedIpIntelExt,
  type IpLookupResult,
  type SecurityEventDetail,
} from "@/lib/api/ops-ext";
import { useAuthStore } from "@/stores/auth";

// ─── Palette (military theme) ─────────────────────────────────────────────

const BG_PRIMARY = "#0A0E1A";
const BG_CARD = "#0F1628";
const BG_CARD_2 = "#141B2D";
const BORDER_DIM = "#1E2D4A";
const BORDER_BRIGHT = "#2E4A7A";

const AMBER = "#F59E0B";
const AMBER_BRIGHT = "#FCD34D";
const AMBER_DIM = "#92400E";
const RED_ALERT = "#EF4444";
const RED_DIM = "#7F1D1D";
const GREEN_OK = "#10B981";
const GREEN_DIM = "#064E3B";
const CYAN = "#06B6D4";
const CYAN_DIM = "#164E63";
const WHITE = "#F1F5F9";
const GRAY_MID = "#64748B";
const GRAY_DIM = "#1E293B";

const FONT_MONO = "'Courier New','Lucida Console',monospace";
const FONT_SANS = "Arial,sans-serif";

const STYLE_ID = "ghw-ops-styles";

const STYLE_CONTENT = `
  @keyframes ghw-ops-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
  @keyframes ghw-ops-scan { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
  @keyframes ghw-ops-pulse-green {
    0%,100%{ box-shadow: 0 0 0 0 ${GREEN_OK}66 }
    50%   { box-shadow: 0 0 0 6px ${GREEN_OK}00 }
  }
  @keyframes ghw-ops-pulse-red {
    0%,100%{ box-shadow: 0 0 0 0 ${RED_ALERT}66 }
    50%   { box-shadow: 0 0 0 6px ${RED_ALERT}00 }
  }
  @keyframes ghw-ops-pulse-amber {
    0%,100%{ box-shadow: 0 0 0 0 ${AMBER}66 }
    50%   { box-shadow: 0 0 0 6px ${AMBER}00 }
  }
  @keyframes ghw-ops-countup {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .ghw-ops-blink { animation: ghw-ops-blink 2s ease-in-out infinite; }
  .ghw-ops-scanwrap { position: relative; overflow: hidden; }
  .ghw-ops-scanwrap::after {
    content: ""; position: absolute; top: 0; left: 0;
    width: 30%; height: 2px;
    background: linear-gradient(90deg, transparent, ${AMBER}, transparent);
    animation: ghw-ops-scan 3s linear infinite;
  }
  .ghw-ops-dot-green {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: ${GREEN_OK}; animation: ghw-ops-pulse-green 2s infinite;
  }
  .ghw-ops-dot-red {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: ${RED_ALERT}; animation: ghw-ops-pulse-red 2s infinite;
  }
  .ghw-ops-dot-amber {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: ${AMBER}; animation: ghw-ops-pulse-amber 2s infinite;
  }
  .ghw-ops-page {
    background-color: ${BG_PRIMARY};
    background-image: repeating-linear-gradient(
      to bottom,
      rgba(255,255,255,0.02) 0px,
      rgba(255,255,255,0.02) 1px,
      transparent 1px, transparent 3px
    );
  }
  .ghw-ops-countup { animation: ghw-ops-countup 0.6s ease-out both; }
  @media (max-width: 1024px) {
    .ghw-ops-grid-3 { grid-template-columns: 1fr !important; }
    .ghw-ops-grid-4 { grid-template-columns: 1fr 1fr !important; }
  }
  @media (max-width: 640px) {
    .ghw-ops-grid-4 { grid-template-columns: 1fr !important; }
  }
`;

function useOpsStyles() {
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = STYLE_CONTENT;
    document.head.appendChild(el);
  }, []);
}

function fmt3(n: number | null | undefined): string {
  return String(n ?? 0).padStart(3, "0");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface PostureScores {
  auth: number;
  access: number;
  encryption: number;
  monitoring: number;
  compliance: number;
  availability: number;
  overall: number;
}

function deriveScores(data: OpsHealthResponse | undefined): PostureScores {
  if (!data) {
    return {
      auth: 0,
      access: 0,
      encryption: 0,
      monitoring: 0,
      compliance: 0,
      availability: 0,
      overall: 0,
    };
  }
  const sec = isOpsError(data.security) ? null : (data.security as OpsSecurity);
  const di = isOpsError(data.data_integrity)
    ? null
    : (data.data_integrity as OpsDataIntegrity);
  const sys = isOpsError(data.system) ? null : (data.system as OpsSystem);
  const comp = isOpsError(data.compliance)
    ? null
    : (data.compliance as OpsCompliance);

  const auth = clamp(Math.round(sec?.mfa_adoption_pct ?? 0), 0, 100);
  const orphans = di?.leads_missing_agent ?? 0;
  const access = clamp(100 - orphans * 5, 0, 100);
  const encryption = clamp(100 - (di?.leads_dirty_state ?? 0) * 20, 0, 100);

  let monitoring = 0;
  if (comp?.audit_last_write) {
    const ageMs = Date.now() - Date.parse(comp.audit_last_write);
    const ageHrs = ageMs / 3_600_000;
    monitoring = clamp(100 - Math.floor(ageHrs) * 10, 0, 100);
  }

  const signedCount = [
    comp?.baa_render?.signed,
    comp?.baa_mongodb?.signed,
  ].filter(Boolean).length;
  const complianceScore = signedCount === 0 ? 0 : signedCount === 1 ? 50 : 100;

  const ping = sys?.db_ping_ms;
  const availability =
    !sys || ping == null
      ? 0
      : ping < 50
        ? 100
        : ping < 200
          ? 70
          : 40;

  const overall = Math.round(
    (auth + access + encryption + monitoring + complianceScore + availability) /
      6,
  );
  return {
    auth,
    access,
    encryption,
    monitoring,
    compliance: complianceScore,
    availability,
    overall,
  };
}

interface ThreatSummary {
  label: string;
  color: string;
  count: number;
}

function threatSummary(data: OpsHealthResponse | undefined): ThreatSummary {
  if (!data) return { label: "UNKNOWN", color: GRAY_MID, count: 0 };
  const sec = isOpsError(data.security) ? null : (data.security as OpsSecurity);
  const di = isOpsError(data.data_integrity)
    ? null
    : (data.data_integrity as OpsDataIntegrity);
  const issues =
    (sec?.accounts_locked_now ?? 0) +
    (sec?.ip_bans_active ?? 0) +
    ((sec?.booking_attacks_24hr ?? 0) > 5 ? 1 : 0) +
    ((di?.leads_missing_agent ?? 0) > 0 ? 1 : 0) +
    (di?.ghl_sync_errors ?? 0);
  if (issues === 0) return { label: "LOW", color: GREEN_OK, count: 0 };
  if (issues <= 3) return { label: "ELEVATED", color: AMBER, count: issues };
  return { label: "CRITICAL", color: RED_ALERT, count: issues };
}

// ─── Public component ─────────────────────────────────────────────────────

export function OpsConsoleView() {
  useOpsStyles();

  const user = useAuthStore((s) => s.user);
  const healthQuery = useQuery({
    queryKey: ["ops", "health"],
    queryFn: () => opsApi.getHealth(),
    refetchInterval: 60_000,
  });
  const data = healthQuery.data;
  const error = healthQuery.error
    ? "Failed to load ops data — retrying…"
    : null;

  const [clock, setClock] = React.useState<string>(() =>
    new Date().toLocaleTimeString("en-US", { hour12: false }),
  );
  const [secondsAgo, setSecondsAgo] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => {
      setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
    }, 1_000);
    return () => clearInterval(id);
  }, []);

  React.useEffect(() => {
    setSecondsAgo(0);
    const id = setInterval(() => setSecondsAgo((s) => s + 1), 1_000);
    return () => clearInterval(id);
  }, [healthQuery.dataUpdatedAt]);

  const scores = React.useMemo(() => deriveScores(data), [data]);
  const threat = React.useMemo(() => threatSummary(data), [data]);

  return (
    <div className="ghw-ops-page" style={styles.page}>
      <div style={styles.container}>
        <ClassifiedBanner clock={clock} operator={user} />
        <SystemStatusBar
          data={data}
          secondsAgo={secondsAgo}
          threat={threat}
        />
        {error ? (
          <div style={styles.errorBanner}>▲ {error}</div>
        ) : null}
        {healthQuery.isLoading ? (
          <LoadingRow />
        ) : (
          <>
            <KpiRow data={data} threat={threat} />
            <PostureRadar scores={scores} />
            <div className="ghw-ops-grid-3" style={styles.grid3}>
              <ThreatMonitor data={data} />
              <DataIntegrityScanner data={data} />
              <AutomationEngine data={data} />
            </div>
            <ComplianceCommand data={data} />
            <AISecurityPanel opsData={data} />
            <ChartsRow data={data} />
            <UsageSection data={data} />
            <Footer />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Header banner ────────────────────────────────────────────────────────

function ClassifiedBanner({
  clock,
  operator,
}: {
  clock: string;
  operator: { full_name?: string | null; email?: string; role?: string } | null;
}) {
  const name = (operator?.full_name || operator?.email || "OPERATOR").toUpperCase();
  const role = (operator?.role || "ADMIN").toUpperCase();
  return (
    <div className="ghw-ops-scanwrap" style={styles.banner}>
      <div style={styles.bannerInner}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="ghw-ops-blink" style={{ color: AMBER, fontSize: 22 }}>◉</span>
            <span style={{ color: AMBER, fontWeight: 800, letterSpacing: 2, fontSize: 22, textTransform: "uppercase" }}>
              OPS CONSOLE
            </span>
            <span className="ghw-ops-blink" style={styles.classified}>[CLASSIFIED]</span>
          </div>
          <div style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11, letterSpacing: 1 }}>
            GHW MEDICARE AGENT PORTAL · OPERATIONS COMMAND CENTER
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, color: WHITE, fontFamily: FONT_MONO, fontSize: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span><span style={styles.label}>OPERATOR:</span> {name}</span>
          <span><span style={styles.label}>CLEARANCE:</span> {role}</span>
          <span style={{ color: AMBER }}>████████ SECURE</span>
          <span style={{ color: WHITE, fontWeight: 700, fontSize: 16 }}>{clock}</span>
        </div>
      </div>
    </div>
  );
}

function SystemStatusBar({
  data,
  secondsAgo,
  threat,
}: {
  data: OpsHealthResponse | undefined;
  secondsAgo: number;
  threat: ThreatSummary;
}) {
  const sys = data && !isOpsError(data.system) ? (data.system as OpsSystem) : null;
  const auto = data && !isOpsError(data.automations) ? (data.automations as OpsAutomations) : null;
  const comp = data && !isOpsError(data.compliance) ? (data.compliance as OpsCompliance) : null;

  const apiOk = sys?.api_status === "ok";
  const ping = sys?.db_ping_ms;
  const sched = auto?.scheduler_status || "unknown";
  const lastSync = comp?.audit_last_write ?? null;
  const refreshColor = secondsAgo < 30 ? GREEN_OK : secondsAgo < 60 ? AMBER : RED_ALERT;

  const dot = (state: "ok" | "warning" | "error") =>
    state === "ok" ? <span className="ghw-ops-dot-green" aria-hidden="true" /> :
    state === "warning" ? <span className="ghw-ops-dot-amber" aria-hidden="true" /> :
    <span className="ghw-ops-dot-red" aria-hidden="true" />;

  return (
    <div style={styles.statusBar}>
      <span>
        <span style={styles.label}>SYSTEM:</span> [ {dot(apiOk ? "ok" : "error")}{" "}
        <span style={{ color: apiOk ? GREEN_OK : RED_ALERT, marginLeft: 4 }}>
          {apiOk ? "NOMINAL" : "DEGRADED"}
        </span> ]
      </span>
      <Sep />
      <span>
        <span style={styles.label}>DB:</span> [{" "}
        {dot(ping == null ? "error" : ping < 50 ? "ok" : ping < 200 ? "warning" : "error")}{" "}
        <span style={{ color: WHITE, marginLeft: 4 }}>{ping != null ? `${ping}ms` : "—"}</span> ]
      </span>
      <Sep />
      <span>
        <span style={styles.label}>SCHEDULER:</span> [{" "}
        {dot(sched === "running" ? "ok" : "error")}{" "}
        <span style={{ color: sched === "running" ? GREEN_OK : RED_ALERT, marginLeft: 4 }}>
          {sched.toUpperCase()}
        </span> ]
      </span>
      <Sep />
      <span>
        <span style={styles.label}>THREATS:</span> [{" "}
        {dot(threat.count === 0 ? "ok" : threat.count <= 3 ? "warning" : "error")}{" "}
        <span style={{ color: threat.color, marginLeft: 4 }}>{threat.count}</span> ]
      </span>
      <Sep />
      <span>
        <span style={styles.label}>LAST AUDIT:</span> [ {dot("ok")}{" "}
        <span style={{ color: WHITE, marginLeft: 4 }}>{relativeTime(lastSync)}</span> ]
      </span>
      <Sep />
      <span style={{ color: refreshColor }}>REFRESH: {secondsAgo}s</span>
    </div>
  );
}

function Sep() {
  return <span style={{ color: GRAY_MID, margin: "0 4px" }}>│</span>;
}

// ─── KPI row ──────────────────────────────────────────────────────────────

function KpiRow({ data, threat }: { data: OpsHealthResponse | undefined; threat: ThreatSummary }) {
  const sys = data && !isOpsError(data.system) ? (data.system as OpsSystem) : null;
  const sec = data && !isOpsError(data.security) ? (data.security as OpsSecurity) : null;
  const usage = data && !isOpsError(data.usage) ? (data.usage as OpsUsage) : null;
  const di = data && !isOpsError(data.data_integrity) ? (data.data_integrity as OpsDataIntegrity) : null;

  const mfaPct = sec?.mfa_adoption_pct ?? 0;
  const mfaStatus: "ok" | "warning" | "error" = mfaPct >= 80 ? "ok" : mfaPct >= 50 ? "warning" : "error";

  return (
    <div className="ghw-ops-grid-4" style={styles.grid4}>
      <KpiCard
        label="API RESPONSE"
        value={sys?.db_ping_ms != null ? `${sys.db_ping_ms} ms` : "—"}
        status={sys?.api_status === "ok" ? "ok" : "error"}
        barPct={sys?.db_ping_ms != null ? clamp(100 - sys.db_ping_ms, 0, 100) : 0}
        footer={sys?.api_status === "ok" ? "█████████░ OK" : "▓░░░░░░░░░ DEGRADED"}
      />
      <KpiCard
        label="ACTIVE AGENTS"
        value={`${usage?.active_agents_7d ?? 0} / ${di?.total_agents ?? 0}`}
        status="ok"
        footer="agents online (7d)"
      />
      <KpiCard
        label="MFA ADOPTION"
        value={`${Math.round(mfaPct)}%`}
        status={mfaStatus}
        barPct={mfaPct}
        footer={`${sec?.mfa_enabled_count ?? 0} of ${sec?.mfa_total_agents ?? 0} agents`}
      />
      <KpiCard
        label="THREAT LEVEL"
        value={threat.label}
        valueColor={threat.color}
        footer={`${threat.count} alert${threat.count === 1 ? "" : "s"} active`}
        status={threat.count === 0 ? "ok" : threat.count <= 3 ? "warning" : "error"}
        arrow
      />
    </div>
  );
}

function KpiCard({
  label, value, valueColor, footer, barPct, status, arrow,
}: {
  label: string; value: string; valueColor?: string; footer: string;
  barPct?: number; status: "ok" | "warning" | "error"; arrow?: boolean;
}) {
  const color = valueColor || (status === "error" ? RED_ALERT : status === "warning" ? AMBER_BRIGHT : GREEN_OK);
  return (
    <div style={styles.kpiCard} className="ghw-ops-countup">
      <div style={styles.kpiTopAccent} />
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{ ...styles.kpiValue, color, display: "flex", alignItems: "center", gap: 10 }}>
        {arrow ? <span style={{ fontSize: 20 }}>▲</span> : null}
        <span>{value}</span>
      </div>
      {barPct != null ? (
        <div style={styles.kpiBarTrack}>
          <div style={{ ...styles.kpiBarFill, width: `${clamp(barPct, 0, 100)}%`, background: color }} />
        </div>
      ) : null}
      <div style={styles.kpiFooter}>{footer}</div>
    </div>
  );
}

// ─── Posture radar ────────────────────────────────────────────────────────

function PostureRadar({ scores }: { scores: PostureScores }) {
  const radarData = [
    { dim: "AUTH SEC", v: scores.auth },
    { dim: "DATA INTEGRITY", v: scores.access },
    { dim: "ENCRYPTION", v: scores.encryption },
    { dim: "COMPLIANCE", v: scores.compliance },
    { dim: "AUTOMATIONS", v: scores.monitoring },
    { dim: "AI SECURITY", v: scores.availability },
  ];
  const overallColor = scores.overall >= 80 ? GREEN_OK : scores.overall >= 50 ? AMBER : RED_ALERT;
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>◈ SYSTEM POSTURE — 6 DIMENSIONS</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 24, alignItems: "center", marginTop: 8 }}>
        <div style={{ minHeight: 280 }}>
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarData}>
              <PolarGrid stroke={BORDER_BRIGHT} />
              <PolarAngleAxis dataKey="dim" tick={{ fill: AMBER, fontFamily: FONT_MONO, fontSize: 11 }} />
              <PolarRadiusAxis domain={[0, 100]} tick={{ fill: GRAY_MID, fontSize: 9 }} axisLine={false} />
              <Radar name="score" dataKey="v" stroke={CYAN} fill={CYAN} fillOpacity={0.18} strokeWidth={2} />
              <Tooltip contentStyle={tooltipStyle} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={styles.smallLabel}>OVERALL SCORE</div>
          <div style={{ color: overallColor, fontFamily: FONT_MONO, fontSize: 64, fontWeight: 700, lineHeight: 1 }}>
            {scores.overall}
          </div>
          <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4, fontFamily: FONT_MONO }}>/ 100</div>
          <div style={{ marginTop: 16 }}>
            {radarData.map((d) => (
              <div key={d.dim} style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 11, padding: "2px 0", color: GRAY_MID }}>
                <span>{d.dim}</span>
                <span style={{ color: d.v >= 80 ? GREEN_OK : d.v >= 50 ? AMBER : RED_ALERT }}>{d.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Threat monitor ───────────────────────────────────────────────────────

function ThreatMonitor({ data }: { data: OpsHealthResponse | undefined }) {
  if (data && isOpsError(data.security)) return <UnavailableCard title="🔴 THREAT MONITOR" message={data.security.error} />;
  const sec = data && !isOpsError(data.security) ? (data.security as OpsSecurity) : null;
  const comp = data && !isOpsError(data.compliance) ? (data.compliance as OpsCompliance) : null;
  const threatLog = data && !isOpsError(data.threat_log) ? (data.threat_log as OpsThreatLogEntry[]) : [];
  const logErr = data && isOpsError(data.threat_log);
  const alerts = (sec?.accounts_locked_now ?? 0) + (sec?.ip_bans_active ?? 0);
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle color={alerts > 0 ? RED_ALERT : GREEN_OK}>
        {alerts > 0 ? "🔴" : "🟢"} THREAT MONITOR
      </SectionTitle>
      <ThreatRow label="FAILED LOGINS [24HR]" value={fmt3(sec?.failed_logins_24hr)} level={(sec?.failed_logins_24hr ?? 0) > 10 ? "critical" : "ok"} />
      <ThreatRow label="LOCKED ACCTS [NOW]" value={fmt3(sec?.accounts_locked_now)} level={(sec?.accounts_locked_now ?? 0) > 0 ? "critical" : "ok"} />
      <ThreatRow label="IP BANS ACTIVE [NOW]" value={fmt3(sec?.ip_bans_active)} level={(sec?.ip_bans_active ?? 0) > 0 ? "warning" : "ok"} />
      <ThreatRow label="BOOKING ATKS [24HR]" value={fmt3(sec?.booking_attacks_24hr)} level={(sec?.booking_attacks_24hr ?? 0) > 5 ? "warning" : "ok"} />
      <ThreatRow label="NO-MFA AGENTS" value={fmt3(comp?.agents_without_mfa)} level={(comp?.agents_without_mfa ?? 0) > 0 ? "warning" : "ok"} />

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${BORDER_DIM}` }}>
        <div style={styles.smallLabel}>THREAT LOG · LAST 5</div>
        {logErr ? (
          <p style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>— log unavailable —</p>
        ) : (
          <table style={styles.threatTable}>
            <thead>
              <tr>
                <th style={styles.threatTh}>TIME</th>
                <th style={styles.threatTh}>EVENT</th>
                <th style={styles.threatTh}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {threatLog.slice(0, 5).map((row, i) => (
                <tr key={i}>
                  <td style={styles.threatTd}>{hhmm(row.time)}</td>
                  <td style={styles.threatTd}>{row.event}</td>
                  <td style={{ ...styles.threatTd, color: RED_ALERT }}>{row.status}</td>
                </tr>
              ))}
              {threatLog.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ ...styles.threatTd, color: GRAY_MID, textAlign: "center" }}>
                    — no incidents logged —
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ThreatRow({ label, value, level }: { label: string; value: string; level: "ok" | "warning" | "critical" }) {
  const color = level === "critical" ? RED_ALERT : level === "warning" ? AMBER : GREEN_OK;
  const symbol = level === "warning" ? "▲" : "●";
  return (
    <div style={styles.threatRow}>
      <span style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>
        {label.padEnd(24, " ").slice(0, 24)}
      </span>
      <span style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>....</span>
      <span style={{ color, fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, marginLeft: "auto", marginRight: 8 }}>
        {value}
      </span>
      <span style={{ color }}>{symbol}</span>
    </div>
  );
}

// ─── Data integrity scanner ───────────────────────────────────────────────

function DataIntegrityScanner({ data }: { data: OpsHealthResponse | undefined }) {
  if (data && isOpsError(data.data_integrity)) return <UnavailableCard title="📡 DATA INTEGRITY SCAN" message={data.data_integrity.error} />;
  const di = data && !isOpsError(data.data_integrity) ? (data.data_integrity as OpsDataIntegrity) : null;
  const issues = (di?.leads_missing_agent ?? 0) + (di?.leads_dirty_state ?? 0) + (di?.ghl_sync_errors ?? 0);
  const integrityPct = Math.max(0, 100 - issues);
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup ghw-ops-scanwrap">
      <SectionTitle>📡 DATA INTEGRITY SCAN</SectionTitle>
      <div style={{ color: CYAN, fontFamily: FONT_MONO, fontSize: 11, marginBottom: 8 }}>
        [SCANNING LEADS DATABASE…]
      </div>
      <IntegrityRow label="TOTAL RECORDS" value={di?.total_leads ?? 0} status="verified" />
      <IntegrityRow label="AGENT ORPHANS" value={di?.leads_missing_agent ?? 0} status={(di?.leads_missing_agent ?? 0) > 0 ? "warning" : "verified"} />
      <IntegrityRow label="STATE ANOMALIES" value={di?.leads_dirty_state ?? 0} status={(di?.leads_dirty_state ?? 0) > 0 ? "warning" : "verified"} />
      <IntegrityRow label="GHL SYNC ERRORS" value={di?.ghl_sync_errors ?? 0} status={(di?.ghl_sync_errors ?? 0) > 0 ? "warning" : "verified"} />
      <IntegrityRow label="UNSYNCED LEADS" value={di?.ghl_unsynced ?? 0} status="pending" />
      <IntegrityRow label="APPT REMINDERS" value={di?.reminders_pending ?? 0} status="pending" />
      <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${BORDER_DIM}` }}>
        <div style={styles.smallLabel}>DATABASE INTEGRITY · {integrityPct}%</div>
        <div style={styles.kpiBarTrack}>
          <div style={{ ...styles.kpiBarFill, width: `${integrityPct}%`, background: integrityPct >= 80 ? GREEN_OK : integrityPct >= 50 ? AMBER : RED_ALERT }} />
        </div>
      </div>
    </div>
  );
}

function IntegrityRow({ label, value, status }: { label: string; value: number; status: "verified" | "warning" | "error" | "pending" }) {
  const labelText = status === "verified" ? "✓ VERIFIED" : status === "warning" ? "⚠ ACTION REQ" : status === "error" ? "✗ ERROR" : "○ PENDING";
  const color = status === "verified" ? GREEN_OK : status === "warning" ? AMBER : status === "error" ? RED_ALERT : CYAN;
  return (
    <div style={styles.intRow}>
      <span style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>{label.padEnd(18, " ").slice(0, 18)}</span>
      <span style={{ color: WHITE, fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, marginLeft: "auto", marginRight: 12, minWidth: 50, textAlign: "right" }}>
        {String(value).padStart(3, "0")}
      </span>
      <span style={{ color, fontFamily: FONT_MONO, fontSize: 11, width: 130, textAlign: "right" }}>{labelText}</span>
    </div>
  );
}

// ─── Automation engine ────────────────────────────────────────────────────

const JOB_ORDER: Array<[string, string]> = [
  ["birthday_window", "Birthday Window"],
  ["new_lead_notify", "New Lead Notify"],
  ["reminder_48hr", "Reminder 48hr"],
  ["reminder_24hr", "Reminder 24hr"],
  ["reminder_1hr", "Reminder 1hr"],
  ["post_appointment", "Post-Appt Follow-up"],
  ["enrolled_welcome", "Enrolled Welcome"],
  ["stale_lead_alert", "Stale Lead Alert"],
];

function AutomationEngine({ data }: { data: OpsHealthResponse | undefined }) {
  if (data && isOpsError(data.automations)) return <UnavailableCard title="⚡ AUTOMATION ENGINE" message={data.automations.error} />;
  const auto = data && !isOpsError(data.automations) ? (data.automations as OpsAutomations) : null;
  const status = auto?.scheduler_status || "unknown";
  const lastCheck = auto?.last_reminder_check ? relativeTime(auto.last_reminder_check) : "—";
  const jobs = auto?.jobs ?? {};
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>⚡ AUTOMATION ENGINE</SectionTitle>
      <div style={{ border: `1px solid ${status === "running" ? GREEN_OK : RED_ALERT}`, borderRadius: 6, padding: 12, marginBottom: 14, background: status === "running" ? GREEN_DIM : RED_DIM, fontFamily: FONT_MONO }}>
        <div style={{ color: status === "running" ? GREEN_OK : RED_ALERT, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
          <span className={status === "running" ? "ghw-ops-dot-green" : "ghw-ops-dot-red"} />
          SCHEDULER: {status.toUpperCase()}
        </div>
        <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4 }}>15-MIN CYCLE · LAST RUN: {lastCheck}</div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT_MONO }}>
        <thead>
          <tr>
            <th style={styles.threatTh}>JOB</th>
            <th style={{ ...styles.threatTh, textAlign: "right" }}>LAST 7D</th>
            <th style={{ ...styles.threatTh, textAlign: "right" }}>STATUS</th>
          </tr>
        </thead>
        <tbody>
          {JOB_ORDER.map(([key, label]) => {
            const j = jobs[key];
            return (
              <tr key={key}>
                <td style={styles.threatTd}>{label}</td>
                <td style={{ ...styles.threatTd, textAlign: "right", color: WHITE }}>{fmt3(j?.sent_7d)} sent</td>
                <td style={{ ...styles.threatTd, textAlign: "right", color: GREEN_OK }}>● ACTIVE</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Compliance command ───────────────────────────────────────────────────

interface BaaRow {
  name: string;
  state: "signed" | "pending" | "not_signed" | "not_required";
  action: string;
}

function ComplianceCommand({ data }: { data: OpsHealthResponse | undefined }) {
  if (data && isOpsError(data.compliance)) return <UnavailableCard title="⚖ COMPLIANCE & CERTIFICATION STATUS" message={data.compliance.error} />;
  const c = data && !isOpsError(data.compliance) ? (data.compliance as OpsCompliance) : null;
  const baaState = (baa: { signed?: boolean } | undefined, fallback: "not_signed" | "pending"): "signed" | "pending" | "not_signed" =>
    baa?.signed ? "signed" : fallback;
  const rows: BaaRow[] = [
    { name: "Render (Hosting)", state: baaState(c?.baa_render, "not_signed"), action: "MATT: Approve $499/mo Scale plan" },
    { name: "MongoDB Atlas", state: baaState(c?.baa_mongodb, "not_signed"), action: "TIM: Contact mongodb.com/hipaa" },
    { name: "AWS SES", state: baaState(c?.baa_aws_ses, "pending"), action: "TIM: Migration pending" },
    { name: "Sentry (Monitoring)", state: "pending", action: "MATT: Approve Sentry billing" },
    { name: "Vercel (Frontend)", state: "not_required", action: "No action — no PHI" },
  ];
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>⚖ COMPLIANCE & CERTIFICATION STATUS</SectionTitle>
      <div className="ghw-ops-grid-3" style={{ ...styles.grid3, gridTemplateColumns: "1.4fr 1fr", marginTop: 10 }}>
        <div>
          <div style={styles.smallLabel}>BAA STATUS BOARD</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT_MONO }}>
            <thead>
              <tr>
                <th style={styles.threatTh}>VENDOR</th>
                <th style={styles.threatTh}>STATUS</th>
                <th style={styles.threatTh}>ACTION REQUIRED</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isSigned = row.state === "signed";
                const isNotReq = row.state === "not_required";
                const isPending = row.state === "pending";
                const bg = isSigned || isNotReq ? "transparent" : isPending ? `${AMBER_DIM}22` : `${RED_DIM}33`;
                const color = isSigned ? GREEN_OK : isNotReq ? GREEN_OK : isPending ? AMBER : RED_ALERT;
                const symbol = isSigned ? "✓ " : isNotReq ? "✓ " : isPending ? "▓▓ " : "██ ";
                const label = isSigned ? "SIGNED" : isNotReq ? "NOT REQUIRED" : isPending ? "MIGRATION PENDING" : "NOT SIGNED — Action Required";
                return (
                  <tr key={row.name} style={{ background: bg }}>
                    <td style={styles.threatTd}>{row.name}</td>
                    <td style={{ ...styles.threatTd, color, fontWeight: 700 }}>{symbol}{label}</td>
                    <td style={{ ...styles.threatTd, color: GRAY_MID }}>{row.action}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 12, color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>AUDIT LOG ENTRIES: <span style={{ color: WHITE }}>{c?.audit_log_count ?? 0}</span></span>
            <span style={{ color: GRAY_MID }}>·</span>
            <span>LAST WRITE: <span style={{ color: WHITE }}>{relativeTime(c?.audit_last_write ?? null)}</span></span>
          </div>
        </div>
        <div>
          <div style={styles.smallLabel}>RETENTION + PROCESS</div>
          <div style={{ border: `1px solid ${GREEN_OK}`, background: `${GREEN_DIM}55`, borderRadius: 6, padding: 12, fontFamily: FONT_MONO, marginBottom: 10 }}>
            <div style={{ color: GREEN_OK, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
              <span className="ghw-ops-dot-green" />
              HIPAA 7-YEAR AUDIT RETENTION
            </div>
            <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4 }}>
              ENFORCED · TTL forbidden on audit_logs (server.py comment).
            </div>
          </div>
          <div style={{ border: `1px solid ${BORDER_DIM}`, background: BG_CARD_2, borderRadius: 6, padding: 12, fontFamily: FONT_MONO }}>
            <div style={styles.smallLabel}>SOA COMPLIANCE</div>
            <div style={{ color: WHITE, fontSize: 18, fontWeight: 700, marginTop: 4 }}>
              {/* No dedicated SOA-rate metric on ops/health today; surface
                  the audit-log count as a proxy of compliance activity until
                  the real metric ships. */}
              {(c?.audit_log_count ?? 0).toLocaleString()} audit entries
            </div>
            <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4 }}>
              SOA-rate metric pending — see follow-ups.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AI Security Intelligence panel ───────────────────────────────────────

function AISecurityPanel({ opsData }: { opsData: OpsHealthResponse | undefined }) {
  const qc = useQueryClient();
  const aiErr = opsData ? isOpsError(opsData.ai_security) : false;
  const ai = opsData && !isOpsError(opsData.ai_security) ? (opsData.ai_security as OpsAiSecurity) : null;

  const eventsQuery = useQuery({
    queryKey: ["security", "events", { limit: 10 }],
    queryFn: () => getSecurityEventsDetail({ limit: 10 }),
    refetchInterval: 60_000,
  });
  const bansQuery = useQuery({
    queryKey: ["security", "banned-ips"],
    queryFn: () => opsApi.getBannedIps(),
    refetchInterval: 60_000,
  });
  const configQuery = useQuery({
    queryKey: ["security", "config"],
    queryFn: () => opsApi.getConfig(),
  });

  const killSwitchMutation = useMutation({
    mutationFn: (next: boolean) => opsApi.patchConfig({ ai_auto_ban_enabled: next }),
    onSuccess: (cfg) => {
      qc.setQueryData(["security", "config"], cfg);
      qc.invalidateQueries({ queryKey: ["ops", "health"] });
      toast.success(cfg.ai_auto_ban_enabled ? "Auto-ban ENABLED." : "Auto-ban DISABLED.");
    },
    onError: (err) => toast.error(isApiError(err) ? err.message : "Couldn't toggle."),
  });

  const runMutation = useMutation({
    mutationFn: () => opsApi.runAnalysis(),
    onSuccess: (event) => {
      qc.invalidateQueries({ queryKey: ["security", "events"] });
      qc.invalidateQueries({ queryKey: ["ops", "health"] });
      toast.success(`Analysis complete — threat level: ${event.threat_level}`);
    },
    onError: (err) => toast.error(isApiError(err) ? err.message : "Analysis failed."),
  });

  const unbanMutation = useMutation({
    mutationFn: (ip: string) => opsApi.unbanIp(ip),
    onSuccess: (_, ip) => {
      qc.invalidateQueries({ queryKey: ["security", "banned-ips"] });
      qc.invalidateQueries({ queryKey: ["ops", "health"] });
      toast.success(`Unbanned ${ip}.`);
    },
    onError: (err) => toast.error(isApiError(err) ? err.message : "Unban failed."),
  });

  const config = configQuery.data;
  const autoOn = killSwitchMutation.isPending && killSwitchMutation.variables != null
    ? killSwitchMutation.variables
    : (config?.ai_auto_ban_enabled ?? ai?.auto_ban_enabled ?? false);

  const events = eventsQuery.data?.events ?? [];
  const bans = bansQuery.data?.banned_ips ?? [];
  const [openEventId, setOpenEventId] = React.useState<string | null>(null);

  const lastTs = ai?.last_analysis ?? null;
  const lastThreat = (ai?.last_threat_level ?? "unknown").toLowerCase();
  const threatColor = lastThreat === "critical" || lastThreat === "high" ? RED_ALERT
    : lastThreat === "medium" ? AMBER : lastThreat === "low" ? GREEN_OK : GRAY_MID;

  if (aiErr) {
    return (
      <UnavailableCard
        title="◉ AI SECURITY INTELLIGENCE"
        message={opsData && isOpsError(opsData.ai_security) ? opsData.ai_security.error : "unavailable"}
      />
    );
  }

  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>◉ AI SECURITY INTELLIGENCE</SectionTitle>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap", padding: "12px 14px", borderRadius: 8, background: autoOn ? GREEN_DIM : RED_DIM, border: `1px solid ${autoOn ? GREEN_OK : RED_ALERT}`, marginBottom: 14, fontFamily: FONT_MONO }}>
        <div>
          <div style={{ color: autoOn ? GREEN_OK : RED_ALERT, fontWeight: 700, letterSpacing: 0.6 }}>
            AI AUTO-BAN: {autoOn ? "● ACTIVE" : "○ DISABLED"}
          </div>
          <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4 }}>
            {autoOn ? "AI auto-bans high/critical-threat IPs every 15 min." : "⚠ Threats will alert but will NOT be auto-blocked."}
          </div>
        </div>
        <button
          type="button"
          onClick={() => killSwitchMutation.mutate(!autoOn)}
          disabled={killSwitchMutation.isPending || !config}
          style={{
            background: autoOn ? RED_ALERT : GREEN_OK, color: WHITE, border: "none", borderRadius: 6,
            padding: "10px 18px", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 13, letterSpacing: 0.6,
            cursor: killSwitchMutation.isPending ? "not-allowed" : "pointer",
            opacity: killSwitchMutation.isPending ? 0.6 : 1,
          }}
        >
          {killSwitchMutation.isPending ? "…" : autoOn ? "DISABLE" : "ENABLE"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 14, alignItems: "stretch", marginBottom: 14 }}>
        <div style={{ background: BG_CARD_2, border: `1px solid ${BORDER_DIM}`, borderRadius: 8, padding: 14, fontFamily: FONT_MONO }}>
          <div style={styles.smallLabel}>LAST ANALYSIS</div>
          <div style={{ color: WHITE, fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {lastTs ? relativeTime(lastTs) : "no runs yet"}
          </div>
          <div style={{ marginTop: 4, color: threatColor, fontSize: 12, fontWeight: 700, letterSpacing: 0.6 }}>
            THREAT LEVEL: ● {lastThreat.toUpperCase()}
          </div>
          <div style={{ marginTop: 4, color: GRAY_MID, fontSize: 11 }}>
            {ai?.events_24hr ?? 0} runs in last 24h · {ai?.bans_ai_24hr ?? 0} AI bans · {ai?.bans_active ?? 0} bans active
          </div>
        </div>
        <button
          type="button"
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          style={{
            background: CYAN_DIM, color: CYAN, border: `1px solid ${CYAN}`, borderRadius: 8,
            padding: "10px 18px", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 12, letterSpacing: 0.6,
            cursor: runMutation.isPending ? "not-allowed" : "pointer", minWidth: 140,
          }}
        >
          {runMutation.isPending ? "RUNNING…" : "RUN NOW"}
        </button>
      </div>

      <div style={styles.smallLabel}>RECENT EVENTS · LAST 10</div>
      <table style={styles.threatTable}>
        <thead>
          <tr>
            <th style={styles.threatTh}>TIME</th>
            <th style={styles.threatTh}>LEVEL</th>
            <th style={styles.threatTh}>SUMMARY</th>
          </tr>
        </thead>
        <tbody>
          {eventsQuery.isError ? (
            <tr>
              <td colSpan={3} style={{ ...styles.threatTd, color: RED_ALERT, textAlign: "center" }}>
                — events unavailable —
              </td>
            </tr>
          ) : events.length === 0 ? (
            <tr>
              <td colSpan={3} style={{ ...styles.threatTd, color: GRAY_MID, textAlign: "center" }}>
                — no security analyses recorded yet —
              </td>
            </tr>
          ) : (
            events.map((e: SecurityEventDetail) => {
              const lvl = (e.threat_level || "low").toLowerCase();
              const c = lvl === "critical" || lvl === "high" ? RED_ALERT
                : lvl === "medium" ? AMBER : lvl === "low" ? GREEN_OK : GRAY_MID;
              const isOpen = openEventId === e.event_id;
              const summary = (e.ai_narrative || e.summary || "(no narrative)").toString();
              return (
                <React.Fragment key={e.event_id}>
                  <tr onClick={() => setOpenEventId(isOpen ? null : e.event_id)} style={{ cursor: "pointer" }}>
                    <td style={styles.threatTd}>{hhmm(e.timestamp)}</td>
                    <td style={{ ...styles.threatTd, color: c, fontWeight: 700 }}>{lvl.toUpperCase()}</td>
                    <td style={styles.threatTd}>
                      {summary.slice(0, 80)}{summary.length > 80 ? "…" : ""}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={3} style={{ ...styles.threatTd, background: BG_CARD_2, color: WHITE, padding: 14, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                        <div style={{ color: CYAN, fontWeight: 700, marginBottom: 6 }}>AI NARRATIVE</div>
                        <div>{summary}</div>
                        {(e.findings ?? []).length > 0 ? (
                          <div style={{ marginTop: 10 }}>
                            <div style={{ color: AMBER, fontWeight: 700 }}>
                              FINDINGS ({(e.findings ?? []).length})
                            </div>
                            <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                              {(e.findings ?? []).map((f, i) => (
                                <li key={i} style={{ color: GRAY_MID, fontSize: 12 }}>
                                  <strong style={{ color: WHITE }}>{f.type ?? "finding"}</strong>
                                  {" · "}{(f.severity ?? "").toString().toUpperCase()}{" — "}{f.description ?? ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {(e.auto_actions_taken ?? []).length > 0 ? (
                          <div style={{ marginTop: 10, color: RED_ALERT, fontSize: 12 }}>
                            AUTO-ACTIONS: {(e.auto_actions_taken ?? []).map((a) => `${a.type ?? ""}:${a.ip ?? ""}`).join(", ")}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>

      <div style={{ ...styles.smallLabel, marginTop: 18 }}>ACTIVE IP BANS · {bans.length}</div>
      <table style={styles.threatTable}>
        <thead>
          <tr>
            <th style={styles.threatTh}>IP</th>
            <th style={styles.threatTh}>LOCATION</th>
            <th style={styles.threatTh}>BANNED</th>
            <th style={styles.threatTh}>REASON</th>
            <th style={styles.threatTh}>ACTION</th>
          </tr>
        </thead>
        <tbody>
          {bansQuery.isError ? (
            <tr>
              <td colSpan={5} style={{ ...styles.threatTd, color: RED_ALERT, textAlign: "center" }}>
                — bans unavailable —
              </td>
            </tr>
          ) : bans.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ ...styles.threatTd, color: GRAY_MID, textAlign: "center" }}>
                — no active bans —
              </td>
            </tr>
          ) : (
            bans.slice(0, 10).map((b: BannedIp) => {
              const intel: BannedIpIntelExt = b.intel ?? {};
              const loc = [intel.city, intel.country_code ?? intel.country].filter(Boolean).join(", ") || "—";
              const bannedAt = typeof b.banned_at === "string" ? b.banned_at : null;
              return (
                <tr key={b.ip}>
                  <td style={{ ...styles.threatTd, fontFamily: "monospace" }}>{b.ip}</td>
                  <td style={styles.threatTd}>{loc}</td>
                  <td style={styles.threatTd}>{relativeTime(bannedAt)}</td>
                  <td style={{ ...styles.threatTd, color: GRAY_MID }}>
                    {(b.reason || b.source || "—").slice(0, 40)}
                  </td>
                  <td style={styles.threatTd}>
                    <button
                      type="button"
                      onClick={() => unbanMutation.mutate(b.ip)}
                      disabled={unbanMutation.isPending && unbanMutation.variables === b.ip}
                      style={{
                        background: "transparent", color: AMBER, border: `1px solid ${AMBER}`,
                        borderRadius: 4, padding: "3px 10px", fontFamily: FONT_MONO,
                        fontSize: 11, cursor: "pointer",
                      }}
                    >
                      {unbanMutation.isPending && unbanMutation.variables === b.ip ? "…" : "UNBAN"}
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <IpLookup />
    </div>
  );
}

function IpLookup() {
  const [ip, setIp] = React.useState("");
  const [result, setResult] = React.useState<IpLookupResult | null>(null);
  const lookupMutation = useMutation({
    mutationFn: (input: string) => lookupIp(input),
    onSuccess: (data) => setResult(data),
    onError: (err) => {
      setResult({ ip, error: isApiError(err) ? err.message : "Lookup failed" });
    },
  });

  const go = () => {
    const trimmed = ip.trim();
    if (!trimmed) return;
    setResult(null);
    lookupMutation.mutate(trimmed);
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div style={styles.smallLabel}>IP LOOKUP</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); }}
          placeholder="Enter IP address…"
          style={{
            flex: 1, background: BG_CARD_2, color: WHITE,
            border: `1px solid ${BORDER_BRIGHT}`, borderRadius: 6,
            padding: "8px 12px", fontFamily: FONT_MONO, fontSize: 13,
          }}
        />
        <button
          type="button"
          onClick={go}
          disabled={lookupMutation.isPending || !ip.trim()}
          style={{
            background: CYAN_DIM, color: CYAN, border: `1px solid ${CYAN}`, borderRadius: 6,
            padding: "8px 18px", fontFamily: FONT_MONO, fontWeight: 700, fontSize: 12,
            cursor: lookupMutation.isPending ? "not-allowed" : "pointer", minWidth: 90,
          }}
        >
          {lookupMutation.isPending ? "…" : "LOOKUP"}
        </button>
      </div>
      {result ? (
        <div style={{ marginTop: 10, padding: 12, borderRadius: 8, background: BG_CARD_2, border: `1px solid ${BORDER_DIM}`, fontFamily: FONT_MONO, fontSize: 12, color: WHITE }}>
          {result.error ? (
            <div style={{ color: RED_ALERT }}>✗ {result.error}</div>
          ) : result.private ? (
            <div style={{ color: GRAY_MID }}>
              {result.ip} is a private / loopback IP — no geo data.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 4 }}>
              <AiRow label="IP" value={result.ip} />
              <AiRow label="Location" value={[result.city, result.region, result.country].filter(Boolean).join(", ") || "—"} />
              <AiRow label="ISP" value={result.isp || "—"} />
              <AiRow label="VPN/Proxy" value={result.is_vpn ? "YES" : "no"} />
              <AiRow label="Tor" value={result.is_tor ? "YES" : "no"} />
              {result.threat_score != null ? (
                <AiRow label="Abuse score" value={`${result.threat_score} / 100`} />
              ) : null}
              {result.lookup_error ? (
                <div style={{ color: AMBER, marginTop: 4 }}>Note: {result.lookup_error}</div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function AiRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "2px 0", fontFamily: FONT_MONO, fontSize: 12 }}>
      <span style={{ color: GRAY_MID }}>{label}</span>
      <span style={{ color: WHITE, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ─── Charts row ───────────────────────────────────────────────────────────

function ChartsRow({ data }: { data: OpsHealthResponse | undefined }) {
  if (data && isOpsError(data.activity_7d)) {
    return <UnavailableCard title="◉ ACTIVITY · LAST 7 DAYS" message={data.activity_7d.error} />;
  }
  const days: OpsActivityDay[] = data && !isOpsError(data.activity_7d) ? (data.activity_7d as OpsActivityDay[]) : [];
  return (
    <div className="ghw-ops-grid-3" style={{ ...styles.grid3, gridTemplateColumns: "1fr 1fr" }}>
      <ChartCard title="◉ LEAD ACTIVITY — LAST 7 DAYS">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={days}>
            <CartesianGrid stroke={BORDER_DIM} strokeDasharray="3 3" />
            <XAxis dataKey="label" stroke={GRAY_MID} tick={{ fill: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }} />
            <YAxis stroke={GRAY_MID} allowDecimals={false} tick={{ fill: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: AMBER, strokeOpacity: 0.4 }} />
            <Legend wrapperStyle={{ fontFamily: FONT_MONO, color: GRAY_MID, fontSize: 11 }} />
            <Line type="monotone" dataKey="leads" stroke={CYAN} strokeWidth={2} dot={{ fill: CYAN, r: 3 }} />
            <Line type="monotone" dataKey="enrollments" stroke={AMBER} strokeWidth={2} dot={{ fill: AMBER, r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="◉ BOOKING ACTIVITY — LAST 7 DAYS">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={days}>
            <CartesianGrid stroke={BORDER_DIM} strokeDasharray="3 3" />
            <XAxis dataKey="label" stroke={GRAY_MID} tick={{ fill: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }} />
            <YAxis stroke={GRAY_MID} allowDecimals={false} tick={{ fill: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: AMBER, fillOpacity: 0.1 }} />
            <Bar dataKey="bookings" fill={AMBER} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

// ─── Usage section ────────────────────────────────────────────────────────

function UsageSection({ data }: { data: OpsHealthResponse | undefined }) {
  if (data && isOpsError(data.usage)) return <UnavailableCard title="◉ USAGE — LAST 7 DAYS" message={data.usage.error} />;
  const u = data && !isOpsError(data.usage) ? (data.usage as OpsUsage) : null;
  // Backend's /ops/health doesn't return a per-agent activity breakdown
  // today — spec lists "Top active agents" but that needs a new aggregation.
  // Surface the aggregates instead; the per-agent list is a tracked follow-up.
  const tiles: Array<[string, number]> = [
    ["Logins (active 7d)", u?.active_agents_7d ?? 0],
    ["Leads created (7d)", u?.leads_created_7d ?? 0],
    ["Leads today", u?.leads_created_today ?? 0],
    ["Bookings (7d)", u?.bookings_7d ?? 0],
    ["Bookings today", u?.bookings_today ?? 0],
    ["SOAs signed (7d)", u?.soa_signed_7d ?? 0],
    ["Enrollments (7d)", u?.enrollments_7d ?? 0],
  ];
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>◉ USAGE — 7-DAY ACTIVITY</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
        {tiles.map(([label, val]) => (
          <div key={label} style={{ background: BG_CARD_2, border: `1px solid ${BORDER_DIM}`, borderRadius: 8, padding: 14, fontFamily: FONT_MONO }}>
            <div style={styles.smallLabel}>{label}</div>
            <div style={{ color: WHITE, fontSize: 26, fontWeight: 700, marginTop: 4 }}>{val.toLocaleString()}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>
        Top-active-agents breakdown: planned · backend aggregation pending.
      </div>
    </div>
  );
}

// ─── Reusable bits ────────────────────────────────────────────────────────

function SectionTitle({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{
      color: color || AMBER, fontFamily: FONT_MONO, fontSize: 13,
      letterSpacing: 1.2, fontWeight: 700, marginBottom: 12,
      borderBottom: `1px solid ${BORDER_DIM}`, paddingBottom: 8,
    }}>
      {children}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </div>
  );
}

function UnavailableCard({ title, message }: { title: string; message?: string }) {
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle color={RED_ALERT}>{title}</SectionTitle>
      <div style={{
        color: RED_ALERT, background: `${RED_DIM}33`,
        border: `1px solid ${RED_ALERT}`, borderRadius: 6,
        padding: 12, fontFamily: FONT_MONO, fontSize: 12,
      }}>
        ▲ SECTION UNAVAILABLE {message ? `— ${message}` : ""}
      </div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div style={{ marginTop: 16 }}>
      <div className="ghw-ops-grid-4" style={styles.grid4}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ ...styles.kpiCard, opacity: 0.4 }}>
            <div style={styles.kpiTopAccent} />
            <div style={styles.kpiLabel}>LOADING…</div>
            <div style={{ ...styles.kpiValue, color: GRAY_MID }}>—</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div style={{
      marginTop: 20, padding: "12px 0", textAlign: "center",
      color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11,
      letterSpacing: 1, borderTop: `1px solid ${BORDER_DIM}`,
    }}>
      ▓▓▓ END OF TRANSMISSION · ALL DATA AGGREGATED — NO PHI ON SCREEN ▓▓▓
    </div>
  );
}

// ─── Inline style table ───────────────────────────────────────────────────

const tooltipStyle: React.CSSProperties = {
  background: BG_CARD_2,
  border: `1px solid ${BORDER_BRIGHT}`,
  color: WHITE,
  fontFamily: FONT_MONO,
  fontSize: 12,
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh", color: WHITE, fontFamily: FONT_SANS,
    // Bleed under the admin layout's p-6 wrapper so the military
    // background fills edge-to-edge rather than sitting in a card.
    marginInline: -24, marginTop: -24, marginBottom: -24,
  },
  container: { maxWidth: 1600, margin: "0 auto", padding: "24px" },
  banner: {
    border: `1px solid ${AMBER}`, borderRadius: 6,
    background: `${AMBER_DIM}22`, padding: 14, marginBottom: 12,
  },
  bannerInner: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 16, flexWrap: "wrap", fontFamily: FONT_MONO,
  },
  classified: {
    color: AMBER_BRIGHT, fontWeight: 700, border: `1px solid ${AMBER}`,
    padding: "2px 6px", fontSize: 11, letterSpacing: 1,
  },
  label: { color: AMBER, letterSpacing: 0.6, fontSize: 11 },
  statusBar: {
    display: "flex", alignItems: "center", gap: 6,
    fontFamily: FONT_MONO, fontSize: 12, color: WHITE,
    padding: "8px 14px", marginBottom: 18,
    background: BG_CARD, border: `1px solid ${BORDER_DIM}`,
    borderRadius: 6, flexWrap: "wrap",
  },
  errorBanner: {
    color: RED_ALERT, background: `${RED_DIM}33`,
    border: `1px solid ${RED_ALERT}`, borderRadius: 6,
    padding: "10px 14px", marginBottom: 14, fontFamily: FONT_MONO,
  },
  grid4: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 },
  grid3: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 18 },
  kpiCard: {
    background: BG_CARD, border: `1px solid ${BORDER_DIM}`,
    borderRadius: 8, padding: 20, position: "relative", fontFamily: FONT_MONO,
  },
  kpiTopAccent: {
    position: "absolute", top: 0, left: 0, right: 0,
    height: 3, background: AMBER, borderRadius: "8px 8px 0 0",
  },
  kpiLabel: { color: GRAY_MID, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase" },
  kpiValue: { fontSize: 36, fontWeight: 700, marginTop: 10, marginBottom: 8, letterSpacing: -0.5 },
  kpiBarTrack: { height: 6, background: GRAY_DIM, borderRadius: 3, overflow: "hidden", marginTop: 8 },
  kpiBarFill: { height: "100%", transition: "width 600ms ease" },
  kpiFooter: { color: GRAY_MID, fontSize: 11, marginTop: 8, letterSpacing: 0.4 },
  sectionCard: {
    background: BG_CARD, border: `1px solid ${BORDER_DIM}`,
    borderRadius: 8, padding: 20, marginBottom: 14,
  },
  smallLabel: {
    color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 10,
    letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 8,
  },
  threatRow: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "5px 0", borderBottom: `1px dashed ${BORDER_DIM}`,
  },
  threatTable: {
    width: "100%", borderCollapse: "collapse",
    fontFamily: FONT_MONO, marginTop: 6,
  },
  threatTh: {
    color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 10,
    letterSpacing: 1.2, textAlign: "left",
    padding: "6px 8px", borderBottom: `1px solid ${BORDER_DIM}`,
    fontWeight: 700,
  },
  threatTd: {
    color: WHITE, fontFamily: FONT_MONO, fontSize: 12,
    padding: "6px 8px", borderBottom: `1px dashed ${BORDER_DIM}`,
  },
  intRow: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "6px 0", borderBottom: `1px dashed ${BORDER_DIM}`,
  },
};
