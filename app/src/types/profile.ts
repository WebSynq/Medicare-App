/**
 * Types for the /clients/[id] surfaces — CNA, documents, SOA,
 * policies, notes, and the commission calculator inputs.
 *
 * Compact-but-accurate shapes pulled from the backend models
 * (deps.py + cna_router + documents_router + soa_router +
 * clients_router + notes_router + commission_router). Anything
 * intentionally pruned is marked `// minimal` so the swap to a
 * fuller representation is a deliberate edit, not a guess.
 */

// ─── CNA — Client Needs Assessment ─────────────────────────────────────────

export interface CnaRecord {
  lead_id: string;
  agent_id: string;
  agency_id: string;
  /** Stamped on first save. */
  completed_at: string | null;
  updated_at: string | null;
  /** Cached AI recommendation; populated by /ai-analysis. */
  ai_recommendation: CnaAiRecommendation | null;
  ai_generated_at: string | null;
  /** Free-form COACHG fields — typed as a record so adding a
   *  question doesn't require a type edit. The form component
   *  knows the canonical key list. */
  fields: Record<string, string | number | boolean | null>;
}

export interface CnaFetchResponse {
  exists: boolean;
  cna: CnaRecord;
}

export type CnaUrgencyLevel = "urgent" | "high" | "moderate" | "low";

export interface CnaAiRecommendation {
  urgency_score?: number; // 0-100
  urgency_level?: CnaUrgencyLevel;
  recommendation?: string;
  umbrella_tier?: "essential" | "complete" | "premier" | null;
  exposures?: string[];
  talking_points?: string[];
  cross_sell?: string[];
  objection_handles?: { objection: string; response: string }[];
  formal_script?: string;
}

// ─── Documents ─────────────────────────────────────────────────────────────

export type DocumentType =
  | "medicare_card"
  | "drivers_license"
  | "state_id"
  | "ssn_card"
  | "application_pdf"
  | "soa"
  | "eft_authorization"
  | "other";

export interface LeadDocument {
  id: string;
  lead_id: string;
  agent_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  doc_type: DocumentType;
  uploaded_at: string;
  uploaded_by: string | null;
}

export interface DocumentListResponse {
  documents: LeadDocument[];
  total: number;
}

// ─── SOA — Scope of Appointment ────────────────────────────────────────────

export type SoaStatus = "pending" | "signed" | "expired" | "revoked";

export interface SoaRecord {
  id: string;
  lead_id: string;
  agent_id: string;
  agency_id: string;
  status: SoaStatus;
  token: string;
  public_link: string;
  expires_at: string;
  signed_at: string | null;
  signed_name: string | null;
  signed_ip: string | null;
  signed_user_agent: string | null;
  /** Products listed on the SOA the client agreed to discuss. */
  products: string[];
  created_at: string;
}

export interface SoaListResponse {
  records: SoaRecord[];
  total: number;
}

// ─── Policies + commission ────────────────────────────────────────────────

export type PolicyStatus =
  | "active"
  | "pending"
  | "terminated"
  | "cancelled"
  | "lapsed";

export interface PolicyRecord {
  id: string;
  application_id: string | null;
  lead_id: string | null;
  ghl_contact_id: string | null;
  agent_id: string;
  carrier: string | null;
  product_type: string | null;
  product_label: string | null;
  plan_type: string | null;
  premium: number | string | null;
  effective_date: string | null;
  policy_status: PolicyStatus | string | null;
  submitted_at: string;
  contact_name: string | null;
}

export interface PolicyListResponse {
  contact_id: string;
  policies: PolicyRecord[];
  count: number;
}

export interface CommissionCarriersResponse {
  product_types: string[];
  carriers_by_product: Record<string, string[]>;
  plan_options_by_product: Record<string, string[]>;
}

export interface CommissionCalculatePayload {
  product_type: string;
  carrier?: string;
  state?: string;
  plan_type?: string | null;
  monthly_premium?: number;
  client_age?: number;
  scope_completed?: boolean;
  lead_source?: string | null;
  lead_id?: string | null;
}

export interface CommissionCalculateResponse {
  annual_premium: number;
  agency_revenue: number;
  agent_commission: number;
  rate_type: string | null;
  carrier_rate: number | null;
  notes: string | null;
}

// ─── Notes + tasks ─────────────────────────────────────────────────────────

export type NoteKind = "note" | "task";

export interface NoteRecord {
  id: string;
  lead_id: string;
  agent_id: string;
  agency_id: string;
  kind: NoteKind;
  body: string;
  /** Tasks only. */
  due_at: string | null;
  completed: boolean;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteListResponse {
  notes: NoteRecord[];
  total: number;
}

export interface NoteCreatePayload {
  lead_id: string;
  kind: NoteKind;
  body: string;
  due_at?: string;
}
