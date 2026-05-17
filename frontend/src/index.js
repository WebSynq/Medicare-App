import * as Sentry from "@sentry/react";
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";

// ── Sentry error monitoring ───────────────────────────────────────────────
// sendDefaultPii: false — HIPAA compliance, no user data sent to Sentry
// beforeBreadcrumb — scrubs fetch/xhr payloads that might contain PHI
const _sentryDsn = process.env.REACT_APP_SENTRY_DSN;
if (_sentryDsn) {
  Sentry.init({
    dsn: _sentryDsn,
    environment: process.env.NODE_ENV || "production",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeBreadcrumb(breadcrumb) {
      // Strip request/response bodies from network breadcrumbs
      if (
        breadcrumb.category === "fetch" ||
        breadcrumb.category === "xhr"
      ) {
        if (breadcrumb.data) {
          delete breadcrumb.data.body;
          delete breadcrumb.data.response;
        }
      }
      return breadcrumb;
    },
  });
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

serviceWorkerRegistration.register({
  onUpdate: registration => {
    // When a new version is available, reload to get fresh content
    if (registration && registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      window.location.reload();
    }
  }
});
