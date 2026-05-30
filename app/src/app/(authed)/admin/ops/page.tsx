"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  FileWarning,
  Loader2,
  Network,
  Power,
  RefreshCw,
  ShieldAlert,
  Skull,
  TrendingUp,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { isApiError, ops as opsApi } from "@/lib/api";
import {
  isOpsError,
  type OpsActivityDay,
  type OpsAiSecurity,
  type OpsAutomations,
  type OpsCompliance,
  type OpsComplianceBaa,
  type OpsDataIntegrity,
  type OpsHealthResponse,
  type OpsSecurity,
  type OpsSystem,
  type OpsThreatLogEntry,
  type OpsUsage,
  type ThreatLevel,
} from "@/lib/api/ops";
import { useAuthStore, selectHasAgencyScope } from "@/stores/auth";

// ─── Route guard ───────────────────────────────────────────────────────────

export default function OpsPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);
  // ops_access may not exist on the User type yet (legacy flag); read it
  // via a defensive cast so the gate works without adding a stale field
  // to the typed shape that the auth store doesn't otherwise care about.
  const opsAccess = useAuthStore(
    (s) => (s.user as { ops_access?: boolean } | null)?.ops_access ?? false,
  );

  const allowed = status === "authed" && (hasAgencyScope || opsAccess);

  React.useEffect(() => {
    if (status === "authed" && !allowed) {
      router.replace("/dashboard");
    }
  }, [status, allowed, router]);

  if (status !== "authed" || !allowed) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <OpsConsole />;
}

// ─── Console root ──────────────────────────────────────────────────────────

function OpsConsole() {
  const qc = useQueryClient();
  const healthQuery = useQuery({
    queryKey: ["ops", "health"],
    queryFn: () => opsApi.getHealth(),
    // Aggregate is small + sections self-degrade. Refetch every 60s.
    refetchInterval: 60_000,
  });

  if (healthQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (healthQuery.isError || !healthQuery.data) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="p-10 text-center text-destructive">
          <AlertCircle className="h-10 w-10 mx-auto mb-3" />
          <p className="font-semibold">Couldn&apos;t load Ops Console.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Backend may be down or your session may have expired.
          </p>
        </CardContent>
      </Card>
    );
  }

  const health = healthQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground tabular-nums">
          Snapshot {new Date(health.generated_at).toLocaleString()} · refreshes
          every 60s
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            qc.invalidateQueries({ queryKey: ["ops", "health"] })
          }
          disabled={healthQuery.isFetching}
        >
          {healthQuery.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          )}
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SystemSection data={health.system} />
        <SecuritySection data={health.security} />
        <UsageSection data={health.usage} />
      </div>

      <ActivitySection data={health.activity_7d} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AutomationsSection data={health.automations} />
        <DataIntegritySection data={health.data_integrity} />
      </div>

      <ComplianceSection data={health.compliance} />

      <AiSecurityPanel data={health.ai_security} threatLog={health.threat_log} />
    </div>
  );
}

// ─── Section wrapper ───────────────────────────────────────────────────────

function SectionCard({
  title,
  icon,
  hasError,
  children,
  className,
}: {
  title: string;
  icon: React.ReactNode;
  hasError?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("border-border/70", className)}>
      <CardContent className="p-4 md:p-5 space-y-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold">{title}</h2>
          {hasError ? (
            <Badge
              variant="outline"
              className="ml-auto text-[10px] bg-destructive/10 text-destructive border-destructive/30"
            >
              section unavailable
            </Badge>
          ) : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function SectionError({ message }: { message?: string }) {
  return (
    <div className="rounded-md bg-destructive/5 border border-destructive/20 p-3 text-xs text-destructive">
      <AlertCircle className="h-3.5 w-3.5 inline-block mr-1" />
      {message ?? "Section unavailable. Backend logged the error."}
    </div>
  );
}

// ─── System section ───────────────────────────────────────────────────────

function SystemSection({ data }: { data: OpsHealthResponse["system"] }) {
  const err = isOpsError(data);
  const sys = !err ? (data as OpsSystem) : null;
  return (
    <SectionCard title="System" icon={<Cpu className="h-4 w-4 text-primary" />} hasError={err}>
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="space-y-2">
          <StatusRow
            label="API"
            value={sys?.api_status ?? "—"}
            ok={(sys?.api_status ?? "").toLowerCase() === "ok"}
          />
          <StatusRow
            label="Mongo ping"
            value={sys?.db_ping_ms != null ? `${sys.db_ping_ms} ms` : "—"}
            ok={sys?.db_ping_ms != null && sys.db_ping_ms < 100}
          />
          <StatusRow
            label="Scheduler"
            value={sys?.scheduler_running ? "running" : "stopped"}
            ok={!!sys?.scheduler_running}
          />
          {sys?.uptime_seconds != null ? (
            <StatusRow
              label="Uptime"
              value={formatUptime(sys.uptime_seconds)}
              ok
            />
          ) : null}
          {sys?.env_checks ? (
            <div className="pt-2 border-t border-border/40 space-y-1.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                Env checks
              </p>
              {Object.entries(sys.env_checks).map(([k, v]) => (
                <StatusRow key={k} label={k} value={v ? "set" : "missing"} ok={v} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function StatusRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground capitalize">{label}</span>
      <span className="flex items-center gap-1.5 font-medium tabular-nums">
        {ok ? (
          <CheckCircle2 className="h-3 w-3 text-ghw-forest" />
        ) : (
          <AlertTriangle className="h-3 w-3 text-ghw-copper" />
        )}
        {value}
      </span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Security section ─────────────────────────────────────────────────────

function SecuritySection({
  data,
}: {
  data: OpsHealthResponse["security"];
}) {
  const err = isOpsError(data);
  const sec = !err ? (data as OpsSecurity) : null;
  return (
    <SectionCard
      title="Security"
      icon={<ShieldAlert className="h-4 w-4 text-primary" />}
      hasError={err}
    >
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="space-y-2">
          <MetricRow
            label="Failed logins 24h"
            value={sec?.failed_logins_24hr ?? 0}
            warn={(sec?.failed_logins_24hr ?? 0) > 50}
          />
          <MetricRow
            label="Accounts locked"
            value={sec?.accounts_locked_now ?? 0}
            warn={(sec?.accounts_locked_now ?? 0) > 0}
          />
          <MetricRow
            label="IP bans active"
            value={sec?.ip_bans_active ?? 0}
          />
          <MetricRow
            label="Booking attacks 24h"
            value={sec?.booking_attacks_24hr ?? 0}
            warn={(sec?.booking_attacks_24hr ?? 0) > 0}
          />
          <div className="pt-2 border-t border-border/40">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-muted-foreground">MFA adoption</span>
              <span className="font-medium tabular-nums">
                {sec?.mfa_enabled_count ?? 0} / {sec?.mfa_total_agents ?? 0} ·{" "}
                {sec?.mfa_adoption_pct ?? 0}%
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${sec?.mfa_adoption_pct ?? 0}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function MetricRow({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-bold tabular-nums",
          warn ? "text-ghw-copper" : "text-foreground",
        )}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

// ─── Usage section ─────────────────────────────────────────────────────────

function UsageSection({ data }: { data: OpsHealthResponse["usage"] }) {
  const err = isOpsError(data);
  const u = !err ? (data as OpsUsage) : null;
  return (
    <SectionCard
      title="Usage (7d)"
      icon={<TrendingUp className="h-4 w-4 text-primary" />}
      hasError={err}
    >
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="space-y-2">
          <MetricRow label="Active agents" value={u?.active_agents_7d ?? 0} />
          <MetricRow label="Leads created" value={u?.leads_created_7d ?? 0} />
          <MetricRow label="Bookings" value={u?.bookings_7d ?? 0} />
          <MetricRow label="SOAs signed" value={u?.soa_signed_7d ?? 0} />
          <MetricRow label="Enrollments" value={u?.enrollments_7d ?? 0} />
          <div className="pt-2 border-t border-border/40 grid grid-cols-2 gap-2">
            <SmallTile
              label="Bookings today"
              value={u?.bookings_today ?? 0}
            />
            <SmallTile
              label="Leads today"
              value={u?.leads_created_today ?? 0}
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function SmallTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-secondary/30 p-2 text-center">
      <p className="text-[9px] text-muted-foreground uppercase tracking-widest">
        {label}
      </p>
      <p className="text-base font-bold tabular-nums">{value}</p>
    </div>
  );
}

// ─── Activity chart ────────────────────────────────────────────────────────

function ActivitySection({
  data,
}: {
  data: OpsHealthResponse["activity_7d"];
}) {
  const err = isOpsError(data);
  const days = !err ? (data as OpsActivityDay[]) : [];
  return (
    <SectionCard
      title="Last 7 days"
      icon={<Activity className="h-4 w-4 text-primary" />}
      hasError={err}
    >
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={days} margin={{ left: 0, right: 8, top: 4 }}>
              <CartesianGrid
                stroke="hsl(var(--border))"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
                allowDecimals={false}
                width={28}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  fontSize: 11,
                  borderRadius: 6,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="leads"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="bookings"
                stroke="hsl(var(--chart-4))"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="enrollments"
                stroke="hsl(140 50% 50%)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Automations ───────────────────────────────────────────────────────────

function AutomationsSection({
  data,
}: {
  data: OpsHealthResponse["automations"];
}) {
  const err = isOpsError(data);
  const a = !err ? (data as OpsAutomations) : null;
  const jobs = a?.jobs ? Object.entries(a.jobs) : [];
  return (
    <SectionCard
      title="Automations"
      icon={<Zap className="h-4 w-4 text-primary" />}
      hasError={err}
    >
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Scheduler</span>
            <span
              className={cn(
                "flex items-center gap-1.5 font-medium",
                a?.scheduler_status === "running"
                  ? "text-ghw-forest"
                  : "text-destructive",
              )}
            >
              {a?.scheduler_status === "running" ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {a?.scheduler_status ?? "—"}
            </span>
          </div>
          {a?.last_reminder_check ? (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              Last tick {new Date(a.last_reminder_check).toLocaleTimeString()}
            </p>
          ) : null}

          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest pb-1">
              Jobs · sent 7d
            </p>
            {jobs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No job map yet.</p>
            ) : (
              jobs.map(([name, job]) => (
                <div
                  key={name}
                  className="flex items-center justify-between text-xs py-1"
                >
                  <span className="capitalize">
                    {name.replace(/_/g, " ")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="tabular-nums">{job.sent_7d}</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[9px]",
                        job.status === "ok"
                          ? "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
                          : "bg-destructive/15 text-destructive border-destructive/30",
                      )}
                    >
                      {job.status}
                    </Badge>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Data integrity ────────────────────────────────────────────────────────

function DataIntegritySection({
  data,
}: {
  data: OpsHealthResponse["data_integrity"];
}) {
  const err = isOpsError(data);
  const di = !err ? (data as OpsDataIntegrity) : null;
  return (
    <SectionCard
      title="Data integrity"
      icon={<Database className="h-4 w-4 text-primary" />}
      hasError={err}
    >
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <SmallTile label="Total leads" value={di?.total_leads ?? 0} />
          <SmallTile label="Total agents" value={di?.total_agents ?? 0} />
          <SmallTile label="Appointments" value={di?.appointments_total ?? 0} />
          <SmallTile
            label="Reminders pending"
            value={di?.reminders_pending ?? 0}
          />
          <MetricRow
            label="Leads missing agent"
            value={di?.leads_missing_agent ?? 0}
            warn={(di?.leads_missing_agent ?? 0) > 0}
          />
          <MetricRow
            label="Dirty state"
            value={di?.leads_dirty_state ?? 0}
            warn={(di?.leads_dirty_state ?? 0) > 0}
          />
          <MetricRow
            label="GHL unsynced"
            value={di?.ghl_unsynced ?? 0}
            warn={(di?.ghl_unsynced ?? 0) > 25}
          />
          <MetricRow
            label="GHL sync errors"
            value={di?.ghl_sync_errors ?? 0}
            warn={(di?.ghl_sync_errors ?? 0) > 0}
          />
        </div>
      )}
    </SectionCard>
  );
}

// ─── Compliance ────────────────────────────────────────────────────────────

function ComplianceSection({
  data,
}: {
  data: OpsHealthResponse["compliance"];
}) {
  const err = isOpsError(data);
  const c = !err ? (data as OpsCompliance) : null;
  const baas: { key: string; baa: OpsComplianceBaa | undefined }[] = [
    { key: "Render", baa: c?.baa_render },
    { key: "MongoDB Atlas", baa: c?.baa_mongodb },
    { key: "AWS SES", baa: c?.baa_aws_ses },
  ];
  return (
    <SectionCard
      title="Compliance"
      icon={<FileWarning className="h-4 w-4 text-primary" />}
      hasError={err}
    >
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {baas.map(({ key, baa }) => (
              <BaaCard key={key} vendor={key} baa={baa} />
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3 border-t border-border/40">
            <SmallTile
              label="HIPAA training due"
              value={c?.hipaa_training_due ?? 0}
            />
            <SmallTile
              label="Audit log rows"
              value={c?.audit_log_count ?? 0}
            />
            <SmallTile
              label="Agents w/o MFA"
              value={c?.agents_without_mfa ?? 0}
            />
            <div className="rounded-md bg-secondary/30 p-2 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest">
                Last audit write
              </p>
              <p className="text-[10px] font-medium tabular-nums truncate mt-1">
                {c?.audit_last_write
                  ? new Date(c.audit_last_write).toLocaleString()
                  : "—"}
              </p>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function BaaCard({
  vendor,
  baa,
}: {
  vendor: string;
  baa: OpsComplianceBaa | undefined;
}) {
  const signed = !!baa?.signed;
  return (
    <Card
      className={cn(
        "border-2",
        signed
          ? "border-ghw-forest/40 bg-ghw-forest/5"
          : "border-destructive/40 bg-destructive/5",
      )}
    >
      <CardContent className="p-3 space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold">{vendor}</p>
          {signed ? (
            <Badge
              variant="outline"
              className="bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30 text-[10px]"
            >
              SIGNED
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="bg-destructive/15 text-destructive border-destructive/30 text-[10px] uppercase"
            >
              Action req&apos;d
            </Badge>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          BAA · {baa?.signed_at ? new Date(baa.signed_at).toLocaleDateString() : "not signed"}
        </p>
        {baa?.notes ? (
          <p className="text-[10px] text-muted-foreground italic">
            {baa.notes}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── AI Security panel ─────────────────────────────────────────────────────

function AiSecurityPanel({
  data,
  threatLog,
}: {
  data: OpsHealthResponse["ai_security"];
  threatLog: OpsHealthResponse["threat_log"];
}) {
  const err = isOpsError(data);
  const ai = !err ? (data as OpsAiSecurity) : null;
  const logErr = isOpsError(threatLog);
  const log = !logErr ? (threatLog as OpsThreatLogEntry[]) : [];

  return (
    <SectionCard
      title="AI Security Intelligence"
      icon={<Skull className="h-4 w-4 text-primary" />}
      hasError={err}
      className="ring-1 ring-primary/15"
    >
      {err ? (
        <SectionError message={data.error} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap gap-3 items-center">
              <ThreatLevelBadge level={(ai?.last_threat_level as ThreatLevel) ?? "unknown"} />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  Last analysis
                </p>
                <p className="text-xs font-medium tabular-nums">
                  {ai?.last_analysis
                    ? new Date(ai.last_analysis).toLocaleString()
                    : "Never"}
                </p>
              </div>
            </div>
            <RunNowControls />
          </div>

          <KillSwitch initial={ai?.auto_ban_enabled ?? false} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SmallTile label="Events 24h" value={ai?.events_24hr ?? 0} />
            <SmallTile label="Bans active" value={ai?.bans_active ?? 0} />
            <SmallTile label="AI bans 24h" value={ai?.bans_ai_24hr ?? 0} />
            <div className="rounded-md bg-secondary/30 p-2 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest">
                Auto-ban
              </p>
              <p className="text-base font-bold">
                {ai?.auto_ban_enabled ? (
                  <span className="text-ghw-forest">ON</span>
                ) : (
                  <span className="text-destructive">OFF</span>
                )}
              </p>
            </div>
          </div>

          <BannedIpsTable />

          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1.5">
              Threat log (top 5)
            </p>
            {logErr ? (
              <SectionError message={threatLog.error} />
            ) : log.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3 text-center">
                No threats in the recent window.
              </p>
            ) : (
              <ol className="space-y-1">
                {log.map((row, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-xs py-1.5 px-2 rounded bg-secondary/30"
                  >
                    <Network className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="font-medium truncate flex-1">{row.event}</span>
                    <span className="text-muted-foreground truncate max-w-[160px]">
                      {row.actor ?? "—"}
                    </span>
                    <Badge variant="outline" className="text-[9px]">
                      {row.status}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {new Date(row.time).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function ThreatLevelBadge({ level }: { level: ThreatLevel }) {
  const tint =
    level === "critical"
      ? "bg-destructive/20 text-destructive ring-destructive/40"
      : level === "high"
        ? "bg-destructive/15 text-destructive ring-destructive/30"
        : level === "medium"
          ? "bg-ghw-copper/20 text-ghw-copper ring-ghw-copper/40"
          : level === "low"
            ? "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30"
            : "bg-muted text-muted-foreground ring-border";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-xs uppercase font-bold tracking-widest ring-2 px-3 py-1",
        tint,
      )}
    >
      {level}
    </Badge>
  );
}

function RunNowControls() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => opsApi.runAnalysis(),
    onSuccess: (event) => {
      qc.invalidateQueries({ queryKey: ["ops", "health"] });
      qc.invalidateQueries({ queryKey: ["security", "events"] });
      toast.success(
        `Analysis complete — threat level: ${event.threat_level}`,
      );
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Analysis failed."),
  });

  return (
    <Button
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      variant="outline"
    >
      {mutation.isPending ? (
        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
      ) : (
        <Zap className="h-3.5 w-3.5 mr-1.5" />
      )}
      Run analysis now
    </Button>
  );
}

function KillSwitch({ initial }: { initial: boolean }) {
  const qc = useQueryClient();
  const [optimistic, setOptimistic] = React.useState(initial);
  React.useEffect(() => setOptimistic(initial), [initial]);

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      opsApi.patchConfig({ ai_auto_ban_enabled: next }),
    onMutate: (next) => {
      setOptimistic(next);
    },
    onSuccess: (config) => {
      setOptimistic(config.ai_auto_ban_enabled);
      qc.invalidateQueries({ queryKey: ["ops", "health"] });
      qc.invalidateQueries({ queryKey: ["security", "config"] });
      toast.success(
        config.ai_auto_ban_enabled
          ? "Auto-ban ENABLED."
          : "Auto-ban DISABLED.",
      );
    },
    onError: (err) => {
      setOptimistic(initial);
      toast.error(isApiError(err) ? err.message : "Couldn't toggle.");
    },
  });

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 flex items-center gap-3 flex-wrap">
      <Power className="h-5 w-5 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold uppercase tracking-widest text-destructive">
          AI kill switch
        </p>
        <p className="text-[10px] text-muted-foreground">
          When OFF, AI security never auto-bans IPs. Events still log + alert.
        </p>
      </div>
      <Switch
        checked={optimistic}
        onCheckedChange={(v) => mutation.mutate(v)}
        disabled={mutation.isPending}
      />
    </div>
  );
}

function BannedIpsTable() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["security", "banned-ips"],
    queryFn: () => opsApi.getBannedIps(),
  });

  const unbanMutation = useMutation({
    mutationFn: (ip: string) => opsApi.unbanIp(ip),
    onSuccess: (_, ip) => {
      qc.invalidateQueries({ queryKey: ["security", "banned-ips"] });
      qc.invalidateQueries({ queryKey: ["ops", "health"] });
      toast.success(`Unbanned ${ip}.`);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Unban failed."),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <SectionError message="Couldn't load banned-IPs table." />
    );
  }
  const rows = query.data?.banned_ips ?? [];
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-3 text-center">
        No active bans.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-secondary/40">
          <tr className="border-b border-border text-[10px] uppercase tracking-widest text-muted-foreground">
            <th className="text-left px-2 py-1.5">IP</th>
            <th className="text-left px-2 py-1.5 hidden md:table-cell">
              Country
            </th>
            <th className="text-left px-2 py-1.5">Reason</th>
            <th className="text-left px-2 py-1.5 hidden sm:table-cell">
              Source
            </th>
            <th className="text-right px-2 py-1.5">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr
              key={b.ip}
              className="border-b border-border/60 hover:bg-secondary/40"
            >
              <td className="px-2 py-1.5 font-mono">{b.ip}</td>
              <td className="px-2 py-1.5 hidden md:table-cell">
                {b.intel?.country ?? "—"}
              </td>
              <td className="px-2 py-1.5 truncate max-w-[200px]">
                {b.reason ?? "—"}
              </td>
              <td className="px-2 py-1.5 hidden sm:table-cell">
                <Badge variant="outline" className="text-[9px]">
                  {b.source ?? "manual"}
                </Badge>
              </td>
              <td className="px-2 py-1.5 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => unbanMutation.mutate(b.ip)}
                  disabled={
                    unbanMutation.isPending &&
                    unbanMutation.variables === b.ip
                  }
                  className="h-6 text-[10px] text-destructive hover:bg-destructive/10"
                >
                  {unbanMutation.isPending &&
                  unbanMutation.variables === b.ip ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Unban"
                  )}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

