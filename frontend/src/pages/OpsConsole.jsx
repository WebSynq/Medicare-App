/**
 * Operations Command Center — military-themed admin ops console.
 *
 * Route: /ops (inside Protected wrapper, admin/owner only).
 * Backend: GET /api/ops/health — single endpoint, parallel queries.
 * Auto-refresh: every 60s. Tear-down on unmount.
 *
 * All visuals: dark navy + amber/cyan, monospace headings, scanline
 * overlay, blinking indicators. No PHI surfaced — aggregated counts
 * only. Aggregation lives server-side; this file is purely view.
 */
import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { api, auth } from "@/lib/api";

// ── Palette ────────────────────────────────────────────────────────────────
const BG_PRIMARY    = "#0A0E1A";
const BG_CARD       = "#0F1628";
const BG_CARD_2     = "#141B2D";
const BORDER_DIM    = "#1E2D4A";
const BORDER_BRIGHT = "#2E4A7A";

const AMBER         = "#F59E0B";
const AMBER_BRIGHT  = "#FCD34D";
const AMBER_DIM     = "#92400E";
const RED_ALERT     = "#EF4444";
const RED_DIM       = "#7F1D1D";
const GREEN_OK      = "#10B981";
const GREEN_DIM     = "#064E3B";
const CYAN          = "#06B6D4";
const CYAN_DIM      = "#164E63";
const WHITE         = "#F1F5F9";
const GRAY_MID      = "#64748B";
const GRAY_DIM      = "#1E293B";

const FONT_MONO = "'Courier New','Lucida Console',monospace";
const FONT_SANS = "Arial,sans-serif";

// ── Inject keyframes + scanline texture (one-time) ────────────────────────
function useOpsStyles() {
  useEffect(() => {
    const ID = "ghw-ops-styles";
    if (document.getElementById(ID)) return;
    const el = document.createElement("style");
    el.id = ID;
    el.textContent = `
      @keyframes ghw-ops-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
      @keyframes ghw-ops-scan  {
        0%{transform:translateX(-100%)} 100%{transform:translateX(100%)}
      }
      @keyframes ghw-ops-pulse {
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
      .ghw-ops-scanwrap {
        position: relative; overflow: hidden;
      }
      .ghw-ops-scanwrap::after {
        content: ""; position: absolute; top: 0; left: 0;
        width: 30%; height: 2px; background: linear-gradient(
          90deg, transparent, ${AMBER}, transparent
        );
        animation: ghw-ops-scan 3s linear infinite;
      }
      .ghw-ops-dot-green {
        display: inline-block; width: 8px; height: 8px;
        border-radius: 50%; background: ${GREEN_OK};
        animation: ghw-ops-pulse 2s infinite;
      }
      .ghw-ops-dot-red {
        display: inline-block; width: 8px; height: 8px;
        border-radius: 50%; background: ${RED_ALERT};
        animation: ghw-ops-pulse-red 2s infinite;
      }
      .ghw-ops-dot-amber {
        display: inline-block; width: 8px; height: 8px;
        border-radius: 50%; background: ${AMBER};
        animation: ghw-ops-pulse-amber 2s infinite;
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
      .ghw-recharts-tooltip {
        background: ${BG_CARD_2} !important;
        border: 1px solid ${BORDER_BRIGHT} !important;
        color: ${WHITE} !important;
        font-family: ${FONT_MONO};
      }
      @media (max-width: 1024px) {
        .ghw-ops-grid-3 { grid-template-columns: 1fr !important; }
        .ghw-ops-grid-4 { grid-template-columns: 1fr 1fr !important; }
      }
      @media (max-width: 640px) {
        .ghw-ops-grid-4 { grid-template-columns: 1fr !important; }
      }
    `;
    document.head.appendChild(el);
  }, []);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt2(n) {
  return String(n ?? 0).padStart(3, "0");
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function relativeTime(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

function StatusDot({ status }) {
  if (status === "ok" || status === "signed" || status === "running")
    return <span className="ghw-ops-dot-green" aria-label="ok" />;
  if (status === "warning" || status === "pending")
    return <span className="ghw-ops-dot-amber" aria-label="warning" />;
  return <span className="ghw-ops-dot-red" aria-label="error" />;
}

// (Number count-up is delivered via the CSS .ghw-ops-countup fade-in
//  keyframe on first mount — keeps the visual impact without a per-
//  number state machine.)

// ── Posture score derivation ──────────────────────────────────────────────
function deriveScores(data) {
  if (!data) {
    return { auth: 0, access: 0, encryption: 0, monitoring: 0,
              compliance: 0, availability: 0, overall: 0 };
  }
  const security = data.security || {};
  const di = data.data_integrity || {};
  const sys = data.system || {};
  const comp = data.compliance || {};

  const auth = clamp(Math.round(security.mfa_adoption_pct ?? 0), 0, 100);
  const orphans = di.leads_missing_agent ?? 0;
  const access = clamp(100 - orphans * 5, 0, 100);
  // Encryption is binary at the platform layer (PHI_FIELD_KEY in place);
  // surface dirty-data penalties so the radar reflects integrity drift.
  const encryption = clamp(
    100 - (di.leads_dirty_state ?? 0) * 20, 0, 100,
  );
  // Monitoring: fresh audit writes prove the trail is alive.
  let monitoring = 0;
  if (comp.audit_last_write) {
    const ageMs = Date.now() - Date.parse(comp.audit_last_write);
    const ageHrs = ageMs / 3_600_000;
    monitoring = clamp(100 - Math.floor(ageHrs) * 10, 0, 100);
  }
  // Compliance: 0 / 50 / 100 based on BAA signatures.
  const signed = [
    comp.baa_render === "signed",
    comp.baa_mongodb === "signed",
  ].filter(Boolean).length;
  const compliance = signed === 0 ? 0 : signed === 1 ? 50 : 100;
  // Availability: db_ping_ms thresholds.
  const ping = sys.db_ping_ms;
  const availability = sys.error || ping == null
    ? 0
    : ping < 50 ? 100 : ping < 200 ? 70 : 40;

  const overall = Math.round(
    (auth + access + encryption + monitoring + compliance + availability) / 6,
  );
  return { auth, access, encryption, monitoring, compliance,
            availability, overall };
}

function threatLevel(data) {
  if (!data) return { label: "UNKNOWN", color: GRAY_MID, count: 0 };
  const s = data.security || {};
  const di = data.data_integrity || {};
  const issues =
    (s.accounts_locked_now ?? 0) +
    (s.ip_bans_active ?? 0) +
    (s.booking_attacks_24hr > 5 ? 1 : 0) +
    (di.leads_missing_agent > 0 ? 1 : 0) +
    (di.ghl_sync_errors ?? 0);
  if (issues === 0) return { label: "LOW", color: GREEN_OK, count: 0 };
  if (issues <= 3) return { label: "ELEVATED", color: AMBER, count: issues };
  return { label: "CRITICAL", color: RED_ALERT, count: issues };
}

// ── Component ──────────────────────────────────────────────────────────────
export default function OpsConsole() {
  useOpsStyles();
  // All hooks declared up-front — React rules forbid hook calls after
  // an early return. The role gate is the LAST statement before the
  // JSX so the App.js Protected wrapper is the actual access control;
  // this is belt-and-braces.
  const user = auth.getUser();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [clock, setClock] = useState(
    new Date().toLocaleTimeString("en-US", { hour12: false }),
  );

  // Initial + 60s refresh.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const { data: payload } = await api.get("/ops/health");
        if (!alive) return;
        setData(payload);
        setError(null);
        setSecondsAgo(0);
      } catch (e) {
        if (!alive) return;
        setError("Failed to load ops data — retrying…");
      }
    }
    load();
    const refreshInterval = setInterval(load, 60_000);
    const secInterval = setInterval(() => setSecondsAgo((s) => s + 1), 1_000);
    const clockInterval = setInterval(() => {
      setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
    }, 1_000);
    return () => {
      alive = false;
      clearInterval(refreshInterval);
      clearInterval(secInterval);
      clearInterval(clockInterval);
    };
  }, []);

  const scores = useMemo(() => deriveScores(data), [data]);
  const threat = useMemo(() => threatLevel(data), [data]);

  // Role gate — runs AFTER all hooks. App.js's Protected wrapper is the
  // primary gate; this is defence-in-depth against a direct mount.
  if (!user || !["admin", "owner"].includes(user.role)) {
    return <Navigate to="/today" replace />;
  }

  return (
    <div className="ghw-ops-page" style={styles.page}>
      <div style={styles.container}>
        <ClassifiedBanner clock={clock} operator={user} />
        <SystemStatusBar
          data={data}
          secondsAgo={secondsAgo}
          error={error}
          threat={threat}
        />

        {error && (
          <div style={styles.errorBanner} data-testid="ops-error">
            ▲ {error}
          </div>
        )}

        {/* Top KPI row */}
        <div className="ghw-ops-grid-4" style={styles.grid4}>
          <KpiCard
            label="API RESPONSE"
            value={data?.system?.db_ping_ms != null
              ? `${data.system.db_ping_ms} ms`
              : "—"}
            status={data?.system?.api_status === "ok" ? "ok" : "error"}
            barPct={data?.system?.db_ping_ms != null
              ? clamp(100 - data.system.db_ping_ms, 0, 100)
              : 0}
            footer={data?.system?.api_status === "ok"
              ? "█████████░ OK" : "▓░░░░░░░░░ DEGRADED"}
          />
          <KpiCard
            label="ACTIVE AGENTS"
            value={`${data?.usage?.active_agents_7d ?? 0} / ${
              data?.data_integrity?.total_agents ?? 0
            }`}
            status="ok"
            footer="agents online (7d)"
          />
          <KpiCard
            label="MFA ADOPTION"
            value={`${Math.round(data?.security?.mfa_adoption_pct ?? 0)}%`}
            status={
              (data?.security?.mfa_adoption_pct ?? 0) >= 80 ? "ok"
              : (data?.security?.mfa_adoption_pct ?? 0) >= 50 ? "warning"
              : "error"
            }
            barPct={data?.security?.mfa_adoption_pct ?? 0}
            footer={`${data?.security?.mfa_enabled_count ?? 0} of ${
              data?.security?.mfa_total_agents ?? 0
            } agents`}
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

        {/* Posture radar */}
        <PostureRadar scores={scores} />

        {/* 3-column grid */}
        <div className="ghw-ops-grid-3" style={styles.grid3}>
          <ThreatMonitor data={data} />
          <DataIntegrityScanner data={data} />
          <AutomationEngine data={data} />
        </div>

        {/* Compliance command */}
        <ComplianceCommand data={data} />

        <AISecurityPanel opsData={data} />

        {/* Charts */}
        <div className="ghw-ops-grid-3" style={{ ...styles.grid3,
                                                  gridTemplateColumns: "1fr 1fr" }}>
          <ChartCard
            title="◉ LEAD ACTIVITY — LAST 7 DAYS"
            chart={
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data?.activity_7d || []}>
                  <CartesianGrid stroke={BORDER_DIM} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={GRAY_MID}
                          tick={{ fill: GRAY_MID, fontFamily: FONT_MONO,
                                  fontSize: 11 }} />
                  <YAxis stroke={GRAY_MID} allowDecimals={false}
                          tick={{ fill: GRAY_MID, fontFamily: FONT_MONO,
                                  fontSize: 11 }} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: AMBER, strokeOpacity: 0.4 }} />
                  <Legend wrapperStyle={{ fontFamily: FONT_MONO, color: GRAY_MID, fontSize: 11 }} />
                  <Line type="monotone" dataKey="leads"
                         stroke={CYAN} strokeWidth={2}
                         dot={{ fill: CYAN, r: 3 }} />
                  <Line type="monotone" dataKey="enrollments"
                         stroke={AMBER} strokeWidth={2}
                         dot={{ fill: AMBER, r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            } />
          <ChartCard
            title="◉ BOOKING ACTIVITY — LAST 7 DAYS"
            chart={
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data?.activity_7d || []}>
                  <CartesianGrid stroke={BORDER_DIM} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={GRAY_MID}
                          tick={{ fill: GRAY_MID, fontFamily: FONT_MONO,
                                  fontSize: 11 }} />
                  <YAxis stroke={GRAY_MID} allowDecimals={false}
                          tick={{ fill: GRAY_MID, fontFamily: FONT_MONO,
                                  fontSize: 11 }} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: AMBER, fillOpacity: 0.1 }} />
                  <Bar dataKey="bookings" fill={AMBER} />
                </BarChart>
              </ResponsiveContainer>
            } />
        </div>

        <Footer />
      </div>
    </div>
  );
}

// ── Banner + system bar ────────────────────────────────────────────────────
function ClassifiedBanner({ clock, operator }) {
  const name = (operator?.full_name || operator?.email || "OPERATOR")
    .toUpperCase();
  const role = (operator?.role || "ADMIN").toUpperCase();
  return (
    <div className="ghw-ops-scanwrap" style={styles.banner}>
      <div style={styles.bannerInner}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="ghw-ops-blink" style={{ color: AMBER, fontSize: 18 }}>◉</span>
          <span style={{ color: AMBER, fontWeight: 700, letterSpacing: 1 }}>
            GRUENING H&amp;W — OPERATIONS COMMAND CENTER
          </span>
          <span style={styles.classified}>[CLASSIFIED]</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 24,
                       color: WHITE, fontSize: 13 }}>
          <span><span style={styles.label}>OPERATOR:</span> {name}</span>
          <span><span style={styles.label}>CLEARANCE:</span> {role}</span>
          <span style={{ color: AMBER }}>████████ SECURE</span>
          <span style={{ color: WHITE, fontWeight: 700 }}>{clock}</span>
        </div>
      </div>
    </div>
  );
}

function SystemStatusBar({ data, secondsAgo, error, threat }) {
  const dot = (status) => {
    const cls = status === "ok" || status === "running"
      ? "ghw-ops-dot-green"
      : status === "warning" ? "ghw-ops-dot-amber"
      : "ghw-ops-dot-red";
    return <span className={cls} aria-hidden="true" />;
  };
  const sys = data?.system || {};
  const apiOk = sys.api_status === "ok";
  const ping = sys.db_ping_ms;
  const sched = data?.automations?.scheduler_status || "unknown";
  const lastSync = data?.compliance?.audit_last_write;
  const refreshColor =
    secondsAgo < 30 ? GREEN_OK : secondsAgo < 60 ? AMBER : RED_ALERT;
  return (
    <div style={styles.statusBar} data-testid="ops-status-bar">
      <span>
        <span style={styles.label}>SYSTEM STATUS:</span> [{" "}
        {dot(apiOk ? "ok" : "error")}{" "}
        <span style={{ color: apiOk ? GREEN_OK : RED_ALERT, marginLeft: 4 }}>
          {apiOk ? "NOMINAL" : "DEGRADED"}
        </span>
        {" ]"}
      </span>
      <Sep />
      <span>
        <span style={styles.label}>DB:</span> [{" "}
        {dot(ping == null ? "error" : ping < 50 ? "ok" : ping < 200 ? "warning" : "error")}{" "}
        <span style={{ color: WHITE, marginLeft: 4 }}>
          {ping != null ? `${ping}ms` : "—"}
        </span>
        {" ]"}
      </span>
      <Sep />
      <span>
        <span style={styles.label}>SCHEDULER:</span> [{" "}
        {dot(sched === "running" ? "ok" : "error")}{" "}
        <span style={{ color: sched === "running" ? GREEN_OK : RED_ALERT, marginLeft: 4 }}>
          {sched.toUpperCase()}
        </span>
        {" ]"}
      </span>
      <Sep />
      <span>
        <span style={styles.label}>THREATS:</span> [{" "}
        {dot(threat.count === 0 ? "ok" : threat.count <= 3 ? "warning" : "error")}{" "}
        <span style={{ color: threat.color, marginLeft: 4 }}>
          {threat.count}
        </span>
        {" ]"}
      </span>
      <Sep />
      <span>
        <span style={styles.label}>LAST SYNC:</span> [{" "}
        {dot("ok")}{" "}
        <span style={{ color: WHITE, marginLeft: 4 }}>
          {relativeTime(lastSync)}
        </span>
        {" ]"}
      </span>
      <Sep />
      <span style={{ color: refreshColor }}>
        REFRESH: {secondsAgo}s
      </span>
    </div>
  );
}

function Sep() {
  return <span style={{ color: GRAY_MID, margin: "0 4px" }}>│</span>;
}

// ── KPI card ───────────────────────────────────────────────────────────────
function KpiCard({ label, value, valueColor, footer, barPct, status, arrow }) {
  const color =
    valueColor ||
    (status === "error" ? RED_ALERT :
     status === "warning" ? AMBER_BRIGHT :
     status === "ok" ? GREEN_OK : AMBER_BRIGHT);
  return (
    <div style={styles.kpiCard} className="ghw-ops-countup">
      <div style={styles.kpiTopAccent} />
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{
        ...styles.kpiValue, color,
        display: "flex", alignItems: "center", gap: 10,
      }}>
        {arrow && <span style={{ fontSize: 20 }}>▲</span>}
        <span>{value}</span>
      </div>
      {barPct != null && (
        <div style={styles.kpiBarTrack}>
          <div style={{
            ...styles.kpiBarFill,
            width: `${clamp(barPct, 0, 100)}%`,
            background: color,
          }} />
        </div>
      )}
      <div style={styles.kpiFooter}>{footer}</div>
    </div>
  );
}

// ── Posture radar ──────────────────────────────────────────────────────────
function PostureRadar({ scores }) {
  const radarData = [
    { dim: "AUTHENTICATION", v: scores.auth },
    { dim: "ACCESS CTRL",    v: scores.access },
    { dim: "ENCRYPTION",     v: scores.encryption },
    { dim: "MONITORING",     v: scores.monitoring },
    { dim: "COMPLIANCE",     v: scores.compliance },
    { dim: "AVAILABILITY",   v: scores.availability },
  ];
  const overallColor =
    scores.overall >= 80 ? GREEN_OK
    : scores.overall >= 50 ? AMBER
    : RED_ALERT;
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>◈ SECURITY POSTURE ASSESSMENT</SectionTitle>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 220px", gap: 24,
        alignItems: "center", marginTop: 8,
      }}>
        <div style={{ minHeight: 280 }}>
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarData}>
              <PolarGrid stroke={BORDER_BRIGHT} />
              <PolarAngleAxis dataKey="dim"
                               tick={{ fill: AMBER, fontFamily: FONT_MONO,
                                       fontSize: 11 }} />
              <PolarRadiusAxis domain={[0, 100]}
                                tick={{ fill: GRAY_MID, fontSize: 9 }}
                                axisLine={false} />
              <Radar
                name="score"
                dataKey="v"
                stroke={CYAN}
                fill={CYAN}
                fillOpacity={0.18}
                strokeWidth={2}
              />
              <Tooltip contentStyle={tooltipStyle} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={styles.smallLabel}>OVERALL SCORE</div>
          <div style={{
            color: overallColor, fontFamily: FONT_MONO,
            fontSize: 64, fontWeight: 700, lineHeight: 1,
          }}>
            {scores.overall}
          </div>
          <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4,
                         fontFamily: FONT_MONO }}>
            / 100
          </div>
          <div style={{ marginTop: 16 }}>
            {radarData.map((d) => (
              <div key={d.dim} style={{
                display: "flex", justifyContent: "space-between",
                fontFamily: FONT_MONO, fontSize: 11, padding: "2px 0",
                color: GRAY_MID,
              }}>
                <span>{d.dim}</span>
                <span style={{
                  color: d.v >= 80 ? GREEN_OK : d.v >= 50 ? AMBER : RED_ALERT,
                }}>
                  {d.v}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Threat monitor ─────────────────────────────────────────────────────────
function ThreatMonitor({ data }) {
  const s = data?.security || {};
  const alerts = (s.accounts_locked_now ?? 0) + (s.ip_bans_active ?? 0);
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle color={alerts > 0 ? RED_ALERT : GREEN_OK}>
        {alerts > 0 ? "🔴" : "🟢"} THREAT MONITOR
      </SectionTitle>
      <ThreatRow label="FAILED LOGINS [24HR]"
                  value={fmt2(s.failed_logins_24hr)}
                  level={(s.failed_logins_24hr ?? 0) > 10 ? "critical" : "ok"} />
      <ThreatRow label="LOCKED ACCTS [NOW]"
                  value={fmt2(s.accounts_locked_now)}
                  level={(s.accounts_locked_now ?? 0) > 0 ? "critical" : "ok"} />
      <ThreatRow label="IP BANS ACTIVE [NOW]"
                  value={fmt2(s.ip_bans_active)}
                  level={(s.ip_bans_active ?? 0) > 0 ? "warning" : "ok"} />
      <ThreatRow label="BOOKING ATKS [24HR]"
                  value={fmt2(s.booking_attacks_24hr)}
                  level={(s.booking_attacks_24hr ?? 0) > 5 ? "warning" : "ok"} />
      <ThreatRow label="NO-MFA AGENTS"
                  value={fmt2(data?.compliance?.agents_without_mfa)}
                  level={(data?.compliance?.agents_without_mfa ?? 0) > 0 ? "warning" : "ok"} />

      <div style={{ marginTop: 14, paddingTop: 10,
                     borderTop: `1px solid ${BORDER_DIM}` }}>
        <div style={styles.smallLabel}>THREAT LOG · LAST 5</div>
        <table style={styles.threatTable}>
          <thead>
            <tr>
              <th style={styles.threatTh}>TIME</th>
              <th style={styles.threatTh}>EVENT</th>
              <th style={styles.threatTh}>STATUS</th>
            </tr>
          </thead>
          <tbody>
            {(data?.threat_log || []).slice(0, 5).map((row, i) => (
              <tr key={i}>
                <td style={styles.threatTd}>
                  {row.time ? new Date(row.time).toLocaleTimeString("en-US", {
                    hour12: false, hour: "2-digit", minute: "2-digit",
                  }) : "—"}
                </td>
                <td style={styles.threatTd}>{row.event}</td>
                <td style={{ ...styles.threatTd, color: RED_ALERT }}>
                  {row.status}
                </td>
              </tr>
            ))}
            {(!data?.threat_log || data.threat_log.length === 0) && (
              <tr>
                <td colSpan={3} style={{ ...styles.threatTd,
                                           color: GRAY_MID, textAlign: "center" }}>
                  — no incidents logged —
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ThreatRow({ label, value, level }) {
  const colorFor = (l) => l === "critical" ? RED_ALERT
                          : l === "warning" ? AMBER : GREEN_OK;
  const symbol = level === "critical" ? "●"
                  : level === "warning" ? "▲" : "●";
  return (
    <div style={styles.threatRow}>
      <span style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>
        {label.padEnd(24, " ").slice(0, 24)}
      </span>
      <span style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>
        ....
      </span>
      <span style={{
        color: colorFor(level), fontFamily: FONT_MONO, fontSize: 14,
        fontWeight: 700, marginLeft: "auto", marginRight: 8,
      }}>
        {value}
      </span>
      <span style={{ color: colorFor(level) }}>{symbol}</span>
    </div>
  );
}

// ── Data integrity scanner ─────────────────────────────────────────────────
function DataIntegrityScanner({ data }) {
  const di = data?.data_integrity || {};
  const errored = di.error;
  const issues =
    (di.leads_missing_agent ?? 0) +
    (di.leads_dirty_state ?? 0) +
    (di.ghl_sync_errors ?? 0);
  const integrityPct = Math.max(0, 100 - issues);

  return (
    <div style={styles.sectionCard} className="ghw-ops-countup ghw-ops-scanwrap">
      <SectionTitle>📡 DATA INTEGRITY SCAN</SectionTitle>
      <div style={{ color: CYAN, fontFamily: FONT_MONO, fontSize: 11,
                     marginBottom: 8 }}>
        {errored ? "[SCAN UNAVAILABLE]" : "[SCANNING LEADS DATABASE…]"}
      </div>
      <IntegrityRow label="TOTAL RECORDS" value={di.total_leads ?? 0}
                     status="verified" />
      <IntegrityRow label="AGENT ORPHANS" value={di.leads_missing_agent ?? 0}
                     status={(di.leads_missing_agent ?? 0) > 0 ? "warning" : "verified"} />
      <IntegrityRow label="STATE ANOMALIES" value={di.leads_dirty_state ?? 0}
                     status={(di.leads_dirty_state ?? 0) > 0 ? "warning" : "verified"} />
      <IntegrityRow label="GHL SYNC ERRORS" value={di.ghl_sync_errors ?? 0}
                     status={(di.ghl_sync_errors ?? 0) > 0 ? "warning" : "verified"} />
      <IntegrityRow label="UNSYNCED LEADS" value={di.ghl_unsynced ?? 0}
                     status="pending" />
      <IntegrityRow label="APPT REMINDERS" value={di.reminders_pending ?? 0}
                     status="pending" />

      <div style={{ marginTop: 14, paddingTop: 10,
                     borderTop: `1px solid ${BORDER_DIM}` }}>
        <div style={styles.smallLabel}>
          DATABASE INTEGRITY · {integrityPct}%
        </div>
        <div style={styles.kpiBarTrack}>
          <div style={{
            ...styles.kpiBarFill,
            width: `${integrityPct}%`,
            background: integrityPct >= 80 ? GREEN_OK
                          : integrityPct >= 50 ? AMBER : RED_ALERT,
          }} />
        </div>
      </div>
    </div>
  );
}

function IntegrityRow({ label, value, status }) {
  const labelText = status === "verified" ? "✓ VERIFIED"
                     : status === "warning" ? "⚠ ACTION REQ"
                     : status === "error" ? "✗ ERROR"
                     : "○ PENDING";
  const color = status === "verified" ? GREEN_OK
                 : status === "warning" ? AMBER
                 : status === "error" ? RED_ALERT : CYAN;
  return (
    <div style={styles.intRow}>
      <span style={{ color: GRAY_MID, fontFamily: FONT_MONO, fontSize: 11 }}>
        {label.padEnd(18, " ").slice(0, 18)}
      </span>
      <span style={{
        color: WHITE, fontFamily: FONT_MONO, fontSize: 13,
        fontWeight: 700, marginLeft: "auto", marginRight: 12,
        minWidth: 50, textAlign: "right",
      }}>
        {String(value).padStart(3, "0")}
      </span>
      <span style={{ color, fontFamily: FONT_MONO, fontSize: 11,
                      width: 130, textAlign: "right" }}>
        {labelText}
      </span>
    </div>
  );
}

// ── Automation engine ─────────────────────────────────────────────────────
function AutomationEngine({ data }) {
  const auto = data?.automations || {};
  const status = auto.scheduler_status || "unknown";
  const lastCheck = auto.last_reminder_check
    ? relativeTime(auto.last_reminder_check) : "—";
  const jobs = auto.jobs || {};
  const jobOrder = [
    ["birthday_window",    "Birthday Window"],
    ["new_lead_notify",    "New Lead Notify"],
    ["reminder_48hr",      "Reminder 48hr"],
    ["reminder_24hr",      "Reminder 24hr"],
    ["reminder_1hr",       "Reminder 1hr"],
    ["post_appointment",   "Post-Appt Follow-up"],
    ["enrolled_welcome",   "Enrolled Welcome"],
    ["stale_lead_alert",   "Stale Lead Alert"],
  ];
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>⚡ AUTOMATION ENGINE</SectionTitle>
      <div style={{
        border: `1px solid ${status === "running" ? GREEN_OK : RED_ALERT}`,
        borderRadius: 6, padding: 12, marginBottom: 14,
        background: status === "running" ? GREEN_DIM : RED_DIM,
        fontFamily: FONT_MONO,
      }}>
        <div style={{
          color: status === "running" ? GREEN_OK : RED_ALERT,
          fontWeight: 700, display: "flex", alignItems: "center", gap: 8,
        }}>
          <span className={status === "running"
                            ? "ghw-ops-dot-green" : "ghw-ops-dot-red"} />
          SCHEDULER: {status.toUpperCase()}
        </div>
        <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4 }}>
          15-MIN CYCLE · LAST RUN: {lastCheck}
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse",
                       fontFamily: FONT_MONO }}>
        <thead>
          <tr>
            <th style={styles.threatTh}>JOB</th>
            <th style={{ ...styles.threatTh, textAlign: "right" }}>LAST 7D</th>
            <th style={{ ...styles.threatTh, textAlign: "right" }}>STATUS</th>
          </tr>
        </thead>
        <tbody>
          {jobOrder.map(([key, label]) => {
            const j = jobs[key] || {};
            return (
              <tr key={key}>
                <td style={styles.threatTd}>{label}</td>
                <td style={{ ...styles.threatTd, textAlign: "right",
                              color: WHITE }}>
                  {fmt2(j.sent_7d)} sent
                </td>
                <td style={{ ...styles.threatTd, textAlign: "right",
                              color: GREEN_OK }}>
                  ● ACTIVE
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Compliance command ────────────────────────────────────────────────────
function ComplianceCommand({ data }) {
  const c = data?.compliance || {};
  const vendors = [
    { name: "Render (Hosting)",   status: c.baa_render,
      action: "MATT: Approve $499/mo Scale plan" },
    { name: "MongoDB Atlas",      status: c.baa_mongodb,
      action: "TIM: Contact mongodb.com/hipaa" },
    { name: "AWS SES",            status: c.baa_aws_ses,
      action: "TIM: Set up + get BAA" },
    { name: "Vercel (Frontend)",  status: "not_required",
      action: "No action — no PHI" },
    { name: "Sentry (Monitor)",   status: "pending",
      action: "MATT: Approve Sentry billing" },
  ];
  const roadmap = [
    { phase: "PHASE 1: HIPAA BAAs",         tag: "[IN PROGRESS]", active: true },
    { phase: "PHASE 2: Policy Docs",        tag: "[PLANNED Q2]" },
    { phase: "PHASE 3: Vanta/Drata Setup",  tag: "[PLANNED Q3]" },
    { phase: "PHASE 4: Readiness Audit",    tag: "[PLANNED Q3]" },
    { phase: "PHASE 5: SOC 2 TYPE I",       tag: "[TARGET Q3 2026]" },
    { phase: "PHASE 6: SOC 2 TYPE II",      tag: "[TARGET Q3 2027]" },
  ];
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>⚖ COMPLIANCE &amp; CERTIFICATION STATUS</SectionTitle>
      <div className="ghw-ops-grid-3"
           style={{ ...styles.grid3, gridTemplateColumns: "1.4fr 1fr",
                     marginTop: 10 }}>
        {/* BAA STATUS BOARD */}
        <div>
          <div style={styles.smallLabel}>BAA STATUS BOARD</div>
          <table style={{ width: "100%", borderCollapse: "collapse",
                           fontFamily: FONT_MONO }}>
            <thead>
              <tr>
                <th style={styles.threatTh}>VENDOR</th>
                <th style={styles.threatTh}>STATUS</th>
                <th style={styles.threatTh}>ACTION REQUIRED</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => {
                const isSigned = v.status === "signed" || v.status === "not_required";
                const isPending = v.status === "pending";
                const bg = isSigned ? "transparent"
                            : isPending ? `${AMBER_DIM}22`
                            : `${RED_DIM}33`;
                const color = isSigned ? GREEN_OK
                                : isPending ? AMBER : RED_ALERT;
                const symbol = isSigned ? "✓ "
                                : isPending ? "▓▓ "
                                : "██ ";
                const label = isSigned ?
                  (v.status === "not_required" ? "NOT REQUIRED" : "SIGNED")
                  : isPending ? "PENDING"
                  : "NOT SIGNED";
                return (
                  <tr key={v.name} style={{ background: bg }}>
                    <td style={styles.threatTd}>{v.name}</td>
                    <td style={{ ...styles.threatTd, color, fontWeight: 700 }}>
                      {symbol}{label}
                    </td>
                    <td style={{ ...styles.threatTd, color: GRAY_MID }}>
                      {v.action}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 12, color: GRAY_MID, fontFamily: FONT_MONO,
                         fontSize: 11 }}>
            AUDIT LOG ENTRIES: <span style={{ color: WHITE }}>{c.audit_log_count ?? 0}</span>
            {"  · "}
            LAST WRITE: <span style={{ color: WHITE }}>{relativeTime(c.audit_last_write)}</span>
          </div>
        </div>

        {/* CERTIFICATION ROADMAP */}
        <div>
          <div style={styles.smallLabel}>CERTIFICATION ROADMAP</div>
          <div style={{ marginTop: 6 }}>
            {roadmap.map((p) => (
              <div key={p.phase} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "6px 0", fontFamily: FONT_MONO, fontSize: 12,
                color: p.active ? AMBER : GRAY_MID,
              }}>
                <span style={{
                  color: p.active ? AMBER : GRAY_DIM,
                  fontSize: 14,
                }}>
                  {p.active ? "◉" : "○"}
                </span>
                <span style={{ flex: 1 }}>{p.phase}</span>
                <span style={{
                  color: p.active ? AMBER_BRIGHT : GRAY_MID,
                  fontSize: 10,
                }}>
                  {p.tag}
                </span>
                {p.active && (
                  <span style={{ color: AMBER, fontSize: 10 }}>
                    ← you are here
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
function SectionTitle({ children, color }) {
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

function ChartCard({ title, chart }) {
  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>{title}</SectionTitle>
      {chart}
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

// ── Inline style table ────────────────────────────────────────────────────
const tooltipStyle = {
  background: BG_CARD_2,
  border: `1px solid ${BORDER_BRIGHT}`,
  color: WHITE,
  fontFamily: FONT_MONO,
  fontSize: 12,
};

const styles = {
  page: {
    minHeight: "100vh", color: WHITE,
    fontFamily: FONT_SANS,
  },
  container: {
    maxWidth: 1600, margin: "0 auto", padding: "24px",
  },
  banner: {
    border: `1px solid ${AMBER}`, borderRadius: 6,
    background: `${AMBER_DIM}22`, padding: 14, marginBottom: 12,
  },
  bannerInner: {
    display: "flex", justifyContent: "space-between",
    alignItems: "center", gap: 16, flexWrap: "wrap",
    fontFamily: FONT_MONO,
  },
  classified: {
    color: AMBER_BRIGHT, fontWeight: 700,
    border: `1px solid ${AMBER}`,
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
    padding: "10px 14px", marginBottom: 14,
    fontFamily: FONT_MONO,
  },
  grid4: {
    display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
    gap: 14, marginBottom: 18,
  },
  grid3: {
    display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
    gap: 14, marginBottom: 18,
  },
  kpiCard: {
    background: BG_CARD, border: `1px solid ${BORDER_DIM}`,
    borderRadius: 8, padding: 20, position: "relative",
    fontFamily: FONT_MONO,
  },
  kpiTopAccent: {
    position: "absolute", top: 0, left: 0, right: 0,
    height: 3, background: AMBER, borderRadius: "8px 8px 0 0",
  },
  kpiLabel: {
    color: GRAY_MID, fontSize: 10, letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  kpiValue: {
    fontSize: 36, fontWeight: 700, marginTop: 10, marginBottom: 8,
    letterSpacing: -0.5,
  },
  kpiBarTrack: {
    height: 6, background: GRAY_DIM, borderRadius: 3,
    overflow: "hidden", marginTop: 8,
  },
  kpiBarFill: {
    height: "100%", transition: "width 600ms ease",
  },
  kpiFooter: {
    color: GRAY_MID, fontSize: 11, marginTop: 8, letterSpacing: 0.4,
  },
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


// ── AI Security Intelligence panel ─────────────────────────────────────────
// Owns its own data lifecycle (config + recent events + banned-ips list)
// so the parent's 60-s refresh keeps this card in sync without us
// duplicating queries from /api/ops/health (which already exposes the
// summary counts on opsData.ai_security).
function AISecurityPanel({ opsData }) {
  const [config, setConfig] = useState(null);
  const [events, setEvents] = useState([]);
  const [bans, setBans] = useState([]);
  const [busy, setBusy] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [openEventId, setOpenEventId] = useState(null);
  const [lookupIp, setLookupIp] = useState("");
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [c, e, b] = await Promise.all([
        api.get("/security/config").catch(() => null),
        api.get("/security/events", { params: { limit: 5 } }).catch(() => null),
        api.get("/security/banned-ips").catch(() => null),
      ]);
      if (c) setConfig(c.data);
      if (e) setEvents(e.data?.events || []);
      if (b) setBans(b.data?.banned_ips || []);
    } catch {
      /* surfaced via ops error banner */
    }
  }, []);

  useEffect(() => {
    reload();
    const i = setInterval(reload, 60_000);
    return () => clearInterval(i);
  }, [reload]);

  async function toggleKillSwitch() {
    if (!config) return;
    setBusy(true);
    try {
      const next = !config.ai_auto_ban_enabled;
      const { data } = await api.patch("/security/config", {
        ai_auto_ban_enabled: next,
      });
      setConfig(data);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  async function runAnalysisNow() {
    setAnalysisBusy(true);
    try {
      await api.post("/security/run-analysis");
      await reload();
    } catch {
      /* ignore */
    } finally {
      setAnalysisBusy(false);
    }
  }

  async function doLookup() {
    if (!lookupIp.trim()) return;
    setLookupBusy(true);
    setLookupResult(null);
    try {
      const { data } = await api.get(
        `/security/ip/${encodeURIComponent(lookupIp.trim())}`,
      );
      setLookupResult(data);
    } catch (err) {
      setLookupResult({
        ip: lookupIp.trim(),
        error: err?.response?.data?.detail || "Lookup failed",
      });
    } finally {
      setLookupBusy(false);
    }
  }

  async function unbanIp(ip) {
    // eslint-disable-next-line no-restricted-globals
    if (!window.confirm(`Unban ${ip}? This removes the ban immediately.`)) {
      return;
    }
    try {
      await api.delete(`/security/ban-ip/${encodeURIComponent(ip)}`);
      await reload();
    } catch {
      /* ignore */
    }
  }

  const autoOn = !!config?.ai_auto_ban_enabled;
  const aiOps = opsData?.ai_security || {};
  const lastTs = aiOps.last_analysis;
  const lastThreat = (aiOps.last_threat_level || "unknown").toLowerCase();
  const threatColor =
    lastThreat === "critical" ? RED_ALERT
    : lastThreat === "high" ? RED_ALERT
    : lastThreat === "medium" ? AMBER
    : lastThreat === "low" ? GREEN_OK
    : GRAY_MID;

  return (
    <div style={styles.sectionCard} className="ghw-ops-countup">
      <SectionTitle>◉ AI SECURITY INTELLIGENCE</SectionTitle>

      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 14, flexWrap: "wrap",
        padding: "12px 14px", borderRadius: 8,
        background: autoOn ? GREEN_DIM : RED_DIM,
        border: `1px solid ${autoOn ? GREEN_OK : RED_ALERT}`,
        marginBottom: 14, fontFamily: FONT_MONO,
      }}>
        <div>
          <div style={{ color: autoOn ? GREEN_OK : RED_ALERT,
                         fontWeight: 700, letterSpacing: 0.6 }}>
            AI AUTO-BAN: {autoOn ? "● ACTIVE" : "○ DISABLED"}
          </div>
          <div style={{ color: GRAY_MID, fontSize: 11, marginTop: 4 }}>
            {autoOn
              ? "AI auto-bans high/critical-threat IPs every 15 min."
              : "⚠ Threats will alert but will NOT be auto-blocked."}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleKillSwitch}
          disabled={busy || !config}
          data-testid="ai-kill-switch"
          style={{
            background: autoOn ? RED_ALERT : GREEN_OK,
            color: WHITE, border: "none", borderRadius: 6,
            padding: "10px 18px", fontFamily: FONT_MONO,
            fontWeight: 700, fontSize: 13, letterSpacing: 0.6,
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "…" : autoOn ? "DISABLE" : "ENABLE"}
        </button>
      </div>

      <div style={{ display: "grid",
                     gridTemplateColumns: "1fr auto", gap: 14,
                     alignItems: "stretch", marginBottom: 14 }}>
        <div style={{
          background: BG_CARD_2, border: `1px solid ${BORDER_DIM}`,
          borderRadius: 8, padding: 14, fontFamily: FONT_MONO,
        }}>
          <div style={styles.smallLabel}>LAST ANALYSIS</div>
          <div style={{ color: WHITE, fontSize: 18, fontWeight: 700,
                         marginTop: 4 }}>
            {lastTs ? relativeTime(lastTs) : "no runs yet"}
          </div>
          <div style={{ marginTop: 4, color: threatColor, fontSize: 12,
                         fontWeight: 700, letterSpacing: 0.6 }}>
            THREAT LEVEL: ● {lastThreat.toUpperCase()}
          </div>
          <div style={{ marginTop: 4, color: GRAY_MID, fontSize: 11 }}>
            {aiOps.events_24hr ?? 0} runs in last 24h ·{" "}
            {aiOps.bans_ai_24hr ?? 0} AI bans ·{" "}
            {aiOps.bans_active ?? 0} bans active
          </div>
        </div>
        <button
          type="button"
          onClick={runAnalysisNow}
          disabled={analysisBusy}
          data-testid="ai-run-now"
          style={{
            background: CYAN_DIM, color: CYAN,
            border: `1px solid ${CYAN}`, borderRadius: 8,
            padding: "10px 18px", fontFamily: FONT_MONO,
            fontWeight: 700, fontSize: 12, letterSpacing: 0.6,
            cursor: analysisBusy ? "not-allowed" : "pointer",
            minWidth: 140, alignSelf: "stretch",
          }}
        >
          {analysisBusy ? "RUNNING…" : "RUN NOW"}
        </button>
      </div>

      <div style={styles.smallLabel}>RECENT EVENTS · LAST 5</div>
      <table style={styles.threatTable} data-testid="ai-events-table">
        <thead>
          <tr>
            <th style={styles.threatTh}>TIME</th>
            <th style={styles.threatTh}>LEVEL</th>
            <th style={styles.threatTh}>SUMMARY</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr>
              <td colSpan={3} style={{ ...styles.threatTd,
                                         color: GRAY_MID,
                                         textAlign: "center" }}>
                — no security analyses recorded yet —
              </td>
            </tr>
          )}
          {events.map((e) => {
            const lvl = (e.threat_level || "low").toLowerCase();
            const c = lvl === "critical" || lvl === "high" ? RED_ALERT
                      : lvl === "medium" ? AMBER
                      : lvl === "low" ? GREEN_OK : GRAY_MID;
            const ts = e.timestamp;
            const isOpen = openEventId === e.event_id;
            const rows = [
              <tr key={e.event_id}
                  onClick={() => setOpenEventId(isOpen ? null : e.event_id)}
                  style={{ cursor: "pointer" }}
                  data-testid={`ai-event-row-${e.event_id}`}>
                <td style={styles.threatTd}>
                  {ts ? new Date(ts).toLocaleTimeString("en-US",
                        { hour12: false, hour: "2-digit", minute: "2-digit" })
                      : "—"}
                </td>
                <td style={{ ...styles.threatTd, color: c, fontWeight: 700 }}>
                  {lvl.toUpperCase()}
                </td>
                <td style={styles.threatTd}>
                  {(e.ai_narrative || "(no narrative)").slice(0, 80)}
                  {((e.ai_narrative || "").length > 80) ? "…" : ""}
                </td>
              </tr>,
            ];
            if (isOpen) {
              rows.push(
                <tr key={`${e.event_id}-detail`}>
                  <td colSpan={3} style={{
                    ...styles.threatTd,
                    background: BG_CARD_2, color: WHITE, padding: 14,
                    whiteSpace: "pre-wrap", lineHeight: 1.5,
                  }}>
                    <div style={{ color: CYAN, fontWeight: 700,
                                   marginBottom: 6 }}>
                      AI NARRATIVE
                    </div>
                    <div>{e.ai_narrative || "(no narrative)"}</div>
                    {(e.findings || []).length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ color: AMBER, fontWeight: 700 }}>
                          FINDINGS ({(e.findings || []).length})
                        </div>
                        <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                          {(e.findings || []).map((f, i) => (
                            <li key={i} style={{ color: GRAY_MID,
                                                  fontSize: 12 }}>
                              <strong style={{ color: WHITE }}>
                                {f.type}
                              </strong>{" · "}
                              {f.severity?.toUpperCase()}
                              {" — "}{f.description}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(e.auto_actions_taken || []).length > 0 && (
                      <div style={{ marginTop: 10, color: RED_ALERT,
                                     fontSize: 12 }}>
                        AUTO-ACTIONS: {(e.auto_actions_taken || [])
                          .map((a) => `${a.type}:${a.ip || ""}`).join(", ")}
                      </div>
                    )}
                  </td>
                </tr>
              );
            }
            return rows;
          })}
        </tbody>
      </table>

      <div style={{ ...styles.smallLabel, marginTop: 18 }}>
        ACTIVE IP BANS · {bans.length}
      </div>
      <table style={styles.threatTable} data-testid="ai-banned-table">
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
          {bans.length === 0 && (
            <tr>
              <td colSpan={5} style={{ ...styles.threatTd,
                                         color: GRAY_MID,
                                         textAlign: "center" }}>
                — no active bans —
              </td>
            </tr>
          )}
          {bans.slice(0, 10).map((b) => {
            const intel = b.intel || {};
            const loc = [intel.city, intel.country_code]
              .filter(Boolean).join(", ") || "—";
            const banned = b.banned_at;
            return (
              <tr key={b.ip} data-testid={`ai-ban-${b.ip}`}>
                <td style={{ ...styles.threatTd, fontFamily: "monospace" }}>
                  {b.ip}
                </td>
                <td style={styles.threatTd}>{loc}</td>
                <td style={styles.threatTd}>
                  {banned ? relativeTime(
                    typeof banned === "string" ? banned : (banned?.$date || "")
                  ) : "—"}
                </td>
                <td style={{ ...styles.threatTd, color: GRAY_MID }}>
                  {(b.reason || b.source || "—").slice(0, 40)}
                </td>
                <td style={styles.threatTd}>
                  <button
                    type="button"
                    onClick={() => unbanIp(b.ip)}
                    data-testid={`ai-unban-${b.ip}`}
                    style={{
                      background: "transparent", color: AMBER,
                      border: `1px solid ${AMBER}`, borderRadius: 4,
                      padding: "3px 10px", fontFamily: FONT_MONO,
                      fontSize: 11, cursor: "pointer",
                    }}
                  >
                    UNBAN
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 18 }}>
        <div style={styles.smallLabel}>IP LOOKUP</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={lookupIp}
            onChange={(e) => setLookupIp(e.target.value)}
            placeholder="Enter IP address…"
            data-testid="ai-lookup-input"
            style={{
              flex: 1, background: BG_CARD_2, color: WHITE,
              border: `1px solid ${BORDER_BRIGHT}`, borderRadius: 6,
              padding: "8px 12px", fontFamily: FONT_MONO, fontSize: 13,
            }}
          />
          <button
            type="button"
            onClick={doLookup}
            disabled={lookupBusy || !lookupIp.trim()}
            data-testid="ai-lookup-go"
            style={{
              background: CYAN_DIM, color: CYAN,
              border: `1px solid ${CYAN}`, borderRadius: 6,
              padding: "8px 18px", fontFamily: FONT_MONO,
              fontWeight: 700, fontSize: 12, cursor: "pointer",
              minWidth: 90,
            }}
          >
            {lookupBusy ? "…" : "LOOKUP"}
          </button>
        </div>
        {lookupResult && (
          <div data-testid="ai-lookup-result" style={{
            marginTop: 10, padding: 12, borderRadius: 8,
            background: BG_CARD_2, border: `1px solid ${BORDER_DIM}`,
            fontFamily: FONT_MONO, fontSize: 12, color: WHITE,
          }}>
            {lookupResult.error ? (
              <div style={{ color: RED_ALERT }}>
                ✗ {lookupResult.error}
              </div>
            ) : lookupResult.private ? (
              <div style={{ color: GRAY_MID }}>
                {lookupResult.ip} is a private / loopback IP — no geo data.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 4 }}>
                <AiRow label="IP" value={lookupResult.ip} />
                <AiRow label="Location"
                       value={[lookupResult.city, lookupResult.region,
                               lookupResult.country].filter(Boolean).join(", ")
                               || "—"} />
                <AiRow label="ISP" value={lookupResult.isp || "—"} />
                <AiRow label="VPN/Proxy"
                       value={lookupResult.is_vpn ? "YES" : "no"} />
                <AiRow label="Tor"
                       value={lookupResult.is_tor ? "YES" : "no"} />
                {lookupResult.threat_score != null && (
                  <AiRow label="Abuse score"
                         value={`${lookupResult.threat_score} / 100`} />
                )}
                {lookupResult.lookup_error && (
                  <div style={{ color: AMBER, marginTop: 4 }}>
                    Note: {lookupResult.lookup_error}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AiRow({ label, value }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      gap: 12, padding: "2px 0",
      fontFamily: FONT_MONO, fontSize: 12,
    }}>
      <span style={{ color: GRAY_MID }}>{label}</span>
      <span style={{ color: WHITE, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
