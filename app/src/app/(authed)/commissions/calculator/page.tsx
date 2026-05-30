"use client";

import { CommissionCalculator } from "@/components/commissions/calculator";

/**
 * Commissions · Calculator tab. Renders the standalone calculator
 * widget (no lead context) so agents can quickly model what a deal
 * would pay. The same component embeds in the client-profile
 * Policies tab with a leadId for in-flight estimates.
 */
export default function CommissionsCalculatorPage() {
  return (
    <div className="max-w-2xl">
      <CommissionCalculator />
    </div>
  );
}
