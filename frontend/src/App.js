import { Toaster } from "@/components/ui/sonner";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "@/App.css";

import Landing from "@/pages/Landing";
import IntakeWizard from "@/pages/IntakeWizard";
import Login from "@/pages/Login";
import MfaSetup from "@/pages/MfaSetup";
import AgentDashboard from "@/pages/AgentDashboard";
import LeadDetail from "@/pages/LeadDetail";
import AuditLog from "@/pages/AuditLog";
import CompliancePanel from "@/pages/CompliancePanel";
import { auth } from "@/lib/api";

function Protected({ children, roles }) {
  const user = auth.getUser();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster richColors position="top-right" />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/intake" element={<IntakeWizard />} />
        <Route path="/login" element={<Login />} />
        <Route path="/mfa-setup" element={<Protected><MfaSetup /></Protected>} />
        <Route path="/dashboard" element={<Protected><AgentDashboard /></Protected>} />
        <Route path="/leads/:id" element={<Protected><LeadDetail /></Protected>} />
        <Route path="/audit" element={<Protected roles={["admin","compliance"]}><AuditLog /></Protected>} />
        <Route path="/admin/compliance" element={<Protected roles={["admin","compliance"]}><CompliancePanel /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
