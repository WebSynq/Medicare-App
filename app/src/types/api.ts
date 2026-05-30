/**
 * Generic API response shapes the FastAPI backend uses.
 *
 * The Render-hosted FastAPI service (api.ghwcrm.com) returns JSON
 * with a few stable patterns:
 *   - Single-resource endpoints return the resource directly.
 *   - List endpoints return `{ items: T[], total: number }` or
 *     `{ <name>: T[], total: number }` depending on the route
 *     (we model both with PaginatedResponse below).
 *   - Errors come through FastAPI's HTTPException pipeline as
 *     `{ detail: string | object }` with the matching HTTP status.
 */

/** FastAPI error body — `detail` is either a free-form string or a
 *  structured object (multi-tenant errors include `feature` /
 *  `upgrade_url` keys; billing 402s include `billing_status`). */
export interface ApiErrorBody {
  detail: string | ApiErrorDetailObject;
}

export interface ApiErrorDetailObject {
  message?: string;
  /** Multi-tenant feature gate (403). */
  feature?: string;
  upgrade_url?: string;
  /** Billing gate (402). */
  billing_status?: "trialing" | "active" | "past_due" | "suspended" | "cancelled";
  billing_url?: string;
  /** Seat-cap gate (402). */
  seats_active?: number;
  seats_max?: number;
  /** Calendar deactivate (409). */
  blocking_appointments?: number;
  /** Pass-through bag for anything else. */
  [key: string]: unknown;
}

/** Thrown / returned from the api client when a request fails.
 *  The shape carries enough context for components to render a
 *  contextual error UI without re-running the request. */
export interface ApiError extends Error {
  /** HTTP status. 0 on network failure (no response). */
  status: number;
  /** Original response body, when one was received. */
  body?: ApiErrorBody;
  /** Convenience field — the most user-readable string we could
   *  extract from `body.detail`. */
  message: string;
}

/** Paginated list response. Many endpoints use a named array key
 *  (`calendars`, `leads`, `appointments`) rather than the generic
 *  `items`. Combine with an intersection per endpoint:
 *
 *      type CalendarsList = PaginatedResponse<Calendar> & {
 *        calendars: Calendar[]
 *      };
 *
 *  We deliberately don't bake the key name into the generic because
 *  TS can't combine an index signature with a named-field type of
 *  a different shape — the intersection at the call site is cleaner
 *  than fighting the compiler. */
export interface PaginatedResponse<T> {
  total: number;
  /** The list field. Always provided under at least one named key;
   *  consumers also receive the typed list via the intersected
   *  named field. Kept here so a generic consumer that doesn't
   *  know the field name still has a path to the data. */
  items?: T[];
}
