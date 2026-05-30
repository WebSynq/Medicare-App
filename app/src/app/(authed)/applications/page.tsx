"use client";

import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calculator,
  CheckCircle2,
  FileSearch,
  FileText,
  Loader2,
  Search,
  Send,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  applications as applicationsApi,
  isApiError,
  leads as leadsApi,
} from "@/lib/api";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import type { ExtractResponse, GhlContact, SupportingDoc } from "@/lib/api/applications";
import type { Lead } from "@/types";

// ─── Wizard state ──────────────────────────────────────────────────────────

interface ContactRef {
  contact_id: string; // GHL contact id (or new local id)
  lead_id: string | null;
  contact_name: string;
  first_name?: string;
  last_name?: string;
  email?: string | null;
  phone?: string | null;
  // "Existing" client never re-runs extract; the extracted dict
  // accumulates from the carrier-app upload at Step 1.
}

const SUPPORTING_LABELS = [
  "SOA",
  "Election Notice",
  "EFT Form",
  "PHI Auth",
  "ID Copy",
  "Prescription List",
  "Agent Attestation",
  "Other",
];

const STEPS = [
  { key: "step1", label: "Client + App" },
  { key: "step2", label: "Supporting docs" },
  { key: "step3", label: "Review & submit" },
] as const;

// ─── Outer Suspense wrapper for useSearchParams ────────────────────────────

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ApplicationsWizard />
    </Suspense>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

// ─── Wizard root ───────────────────────────────────────────────────────────

function ApplicationsWizard() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectLeadId = search.get("lead_id");

  const [step, setStep] = React.useState<0 | 1 | 2>(0);
  const [contact, setContact] = React.useState<ContactRef | null>(null);
  const [extract, setExtract] = React.useState<ExtractResponse | null>(null);
  const [extractedDraft, setExtractedDraft] = React.useState<
    Record<string, string>
  >({});
  const [supporting, setSupporting] = React.useState<SupportingDoc[]>([]);

  // If we landed here from an Outcome=Sold redirect, pre-pick the client.
  const preselectQuery = useQuery({
    queryKey: ["leads", "by-id", preselectLeadId],
    queryFn: () => leadsApi.getLead(preselectLeadId!),
    enabled: !!preselectLeadId && !contact,
  });

  React.useEffect(() => {
    if (preselectQuery.data && !contact) {
      const lead = preselectQuery.data;
      setContact({
        contact_id: lead.id,
        lead_id: lead.id,
        contact_name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
        first_name: lead.first_name ?? "",
        last_name: lead.last_name ?? "",
        email: lead.email,
        phone: lead.phone,
      });
    }
  }, [preselectQuery.data, contact]);

  function resetWizard() {
    setStep(0);
    setContact(null);
    setExtract(null);
    setExtractedDraft({});
    setSupporting([]);
    router.replace("/applications");
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Submit application
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Three steps: pick the client + extract the app, attach supporting
            docs, review and submit.
          </p>
        </div>
        {step > 0 ? (
          <Button variant="ghost" size="sm" onClick={resetWizard}>
            <X className="h-3.5 w-3.5 mr-1.5" />
            Start over
          </Button>
        ) : null}
      </header>

      <ImpersonationBanner />

      <StepBar current={step} />

      {step === 0 ? (
        <Step1ClientAndApp
          contact={contact}
          setContact={setContact}
          extract={extract}
          setExtract={setExtract}
          extractedDraft={extractedDraft}
          setExtractedDraft={setExtractedDraft}
          onNext={() => setStep(1)}
        />
      ) : step === 1 ? (
        <Step2Supporting
          contact={contact}
          supporting={supporting}
          setSupporting={setSupporting}
          onBack={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      ) : (
        <Step3Review
          contact={contact!}
          extract={extract}
          extractedDraft={extractedDraft}
          supporting={supporting}
          onBack={() => setStep(1)}
          onSubmitted={(result) => {
            toast.success("Application submitted.");
            router.push(`/clients/${result.lead_id}`);
          }}
        />
      )}
    </div>
  );
}

// ─── Step bar ──────────────────────────────────────────────────────────────

function StepBar({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const isActive = i === current;
        const isDone = i < current;
        return (
          <li key={s.key} className="flex items-center flex-1 min-w-0">
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isDone
                    ? "bg-ghw-forest/15 text-ghw-forest"
                    : "bg-secondary text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "h-5 w-5 rounded-full flex items-center justify-center text-[10px]",
                  isActive
                    ? "bg-primary-foreground/20"
                    : isDone
                      ? "bg-ghw-forest/30"
                      : "bg-background/60",
                )}
              >
                {isDone ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
              </span>
              {s.label}
            </div>
            {i < STEPS.length - 1 ? (
              <div className="h-px flex-1 bg-border mx-2" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Step 1 — Client + App ─────────────────────────────────────────────────

function Step1ClientAndApp({
  contact,
  setContact,
  extract,
  setExtract,
  extractedDraft,
  setExtractedDraft,
  onNext,
}: {
  contact: ContactRef | null;
  setContact: (c: ContactRef | null) => void;
  extract: ExtractResponse | null;
  setExtract: (e: ExtractResponse | null) => void;
  extractedDraft: Record<string, string>;
  setExtractedDraft: (
    next:
      | Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  onNext: () => void;
}) {
  const [mode, setMode] = React.useState<"new" | "existing">(
    contact ? "existing" : "new",
  );

  return (
    <Card>
      <CardContent className="p-5 md:p-6 space-y-5">
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={mode === "new" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("new")}
          >
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            New client
          </Button>
          <Button
            variant={mode === "existing" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("existing")}
          >
            <Users className="h-3.5 w-3.5 mr-1.5" />
            Existing client
          </Button>
        </div>

        {mode === "new" ? (
          <NewClientMode
            extract={extract}
            setExtract={setExtract}
            extractedDraft={extractedDraft}
            setExtractedDraft={setExtractedDraft}
            contact={contact}
            setContact={setContact}
          />
        ) : (
          <ExistingClientMode
            contact={contact}
            setContact={setContact}
            extract={extract}
            setExtract={setExtract}
            extractedDraft={extractedDraft}
            setExtractedDraft={setExtractedDraft}
          />
        )}

        <div className="flex justify-end pt-4 border-t border-border">
          <Button onClick={onNext} disabled={!contact || !extract}>
            Next: supporting docs
            <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── New client mode ──

function NewClientMode({
  extract,
  setExtract,
  extractedDraft,
  setExtractedDraft,
  contact,
  setContact,
}: {
  extract: ExtractResponse | null;
  setExtract: (e: ExtractResponse | null) => void;
  extractedDraft: Record<string, string>;
  setExtractedDraft: (
    next:
      | Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  contact: ContactRef | null;
  setContact: (c: ContactRef | null) => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);

  const extractMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("no file");
      return applicationsApi.extractApplication(file);
    },
    onSuccess: (data) => {
      setExtract(data);
      const seed: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.extracted)) {
        seed[k] = v == null ? "" : String(v);
      }
      setExtractedDraft(seed);
      toast.success(
        `Extracted ${data.field_count} fields from a ${data.product_label}.`,
      );
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Extraction failed."),
  });

  const createLeadMutation = useMutation({
    mutationFn: () => {
      const ex = extractedDraft;
      return leadsApi.createLead({
        first_name: ex.first_name ?? "",
        last_name: ex.last_name ?? "",
        email: ex.email,
        phone: ex.phone,
        state: ex.state,
        date_of_birth: ex.date_of_birth ?? ex.dob,
        lead_source: "application",
      });
    },
    onSuccess: (lead: Lead) => {
      setContact({
        contact_id: lead.id,
        lead_id: lead.id,
        contact_name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
        first_name: lead.first_name ?? "",
        last_name: lead.last_name ?? "",
        email: lead.email,
        phone: lead.phone,
      });
      toast.success("Lead created. Continue to supporting docs.");
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Couldn't create lead."),
  });

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setFile(f);
    e.target.value = "";
  }

  return (
    <div className="space-y-4">
      {!extract ? (
        <div className="rounded-md border-2 border-dashed border-border p-6 text-center space-y-3">
          <FileSearch className="h-10 w-10 text-muted-foreground mx-auto" />
          <div>
            <p className="font-medium text-sm">Upload the carrier app PDF</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              We&apos;ll auto-extract identity, plan, and contact fields
              with Claude via Bedrock. PDFs only, max 10 MB.
            </p>
          </div>
          <Input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={onFilePicked}
            className="hidden"
          />
          {file ? (
            <div className="space-y-2">
              <p className="text-xs">
                <span className="font-medium">{file.name}</span>{" "}
                <span className="text-muted-foreground">
                  ({Math.round(file.size / 1024)} KB)
                </span>
              </p>
              <Button
                onClick={() => extractMutation.mutate()}
                disabled={extractMutation.isPending}
              >
                {extractMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                )}
                Extract fields
              </Button>
            </div>
          ) : (
            <Button onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Pick PDF
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Extracted fields
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {extract.product_label}{" "}
                {extract.auto_detected ? (
                  <Badge
                    variant="outline"
                    className="ml-1 text-[10px] bg-primary/10 text-primary border-primary/30"
                  >
                    auto-detected
                  </Badge>
                ) : null}{" "}
                · {extract.field_count} non-empty fields
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setExtract(null);
                setExtractedDraft({});
                setFile(null);
              }}
              className="text-xs"
            >
              Re-extract
            </Button>
          </div>

          <FieldsGrid
            extract={extract}
            draft={extractedDraft}
            onChange={setExtractedDraft}
          />

          {!contact ? (
            <div className="rounded-md bg-primary/5 border border-primary/20 p-4 space-y-2">
              <p className="text-xs">
                Confirm the extracted fields above, then create the lead.
              </p>
              <Button
                onClick={() => createLeadMutation.mutate()}
                disabled={
                  !extractedDraft.first_name ||
                  !extractedDraft.last_name ||
                  createLeadMutation.isPending
                }
                size="sm"
              >
                {createLeadMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                )}
                Create lead from extracted fields
              </Button>
            </div>
          ) : (
            <ContactSummary contact={contact} />
          )}
        </>
      )}
    </div>
  );
}

// ── Existing client mode ──

function ExistingClientMode({
  contact,
  setContact,
  extract,
  setExtract,
  extractedDraft,
  setExtractedDraft,
}: {
  contact: ContactRef | null;
  setContact: (c: ContactRef | null) => void;
  extract: ExtractResponse | null;
  setExtract: (e: ExtractResponse | null) => void;
  extractedDraft: Record<string, string>;
  setExtractedDraft: (
    next:
      | Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
}) {
  return (
    <div className="space-y-4">
      {contact ? (
        <ContactSummary
          contact={contact}
          onClear={() => {
            setContact(null);
            setExtract(null);
            setExtractedDraft({});
          }}
        />
      ) : (
        <LeadSearch
          onSelect={(lead) =>
            setContact({
              contact_id: lead.id,
              lead_id: lead.id,
              contact_name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
              first_name: lead.first_name ?? "",
              last_name: lead.last_name ?? "",
              email: lead.email,
              phone: lead.phone,
            })
          }
        />
      )}

      {contact ? (
        <ExtractCard
          extract={extract}
          setExtract={setExtract}
          extractedDraft={extractedDraft}
          setExtractedDraft={setExtractedDraft}
        />
      ) : null}
    </div>
  );
}

function LeadSearch({ onSelect }: { onSelect: (lead: Lead) => void }) {
  const [q, setQ] = React.useState("");
  const debounced = useDebouncedValue(q, 250);
  const leadsQ = useQuery({
    queryKey: ["leads", "appsearch", debounced],
    queryFn: () => leadsApi.listLeads({ q: debounced, limit: 12 }),
    enabled: debounced.trim().length > 1,
  });
  const ghlQ = useQuery({
    queryKey: ["ghl-contacts", debounced],
    queryFn: () => applicationsApi.searchContacts(debounced),
    enabled: debounced.trim().length > 1,
    retry: false,
  });

  const portalLeads = leadsQ.data?.leads ?? [];
  const ghlContacts: GhlContact[] = ghlQ.data ?? [];
  const portalIds = new Set(portalLeads.map((l) => l.id));
  const ghlOnly = ghlContacts.filter(
    (c) => !c.lead_id || !portalIds.has(c.lead_id),
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email, or phone (also pulls from GHL)"
          className="pl-9"
        />
      </div>

      {debounced.trim().length < 2 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          Type at least 2 characters to search.
        </p>
      ) : leadsQ.isFetching || ghlQ.isFetching ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : portalLeads.length === 0 && ghlOnly.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          No matches.
        </p>
      ) : (
        <ul className="space-y-1 max-h-80 overflow-y-auto">
          {portalLeads.map((lead) => (
            <li key={lead.id}>
              <button
                onClick={() => onSelect(lead)}
                className="w-full text-left px-3 py-2 rounded-md border border-border/40 hover:bg-secondary/50 text-sm flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {lead.first_name} {lead.last_name}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {lead.email || lead.phone || "—"}
                  </p>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  Portal
                </Badge>
              </button>
            </li>
          ))}
          {ghlOnly.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => {
                  // GHL search auto-imports to the portal, so c.lead_id
                  // should be present. Fall back to GHL id if not.
                  onSelect({
                    id: c.lead_id ?? c.id,
                    first_name: c.first_name ?? "",
                    last_name: c.last_name ?? "",
                    email: c.email ?? null,
                    phone: c.phone ?? null,
                  } as Lead);
                }}
                className="w-full text-left px-3 py-2 rounded-md border border-border/40 hover:bg-secondary/50 text-sm flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {c.first_name} {c.last_name}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {c.email || c.phone || "—"}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="text-[10px] bg-chart-4/15 text-chart-4 border-chart-4/30"
                >
                  GHL
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExtractCard({
  extract,
  setExtract,
  extractedDraft,
  setExtractedDraft,
}: {
  extract: ExtractResponse | null;
  setExtract: (e: ExtractResponse | null) => void;
  extractedDraft: Record<string, string>;
  setExtractedDraft: (
    next:
      | Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);

  const extractMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("no file");
      return applicationsApi.extractApplication(file);
    },
    onSuccess: (data) => {
      setExtract(data);
      const seed: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.extracted)) {
        seed[k] = v == null ? "" : String(v);
      }
      setExtractedDraft(seed);
      toast.success(`Extracted ${data.field_count} fields.`);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Extraction failed."),
  });

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setFile(f);
    e.target.value = "";
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border/60 p-4 flex flex-wrap items-center gap-3">
        <FileText className="h-4 w-4 text-primary" />
        <p className="text-sm font-medium mr-auto">
          Upload the carrier app PDF
        </p>
        <Input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          onChange={onFilePicked}
          className="hidden"
        />
        {file ? (
          <span className="text-xs truncate max-w-[180px]">{file.name}</span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
        >
          {file ? "Replace" : "Pick PDF"}
        </Button>
        <Button
          size="sm"
          onClick={() => extractMutation.mutate()}
          disabled={!file || extractMutation.isPending}
        >
          {extractMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          )}
          Extract
        </Button>
      </div>

      {extract ? (
        <FieldsGrid
          extract={extract}
          draft={extractedDraft}
          onChange={setExtractedDraft}
        />
      ) : null}
    </div>
  );
}

// ── Shared bits ──

function FieldsGrid({
  extract,
  draft,
  onChange,
}: {
  extract: ExtractResponse;
  draft: Record<string, string>;
  onChange: (
    next:
      | Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
}) {
  const fields = extract.fields_available;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {fields.map((key) => {
        const value = draft[key] ?? "";
        const confidence = extract.main_confidences[key];
        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between">
              <Label
                htmlFor={`field-${key}`}
                className="text-[11px] text-muted-foreground"
              >
                {key.replace(/_/g, " ")}
              </Label>
              {confidence != null ? (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[9px] h-4",
                    confidence >= 0.8
                      ? "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
                      : confidence >= 0.5
                        ? "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
                        : "bg-destructive/15 text-destructive border-destructive/30",
                  )}
                >
                  {Math.round(confidence * 100)}%
                </Badge>
              ) : null}
            </div>
            <Input
              id={`field-${key}`}
              value={value}
              onChange={(e) =>
                onChange((p) => ({ ...p, [key]: e.target.value }))
              }
              className={cn(
                confidence != null && confidence < 0.5 && "ring-1 ring-destructive/30",
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

function ContactSummary({
  contact,
  onClear,
}: {
  contact: ContactRef;
  onClear?: () => void;
}) {
  return (
    <div className="rounded-md bg-secondary/40 p-3 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-semibold text-sm">{contact.contact_name}</p>
        <p className="text-[11px] text-muted-foreground truncate">
          {contact.email || contact.phone || contact.contact_id}
        </p>
      </div>
      {onClear ? (
        <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
          Change
        </Button>
      ) : null}
    </div>
  );
}

// ─── Step 2 — Supporting documents ─────────────────────────────────────────

function Step2Supporting({
  contact,
  supporting,
  setSupporting,
  onBack,
  onNext,
}: {
  contact: ContactRef | null;
  supporting: SupportingDoc[];
  setSupporting: (
    next: SupportingDoc[] | ((prev: SupportingDoc[]) => SupportingDoc[]),
  ) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [pending, setPending] = React.useState<{ file: File; label: string }[]>(
    [],
  );

  const uploadMutation = useMutation({
    mutationFn: () => {
      if (pending.length === 0) throw new Error("no files");
      return applicationsApi.uploadSupporting(
        pending.map((p) => p.file),
        pending.map((p) => p.label),
        contact?.contact_id,
      );
    },
    onSuccess: (data) => {
      setSupporting((prev) => [...prev, ...data.uploaded]);
      setPending([]);
      toast.success(
        `Uploaded ${data.uploaded.length} supporting document${data.uploaded.length === 1 ? "" : "s"}.`,
      );
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Upload failed."),
  });

  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      setPending((p) => [
        ...p,
        ...files.map((f) => ({ file: f, label: "Other" })),
      ]);
    }
    e.target.value = "";
  }

  function removePending(i: number) {
    setPending((p) => p.filter((_, j) => j !== i));
  }

  function setLabel(i: number, label: string) {
    setPending((p) => p.map((row, j) => (j === i ? { ...row, label } : row)));
  }

  function removeUploaded(s3Key: string) {
    setSupporting((prev) => prev.filter((d) => d.s3_key !== s3Key));
  }

  return (
    <Card>
      <CardContent className="p-5 md:p-6 space-y-5">
        <div>
          <h3 className="text-sm font-semibold">Supporting documents</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Attach SOA, EFT authorization, ID copies, and anything else the
            carrier requires. Up to 9 docs, 10 MB each, 50 MB total.
            PDF / JPG / PNG.
          </p>
        </div>

        {/* Pending queue */}
        {pending.length > 0 ? (
          <ul className="space-y-2">
            {pending.map((row, i) => (
              <li
                key={i}
                className="flex items-center gap-2 p-2 rounded-md border border-dashed border-border/60"
              >
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{row.file.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {Math.round(row.file.size / 1024)} KB
                  </p>
                </div>
                <Select
                  value={row.label}
                  onValueChange={(v) => setLabel(i, v)}
                >
                  <SelectTrigger className="w-[140px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTING_LABELS.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removePending(i)}
                  className="h-7 w-7 p-0 text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-2 flex-wrap">
          <Input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={onFilesPicked}
            className="hidden"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Add file{pending.length > 0 ? "s" : ""}
          </Button>
          {pending.length > 0 ? (
            <Button
              size="sm"
              onClick={() => uploadMutation.mutate()}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5 mr-1.5" />
              )}
              Upload {pending.length} pending
            </Button>
          ) : null}
        </div>

        {/* Already uploaded */}
        {supporting.length > 0 ? (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Uploaded ({supporting.length})
            </p>
            <ul className="space-y-1.5">
              {supporting.map((d) => (
                <li
                  key={d.s3_key}
                  className="flex items-center gap-2 p-2 rounded-md bg-secondary/40"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-ghw-forest flex-shrink-0" />
                  <Badge
                    variant="outline"
                    className="text-[10px] bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
                  >
                    {d.file_label}
                  </Badge>
                  <span className="text-sm truncate flex-1 min-w-0">
                    {d.filename}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {Math.round(d.size_bytes / 1024)} KB
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeUploaded(d.s3_key)}
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex justify-between pt-4 border-t border-border">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            Back
          </Button>
          <Button onClick={onNext}>
            Next: review
            <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Step 3 — Review + Submit ──────────────────────────────────────────────

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function Step3Review({
  contact,
  extract,
  extractedDraft,
  supporting,
  onBack,
  onSubmitted,
}: {
  contact: ContactRef;
  extract: ExtractResponse | null;
  extractedDraft: Record<string, string>;
  supporting: SupportingDoc[];
  onBack: () => void;
  onSubmitted: (result: { lead_id: string; ghl_synced: boolean }) => void;
}) {
  const [submitResult, setSubmitResult] = React.useState<{
    lead_id: string;
    ghl_synced: boolean;
    ghl_sync_error: string | null;
    fields_pushed: number;
  } | null>(null);

  // Commission estimate from the existing /api/commission/calculate path.
  // Best-effort — we feed it a minimal payload built from the extracted
  // fields so the agent gets a number to react to before submit.
  const monthlyPremium = Number(
    (extractedDraft.monthly_premium ?? extractedDraft.premium ?? "").replace(
      /[$,]/g,
      "",
    ),
  );
  const clientAge = Number(extractedDraft.age ?? extractedDraft.client_age ?? 0);
  const state = (extractedDraft.state ?? "").toUpperCase();
  const carrier = extractedDraft.carrier ?? "";
  const planType = extractedDraft.plan_type ?? "";

  const submitMutation = useMutation({
    mutationFn: () => {
      if (!extract) throw new Error("no extraction");
      const cleaned: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(extractedDraft)) {
        const trimmed = v.trim();
        cleaned[k] = trimmed.length === 0 ? null : trimmed;
      }
      return applicationsApi.submitApplication({
        contact_id: contact.contact_id,
        product_type: extract.product_type,
        extracted: cleaned,
        contact_name: contact.contact_name,
        pdf_url: extract.pdf_url,
        supporting_documents: supporting,
        main_extracted: extract.main_extracted,
        main_confidences: extract.main_confidences,
      });
    },
    onSuccess: (data) => {
      setSubmitResult({
        lead_id: data.lead_id,
        ghl_synced: data.ghl_synced,
        ghl_sync_error: data.ghl_sync_error,
        fields_pushed: data.fields_pushed,
      });
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Submission failed."),
  });

  if (submitResult) {
    return (
      <SuccessCard
        result={submitResult}
        onContinue={() =>
          onSubmitted({
            lead_id: submitResult.lead_id,
            ghl_synced: submitResult.ghl_synced,
          })
        }
      />
    );
  }

  return (
    <Card>
      <CardContent className="p-5 md:p-6 space-y-5">
        <h3 className="text-sm font-semibold">Review &amp; submit</h3>

        <ReviewSection label="Client">
          <p className="text-sm font-semibold">{contact.contact_name}</p>
          <p className="text-xs text-muted-foreground">
            {contact.email || contact.phone || contact.contact_id}
          </p>
        </ReviewSection>

        <ReviewSection
          label={`Application — ${extract?.product_label ?? "—"}`}
          rightHint={
            extract ? `${extract.field_count} fields extracted` : undefined
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
            {Object.entries(extractedDraft)
              .filter(([, v]) => v && v.trim().length > 0)
              .slice(0, 12)
              .map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <p className="text-[10px] text-muted-foreground uppercase truncate">
                    {k.replace(/_/g, " ")}
                  </p>
                  <p className="font-medium truncate">{v}</p>
                </div>
              ))}
          </div>
        </ReviewSection>

        <ReviewSection label="Supporting documents">
          {supporting.length === 0 ? (
            <p className="text-xs text-muted-foreground">None attached.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {supporting.map((d) => (
                <li key={d.s3_key}>
                  <Badge variant="outline" className="text-[10px]">
                    {d.file_label} · {d.filename}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </ReviewSection>

        <CommissionEstimate
          product_type={extract?.product_type ?? ""}
          carrier={carrier}
          state={state}
          plan_type={planType}
          monthly_premium={monthlyPremium}
          client_age={clientAge || 65}
          lead_id={contact.lead_id ?? contact.contact_id}
        />

        <div className="flex justify-between pt-4 border-t border-border">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            Back
          </Button>
          <Button
            onClick={() => submitMutation.mutate()}
            disabled={!extract || submitMutation.isPending}
          >
            {submitMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-1.5" />
            )}
            Submit application
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewSection({
  label,
  rightHint,
  children,
}: {
  label: string;
  rightHint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
          {label}
        </p>
        {rightHint ? (
          <p className="text-[10px] text-muted-foreground">{rightHint}</p>
        ) : null}
      </div>
      <div className="rounded-md bg-secondary/30 p-3 border border-border/40">
        {children}
      </div>
    </div>
  );
}

function CommissionEstimate({
  product_type,
  carrier,
  state,
  plan_type,
  monthly_premium,
  client_age,
  lead_id,
}: {
  product_type: string;
  carrier: string;
  state: string;
  plan_type: string;
  monthly_premium: number;
  client_age: number;
  lead_id: string;
}) {
  const canEstimate = product_type.length > 0 && monthly_premium > 0;
  const q = useQuery({
    queryKey: [
      "commission",
      "calculate",
      product_type,
      carrier,
      state,
      plan_type,
      monthly_premium,
      client_age,
    ],
    queryFn: () =>
      import("@/lib/api").then(({ commissions }) =>
        commissions.calculate({
          product_type,
          carrier: carrier || undefined,
          state: state || undefined,
          plan_type: plan_type || undefined,
          monthly_premium,
          client_age,
          scope_completed: true,
          lead_id,
        }),
      ),
    enabled: canEstimate,
    retry: false,
  });

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Calculator className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-semibold">Commission estimate</h4>
      </div>
      {!canEstimate ? (
        <p className="text-xs text-muted-foreground">
          Need a product type and a non-zero monthly premium for an estimate.
        </p>
      ) : q.isFetching ? (
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      ) : q.isError ? (
        <p className="text-xs text-muted-foreground">
          Estimate unavailable.
        </p>
      ) : q.data ? (
        <div className="grid grid-cols-3 gap-3 text-xs">
          <Metric
            label="Annual premium"
            value={USD.format(q.data.annual_premium)}
          />
          <Metric
            label="Agency revenue"
            value={USD.format(q.data.agency_revenue)}
          />
          <Metric
            label="Your commission"
            value={USD.format(q.data.agent_commission)}
            accent
          />
        </div>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "font-bold tabular-nums",
          accent ? "text-primary" : "",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function SuccessCard({
  result,
  onContinue,
}: {
  result: {
    lead_id: string;
    ghl_synced: boolean;
    ghl_sync_error: string | null;
    fields_pushed: number;
  };
  onContinue: () => void;
}) {
  return (
    <Card className="border-ghw-forest/40 ring-2 ring-ghw-forest/20">
      <CardContent className="p-8 text-center space-y-4">
        <div className="h-14 w-14 rounded-full bg-ghw-forest/20 flex items-center justify-center mx-auto">
          <CheckCircle2 className="h-7 w-7 text-ghw-forest" />
        </div>
        <div>
          <h3 className="text-lg font-bold">Application submitted</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {result.fields_pushed} field{result.fields_pushed === 1 ? "" : "s"}{" "}
            pushed to GoHighLevel
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 flex-wrap">
          {result.ghl_synced ? (
            <Badge
              variant="outline"
              className="bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
            >
              <CheckCircle2 className="h-3 w-3 mr-1" />
              GHL synced
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
            >
              <AlertCircle className="h-3 w-3 mr-1" />
              GHL sync queued
            </Badge>
          )}
        </div>

        {result.ghl_sync_error ? (
          <div className="rounded-md bg-ghw-copper/10 border border-ghw-copper/30 p-3 text-left text-xs">
            <p className="font-semibold text-ghw-copper mb-1">
              GHL sync needs attention
            </p>
            <p className="text-muted-foreground break-all">
              {result.ghl_sync_error}
            </p>
          </div>
        ) : null}

        <div className="flex items-center justify-center gap-2 pt-2">
          <Button asChild variant="outline">
            <Link href={`/clients/${result.lead_id}`}>View client</Link>
          </Button>
          <Button onClick={onContinue}>
            Done
            <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
