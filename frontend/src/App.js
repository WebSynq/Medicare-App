import { Toaster } from "@/components/ui/sonner";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "@/App.css";

import HomePortal from "@/pages/HomePortal";
import IntakeWizard from "@/pages/IntakeWizard";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import MfaSetup from "@/pages/MfaSetup";
import AgentDashboard from "@/pages/AgentDashboard";
import LeadDetail from "@/pages/LeadDetail";
import AuditLog from "@/pages/AuditLog";
import CompliancePanel from "@/pages/CompliancePanel";
import CommissionsDashboard from "@/pages/CommissionsDashboard";
import AdminCommissions from "@/pages/AdminCommissions";
import AccountingDashboard from "@/pages/AccountingDashboard";
import ApplicationSubmission from "@/pages/ApplicationSubmission";
import PrivacyPolicy from "@/pages/PrivacyPolicy";
import SecurityPage from "@/pages/SecurityPage";
import { auth } from "@/lib/api";
import { AppLayout } from "@/components/Layout";

function Protected({ children, roles, noLayout }) {
  const user = auth.getUser();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  if (noLayout) return children;
  return <AppLayout>{children}</AppLayout>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster richColors position="top-right" />
      <Routes>
        <Route path="/" element={<HomePortal />} />
        <Route path="/intake" element={<Protected noLayout><IntakeWizard /></Protected>} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/mfa-setup" element={<Protected noLayout><MfaSetup /></Protected>} />
        <Route path="/dashboard" element={<Protected><AgentDashboard /></Protected>} />
        <Route
          path="/commissions"
          element={
            <Protected>
              <CommissionsDashboard />
            </Protected>
          }
        />
        <Route path="/leads/:id" element={<Protected><LeadDetail /></Protected>} />
        <Route path="/applications" element={<Protected><ApplicationSubmission /></Protected>} />
        <Route path="/audit" element={<Protected roles={["admin","compliance"]}><AuditLog /></Protected>} />
        <Route path="/admin/compliance" element={<Protected roles={["admin","compliance"]}><CompliancePanel /></Protected>} />
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
            <Protected roles={["admin"]}>
              <AccountingDashboard />
            </Protected>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
