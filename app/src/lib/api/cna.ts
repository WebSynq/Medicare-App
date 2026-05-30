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

export async function getAiAnalysis(
  leadId: string,
): Promise<CnaAiRecommendation> {
  const { data } = await api.get<CnaAiRecommendation>(
    `/api/cna/${leadId}/ai-analysis`,
  );
  return data;
}

export async function runAiAnalysis(
  leadId: string,
): Promise<CnaAiRecommendation> {
  const { data } = await api.post<CnaAiRecommendation>(
    `/api/cna/${leadId}/ai-analysis`,
  );
  return data;
}
