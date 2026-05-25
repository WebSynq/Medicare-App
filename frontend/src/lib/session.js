/**
 * Activity-driven session lifecycle.
 *
 * Wired up by App on mount (only when a user is logged in). Listens for
 * user activity (mousemove, keydown, click, touchstart) and:
 *
 *   - Refreshes the JWT every REFRESH_INTERVAL_MS if the user has
 *     been active in that window. Idle users do NOT refresh — their
 *     idle_exp will then trip server-side on the next request.
 *   - At IDLE_WARNING_MS of inactivity, shows the SessionTimeoutModal.
 *   - At IDLE_LOGOUT_MS, hard-logs-out and redirects to /login.
 *
 * `installSessionManager()` is idempotent. Call once on mount, get back
 * a teardown function for cleanup on unmount / logout.
 */
import axios from "axios";

const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
const sessionApi = axios.create({
  baseURL: `${BACKEND}/api`,
  withCredentials: true,
  timeout: 10000,
});

export const IDLE_WARNING_MS = 25 * 60 * 1000;   // 25 minutes
export const IDLE_LOGOUT_MS  = 30 * 60 * 1000;   // 30 minutes
export const REFRESH_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

let _lastActivity = Date.now();
let _refreshTimer = null;
let _watchTimer = null;
let _installed = false;
let _onWarn = null;
let _onLogout = null;

function _markActive() {
  _lastActivity = Date.now();
}

async function _refresh() {
  // Don't refresh on a fully-idle user — they should drop to the
  // idle-timeout warning instead.
  const sinceActivity = Date.now() - _lastActivity;
  if (sinceActivity > REFRESH_INTERVAL_MS) return;
  try {
    await sessionApi.post("/auth/refresh");
  } catch {
    // Silent — the next protected request will 401 and the SPA's
    // axios interceptor will bounce the user to /login.
  }
}

function _watch() {
  const idle = Date.now() - _lastActivity;
  if (idle >= IDLE_LOGOUT_MS) {
    if (_onLogout) _onLogout("idle_timeout");
    return;
  }
  if (idle >= IDLE_WARNING_MS) {
    if (_onWarn) _onWarn({ msUntilLogout: IDLE_LOGOUT_MS - idle });
  }
}

export function installSessionManager({ onIdleWarning, onIdleLogout } = {}) {
  if (_installed) {
    // Update callbacks but don't double-install listeners.
    _onWarn = onIdleWarning || _onWarn;
    _onLogout = onIdleLogout || _onLogout;
    return _teardown;
  }
  _installed = true;
  _lastActivity = Date.now();
  _onWarn = onIdleWarning || null;
  _onLogout = onIdleLogout || null;

  const events = ["mousemove", "keydown", "click", "touchstart"];
  events.forEach((ev) => window.addEventListener(ev, _markActive, { passive: true }));

  _refreshTimer = setInterval(_refresh, REFRESH_INTERVAL_MS);
  _watchTimer = setInterval(_watch, 60 * 1000);  // poll every minute

  return _teardown;
}

function _teardown() {
  if (!_installed) return;
  const events = ["mousemove", "keydown", "click", "touchstart"];
  events.forEach((ev) => window.removeEventListener(ev, _markActive));
  if (_refreshTimer) clearInterval(_refreshTimer);
  if (_watchTimer) clearInterval(_watchTimer);
  _refreshTimer = null;
  _watchTimer = null;
  _installed = false;
  _onWarn = null;
  _onLogout = null;
}

/** Force-mark activity now — call from "Stay logged in" button. */
export function bumpActivity() {
  _markActive();
}

/** Reset state — call from a successful login so the next idle clock
 *  starts fresh even on a long-running SPA tab. */
export function resetSessionTimers() {
  _lastActivity = Date.now();
}
