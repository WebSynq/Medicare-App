/**
 * CNA + AI Intelligence — /api/cna/*
 */

import { api } from "./client";
import type { CnaAiRecommendation, CnaFetchResponse } from "@/types";

export async function getCna(leadId: string): Promise<CnaFetchResponse> {
  const { data } = await api.get<CnaFetchResponse>(`/api/cna/${leadId}`);
  return data;
}

export async function saveCna(
  leadId: string,
  payload: Record<string, unknown>,
  options?: { runAi?: boolean },
): Promise<CnaFetchResponse & { ai_recommendation?: CnaAiRecommendation }> {
  const url = options?.runAi
    ? `/api/cna/${leadId}?run_ai=true`
    : `/api/cna/${leadId}`;
  const { data } = await api.post(url, payload);
  return data;
}

// Backend wraps the recommendation in `{ai_recommendation, ai_generated_at,
// cache_fresh, exists}` — unwrap it so the panel can render `null` for a
// brand new lead without crashing on the empty wrapper.
interface AiAnalysisEnvelope {
  ai_recommendation: CnaAiRecommendation | null;
  ai_generated_at?: string | null;
  cache_fresh?: boolean;
  exists?: boolean;
}

export async function getAiAnalysis(
  leadId: string,
): Promise<CnaAiRecommendation | null> {
  const { data } = await api.get<AiAnalysisEnvelope>(
    `/api/cna/${leadId}/ai-analysis`,
  );
  return data?.ai_recommendation ?? null;
}

export async function runAiAnalysis(
  leadId: string,
): Promise<CnaAiRecommendation | null> {
  const { data } = await api.post<AiAnalysisEnvelope>(
    `/api/cna/${leadId}/ai-analysis`,
  );
  return data?.ai_recommendation ?? null;
}
