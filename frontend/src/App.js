import { Toaster } from "@/components/ui/sonner";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "@/App.css";

import HomePortal from "@/pages/HomePortal";
import IntakeWizard from "@/pages/IntakeWizard";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import SOAForm from "@/pages/SOAForm";
import BookingPage from "@/pages/BookingPage";
import MagicLinkVerify from "@/pages/MagicLinkVerify";
import MFAChallenge from "@/pages/MFAChallenge";
import AgentDashboard from "@/pages/AgentDashboard";
import TodayPage from "@/pages/TodayPage";
import AppointmentsList from "@/pages/AppointmentsList";
import Pipeline from "@/pages/Pipeline";
import ImportLeads from "@/pages/ImportLeads";
import CalendarPage from "@/pages/CalendarPage";
import LeadSourceReport from "@/pages/LeadSourceReport";
import LeadDetail from "@/pages/LeadDetail";
import CommissionsDashboard from "@/pages/CommissionsDashboard";
import AdminCommissions from "@/pages/AdminCommissions";
import AccountingDashboard from "@/pages/AccountingDashboard";
import ApplicationSubmission from "@/pages/ApplicationSubmission";
import Leaderboard from "@/pages/Leaderboard";
import ClientsList from "@/pages/ClientsList";
import ClientProfile from "@/pages/ClientProfile";
import DataImport from "@/pages/DataImport";
import AgentManagement from "@/pages/AgentManagement";
import AgencyAdmin from "@/pages/AgencyAdmin";
import BirthdayRule from "@/pages/BirthdayRule";
import RenewalCalendar from "@/pages/RenewalCalendar";
import Settings from "@/pages/Settings";
import PrivacyPolicy from "@/pages/PrivacyPolicy";
import SecurityPage from "@/pages/SecurityPage";
import AgencyCommandCenter from "@/pages/AgencyCommandCenter";
import { auth, COMMAND_CENTER_ROLES } from "@/lib/api";
import { AppLayout } from "@/components/Layout";
import { AgentProvider } from "@/context/AgentContext";
import { useEffect, useState } from "react";
import { installSessionManager, bumpActivity } from "@/lib/session";
import { toast } from "sonner";

// Compliance-bucket roles — see the same screens as legacy "compliance".
// Kept in sync with backend deps.COMPLIANCE_ROLES.
const COMPLIANCE_BUCKET = ["compliance", "cyber_security", "sales_manager"];

// Exact-role gate (no bucket expansion). Used for routes where the
// allowlist must match the backend's gate verbatim — e.g. the
// Agency Command Center, which intentionally excludes cyber_security
// from the compliance bucket.
function ProtectedExact({ children, roleSet, noLayout }) {
  const user = auth.getUser();
  if (!user) return <Navigate to="/login" replace />;
  if (!roleSet.has(user.role)) return <Navigate to="/today" replace />;
  if (noLayout) return children;
  return <AppLayout>{children}</AppLayout>;
}

/**
 * Idle-timeout warning modal — fires at 25 min, hard-logs out at 30 min
 * if no response. Mounted globally so every authenticated route gets
 * it. Visually minimal so it doesn't depend on shadcn primitives.
 */
function IdleTimeoutWarning({ msUntilLogout, onStay, onLogout }) {
  const [remaining, setRemaining] = useState(
    Math.max(0, Math.floor(msUntilLogout / 1000)),
  );
  useEffect(() => {
    const t = setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      data-testid="idle-timeout-warning"
    >
      <div style={{
        background: "#fff", borderRadius: 12, padding: 24,
        maxWidth: 380, width: "100%",
        boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
        fontFamily: `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`,
      }}>
        <h2 style={{ margin: 0, color: "#1B4332", fontSize: 18, fontWeight: 700 }}>
          You're about to be signed out
        </h2>
        <p style={{ color: "#4B5563", fontSize: 14, lineHeight: 1.5, marginTop: 8 }}>
          Your session will end in <strong>{mm}:{ss}</strong> due to inactivity.
        </p>
        <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
          <button onClick={onLogout}
                   style={{
                     flex: 1, padding: "10px 12px", borderRadius: 8,
                     border: "1px solid #E5E7EB", background: "#fff",
                     color: "#1F2937", fontWeight: 600, cursor: "pointer",
                   }}>
            Log out now
          </button>
          <button onClick={onStay}
                   style={{
                     flex: 1, padding: "10px 12px", borderRadius: 8,
                     border: "none", background: "#1B4332",
                     color: "#fff", fontWeight: 700, cursor: "pointer",
                   }}>
            Stay logged in
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Install the activity-driven session manager whenever there's a
 * logged-in user. Tears down on logout. Lives inside the Protected
 * wrapper so unauthenticated routes don't install timers.
 */
function useSessionLifecycle() {
  const [warning, setWarning] = useState(null);
  useEffect(() => {
    if (!auth.getUser()) return;
    const teardown = installSessionManager({
      onIdleWarning: (info) => setWarning(info),
      onIdleLogout: () => {
        try { auth.logout(); } catch { /* ignore */ }
        window.location.assign("/login");
      },
    });
    return teardown;
  }, []);
  return [warning, setWarning];
}

function Protected({ children, roles, forbid, noLayout }) {
  const user = auth.getUser();
  const [warning, setWarning] = useSessionLifecycle();
  if (!user) return <Navigate to="/login" replace />;
  // Expand "compliance" in route role lists to include the wider
  // compliance bucket so cyber_security/sales_manager hit the same set
  // of pages.
  const expanded = roles
    ? Array.from(
        new Set(
          roles.flatMap((r) => (r === "compliance" ? COMPLIANCE_BUCKET : [r])),
        ),
      )
    : null;
  if (expanded && !expanded.includes(user.role)) {
    return <Navigate to="/today" replace />;
  }
  // Inverse role gate. Lets us keep a route otherwise open while still
  // bouncing specific support roles (client_success) away from
  // revenue-shaped surfaces like /commissions and /leaderboard.
  if (forbid && forbid.includes(user.role)) {
    return <Navigate to="/today" replace />;
  }
  const inner = (
    <>
      {children}
      {warning && (
        <IdleTimeoutWarning
          msUntilLogout={warning.msUntilLogout}
          onStay={async () => {
            bumpActivity();
            try {
              const axios = (await import("axios")).default;
              const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
              await axios.post(`${BACKEND}/api/auth/refresh`, null, {
                withCredentials: true,
              });
            } catch { /* the SPA will 401 on next request */ }
            setWarning(null);
            toast.success("Welcome back");
          }}
          onLogout={() => {
            try { auth.logout(); } catch { /* ignore */ }
            window.location.assign("/login");
          }}
        />
      )}
    </>
  );
  if (noLayout) return inner;
  return <AppLayout>{inner}</AppLayout>;
}

export default function App() {
  return (
    <AgentProvider>
      <BrowserRouter>
        <Toaster richColors position="top-right" />
        <Routes>
        <Route path="/" element={<HomePortal />} />
        <Route path="/intake" element={<Protected noLayout><IntakeWizard /></Protected>} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/soa/:token" element={<SOAForm />} />
        {/* Public client-facing booking page. NO auth wrapper, NO
            AppLayout — designed for 65+ users hitting the link cold. */}
        <Route path="/book/:slug" element={<BookingPage />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/security" element={<SecurityPage />} />
        {/* Magic-link verification — public route. Reads ?token from
            the URL, exchanges for a session, then redirects to /today. */}
        <Route path="/auth/magic" element={<MagicLinkVerify />} />
        {/* MFA challenge — public route (user is mid-login).
            Reads session_token from location.state or ?st param. */}
        <Route path="/mfa" element={<MFAChallenge />} />
        <Route
          path="/agency-dashboard"
          element={
            <ProtectedExact roleSet={COMMAND_CENTER_ROLES}>
              <AgencyCommandCenter />
            </ProtectedExact>
          }
        />
        <Route path="/today" element={<Protected><TodayPage /></Protected>} />
        <Route path="/pipeline" element={<Protected><Pipeline /></Protected>} />
        <Route path="/import" element={<Protected><ImportLeads /></Protected>} />
        <Route path="/appointments" element={<Protected><AppointmentsList /></Protected>} />
        <Route path="/calendar" element={<Protected><CalendarPage /></Protected>} />
        <Route path="/reports/lead-sources" element={<Protected><LeadSourceReport /></Protected>} />
        <Route path="/dashboard" element={<Protected><AgentDashboard /></Protected>} />
        <Route
          path="/commissions"
          element={
            <Protected forbid={["client_success"]}>
              <CommissionsDashboard />
            </Protected>
          }
        />
        <Route path="/leads/:id" element={<Protected><LeadDetail /></Protected>} />
        <Route path="/clients" element={<Protected><ClientsList /></Protected>} />
        <Route path="/clients/:leadId" element={<Protected><ClientProfile /></Protected>} />
        {/* /leads exists as a parallel entry point to the client list so the
            mobile bottom-tab bar's "Leads" tab can NavLink-match its own URL
            independently of the "Clients" tab. Same page either way until we
            split out a dedicated leads-only view. */}
        <Route path="/leads" element={<Protected><ClientsList /></Protected>} />
        <Route path="/leaderboard" element={<Protected forbid={["client_success"]}><Leaderboard /></Protected>} />
        <Route path="/birthday-rule" element={<Protected><BirthdayRule /></Protected>} />
        <Route path="/renewals" element={<Protected><RenewalCalendar /></Protected>} />
        <Route path="/applications" element={<Protected><ApplicationSubmission /></Protected>} />
        {/* Audit Log + Compliance now live inside Settings. Old URLs
            redirect so existing bookmarks land on the right tab. */}
        <Route path="/audit" element={<Navigate to="/settings?tab=audit" replace />} />
        <Route path="/admin/compliance" element={<Navigate to="/settings?tab=compliance" replace />} />
        <Route
          path="/admin/commissions"
          element={
            <Protected roles={["admin", "owner", "compliance"]}>
              <AdminCommissions />
            </Protected>
          }
        />
        <Route
          path="/admin/accounting"
          element={
            <Protected roles={["admin", "owner", "compliance"]}>
              <AccountingDashboard />
            </Protected>
          }
        />
        <Route
          path="/admin/import"
          element={
            <Protected roles={["admin", "owner"]}>
              <DataImport />
            </Protected>
          }
        />
        <Route
          path="/agents"
          element={
            <Protected roles={["admin", "owner", "compliance"]}>
              <AgentManagement />
            </Protected>
          }
        />
        <Route
          path="/agency"
          element={
            <Protected roles={["admin", "owner"]}>
              <AgencyAdmin />
            </Protected>
          }
        />
        <Route
          path="/settings"
          element={
            <Protected>
              <Settings />
            </Protected>
          }
        />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AgentProvider>
  );
}
