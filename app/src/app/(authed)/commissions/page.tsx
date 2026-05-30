"use client";

import { ImpersonationBanner } from "@/components/impersonation-banner";
import {
  LeaderboardPreview,
  LivePanel,
  SummaryCards,
} from "@/components/commissions/panels";

/**
 * Commissions · Overview tab. SummaryCards stretch the YTD totals
 * across the page header strip; LivePanel renders the ComTrack feed;
 * a Leaderboard preview rides the right rail so agents see where
 * they stack without leaving the tab.
 */
export default function CommissionsOverviewPage() {
  return (
    <div className="space-y-6">
      <ImpersonationBanner />

      <SummaryCards />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 md:gap-6">
        <div className="min-w-0">
          <LivePanel />
        </div>
        <div>
          <LeaderboardPreview />
        </div>
      </div>
    </div>
  );
}
