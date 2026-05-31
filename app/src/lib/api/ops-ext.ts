/**
 * Ops Console additions on top of `./ops`.
 *
 * Holds the AI Security Intelligence shapes the panel needs that aren't
 * yet on the canonical `SecurityEvent` interface (event_id +
 * ai_narrative + findings + auto_actions_taken), plus the
 * `/api/security/ip/{ip}` lookup wrapper which lives nowhere else.
 *
 * Kept as a sibling file because mutating the existing `./ops` shape
 * has knock-on typing impact for other callers; once we're confident
 * those callers tolerate the richer `SecurityEvent`, fold this back in.
 */

import { api } from "./client";
import type { ThreatLevel } from "./ops";

export interface SecurityFinding {
  type?: string;
  severity?: string;
  description?: string;
  recommended_action?: string;
  [key: string]: unknown;
}

export interface SecurityAutoAction {
  type?: string;
  ip?: string;
  [key: string]: unknown;
}

/** Richer event shape including the AI narrative + findings the
 *  Ops Console panel renders inline when an event row expands. */
export interface SecurityEventDetail {
  event_id: string;
  timestamp: string;
  threat_level: ThreatLevel;
  ai_narrative?: string;
  summary?: string;
  recommended_action?: string;
  findings?: SecurityFinding[];
  auto_actions_taken?: SecurityAutoAction[];
  banned_ips?: string[];
  alert_sent?: boolean;
  [key: string]: unknown;
}

export interface SecurityEventsDetailResponse {
  events: SecurityEventDetail[];
  count: number;
}

export async function getSecurityEventsDetail(options?: {
  limit?: number;
}): Promise<SecurityEventsDetailResponse> {
  const { data } = await api.get<SecurityEventsDetailResponse>(
    "/api/security/events",
    {
      params: options?.limit ? { limit: options.limit } : {},
    },
  );
  return data;
}

export interface IpLookupResult {
  ip: string;
  private?: boolean;
  country?: string;
  country_code?: string;
  city?: string;
  region?: string;
  isp?: string;
  org?: string;
  hostname?: string;
  is_vpn?: boolean;
  is_proxy?: boolean;
  is_tor?: boolean;
  threat_score?: number;
  abuse_reports?: number;
  is_whitelisted?: boolean;
  lookup_error?: string;
  abuseipdb_error?: string;
  error?: string;
  [key: string]: unknown;
}

export async function lookupIp(ip: string): Promise<IpLookupResult> {
  const { data } = await api.get<IpLookupResult>(
    `/api/security/ip/${encodeURIComponent(ip)}`,
  );
  return data;
}

/** Banned-IP intel extension. The canonical `BannedIp.intel` shape in
 *  `./ops` doesn't carry country_code/region; we widen it locally so the
 *  Ops Console banned-IPs table can render "City, CC" without a cast. */
export interface BannedIpIntelExt {
  country?: string | null;
  country_code?: string | null;
  city?: string | null;
  region?: string | null;
  isp?: string | null;
  abuse_score?: number | null;
}
