/**
 * Ops Console + Security endpoints.
 *
 *   GET /api/ops/health             — single aggregate; each section
 *                                     degrades to {error} on its own.
 *   GET /api/security/events        — list (admin/owner)
 *   GET /api/security/banned-ips    — banned list (admin/owner)
 *   GET /api/security/config        — kill switch + thresholds
 *   PATCH /api/security/config
 *   POST /api/security/ban-ip
 *   DELETE /api/security/ban-ip/{ip}
 *   POST /api/security/run-analysis — synchronous, returns the result
 *   GET /api/security/ip/{ip}       — intel lookup
 */

import { api } from "./client";

// ─── Ops health (single aggregate) ─────────────────────────────────────────

export interface OpsSectionError {
  error: string;
}

export interface OpsSystem {
  api_status?: string;
  db_ping_ms?: number;
  scheduler_running?: boolean;
  env_checks?: Record<string, boolean>;
  uptime_seconds?: number;
}

export interface OpsSecurity {
  failed_logins_24hr?: number;
  accounts_locked_now?: number;
  ip_bans_active?: number;
  booking_attacks_24hr?: number;
  mfa_enabled_count?: number;
  mfa_total_agents?: number;
  mfa_adoption_pct?: number;
}

export interface OpsDataIntegrity {
  total_leads?: number;
  total_agents?: number;
  leads_missing_agent?: number;
  leads_dirty_state?: number;
  ghl_unsynced?: number;
  ghl_sync_errors?: number;
  appointments_total?: number;
  reminders_pending?: number;
}

export interface OpsUsage {
  active_agents_7d?: number;
  bookings_today?: number;
  bookings_7d?: number;
  leads_created_today?: number;
  leads_created_7d?: number;
  soa_signed_7d?: number;
  enrollments_7d?: number;
}

export interface OpsAutomationJob {
  sent_7d: number;
  status: string;
}

export interface OpsAutomations {
  scheduler_status?: string;
  last_reminder_check?: string | null;
  reminders_sent_7d?: number;
  birthday_emails_sent_7d?: number;
  followups_sent_7d?: number;
  jobs?: Record<string, OpsAutomationJob>;
}

export interface OpsComplianceBaa {
  signed: boolean;
  vendor?: string;
  signed_at?: string | null;
  notes?: string | null;
}

export interface OpsCompliance {
  baa_render?: OpsComplianceBaa;
  baa_mongodb?: OpsComplianceBaa;
  baa_aws_ses?: OpsComplianceBaa;
  hipaa_training_due?: number;
  audit_log_count?: number;
  audit_last_write?: string | null;
  agents_without_mfa?: number;
}

export interface OpsActivityDay {
  date: string;
  label: string;
  leads: number;
  enrollments: number;
  bookings: number;
}

export interface OpsThreatLogEntry {
  time: string;
  event: string;
  actor: string | null;
  status: string;
}

export interface OpsAiSecurity {
  auto_ban_enabled?: boolean;
  last_analysis?: string | null;
  last_threat_level?: string | null;
  events_24hr?: number;
  bans_active?: number;
  bans_ai_24hr?: number;
}

export interface OpsHealthResponse {
  generated_at: string;
  system: OpsSystem | OpsSectionError;
  security: OpsSecurity | OpsSectionError;
  data_integrity: OpsDataIntegrity | OpsSectionError;
  usage: OpsUsage | OpsSectionError;
  automations: OpsAutomations | OpsSectionError;
  compliance: OpsCompliance | OpsSectionError;
  activity_7d: OpsActivityDay[] | OpsSectionError;
  threat_log: OpsThreatLogEntry[] | OpsSectionError;
  ai_security: OpsAiSecurity | OpsSectionError;
}

export function isOpsError<T>(
  section: T | OpsSectionError,
): section is OpsSectionError {
  return (
    typeof section === "object" &&
    section !== null &&
    "error" in section &&
    typeof (section as OpsSectionError).error === "string"
  );
}

export async function getHealth(): Promise<OpsHealthResponse> {
  const { data } = await api.get<OpsHealthResponse>("/api/ops/health");
  return data;
}

// ─── Security ──────────────────────────────────────────────────────────────

export type ThreatLevel = "low" | "medium" | "high" | "critical" | "unknown";

export interface SecurityEvent {
  id: string;
  timestamp: string;
  threat_level: ThreatLevel;
  summary?: string;
  recommended_action?: string;
  banned_ips?: string[];
  alert_sent?: boolean;
  [key: string]: unknown;
}

export interface SecurityEventsResponse {
  events: SecurityEvent[];
  count: number;
}

export async function getEvents(options?: {
  threat_level?: ThreatLevel;
  limit?: number;
}): Promise<SecurityEventsResponse> {
  const { data } = await api.get<SecurityEventsResponse>(
    "/api/security/events",
    {
      params: {
        ...(options?.threat_level ? { threat_level: options.threat_level } : {}),
        ...(options?.limit ? { limit: options.limit } : {}),
      },
    },
  );
  return data;
}

export interface BannedIp {
  ip: string;
  reason?: string;
  source?: string;
  banned_at?: string;
  expires_at?: string | null;
  intel?: {
    country?: string | null;
    city?: string | null;
    isp?: string | null;
    abuse_score?: number | null;
  };
}

export interface BannedIpsResponse {
  banned_ips: BannedIp[];
  count: number;
}

export async function getBannedIps(): Promise<BannedIpsResponse> {
  const { data } = await api.get<BannedIpsResponse>(
    "/api/security/banned-ips",
  );
  return data;
}

export async function unbanIp(ip: string): Promise<{ unbanned: boolean; ip: string }> {
  const { data } = await api.delete<{ unbanned: boolean; ip: string }>(
    `/api/security/ban-ip/${encodeURIComponent(ip)}`,
  );
  return data;
}

export async function banIp(
  ip: string,
  reason: string,
  durationDays = 30,
): Promise<{ banned: boolean; ip: string }> {
  const { data } = await api.post<{ banned: boolean; ip: string }>(
    "/api/security/ban-ip",
    { ip, reason, duration_days: durationDays },
  );
  return data;
}

export interface SecurityConfig {
  ai_auto_ban_enabled: boolean;
  auto_ban_threshold: number;
  alert_emails: string[];
  agent_ip_whitelist: string[];
  [key: string]: unknown;
}

export async function getConfig(): Promise<SecurityConfig> {
  const { data } = await api.get<SecurityConfig>("/api/security/config");
  return data;
}

export interface SecurityConfigPatchPayload {
  ai_auto_ban_enabled?: boolean;
  auto_ban_threshold?: number;
  alert_emails?: string[];
  agent_ip_whitelist?: string[];
}

export async function patchConfig(
  payload: SecurityConfigPatchPayload,
): Promise<SecurityConfig> {
  const { data } = await api.patch<SecurityConfig>(
    "/api/security/config",
    payload,
  );
  return data;
}

export async function runAnalysis(): Promise<SecurityEvent> {
  const { data } = await api.post<SecurityEvent>(
    "/api/security/run-analysis",
  );
  return data;
}
