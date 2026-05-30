/**
 * Policies — backed by /api/clients/{contact_id}/policies.
 *
 * The backend endpoint accepts either the portal lead id OR the
 * GHL contact id under the same path segment (clients_router has
 * the dual-lookup logic). Pass the lead id directly.
 */

import { api } from "./client";
import type { PolicyListResponse } from "@/types";

export async function listByLead(leadId: string): Promise<PolicyListResponse> {
  const { data } = await api.get<PolicyListResponse>(
    `/api/clients/${leadId}/policies`,
  );
  return data;
}
