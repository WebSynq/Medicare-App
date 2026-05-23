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
import MfaSetup from "@/pages/MfaSetup";
import AgentDashboard from "@/pages/AgentDashboard";
import TodayPage from "@/pages/TodayPage";
import AppointmentsList from "@/pages/AppointmentsList";
import Pipeline from "@/pages/Pipeline";
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
import { auth } from "@/lib/api";
import { AppLayout } from "@/components/Layout";
import { AgentProvider } from "@/context/AgentContext";

// Compliance-bucket roles — see the same screens as legacy "compliance".
// Kept in sync with backend deps.COMPLIANCE_ROLES.
const COMPLIANCE_BUCKET = ["compliance", "cyber_security", "sales_manager"];

function Protected({ children, roles, forbid, noLayout }) {
  const user = auth.getUser();
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
  if (noLayout) return children;
  return <AppLayout>{children}</AppLayout>;
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
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/mfa-setup" element={<Protected noLayout><MfaSetup /></Protected>} />
        <Route path="/today" element={<Protected><TodayPage /></Protected>} />
        <Route path="/pipeline" element={<Protected><Pipeline /></Protected>} />
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
            <Protected roles={["admin", "compliance"]}>
              <AdminCommissions />
            </Protected>
          }
        />
        <Route
          path="/admin/accounting"
          element={
            <Protected roles={["admin", "compliance"]}>
              <AccountingDashboard />
            </Protected>
          }
        />
        <Route
          path="/admin/import"
          element={
            <Protected roles={["admin"]}>
              <DataImport />
            </Protected>
          }
        />
        <Route
          path="/agents"
          element={
            <Protected roles={["admin", "compliance"]}>
              <AgentManagement />
            </Protected>
          }
        />
        <Route
          path="/agency"
          element={
            <Protected roles={["admin"]}>
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
