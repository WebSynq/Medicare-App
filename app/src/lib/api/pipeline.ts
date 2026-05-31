/**
 * Pipeline (Kanban) — /api/leads/pipeline + PATCH /api/leads/{id}/stage
 *
 * Backend returns the seven stage columns in a stable order with a
 * card cap per stage. Stage moves go through PATCH /stage which
 * returns the updated card so the SPA can swap it in place.
 */

import { api } from "./client";

export interface PipelineCard {
  lead_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  carrier: string | null;
  product_type: string | null;
  state: string | null;
  created_at: string | null;
  updated_at: string | null;
  agent_name: string | null;
  agent_id?: string | null;
  agent_email?: string | null;
  client_success_rep: string | null;
  estimated_commission: number | null;
}

export interface PipelineStage {
  id: string;
  label: string;
  color: string;
  leads: PipelineCard[];
  count: number;
  truncated: boolean;
  cap: number;
  total_commission: number;
}

export interface PipelineResponse {
  stages: PipelineStage[];
  summary: {
    total_leads: number;
    total_pipeline_value: number;
  };
}

export async function getPipeline(): Promise<PipelineResponse> {
  const { data } = await api.get<PipelineResponse>("/api/leads/pipeline");
  return data;
}

export async function updateStage(
  leadId: string,
  status: string,
): Promise<PipelineCard> {
  const { data } = await api.patch<PipelineCard>(
    `/api/leads/${leadId}/stage`,
    { status },
  );
  return data;
}
