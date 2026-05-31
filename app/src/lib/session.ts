/**
 * Activity-driven session lifecycle — Next.js port of
 * frontend/src/lib/session.js.
 *
 * Wired up by SessionManager on mount (only when authenticated).
 * Listens for user activity (mousemove, keydown, click, touchstart)
 * and:
 *
 *   - Refreshes the JWT every REFRESH_INTERVAL_MS if the user has
 *     been active in that window. Idle users do NOT refresh — their
 *     idle_exp trips server-side on the next request.
 *   - At IDLE_WARNING_MS of inactivity, shows the SessionTimeoutModal.
 *   - At IDLE_LOGOUT_MS, hard-logs out and redirects to /login.
 *
 * `installSessionManager()` is idempotent — call once on mount and
 * use the returned teardown for cleanup on unmount / logout.
 */

import { auth } from "@/lib/api";

export const IDLE_WARNING_MS = 25 * 60 * 1000; // 25 minutes
export const IDLE_LOGOUT_MS = 30 * 60 * 1000; // 30 minutes
export const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

let _lastActivity = Date.now();
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _watchTimer: ReturnType<typeof setInterval> | null = null;
let _installed = false;
let _onWarn: ((info: { msUntilLogout: number }) => void) | null = null;
let _onLogout: ((reason: string) => void) | null = null;

function _markActive(): void {
  _lastActivity = Date.now();
}

async function _refresh(): Promise<void> {
  // Skip the refresh call on a fully-idle user — let them drop to
  // the idle-warning path instead. The next protected request will
  // 401 and bounce through the SPA's redirect path.
  const sinceActivity = Date.now() - _lastActivity;
  if (sinceActivity > REFRESH_INTERVAL_MS) return;
  try {
    await auth.refreshSession();
  } catch {
    // Silent — next protected request will surface the 401.
  }
}

function _watch(): void {
  const idle = Date.now() - _lastActivity;
  if (idle >= IDLE_LOGOUT_MS) {
    _onLogout?.("idle_timeout");
    return;
  }
  if (idle >= IDLE_WARNING_MS) {
    _onWarn?.({ msUntilLogout: IDLE_LOGOUT_MS - idle });
  }
}

const ACTIVITY_EVENTS: readonly (keyof WindowEventMap)[] = [
  "mousemove",
  "keydown",
  "click",
  "touchstart",
] as const;

export interface SessionManagerOptions {
  onIdleWarning?: (info: { msUntilLogout: number }) => void;
  onIdleLogout?: (reason: string) => void;
}

export function installSessionManager(
  options: SessionManagerOptions = {},
): () => void {
  if (_installed) {
    // Already installed — update callbacks but don't double-register
    // listeners. Returning the same teardown lets callers safely call
    // this from inside an effect.
    _onWarn = options.onIdleWarning ?? _onWarn;
    _onLogout = options.onIdleLogout ?? _onLogout;
    return _teardown;
  }
  if (typeof window === "undefined") {
    // SSR safety — no-op when called during render on the server.
    return () => {};
  }
  _installed = true;
  _lastActivity = Date.now();
  _onWarn = options.onIdleWarning ?? null;
  _onLogout = options.onIdleLogout ?? null;

  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, _markActive, { passive: true });
  }

  _refreshTimer = setInterval(_refresh, REFRESH_INTERVAL_MS);
  _watchTimer = setInterval(_watch, 60 * 1000); // every minute

  return _teardown;
}

function _teardown(): void {
  if (!_installed) return;
  for (const ev of ACTIVITY_EVENTS) {
    window.removeEventListener(ev, _markActive);
  }
  if (_refreshTimer) clearInterval(_refreshTimer);
  if (_watchTimer) clearInterval(_watchTimer);
  _refreshTimer = null;
  _watchTimer = null;
  _installed = false;
  _onWarn = null;
  _onLogout = null;
}

/** Force-mark activity now — call from the "Stay signed in" button
 *  in the warning modal so the warning resets without waiting for a
 *  natural mousemove. */
export function bumpActivity(): void {
  _markActive();
}

/** Reset the idle clock — call from a successful login so a long-
 *  running SPA tab starts the next idle window from now. */
export function resetSessionTimers(): void {
  _lastActivity = Date.now();
}
