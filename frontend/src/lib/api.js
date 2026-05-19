import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

// withCredentials: include the httpOnly access cookie on every request. Required
// because the cookie is the auth credential — JWTs are no longer carried in
// localStorage or Authorization headers from the browser. The backend cookie is
// SameSite=None;Secure so it travels cross-site (Vercel → Render).
export const api = axios.create({
  baseURL: API,
  withCredentials: true,
});

// ── Session timeout config ────────────────────────────────────────────────
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes
const SESSION_WARNING_MS = 25 * 60 * 1000;  // 25 minutes — show warning
const LAST_ACTIVITY_KEY = "ghw_last_activity";
const SESSION_WARNING_KEY = "ghw_session_warning_shown";

function updateLastActivity() {
  localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());
  localStorage.removeItem(SESSION_WARNING_KEY);
}

function isSessionExpired() {
  const last = localStorage.getItem(LAST_ACTIVITY_KEY);
  if (!last) return false; // No session in progress
  return Date.now() - parseInt(last, 10) > SESSION_TIMEOUT_MS;
}

function shouldWarnSession() {
  const last = localStorage.getItem(LAST_ACTIVITY_KEY);
  if (!last) return false;
  const elapsed = Date.now() - parseInt(last, 10);
  return elapsed > SESSION_WARNING_MS && elapsed <= SESSION_TIMEOUT_MS;
}

// Read CSRF token from the JS-readable double-submit cookie. Returns null if
// not set yet (e.g. on the very first /auth/login request).
function readCsrfCookie() {
  const match = document.cookie
    .split("; ")
    .find((r) => r.startsWith("ghw_csrf_token="));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

const STATE_CHANGING_METHODS = new Set(["post", "put", "patch", "delete"]);

// ── Agent impersonation (admin/compliance "view as agent") ────────────────
// Module-local store for the impersonated agent id. AgentContext owns the
// React-facing state and pushes changes here via setImpersonatedAgent so the
// request interceptor can attach X-Agent-ID without re-importing React.
let _impersonatedAgentId = null;

export function setImpersonatedAgent(agent) {
  // Accept the full agent object, just the id, or null/undefined to clear.
  if (!agent) {
    _impersonatedAgentId = null;
    return;
  }
  _impersonatedAgentId = typeof agent === "string" ? agent : agent.id || null;
}

export function getImpersonatedAgentId() {
  return _impersonatedAgentId;
}

api.interceptors.request.use(
  (config) => {
    // Session-expiry guard: if a previous activity timestamp exists and is
    // beyond the timeout, force logout. We use the user cache as the proxy
    // for "user is logged in", since the token itself is now in an httpOnly
    // cookie we cannot inspect from JS.
    if (localStorage.getItem("ghw_user")) {
      if (isSessionExpired()) {
        auth.logout();
        window.location.href = "/login?reason=session_expired";
        return Promise.reject(new Error("Session expired"));
      }
    }

    // Attach CSRF header for state-changing methods.
    const method = (config.method || "get").toLowerCase();
    if (STATE_CHANGING_METHODS.has(method)) {
      const csrf = readCsrfCookie();
      if (csrf) {
        config.headers["X-CSRF-Token"] = csrf;
      }
    }

    // Attach the impersonation header when an admin/compliance user has a
    // target agent selected. The backend (get_effective_agent) ignores this
    // header for non-privileged callers, so a leaked header from an agent
    // session cannot widen scope server-side.
    if (_impersonatedAgentId) {
      config.headers["X-Agent-ID"] = _impersonatedAgentId;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => {
    if (localStorage.getItem("ghw_user")) {
      updateLastActivity();

      if (shouldWarnSession() && !localStorage.getItem(SESSION_WARNING_KEY)) {
        localStorage.setItem(SESSION_WARNING_KEY, "true");
        window.dispatchEvent(new CustomEvent("ghw:session-warning"));
      }
    }
    return response;
  },
  (err) => {
    if (err?.response?.status === 401) {
      const path = window.location.pathname;
      if (
        path.startsWith("/dashboard") ||
        path.startsWith("/leads") ||
        path.startsWith("/audit") ||
        path.startsWith("/admin") ||
        path.startsWith("/commissions") ||
        path.startsWith("/intake") ||
        path.startsWith("/mfa-setup")
      ) {
        auth.logout();
        window.location.href = "/login?reason=session_expired";
      }
    }
    return Promise.reject(err);
  }
);

export const auth = {
  // The login response still includes an access_token in the body for the
  // rollout-grace period, but we deliberately ignore it — the authoritative
  // credential is the httpOnly cookie the server planted on this same response.
  saveSession(_token, user) {
    localStorage.setItem("ghw_user", JSON.stringify(user));
    updateLastActivity();
  },
  getUser() {
    const raw = localStorage.getItem("ghw_user");
    return raw ? JSON.parse(raw) : null;
  },
  // logout() clears only the client-side profile cache + activity timer. The
  // httpOnly auth cookie can only be cleared by the server — callers that
  // need a full logout should also POST /auth/logout.
  logout() {
    localStorage.removeItem("ghw_user");
    localStorage.removeItem(LAST_ACTIVITY_KEY);
    localStorage.removeItem(SESSION_WARNING_KEY);
  },
  async serverLogout() {
    try {
      await api.post("/auth/logout");
    } catch (_e) {
      // best-effort — cookie will still expire client-side
    }
    auth.logout();
  },
};
