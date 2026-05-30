/**
 * Today + Brief endpoints — /api/today/actions, /api/brief/today.
 */

import { api } from "./client";
import type { DailyBrief, TodayActionsResponse } from "@/types";

export async function getActions(): Promise<TodayActionsResponse> {
  const { data } = await api.get<TodayActionsResponse>("/api/today/actions");
  return data;
}

export async function getBrief(): Promise<DailyBrief> {
  const { data } = await api.get<DailyBrief>("/api/brief/today");
  return data;
}
