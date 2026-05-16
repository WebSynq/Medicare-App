import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("ghw_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      // Optional: clear token on hard 401
      const path = window.location.pathname;
      if (path.startsWith("/dashboard") || path.startsWith("/leads") || path.startsWith("/audit") || path.startsWith("/admin")) {
        localStorage.removeItem("ghw_token");
        localStorage.removeItem("ghw_user");
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export const auth = {
  saveSession(token, user) {
    localStorage.setItem("ghw_token", token);
    localStorage.setItem("ghw_user", JSON.stringify(user));
  },
  getUser() {
    const raw = localStorage.getItem("ghw_user");
    return raw ? JSON.parse(raw) : null;
  },
  getToken() { return localStorage.getItem("ghw_token"); },
  logout() {
    localStorage.removeItem("ghw_token");
    localStorage.removeItem("ghw_user");
  },
};
