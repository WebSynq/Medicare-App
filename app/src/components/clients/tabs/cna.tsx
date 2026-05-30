"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, CheckCircle2, Loader2, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { cna as cnaApi, isApiError } from "@/lib/api";
import type { CnaFetchResponse } from "@/types";

/**
 * Confidence badge — shown next to a field when the AI pre-fill
 * stamped a confidence score on it. Levels: high / med / low.
 * Mostly placeholder for now — the backend CNA shape doesn't
 * currently stamp per-field confidence; renders nothing when
 * absent. Hook for when the AI-pre-fill phase wires it.
 */
function ConfidenceBadge({
  level,
}: {
  level: "high" | "med" | "low" | null;
}) {
  if (!level) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[9px] h-4 px-1",
        level === "high"
          ? "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30"
          : level === "med"
            ? "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30"
            : "bg-destructive/15 text-destructive border-destructive/30",
      )}
    >
      {level} confidence
    </Badge>
  );
}

// ─── CNA field schema (COACHG-aligned core questions) ──────────────────────

interface CnaField {
  key: string;
  label: string;
  group: string;
  type?: "text" | "number" | "date" | "textarea" | "yesno";
}

const CNA_FIELDS: CnaField[] = [
  // Health
  { key: "primary_doctor", label: "Primary doctor", group: "Health" },
  { key: "specialists", label: "Specialists seen", group: "Health" },
  { key: "hospitals_used", label: "Preferred hospital network", group: "Health" },
  { key: "chronic_conditions", label: "Chronic conditions", group: "Health", type: "textarea" },
  { key: "medications", label: "Current medications", group: "Health", type: "textarea" },

  // Coverage
  { key: "current_coverage_pain_points", label: "Pain points with current plan", group: "Coverage", type: "textarea" },
  { key: "out_of_pocket_concerns", label: "Out-of-pocket concerns", group: "Coverage", type: "yesno" },
  { key: "prescription_costs_concern", label: "Rx cost concerns", group: "Coverage", type: "yesno" },
  { key: "dental_vision_hearing_interest", label: "DVH interest", group: "Coverage", type: "yesno" },

  // Financial
  { key: "fixed_income", label: "On fixed income", group: "Financial", type: "yesno" },
  { key: "budget_monthly_premium", label: "Comfortable monthly premium", group: "Financial", type: "number" },
  { key: "spouse_coverage", label: "Spouse also needs coverage", group: "Financial", type: "yesno" },

  // Lifestyle / Goals
  { key: "travel_frequency", label: "Travel frequency", group: "Lifestyle" },
  { key: "snowbird", label: "Snowbird (multiple states)", group: "Lifestyle", type: "yesno" },
  { key: "primary_concerns", label: "Top 1-2 concerns about Medicare", group: "Lifestyle", type: "textarea" },
  { key: "long_term_goals", label: "Long-term goals", group: "Lifestyle", type: "textarea" },
];

// ─── Component ─────────────────────────────────────────────────────────────

export function CnaTab({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const query = useQuery<CnaFetchResponse>({
    queryKey: ["cna", leadId],
    queryFn: () => cnaApi.getCna(leadId),
  });

  const [draft, setDraft] = React.useState<Record<string, unknown>>({});

  React.useEffect(() => {
    if (query.data) {
      setDraft(query.data.cna.fields ?? {});
    }
  }, [query.data]);

  const saveMutation = useMutation({
    mutationFn: (opts: { runAi: boolean }) =>
      cnaApi.saveCna(leadId, draft, { runAi: opts.runAi }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["cna", leadId] });
      if (vars.runAi) {
        qc.invalidateQueries({ queryKey: ["cna", leadId, "ai"] });
        toast.success("CNA saved + AI analysis refreshed.");
      } else {
        toast.success("CNA saved.");
      }
    },
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Save failed.";
      toast.error(msg);
    },
  });

  // Auto-save on blur — fires only when the field's value actually
  // differs from what the server has. Avoids POST storms while the
  // user is just tabbing through.
  const lastSavedRef = React.useRef<Record<string, unknown>>({});
  React.useEffect(() => {
    if (query.data) {
      lastSavedRef.current = { ...query.data.cna.fields };
    }
  }, [query.data]);

  function handleBlur() {
    if (!query.data) return;
    const changed = Object.keys(draft).some(
      (k) => draft[k] !== lastSavedRef.current[k],
    );
    if (!changed) return;
    saveMutation.mutate({ runAi: false });
    lastSavedRef.current = { ...draft };
  }

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded" />
        ))}
      </div>
    );
  }

  const grouped = groupFields(CNA_FIELDS);
  const cnaExists = query.data?.exists ?? false;
  const updatedAt = query.data?.cna.updated_at;

  return (
    <div className="space-y-4">
      <Card className="border-border/70">
        <CardContent className="p-4 md:p-5 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <Brain className="h-5 w-5 text-primary" />
            <div>
              <h3 className="text-sm font-semibold">Client Needs Assessment</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {cnaExists
                  ? `Last saved ${updatedAt ? new Date(updatedAt).toLocaleString() : "—"}`
                  : "Not started. Answers auto-save on blur."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => saveMutation.mutate({ runAi: false })}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save now
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate({ runAi: true })}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              )}
              Save + Run AI
            </Button>
          </div>
        </CardContent>
      </Card>

      {grouped.map(([group, fields]) => (
        <Card key={group} className="border-border/70">
          <CardContent className="p-4 md:p-5">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">{group}</h4>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {fields.map((f) => (
                <CnaFieldInput
                  key={f.key}
                  field={f}
                  value={draft[f.key]}
                  onChange={(v) => setDraft((p) => ({ ...p, [f.key]: v }))}
                  onBlur={handleBlur}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CnaFieldInput({
  field,
  value,
  onChange,
  onBlur,
}: {
  field: CnaField;
  value: unknown;
  onChange: (next: unknown) => void;
  onBlur: () => void;
}) {
  const stringValue =
    typeof value === "string" || typeof value === "number" ? String(value) : "";

  if (field.type === "yesno") {
    const yes = value === true || value === "true" || value === "yes";
    const no = value === false || value === "false" || value === "no";
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-muted-foreground">
            {field.label}
          </Label>
          <ConfidenceBadge level={null} />
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={yes ? "default" : "outline"}
            onClick={() => {
              onChange(true);
              onBlur();
            }}
            className="text-xs"
          >
            Yes
          </Button>
          <Button
            type="button"
            size="sm"
            variant={no ? "default" : "outline"}
            onClick={() => {
              onChange(false);
              onBlur();
            }}
            className="text-xs"
          >
            No
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label
          htmlFor={`cna-${field.key}`}
          className="text-[11px] text-muted-foreground"
        >
          {field.label}
        </Label>
        <ConfidenceBadge level={null} />
      </div>
      {field.type === "textarea" ? (
        <Textarea
          id={`cna-${field.key}`}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          rows={3}
        />
      ) : (
        <Input
          id={`cna-${field.key}`}
          type={field.type === "number" ? "number" : field.type ?? "text"}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      )}
    </div>
  );
}

function groupFields(fields: CnaField[]): [string, CnaField[]][] {
  const map = new Map<string, CnaField[]>();
  for (const f of fields) {
    const arr = map.get(f.group) ?? [];
    arr.push(f);
    map.set(f.group, arr);
  }
  return Array.from(map.entries());
}
