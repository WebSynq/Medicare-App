/**
 * Base axios instance.
 *
 * Backend lives at NEXT_PUBLIC_BACKEND_URL (api.ghwcrm.com). All
 * requests are cross-origin; cookies are SameSite=None+Secure on
 * the server side so `withCredentials: true` makes the
 * httpOnly access cookie + the JS-readable CSRF cookie flow.
 *
 * Two interceptors:
 *   1. Request — attach CSRF header on state-changing methods and
 *      the X-Agent-ID impersonation header when an admin is
 *      "viewing as" another agent.
 *   2. Response — normalize FastAPI's `{ detail: … }` body into
 *      a typed ApiError that components can render against.
 */

import axios, { type AxiosError, type AxiosInstance } from "axios";
import Cookies from "js-cookie";

import type { ApiError, ApiErrorBody } from "@/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

const CSRF_COOKIE = "ghw_csrf_token";
const CSRF_HEADER = "X-CSRF-Token";
const AGENT_HEADER = "X-Agent-ID";

/** Methods that need a CSRF token. Backend's middleware exempts
 *  GET/HEAD/OPTIONS; bearer-auth callers also bypass, but we
 *  always use cookies so the exemption doesn't help us. */
const CSRF_METHODS = new Set(["post", "put", "patch", "delete"]);

/** Module-level impersonation state. Mutated only by the
 *  ImpersonationStore (phase 5); read here in the request
 *  interceptor. Module scope is fine because there's exactly one
 *  axios instance per browser tab. */
let impersonationAgentId: string | null = null;

export function setImpersonationAgentId(id: string | null): void {
  impersonationAgentId = id;
}

export function getImpersonationAgentId(): string | null {
  return impersonationAgentId;
}

export const api: AxiosInstance = axios.create({
  baseURL: BACKEND_URL,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
  // Timeout long enough for the Bedrock-backed AI endpoints, short
  // enough that a hung route surfaces before the user gives up.
  timeout: 30_000,
});

api.interceptors.request.use((config) => {
  const method = (config.method ?? "get").toLowerCase();
  if (CSRF_METHODS.has(method)) {
    const token = Cookies.get(CSRF_COOKIE);
    if (token) {
      config.headers.set(CSRF_HEADER, token);
    }
  }
  if (impersonationAgentId) {
    config.headers.set(AGENT_HEADER, impersonationAgentId);
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorBody>) => Promise.reject(normalizeError(error)),
);

function normalizeError(error: AxiosError<ApiErrorBody>): ApiError {
  const status = error.response?.status ?? 0;
  const body = error.response?.data;
  let message = error.message ?? "Request failed";
  if (body && typeof body === "object" && "detail" in body) {
    const detail = body.detail;
    if (typeof detail === "string") {
      message = detail;
    } else if (detail && typeof detail === "object" && "message" in detail) {
      const detailMessage = detail.message;
      if (typeof detailMessage === "string") {
        message = detailMessage;
      }
    }
  }
  const apiError = new Error(message) as ApiError;
  apiError.status = status;
  if (body) apiError.body = body;
  return apiError;
}

/** Type guard. Use in catch blocks: */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && "status" in err;
}
