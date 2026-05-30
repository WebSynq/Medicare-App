"use client";

/**
 * Accounting page — Financial Command Center.
 *
 * 5 tabs (Overview / Ledger / Carriers / Disputes / Statements) +
 * a CFO chat side panel. Role-gated on the client to match the
 * backend's `require_roles(COMPLIANCE_ROLES)` — admin, owner,
 * compliance, and accounting see the page; everyone else gets
 * bounced back to /dashboard.
 *
 * Tabs are state, not URL segments, so cross-tab handoffs
 * (carrier donut → ledger pre-filtered, carrier card → disputes
 * modal pre-opened) work without router round-trips.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  Brain,
  Building2,
  ClipboardList,
  FileSpreadsheet,
  Gavel,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores";
import type { UserRole } from "@/types";

import { OverviewTab } from "./_overview-tab";
import { LedgerTab } from "./_ledger-tab";
import { CarriersTab } from "./_carriers-tab";
import { DisputesTab } from "./_disputes-tab";
import { StatementsTab } from "./_statements-tab";
import { CFOChat } from "./_cfo-chat";
import type { AccountingPeriod } from "@/lib/api/accounting";

/** Mirrors the backend `deps.COMPLIANCE_ROLES` list. The /accounting
 *  endpoints all require_roles(*COMPLIANCE_ROLES), so the page mirrors
 *  that gate client-side: anyone in this set sees the dashboard,
 *  everyone else gets routed away. */
const ACCOUNTING_ROLES: readonly UserRole[] = [
  "admin",
  "owner",
  "compliance",
  "accounting",
] as const;

type TabValue = "overview" | "ledger" | "carriers" | "disputes" | "statements";

export default function AccountingPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const role = useAuthStore((s) => s.user?.role ?? null);
  const isSuperAdmin = useAuthStore((s) => s.user?.super_admin ?? false);

  const canSee =
    isSuperAdmin || (role !== null && ACCOUNTING_ROLES.includes(role));

  // Bounce off-role users to /dashboard. Wait for auth hydration
  // before deciding — status === "unknown" means /api/auth/me is
  // still in flight from the layout mount.
  React.useEffect(() => {
    if (status === "anon") {
      router.replace("/login");
      return;
    }
    if (status === "authed" && !canSee) {
      router.replace("/dashboard");
    }
  }, [status, canSee, router]);

  // Tab state. Local state, not URL — cross-tab handoffs (Overview
  // donut click → Ledger pre-filtered; Carriers card → Disputes
  // modal pre-opened) work cleanly without router churn.
  const [tab, setTab] = React.useState<TabValue>("overview");
  const [cfoOpen, setCfoOpen] = React.useState(false);
  const [period, setPeriod] = React.useState<AccountingPeriod>("mtd");
  const [carrierFilter, setCarrierFilter] = React.useState("");
  const [forceCreateDispute, setForceCreateDispute] = React.useState(false);

  function focusCarrierInLedger(carrier: string) {
    setCarrierFilter(carrier);
    setTab("ledger");
  }

  function openCreateDisputeFromCarriers() {
    setForceCreateDispute(true);
    setTab("disputes");
  }

  // Show a quiet placeholder until the auth state resolves; the
  // useEffect above will redirect off-role users.
  if (status === "unknown") {
    return null;
  }
  if (!canSee) {
    return null;
  }

  return (
    <div
      className={cn(
        "p-6 md:p-8 transition-all",
        cfoOpen && "md:pr-[420px]",
      )}
    >
      <div className="max-w-[1500px] mx-auto w-full">
        {/* Header */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Banknote className="w-4 h-4 text-primary" />
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Accounting
              </p>
            </div>
            <h1
              className="text-2xl font-bold tracking-tight font-display"
              data-testid="accounting-title"
            >
              Financial Command Center
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Live commission reconciliation, carrier collections, and
              dispute management.
            </p>
          </div>
          <Button
            onClick={() => setCfoOpen((v) => !v)}
            data-testid="open-cfo"
          >
            <Brain className="w-4 h-4 mr-2" />
            {cfoOpen ? "Close CFO" : "Ask CFO AI"}
            <Badge
              variant="outline"
              className="ml-2 text-[9px] uppercase border-primary-foreground/40 text-primary-foreground/85"
            >
              Bedrock
            </Badge>
          </Button>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList className="mb-4 flex flex-wrap">
            <TabsTrigger value="overview" data-testid="tab-overview">
              <TrendingUp className="w-3.5 h-3.5 mr-1.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="ledger" data-testid="tab-ledger">
              <ClipboardList className="w-3.5 h-3.5 mr-1.5" /> Ledger
            </TabsTrigger>
            <TabsTrigger value="carriers" data-testid="tab-carriers">
              <Building2 className="w-3.5 h-3.5 mr-1.5" /> Carriers
            </TabsTrigger>
            <TabsTrigger value="disputes" data-testid="tab-disputes">
              <Gavel className="w-3.5 h-3.5 mr-1.5" /> Disputes
            </TabsTrigger>
            <TabsTrigger value="statements" data-testid="tab-statements">
              <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" /> Statements
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab
              period={period}
              setPeriod={setPeriod}
              onCarrierClick={focusCarrierInLedger}
              onJumpDisputes={() => setTab("disputes")}
            />
          </TabsContent>
          <TabsContent value="ledger">
            <LedgerTab
              carrierFilter={carrierFilter}
              setCarrierFilter={setCarrierFilter}
            />
          </TabsContent>
          <TabsContent value="carriers">
            <CarriersTab
              onViewLedger={focusCarrierInLedger}
              onCreateDispute={openCreateDisputeFromCarriers}
            />
          </TabsContent>
          <TabsContent value="disputes">
            <DisputesTab
              forceCreateOpen={forceCreateDispute}
              onCreateOpened={() => setForceCreateDispute(false)}
            />
          </TabsContent>
          <TabsContent value="statements">
            <StatementsTab />
          </TabsContent>
        </Tabs>
      </div>

      <CFOChat open={cfoOpen} onClose={() => setCfoOpen(false)} />
    </div>
  );
}
