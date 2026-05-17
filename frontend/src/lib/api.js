import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API });

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

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("ghw_token");
    if (token) {
      // Check if session has expired
      if (isSessionExpired()) {
        auth.logout();
        window.location.href = "/login?reason=session_expired";
        return Promise.reject(new Error("Session expired"));
      }
      config.headers["Authorization"] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => {
    // Reset activity timer on every successful API call when authenticated
    if (localStorage.getItem("ghw_token")) {
      updateLastActivity();

      // Fire a one-shot warning event when entering the 25–30 min window
      if (shouldWarnSession() && !localStorage.getItem(SESSION_WARNING_KEY)) {
        localStorage.setItem(SESSION_WARNING_KEY, "true");
        window.dispatchEvent(new CustomEvent("ghw:session-warning"));
      }
    }
    return response;
  },
  (err) => {
    if (err?.response?.status === 401) {
      // Clear token on hard 401 in app-shell paths
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
  saveSession(token, user) {
    localStorage.setItem("ghw_token", token);
    localStorage.setItem("ghw_user", JSON.stringify(user));
    updateLastActivity();
  },
  getUser() {
    const raw = localStorage.getItem("ghw_user");
    return raw ? JSON.parse(raw) : null;
  },
  getToken() { return localStorage.getItem("ghw_token"); },
  logout() {
    localStorage.removeItem("ghw_token");
    localStorage.removeItem("ghw_user");
    localStorage.removeItem(LAST_ACTIVITY_KEY);
    localStorage.removeItem(SESSION_WARNING_KEY);
  },
};
