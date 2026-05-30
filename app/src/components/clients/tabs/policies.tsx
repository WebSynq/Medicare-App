"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Calculator, Loader2, Wallet } from "lucide-react";
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
import {
  commissions as commissionsApi,
  isApiError,
  policies as policiesApi,
} from "@/lib/api";
import type {
  CommissionCalculateResponse,
  Lead,
  PolicyRecord,
} from "@/types";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function policyStatusTint(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "active") return "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30";
  if (s === "pending") return "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30";
  if (s === "terminated" || s === "cancelled" || s === "lapsed") {
    return "bg-destructive/15 text-destructive border-destructive/30";
  }
  return "bg-muted text-muted-foreground border-border";
}

export function PoliciesTab({ lead }: { lead: Lead }) {
  const query = useQuery({
    queryKey: ["policies", lead.id],
    queryFn: () => policiesApi.listByLead(lead.id),
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 md:gap-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            Policies
            {query.data ? (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                ({query.data.policies.length})
              </span>
            ) : null}
          </h3>
        </div>

        {query.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded" />
            ))}
          </div>
        ) : query.isError || query.data?.policies.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <Wallet className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-sm">
                {query.isError
                  ? "Couldn't load policies."
                  : "No policies on file."}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Submitted applications land here as policy rows.
              </p>
            </CardContent>
          </Card>
        ) : (
          query.data?.policies.map((p, i) => (
            <PolicyCard key={`${p.id}-${i}`} policy={p} />
          ))
        )}
      </div>

      <div>
        <CommissionCalculator
          defaultState={lead.state ?? ""}
          age={null}
          leadId={lead.id}
          leadSource={lead.lead_source}
        />
      </div>
    </div>
  );
}

function PolicyCard({ policy }: { policy: PolicyRecord }) {
  const premiumLabel = (() => {
    const v = policy.premium;
    if (v == null) return "—";
    const n = typeof v === "string" ? Number(v) : v;
    if (Number.isFinite(n)) return USD.format(Number(n));
    return String(v);
  })();
  return (
    <Card className="border-border/70">
      <CardContent className="p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">
              {policy.product_label ?? policy.product_type ?? "Policy"}
            </h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {policy.carrier ?? "Unknown carrier"}
              {policy.plan_type ? ` · ${policy.plan_type}` : ""}
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] capitalize",
              policyStatusTint(policy.policy_status),
            )}
          >
            {policy.policy_status ?? "—"}
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div>
            <div className="text-muted-foreground">Premium</div>
            <div className="font-medium tabular-nums">{premiumLabel}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Effective</div>
            <div className="font-medium">{policy.effective_date ?? "—"}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Commission calculator ────────────────────────────────────────────────

function CommissionCalculator({
  defaultState,
  age,
  leadId,
  leadSource,
}: {
  defaultState: string;
  age: number | null;
  leadId: string;
  leadSource: string | null;
}) {
  const carriersQuery = useQuery({
    queryKey: ["commission", "carriers"],
    queryFn: () => commissionsApi.getCarriers(),
    staleTime: 5 * 60_000,
  });

  const [form, setForm] = React.useState({
    product_type: "",
    carrier: "",
    state: defaultState.toUpperCase(),
    plan_type: "",
    monthly_premium: 0,
    client_age: age ?? 65,
    scope_completed: false,
  });

  const [result, setResult] = React.useState<CommissionCalculateResponse | null>(null);

  const calcMutation = useMutation({
    mutationFn: () =>
      commissionsApi.calculate({
        product_type: form.product_type,
        carrier: form.carrier || undefined,
        state: form.state || undefined,
        plan_type: form.plan_type || undefined,
        monthly_premium: form.monthly_premium,
        client_age: form.client_age,
        scope_completed: form.scope_completed,
        lead_source: leadSource ?? undefined,
        lead_id: leadId,
      }),
    onSuccess: (data) => setResult(data),
    onError: (err) => {
      const msg = isApiError(err) ? err.message : "Calculation failed.";
      toast.error(msg);
    },
  });

  const productTypes = carriersQuery.data?.product_types ?? [];
  const carriers = form.product_type
    ? carriersQuery.data?.carriers_by_product[form.product_type] ?? []
    : [];
  const plans = form.product_type
    ? carriersQuery.data?.plan_options_by_product[form.product_type] ?? []
    : [];

  return (
    <Card className="border-border/70">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Commission Calculator</h3>
        </div>

        <div className="space-y-2.5">
          <FieldSelect
            label="Product"
            value={form.product_type}
            placeholder="Pick product…"
            options={productTypes}
            onChange={(v) =>
              setForm((p) => ({ ...p, product_type: v, carrier: "", plan_type: "" }))
            }
            loading={carriersQuery.isLoading}
          />
          <FieldSelect
            label="Carrier"
            value={form.carrier}
            placeholder="—"
            options={carriers}
            onChange={(v) => setForm((p) => ({ ...p, carrier: v }))}
            disabled={!form.product_type}
          />
          <FieldSelect
            label="Plan"
            value={form.plan_type}
            placeholder="—"
            options={plans}
            onChange={(v) => setForm((p) => ({ ...p, plan_type: v }))}
            disabled={!form.product_type}
          />
          <FieldNumber
            label="Monthly premium ($)"
            value={form.monthly_premium}
            onChange={(v) => setForm((p) => ({ ...p, monthly_premium: v }))}
          />
          <FieldNumber
            label="Client age"
            value={form.client_age}
            onChange={(v) => setForm((p) => ({ ...p, client_age: v }))}
          />
          <FieldText
            label="State (2-letter)"
            value={form.state}
            onChange={(v) => setForm((p) => ({ ...p, state: v.toUpperCase().slice(0, 2) }))}
          />
        </div>

        <Button
          onClick={() => calcMutation.mutate()}
          disabled={!form.product_type || calcMutation.isPending}
          size="sm"
          className="w-full"
        >
          {calcMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Calculator className="h-3.5 w-3.5 mr-1.5" />
          )}
          Calculate
        </Button>

        {result ? (
          <div className="rounded-md bg-secondary/40 p-3 space-y-1.5 text-xs">
            <ResultRow label="Annual premium" value={USD.format(result.annual_premium)} />
            <ResultRow label="Agency revenue" value={USD.format(result.agency_revenue)} />
            <ResultRow
              label="Agent commission"
              value={USD.format(result.agent_commission)}
              accent
            />
            {result.notes ? (
              <p className="text-[10px] text-muted-foreground mt-1.5 italic">
                {result.notes}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FieldSelect({
  label,
  value,
  placeholder,
  options,
  onChange,
  loading,
  disabled,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: string[];
  onChange: (v: string) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select
        value={value || undefined}
        onValueChange={onChange}
        disabled={disabled || loading}
      >
        <SelectTrigger className="h-9">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FieldNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="h-9"
      />
    </div>
  );
}

function FieldText({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9"
      />
    </div>
  );
}

function ResultRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-semibold tabular-nums",
          accent ? "text-primary" : "",
        )}
      >
        {value}
      </span>
    </div>
  );
}
