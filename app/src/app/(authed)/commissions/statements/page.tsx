"use client";

import { ImpersonationBanner } from "@/components/impersonation-banner";
import {
  HistoryPanel,
  UploadCard,
} from "@/components/commissions/panels";

/**
 * Commissions · Statements tab. Upload card up top, then the table
 * of past statement uploads with status badges and totals.
 */
export default function CommissionsStatementsPage() {
  return (
    <div className="space-y-6">
      <ImpersonationBanner />
      <UploadCard />
      <HistoryPanel />
    </div>
  );
}
