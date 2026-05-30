"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CheckSquare,
  ChevronRight,
  FileText,
  Inbox,
  Loader2,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  StickyNote,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { isApiError, leads as leadsApi } from "@/lib/api";
import type { Lead, LeadStatus } from "@/types";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { OutcomeButtonsRow } from "@/components/clients/outcome-buttons";
import { OverviewTab } from "@/components/clients/tabs/overview";
import { CnaTab } from "@/components/clients/tabs/cna";
import { DocumentsTab } from "@/components/clients/tabs/documents";
import { SoaTab } from "@/components/clients/tabs/soa";
import { PoliciesTab } from "@/components/clients/tabs/policies";
import { NotesTab } from "@/components/clients/tabs/notes";

// ─── Status badge map (shared with the list table) ─────────────────────────

const STATUS_BADGE: Record<LeadStatus, string> = {
  new: "bg-primary/15 text-primary ring-primary/30",
  contacted: "bg-chart-4/15 text-chart-4 ring-chart-4/30",
  qualified: "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30",
  appointment_set: "bg-ghw-copper/20 text-ghw-copper ring-ghw-copper/30",
  enrolled: "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30",
  lost: "bg-muted text-muted-foreground ring-border",
  not_interested: "bg-muted text-muted-foreground ring-border",
  do_not_contact: "bg-destructive/15 text-destructive ring-destructive/30",
};

function scoreTint(score: number | null): string {
  if (score == null) return "bg-muted text-muted-foreground ring-border";
  if (score >= 70) return "bg-ghw-forest/15 text-ghw-forest ring-ghw-forest/30";
  if (score >= 40)
    return "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30";
  return "bg-destructive/15 text-destructive ring-destructive/30";
}

function leadFullName(l: Lead): string {
  const name = `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim();
  return name || l.email || "Unknown";
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

type TabId =
  | "overview"
  | "cna"
  | "documents"
  | "soa"
  | "policies"
  | "notes";

const TABS: { id: TabId; label: string; icon: typeof Mail }[] = [
  { id: "overview", label: "Overview", icon: StickyNote },
  { id: "cna", label: "CNA", icon: CheckSquare },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "soa", label: "SOA", icon: ShieldCheck },
  { id: "policies", label: "Policies", icon: Wallet },
  { id: "notes", label: "Notes & Tasks", icon: CheckCircle2 },
];

// ─── Page ──────────────────────────────────────────────────────────────────

export default function ClientProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const leadId = params?.id ?? "";

  const leadQuery = useQuery<Lead>({
    queryKey: ["lead", leadId],
    queryFn: () => leadsApi.getLead(leadId),
    enabled: !!leadId,
  });

  const [activeTab, setActiveTab] = React.useState<TabId>("overview");

  // 404
  if (leadQuery.isError && isApiError(leadQuery.error) && leadQuery.error.status === 404) {
    return <NotFoundCard onBack={() => router.push("/clients")} />;
  }

  // Hard load while we have nothing to render
  if (leadQuery.isLoading || !leadQuery.data) {
    return <PageLoadingShell />;
  }

  const lead = leadQuery.data;

  return (
    <div className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <PageHeader lead={lead} />
      <ImpersonationBanner />
      <OutcomeButtonsRow leadId={lead.id} />

      {/* Mobile tab select */}
      <div className="md:hidden mt-4 mb-3">
        <Select value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TABS.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabId)}
        className="mt-4"
      >
        <TabsList className="hidden md:flex">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon className="h-3.5 w-3.5 mr-1.5" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-5">
          <OverviewTab lead={lead} onLeadChanged={() => leadQuery.refetch()} />
        </TabsContent>
        <TabsContent value="cna" className="mt-5">
          <CnaTab leadId={lead.id} />
        </TabsContent>
        <TabsContent value="documents" className="mt-5">
          <DocumentsTab leadId={lead.id} />
        </TabsContent>
        <TabsContent value="soa" className="mt-5">
          <SoaTab leadId={lead.id} />
        </TabsContent>
        <TabsContent value="policies" className="mt-5">
          <PoliciesTab lead={lead} />
        </TabsContent>
        <TabsContent value="notes" className="mt-5">
          <NotesTab leadId={lead.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Page header ───────────────────────────────────────────────────────────

function PageHeader({ lead }: { lead: Lead }) {
  const fullName = leadFullName(lead);

  return (
    <div>
      {/* Breadcrumb */}
      <Breadcrumb className="mb-3">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/clients">Clients</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>
            <ChevronRight className="h-3.5 w-3.5" />
          </BreadcrumbSeparator>
          <BreadcrumbItem>
            <BreadcrumbPage className="truncate max-w-[260px]">
              {fullName}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Identity row */}
      <div className="flex items-start gap-4 flex-wrap">
        {/* AI Score ring */}
        <div
          className={cn(
            "flex flex-col items-center justify-center w-16 h-16 rounded-full ring-2 flex-shrink-0",
            scoreTint(lead.ai_score),
          )}
          title={lead.ai_score_reason ?? undefined}
        >
          <span className="text-lg font-bold tabular-nums">
            {lead.ai_score ?? "—"}
          </span>
          <span className="text-[9px] uppercase tracking-widest text-muted-foreground -mt-0.5">
            AI
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-display">
            {fullName}
          </h1>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap text-sm">
            <span
              className={cn(
                "inline-flex items-center text-[10px] font-semibold uppercase tracking-wider rounded-full px-2 py-0.5 ring-1 capitalize",
                STATUS_BADGE[lead.status],
              )}
            >
              {lead.status.replace(/_/g, " ")}
            </span>
            {lead.lead_source ? (
              <Badge variant="outline" className="text-[10px]">
                Source: {lead.lead_source}
              </Badge>
            ) : null}
            {lead.state ? (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {lead.state}
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
            {lead.phone ? (
              <a
                href={`tel:${lead.phone}`}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <Phone className="h-3 w-3" />
                <span className="tabular-nums">{lead.phone}</span>
              </a>
            ) : null}
            {lead.email ? (
              <a
                href={`mailto:${lead.email}`}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <Mail className="h-3 w-3" />
                {lead.email}
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── States ────────────────────────────────────────────────────────────────

function PageLoadingShell() {
  return (
    <div className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <Skeleton className="h-4 w-32 mb-3" />
      <div className="flex items-start gap-4 flex-wrap">
        <Skeleton className="h-16 w-16 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-72" />
        </div>
      </div>
      <div className="mt-8 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">Loading client…</span>
      </div>
    </div>
  );
}

function NotFoundCard({ onBack }: { onBack: () => void }) {
  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto">
      <Card>
        <CardContent className="p-10 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium text-sm">Client not found.</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            This lead has been deleted or you don&apos;t have access to it.
          </p>
          <Button onClick={onBack} className="mt-4">
            Back to Clients
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

