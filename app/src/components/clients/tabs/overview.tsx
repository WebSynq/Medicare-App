"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  Edit3,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  StickyNote,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { cna as cnaApi, isApiError, leads as leadsApi, notes as notesApi } from "@/lib/api";
import type {
  CnaAiRecommendation,
  Lead,
  LeadUpdatePayload,
  NoteRecord,
} from "@/types";

// ─── 18 LeadUpdate fields per spec ─────────────────────────────────────────

interface EditField {
  key: keyof LeadUpdatePayload;
  label: string;
  type?: "text" | "date" | "number" | "textarea";
}

const EDIT_FIELDS: EditField[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "date_of_birth", label: "Date of birth", type: "date" },
  { key: "address_line1", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip_code", label: "ZIP" },
  { key: "current_carrier", label: "Current carrier" },
  { key: "current_plan", label: "Current plan" },
  { key: "monthly_premium", label: "Monthly premium", type: "number" },
  { key: "product_interest", label: "Product interest" },
  { key: "plan_type_premium", label: "Plan type + premium (text)" },
  { key: "mbi_number", label: "MBI" },
  { key: "medicare_part_a_effective", label: "Part A effective", type: "date" },
  { key: "medicare_part_b_effective", label: "Part B effective", type: "date" },
  { key: "notes", label: "Notes", type: "textarea" },
];

// ─── Component ─────────────────────────────────────────────────────────────

export function OverviewTab({
  lead,
  onLeadChanged,
}: {
  lead: Lead;
  onLeadChanged: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<LeadUpdatePayload>({});

  function startEdit() {
    const initial: LeadUpdatePayload = {};
    for (const f of EDIT_FIELDS) {
      const v = lead[f.key as keyof Lead];
      // Force narrow assignment via type guard. LeadUpdatePayload
      // and Lead share these field types.
      (initial as Record<string, unknown>)[f.key] = v ?? "";
    }
    setDraft(initial);
    setEditing(true);
  }

  const saveMutation = useMutation({
    mutationFn: (payload: LeadUpdatePayload) =>
      leadsApi.patchLead(lead.id, payload),
    onSuccess: () => {
      toast.success("Saved.");
      qc.invalidateQueries({ queryKey: ["lead", lead.id] });
      setEditing(false);
      onLeadChanged();
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Save failed.";
      toast.error(msg);
    },
  });

  function save() {
    // Strip empty strings → omit (don't send "" — backend interprets
    // string and null differently for some fields).
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (v === "" || v === undefined) continue;
      payload[k] = v;
    }
    saveMutation.mutate(payload as LeadUpdatePayload);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 md:gap-6">
      <div className="space-y-4">
        <AiIntelligenceCard leadId={lead.id} />
        {editing ? (
          <EditCard
            fields={EDIT_FIELDS}
            draft={draft}
            setDraft={setDraft}
            onCancel={() => setEditing(false)}
            onSave={save}
            saving={saveMutation.isPending}
          />
        ) : (
          <DetailsCard lead={lead} onEdit={startEdit} />
        )}
      </div>
      <div className="space-y-4">
        <QuickStatsCard lead={lead} />
        <ActivityFeed leadId={lead.id} />
      </div>
    </div>
  );
}

// ─── AI Intelligence ───────────────────────────────────────────────────────

function AiIntelligenceCard({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const [copied, setCopied] = React.useState(false);

  const query = useQuery<CnaAiRecommendation>({
    queryKey: ["cna", leadId, "ai"],
    queryFn: () => cnaApi.getAiAnalysis(leadId),
    retry: false,
  });

  const refreshMutation = useMutation({
    mutationFn: () => cnaApi.runAiAnalysis(leadId),
    onSuccess: (data) => {
      qc.setQueryData(["cna", leadId, "ai"], data);
      toast.success("AI analysis refreshed.");
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "AI analysis failed.";
      toast.error(msg);
    },
  });

  async function copyScript(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard blocked.");
    }
  }

  if (query.isLoading) return <Skeleton className="h-72 w-full rounded-md" />;

  const empty = query.isError || !query.data;
  if (empty) {
    return (
      <Card className="border-border/70">
        <CardContent className="p-5 text-center space-y-3">
          <Brain className="h-8 w-8 text-muted-foreground mx-auto" />
          <div>
            <p className="text-sm font-medium">No AI analysis yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
              Fill out the CNA tab, then run an analysis. Or click the
              button below to score this lead with whatever&apos;s on
              file right now.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            )}
            Run Analysis
          </Button>
        </CardContent>
      </Card>
    );
  }

  const ai = query.data;

  return (
    <Card className="border-border/70" data-testid="ai-intelligence-card">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">AI Client Intelligence</h3>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="h-7 text-xs"
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <UrgencyScoreRing score={ai.urgency_score} level={ai.urgency_level} />
          <div className="min-w-0">
            <p className="text-sm font-medium">{ai.recommendation}</p>
            {ai.umbrella_tier ? (
              <p className="text-xs text-muted-foreground capitalize">
                Recommended tier: {ai.umbrella_tier}
              </p>
            ) : null}
          </div>
        </div>

        {ai.talking_points.length > 0 ? (
          <BulletList title="Talking Points" items={ai.talking_points} />
        ) : null}

        {ai.exposures.length > 0 ? (
          <BulletList title="Coverage Gaps" items={ai.exposures} />
        ) : null}

        {ai.objection_handles.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-eyebrow">Objection Handles</p>
            <div className="space-y-2">
              {ai.objection_handles.map((h, i) => (
                <div key={i} className="rounded-md bg-secondary/40 p-2">
                  <p className="text-xs font-medium">{h.objection}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    → {h.response}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {ai.formal_script ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-eyebrow">Formal Recommendation Script</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copyScript(ai.formal_script)}
                className="h-6 text-[11px]"
              >
                {copied ? (
                  <ClipboardCheck className="h-3 w-3 mr-1 text-ghw-forest" />
                ) : (
                  <Clipboard className="h-3 w-3 mr-1" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <ScrollArea className="max-h-[180px] rounded-md bg-secondary/30 p-3">
              <p className="text-xs whitespace-pre-wrap">{ai.formal_script}</p>
            </ScrollArea>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UrgencyScoreRing({
  score,
  level,
}: {
  score: number;
  level: CnaAiRecommendation["urgency_level"];
}) {
  const tint =
    level === "urgent"
      ? "bg-destructive/15 text-destructive ring-destructive/30"
      : level === "high"
        ? "bg-primary/15 text-primary ring-primary/30"
        : level === "moderate"
          ? "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30"
          : "bg-muted text-muted-foreground ring-border";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center w-16 h-16 rounded-full ring-2 flex-shrink-0",
        tint,
      )}
    >
      <span className="text-lg font-bold tabular-nums">{score}</span>
      <span className="text-[9px] uppercase tracking-widest capitalize">
        {level}
      </span>
    </div>
  );
}

function BulletList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-eyebrow">{title}</p>
      <ul className="space-y-1 text-xs">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-primary mt-0.5">•</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Details + edit ────────────────────────────────────────────────────────

function DetailsCard({
  lead,
  onEdit,
}: {
  lead: Lead;
  onEdit: () => void;
}) {
  return (
    <Card className="border-border/70">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Client Details</h3>
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Edit3 className="h-3.5 w-3.5 mr-1.5" />
            Edit
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {EDIT_FIELDS.map((f) => {
            const v = lead[f.key as keyof Lead];
            return (
              <div key={f.key as string} className="min-w-0">
                <div className="text-muted-foreground">{f.label}</div>
                <div className="font-medium truncate">
                  {v == null || v === "" ? "—" : String(v)}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function EditCard({
  fields,
  draft,
  setDraft,
  onCancel,
  onSave,
  saving,
}: {
  fields: EditField[];
  draft: LeadUpdatePayload;
  setDraft: React.Dispatch<React.SetStateAction<LeadUpdatePayload>>;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  function set<T extends keyof LeadUpdatePayload>(
    key: T,
    value: LeadUpdatePayload[T] | string,
  ) {
    setDraft((p) => ({ ...p, [key]: value as LeadUpdatePayload[T] }));
  }

  return (
    <Card className="border-primary/40 ring-1 ring-primary/20">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Edit Client Details</h3>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onCancel}
              disabled={saving}
            >
              <X className="h-3.5 w-3.5 mr-1.5" />
              Cancel
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {fields.map((f) => {
            const value =
              (draft as Record<string, unknown>)[f.key as string] ?? "";
            const stringValue =
              typeof value === "number" ? String(value) : (value as string);
            return (
              <div key={f.key as string} className="space-y-1">
                <Label
                  htmlFor={`edit-${f.key as string}`}
                  className="text-[11px] text-muted-foreground"
                >
                  {f.label}
                </Label>
                {f.type === "textarea" ? (
                  <Textarea
                    id={`edit-${f.key as string}`}
                    value={stringValue}
                    onChange={(e) =>
                      set(
                        f.key as keyof LeadUpdatePayload,
                        e.target.value,
                      )
                    }
                    rows={3}
                  />
                ) : (
                  <Input
                    id={`edit-${f.key as string}`}
                    type={f.type ?? "text"}
                    value={stringValue}
                    onChange={(e) =>
                      set(
                        f.key as keyof LeadUpdatePayload,
                        f.type === "number"
                          ? (Number(e.target.value) as never)
                          : (e.target.value as never),
                      )
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Quick stats ───────────────────────────────────────────────────────────

function QuickStatsCard({ lead }: { lead: Lead }) {
  const stats: { label: string; value: React.ReactNode }[] = [
    {
      label: "Enrolled",
      value:
        lead.status === "enrolled" ? (
          <Badge
            variant="outline"
            className="text-[10px] bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
          >
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Yes
          </Badge>
        ) : (
          <span className="text-muted-foreground">No</span>
        ),
    },
    {
      label: "SOA",
      value: lead.soa_signed ? (
        <Badge
          variant="outline"
          className="text-[10px] bg-primary/15 text-primary border-primary/30"
        >
          Signed
        </Badge>
      ) : (
        <span className="text-muted-foreground">Pending</span>
      ),
    },
    {
      label: "GHL",
      value: lead.ghl_sync_status ? (
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] capitalize",
            lead.ghl_sync_status === "synced"
              ? "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
              : "bg-destructive/15 text-destructive border-destructive/30",
          )}
        >
          {lead.ghl_sync_status}
        </Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Updated",
      value: formatRelative(lead.updated_at),
    },
    {
      label: "Created",
      value: formatRelative(lead.created_at),
    },
  ];
  return (
    <Card className="border-border/70">
      <CardContent className="p-5 space-y-2">
        <h3 className="text-sm font-semibold mb-1">Quick Stats</h3>
        <dl className="space-y-1.5 text-xs">
          {stats.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Activity feed (recent notes) ──────────────────────────────────────────

function ActivityFeed({ leadId }: { leadId: string }) {
  const query = useQuery({
    queryKey: ["notes", { lead_id: leadId }],
    queryFn: () => notesApi.listByLead(leadId),
  });

  return (
    <Card className="border-border/70">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Recent Activity</h3>
        </div>
        {query.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded" />
            ))}
          </div>
        ) : query.isError || query.data?.notes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No notes yet. Drop one in the Notes & Tasks tab.
          </p>
        ) : (
          <ScrollArea className="max-h-[280px]">
            <ol className="space-y-2">
              {query.data?.notes.slice(0, 6).map((n) => (
                <RecentNoteRow key={n.id} note={n} />
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function RecentNoteRow({ note }: { note: NoteRecord }) {
  return (
    <li className="text-xs">
      <div className="flex items-center gap-2 mb-0.5">
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider px-1.5 py-0 rounded-full ring-1",
            note.kind === "task"
              ? "bg-ghw-copper/15 text-ghw-copper ring-ghw-copper/30"
              : "bg-muted text-muted-foreground ring-border",
          )}
        >
          {note.kind}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatRelative(note.created_at)}
        </span>
      </div>
      <p className="text-xs line-clamp-2">{note.body}</p>
      <Separator className="mt-2" />
    </li>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (Number.isNaN(diff)) return "—";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
