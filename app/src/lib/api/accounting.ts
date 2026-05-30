/**
 * Accounting endpoints — /api/accounting/* and /api/reconciliation/*
 *
 * Mirrors what `backend/accounting_router.py` and
 * `backend/reconciliation_router.py` actually return (verified
 * 2026-05). The Accounting Dashboard page is the only consumer —
 * extend here when ports of other surfaces need the same data.
 */

import { api } from "./client";

// ─── Period enum ─────────────────────────────────────────────────────────
// Backend supports mtd|ytd|q1|q2|q3|q4|all (see _period_window in
// accounting_router.py). The spec mentioned MTD/Last30/Last90/YTD —
// "last30/last90" don't exist for accounting, so we expose what the
// backend can actually answer.
export type AccountingPeriod =
  | "mtd"
  | "ytd"
  | "q1"
  | "q2"
  | "q3"
  | "q4"
  | "all";

// ─── /accounting/summary ─────────────────────────────────────────────────

export interface RevenueByMonthRow {
  month: string; // YYYY-MM
  expected: number;
  received: number;
}

export interface RevenueByCarrierRow {
  carrier: string;
  expected: number;
  received: number;
  gap: number;
  policies: number;
  collection_rate: number;
}

export interface RevenueByProductRow {
  product: string;
  expected: number;
  received: number;
  gap: number;
}

export interface RevenueByAgentRow {
  agent_id: string;
  agent_name: string;
  expected: number;
  received: number;
  gap: number;
  policy_count: number;
}

export interface AccountingSummary {
  period: AccountingPeriod;
  expected_mtd: number;
  received_mtd: number;
  gap_mtd: number;
  expected_ytd: number;
  received_ytd: number;
  gap_ytd: number;
  expected_period: number;
  received_period: number;
  outstanding_total: number;
  overpaid_total: number;
  collection_rate_pct: number;
  revenue_by_month: RevenueByMonthRow[];
  revenue_by_carrier: RevenueByCarrierRow[];
  revenue_by_product: RevenueByProductRow[];
  revenue_by_agent: RevenueByAgentRow[];
  aging: {
    current: number;
    days_31_60: number;
    days_61_90: number;
    days_90_plus: number;
  };
}

export async function getSummary(
  period: AccountingPeriod = "mtd",
): Promise<AccountingSummary> {
  const { data } = await api.get<AccountingSummary>(
    "/api/accounting/summary",
    { params: { period } },
  );
  return data;
}

// ─── /accounting/ledger ──────────────────────────────────────────────────

export type LedgerStatus =
  | "paid"
  | "pending"
  | "gap"
  | "underpaid"
  | "overpaid"
  | "chargeback"
  | "unmatched";

export interface LedgerRow {
  policy_id: string | null;
  submission_date: string | null;
  effective_date: string | null;
  payment_date: string | null;
  agent_name: string | null;
  client_name: string | null;
  carrier: string | null;
  product_type: string | null;
  monthly_premium: number;
  annual_premium: number;
  expected_commission: number;
  received_commission: number | null;
  gap_amount: number;
  status: LedgerStatus;
}

export interface LedgerResponse {
  items: LedgerRow[];
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface LedgerFilters {
  carrier?: string;
  agent_id?: string;
  product?: string;
  status?: LedgerStatus | "all";
  page?: number;
  limit?: number;
}

export async function getLedger(
  filters: LedgerFilters = {},
): Promise<LedgerResponse> {
  const params: Record<string, string | number> = {};
  if (filters.carrier) params.carrier = filters.carrier;
  if (filters.agent_id) params.agent_id = filters.agent_id;
  if (filters.product) params.product = filters.product;
  if (filters.status && filters.status !== "all") params.status = filters.status;
  if (filters.page) params.page = filters.page;
  params.limit = filters.limit ?? 50;
  const { data } = await api.get<LedgerResponse>(
    "/api/accounting/ledger",
    { params },
  );
  return data;
}

// ─── /accounting/carriers ────────────────────────────────────────────────

export interface CarrierRow {
  carrier_name: string;
  total_policies: number;
  expected_ytd: number;
  received_ytd: number;
  gap_ytd: number;
  collection_rate: number;
  last_payment_date: string | null;
  avg_days_to_pay: number | null;
}

export interface CarriersResponse {
  carriers: CarrierRow[];
  count: number;
}

export async function getCarriers(): Promise<CarriersResponse> {
  const { data } = await api.get<CarriersResponse>("/api/accounting/carriers");
  return data;
}

// ─── /accounting/aging ───────────────────────────────────────────────────

export interface AgingPolicyRow {
  policy_id: string | null;
  agent_name: string | null;
  client_name: string | null;
  carrier: string | null;
  product: string | null;
  expected: number;
  effective_date: string | null;
  days_old: number;
}

export type AgingBucketKey =
  | "current"
  | "days_31_60"
  | "days_61_90"
  | "days_90_plus";

export interface AgingBucket {
  label: string;
  count: number;
  amount: number;
  policies: AgingPolicyRow[];
}

export interface AgingResponse {
  buckets: Record<AgingBucketKey, AgingBucket>;
  as_of: string;
}

export async function getAging(): Promise<AgingResponse> {
  const { data } = await api.get<AgingResponse>("/api/accounting/aging");
  return data;
}

// ─── /accounting/disputes ────────────────────────────────────────────────

export type DisputeStatus = "open" | "in_progress" | "resolved" | "closed";

export interface DisputeRow {
  dispute_id: string;
  policy_id: string | null;
  carrier: string;
  agent_id: string | null;
  agent_name: string | null;
  client_name: string | null;
  amount_disputed: number;
  amount_recovered: number;
  reason: string;
  carrier_contact: string | null;
  notes: string | null;
  status: DisputeStatus;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  days_open: number;
}

export interface DisputesResponse {
  items: DisputeRow[];
  counts: Record<DisputeStatus, number>;
  total_recovered_mtd: number;
}

export async function getDisputes(): Promise<DisputesResponse> {
  const { data } = await api.get<DisputesResponse>(
    "/api/accounting/disputes",
  );
  return data;
}

export interface CreateDisputePayload {
  carrier: string;
  policy_id?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  client_name?: string | null;
  amount_disputed: number;
  reason: string;
  carrier_contact?: string | null;
  notes?: string | null;
}

export async function createDispute(
  payload: CreateDisputePayload,
): Promise<{ dispute_id: string; status: "open" }> {
  const { data } = await api.post<{ dispute_id: string; status: "open" }>(
    "/api/accounting/disputes",
    payload,
  );
  return data;
}

export interface UpdateDisputePayload {
  status: DisputeStatus;
  amount_recovered?: number;
  note?: string;
}

export async function updateDispute(
  disputeId: string,
  payload: UpdateDisputePayload,
): Promise<DisputeRow> {
  const { data } = await api.patch<DisputeRow>(
    `/api/accounting/disputes/${disputeId}`,
    payload,
  );
  return data;
}

// ─── /reconciliation/* ───────────────────────────────────────────────────

export interface ReconciliationUploadResponse {
  statement_id: string;
  status: string;
  extracted_count: number;
}

export type ReconciliationMatchStatus =
  | "paid"
  | "underpaid"
  | "overpaid"
  | "unmatched";

export interface ReconciliationMatchRow {
  client_name?: string | null;
  policy_number?: string | null;
  carrier?: string | null;
  product_type?: string | null;
  commission_paid?: number;
  match_status: ReconciliationMatchStatus;
  match_confidence: number;
  expected_commission: number;
  gap: number;
  matched_policy_id: string | null;
  matched_agent_id: string | null;
  matched_agent_name: string | null;
}

export interface ReconciliationSummary {
  total_records: number;
  matched: number;
  unmatched: number;
  paid: number;
  underpaid: number;
  overpaid: number;
  total_expected: number;
  total_received: number;
  total_gap: number;
}

export interface ReconciliationMatchResponse {
  statement_id: string;
  summary: ReconciliationSummary;
  records: ReconciliationMatchRow[];
}

export async function matchStatement(
  statementId: string,
): Promise<ReconciliationMatchResponse> {
  const { data } = await api.post<ReconciliationMatchResponse>(
    `/api/reconciliation/${statementId}/match`,
  );
  return data;
}

// `/upload` is multipart/form-data — the typed wrapper lives on the
// Statements tab next to its drop-zone so the FormData construction
// stays close to the UI that owns it.
