/**
 * Commission calculator — /api/commission/*
 */

import { api } from "./client";
import type {
  CommissionCalculatePayload,
  CommissionCalculateResponse,
  CommissionCarriersResponse,
} from "@/types";

export async function getCarriers(): Promise<CommissionCarriersResponse> {
  const { data } = await api.get<CommissionCarriersResponse>(
    "/api/commission/carriers",
  );
  return data;
}

export async function calculate(
  payload: CommissionCalculatePayload,
): Promise<CommissionCalculateResponse> {
  const { data } = await api.post<CommissionCalculateResponse>(
    "/api/commission/calculate",
    payload,
  );
  return data;
}
