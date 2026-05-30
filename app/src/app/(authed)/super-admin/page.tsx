"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  Building2,
  Check,
  CreditCard,
  Database,
  Edit3,
  Key,
  Loader2,
  Mail,
  Save,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  isApiError,
  superAdmin as saApi,
} from "@/lib/api";
import { isSystemError } from "@/lib/api/super-admin";
import { useAuthStore, selectIsSuperAdmin } from "@/stores/auth";
import type {
  SuperAdminAgencyRow,
  SuperAdminUserRow,
} from "@/lib/api/super-admin";
import type {
  AgencyBillingStatus,
  AgencyFeature,
  AgencyTier,
  UserRole,
} from "@/types";

const TIERS: { value: AgencyTier; label: string; price: string }[] = [
  { value: "beta", label: "Beta", price: "$297/mo" },
  { value: "foundation", label: "Foundation", price: "$297/mo" },
  { value: "growth", label: "Growth", price: "$497/mo" },
  { value: "domination", label: "Domination", price: "$997/mo" },
];

const BILLING_STATUSES: AgencyBillingStatus[] = [
  "trialing",
  "active",
  "past_due",
  "suspended",
  "cancelled",
];

const USER_ROLES: UserRole[] = [
  "admin",
  "owner",
  "agent",
  "compliance",
  "va",
  "support",
];

const STATUS_TINT: Record<string, string> = {
  active: "bg-ghw-forest/15 text-ghw-forest border-ghw-forest/30",
  trialing: "bg-primary/15 text-primary border-primary/30",
  past_due: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
  suspended: "bg-destructive/15 text-destructive border-destructive/30",
  cancelled: "bg-muted text-muted-foreground border-border",
  pending: "bg-ghw-copper/15 text-ghw-copper border-ghw-copper/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
};

// ─── Route guard ───────────────────────────────────────────────────────────

export default function SuperAdminPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);
  const meEmail = useAuthStore((s) => s.user?.email ?? "");

  React.useEffect(() => {
    if (status === "authed" && !isSuperAdmin) {
      router.replace("/dashboard");
    }
  }, [status, isSuperAdmin, router]);

  if (status !== "authed" || !isSuperAdmin) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <SuperAdminConsole meEmail={meEmail} />;
}

// ─── Console root ──────────────────────────────────────────────────────────

function SuperAdminConsole({ meEmail }: { meEmail: string }) {
  const [tab, setTab] = React.useState("agencies");
  const [usageAgencyId, setUsageAgencyId] = React.useState<string | null>(null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" />
          Super Admin
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Platform-wide controls. Every mutation is audit-logged.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="agencies">
            <Building2 className="h-3.5 w-3.5 mr-1.5" />
            Agencies
          </TabsTrigger>
          <TabsTrigger value="users">
            <Users className="h-3.5 w-3.5 mr-1.5" />
            Users
          </TabsTrigger>
          <TabsTrigger value="usage">
            <Zap className="h-3.5 w-3.5 mr-1.5" />
            Usage
          </TabsTrigger>
          <TabsTrigger value="system">
            <Server className="h-3.5 w-3.5 mr-1.5" />
            System
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agencies" className="mt-6">
          <AgenciesTab
            onOpenUsage={(id) => {
              setUsageAgencyId(id);
              setTab("usage");
            }}
          />
        </TabsContent>
        <TabsContent value="users" className="mt-6">
          <UsersTab meEmail={meEmail} />
        </TabsContent>
        <TabsContent value="usage" className="mt-6">
          <UsageTab
            agencyId={usageAgencyId}
            onSelectAgency={setUsageAgencyId}
          />
        </TabsContent>
        <TabsContent value="system" className="mt-6">
          <SystemTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Agencies tab ──────────────────────────────────────────────────────────

function AgenciesTab({
  onOpenUsage,
}: {
  onOpenUsage: (agencyId: string) => void;
}) {
  const [q, setQ] = React.useState("");
  const [tierFilter, setTierFilter] = React.useState<AgencyTier | "all">("all");
  const [statusFilter, setStatusFilter] = React.useState<
    AgencyBillingStatus | "all"
  >("all");
  const [editing, setEditing] = React.useState<SuperAdminAgencyRow | null>(null);

  const query = useQuery({
    queryKey: ["super-admin", "agencies", q, tierFilter, statusFilter],
    queryFn: () =>
      saApi.listAgencies({
        ...(q.trim().length > 0 ? { q: q.trim() } : {}),
        ...(tierFilter !== "all" ? { tier: tierFilter } : {}),
        ...(statusFilter !== "all" ? { billing_status: statusFilter } : {}),
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-3 md:p-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or slug"
              className="pl-9"
            />
          </div>
          <Select
            value={tierFilter}
            onValueChange={(v) => setTierFilter(v as AgencyTier | "all")}
          >
            <SelectTrigger className="h-9 w-[150px]">
              <SelectValue placeholder="Tier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tiers</SelectItem>
              {TIERS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(v) =>
              setStatusFilter(v as AgencyBillingStatus | "all")
            }
          >
            <SelectTrigger className="h-9 w-[160px]">
              <SelectValue placeholder="Billing" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {BILLING_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground ml-auto tabular-nums">
            {query.data ? `${query.data.total} agenc${query.data.total === 1 ? "y" : "ies"}` : null}
          </div>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center text-destructive">
            Couldn&apos;t load agencies.
          </CardContent>
        </Card>
      ) : (query.data?.agencies ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            No matches.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40">
              <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
                <th className="text-left px-3 py-2">Agency</th>
                <th className="text-left px-3 py-2">Tier</th>
                <th className="text-left px-3 py-2">Billing</th>
                <th className="text-right px-3 py-2 hidden md:table-cell">
                  Seats
                </th>
                <th className="text-right px-3 py-2 hidden lg:table-cell">
                  Monthly
                </th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.agencies.map((a) => (
                <tr
                  key={a.agency_id}
                  className={cn(
                    "border-b border-border/60 hover:bg-secondary/40 transition-colors",
                    a.super_admin && "bg-primary/5",
                  )}
                >
                  <td className="px-3 py-3">
                    <div className="font-medium text-sm truncate">
                      {a.name}
                      {a.super_admin ? (
                        <Badge
                          variant="outline"
                          className="ml-1.5 text-[9px] bg-primary/15 text-primary border-primary/30"
                        >
                          PLATFORM
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate font-mono">
                      {a.slug}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant="outline" className="capitalize text-[10px]">
                      {a.tier}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] capitalize",
                        STATUS_TINT[a.billing_status] ?? STATUS_TINT.cancelled,
                      )}
                    >
                      {a.billing_status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 hidden md:table-cell text-right tabular-nums text-xs">
                    {a.seats_active_live} /{" "}
                    {a.seats_max === -1 ? "∞" : a.seats_max}
                  </td>
                  <td className="px-3 py-3 hidden lg:table-cell text-right tabular-nums text-xs"></td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenUsage(a.agency_id)}
                        className="h-7 text-xs"
                      >
                        <Zap className="h-3 w-3 mr-1" />
                        Usage
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(a)}
                        className="h-7 text-xs"
                      >
                        <Edit3 className="h-3 w-3 mr-1" />
                        Edit
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <EditAgencyDialog
        agency={editing}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
  );
}

// ─── Edit agency dialog ────────────────────────────────────────────────────

const ALL_FEATURES: AgencyFeature[] = [
  "cna",
  "ai_client_intelligence",
  "ai_application_intake",
  "ghl_import",
  "booking",
  "soa",
  "audit_log",
  "leaderboard",
  "ops_console",
  "ai_security",
  "round_robin",
  "email_domain",
  "agency_dashboard",
  "super_admin_panel",
  "owner_settings",
  "stripe_billing",
  "metering",
  "compliance_dashboard",
  "accounting_dashboard",
  "production_records",
  "reconciliation",
  "cfo_chat",
  "google_calendar_sync",
  "renewals",
  "birthday_rule",
  "tags",
  "documents",
  "ghl_webhook",
  "feedback",
];

function EditAgencyDialog({
  agency,
  onOpenChange,
}: {
  agency: SuperAdminAgencyRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [tier, setTier] = React.useState<AgencyTier>("foundation");
  const [billing, setBilling] = React.useState<AgencyBillingStatus>("active");
  const [seatsMax, setSeatsMax] = React.useState(0);
  const [features, setFeatures] = React.useState<Record<string, boolean>>({});
  const [applyDefaults, setApplyDefaults] = React.useState(false);

  React.useEffect(() => {
    if (agency) {
      setName(agency.name);
      setTier(agency.tier);
      setBilling(agency.billing_status);
      setSeatsMax(agency.seats_max);
      const feats: Record<string, boolean> = {};
      for (const k of ALL_FEATURES) {
        feats[k] = agency.features[k] === true;
      }
      setFeatures(feats);
      setApplyDefaults(false);
    }
  }, [agency]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!agency) throw new Error("no agency");
      const payload: Parameters<typeof saApi.patchAgency>[1] = {};
      if (name !== agency.name) payload.name = name.trim();
      if (tier !== agency.tier) payload.tier = tier;
      if (billing !== agency.billing_status) payload.billing_status = billing;
      if (seatsMax !== agency.seats_max) payload.seats_max = seatsMax;
      if (applyDefaults) {
        payload.apply_tier_defaults = true;
      } else {
        // Diff features vs original — only send changed flags.
        const diff: Record<string, boolean> = {};
        for (const k of ALL_FEATURES) {
          const orig = agency.features[k] === true;
          if (features[k] !== orig) diff[k] = !!features[k];
        }
        if (Object.keys(diff).length > 0) payload.features = diff;
      }
      return saApi.patchAgency(agency.agency_id, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["super-admin", "agencies"] });
      toast.success("Agency updated.");
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Couldn't save."),
  });

  return (
    <Dialog open={!!agency} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {agency?.name}
            {agency?.super_admin ? (
              <Badge
                variant="outline"
                className="ml-2 text-[10px] bg-primary/15 text-primary border-primary/30"
              >
                PLATFORM
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            <code className="font-mono">{agency?.agency_id}</code> ·{" "}
            <code className="font-mono">{agency?.slug}</code>
          </DialogDescription>
        </DialogHeader>

        {agency ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Tier">
                <Select
                  value={tier}
                  onValueChange={(v) => setTier(v as AgencyTier)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIERS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label} · {t.price}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Billing status">
                <Select
                  value={billing}
                  onValueChange={(v) => setBilling(v as AgencyBillingStatus)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BILLING_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.replace("_", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Seats max (-1 = unlimited)">
                <Input
                  type="number"
                  value={seatsMax}
                  onChange={(e) => setSeatsMax(Number(e.target.value) || 0)}
                  min={-1}
                  max={10000}
                />
              </Field>
            </div>

            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 flex items-start gap-3">
              <Checkbox
                id="apply-defaults"
                checked={applyDefaults}
                onCheckedChange={(v) => setApplyDefaults(v === true)}
              />
              <div className="min-w-0">
                <Label
                  htmlFor="apply-defaults"
                  className="text-xs font-semibold cursor-pointer"
                >
                  Apply tier defaults
                </Label>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Replaces features / limits / pricing with the new
                  tier&apos;s TIER_DEFAULTS. Skips the feature toggles
                  below.
                </p>
              </div>
            </div>

            {!applyDefaults ? (
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">
                  Features
                </p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                  {ALL_FEATURES.map((f) => (
                    <label
                      key={f}
                      className="flex items-center gap-1.5 text-xs px-2 py-1 rounded hover:bg-secondary/50 cursor-pointer"
                    >
                      <Checkbox
                        checked={features[f] === true}
                        onCheckedChange={(v) =>
                          setFeatures((p) => ({ ...p, [f]: v === true }))
                        }
                      />
                      <span className="capitalize truncate">
                        {f.replace(/_/g, " ")}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1.5" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Users tab ─────────────────────────────────────────────────────────────

function UsersTab({ meEmail }: { meEmail: string }) {
  const [q, setQ] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState<UserRole | "all">("all");
  const [editing, setEditing] = React.useState<SuperAdminUserRow | null>(null);

  const query = useQuery({
    queryKey: ["super-admin", "users", q, roleFilter],
    queryFn: () =>
      saApi.listUsers({
        ...(q.trim().length > 0 ? { q: q.trim() } : {}),
        ...(roleFilter !== "all" ? { role: roleFilter } : {}),
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-3 md:p-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by email, name, or agent name"
              className="pl-9"
            />
          </div>
          <Select
            value={roleFilter}
            onValueChange={(v) => setRoleFilter(v as UserRole | "all")}
          >
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {USER_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground ml-auto tabular-nums">
            {query.data ? `${query.data.total} user${query.data.total === 1 ? "" : "s"}` : null}
          </div>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40">
              <tr className="border-b border-border text-xs uppercase tracking-widest text-muted-foreground">
                <th className="text-left px-3 py-2">User</th>
                <th className="text-left px-3 py-2 hidden md:table-cell">
                  Agency
                </th>
                <th className="text-left px-3 py-2">Role</th>
                <th className="text-left px-3 py-2 hidden sm:table-cell">
                  Status
                </th>
                <th className="text-center px-3 py-2 hidden md:table-cell">
                  MFA
                </th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.users.map((u) => {
                const isSelf =
                  meEmail.length > 0 && u.email.toLowerCase() === meEmail.toLowerCase();
                return (
                  <tr
                    key={u.id}
                    className={cn(
                      "border-b border-border/60 hover:bg-secondary/40",
                      isSelf && "bg-primary/5",
                      !u.is_active && "opacity-60",
                    )}
                  >
                    <td className="px-3 py-3">
                      <div className="font-medium text-sm truncate">
                        {u.full_name ?? u.email}
                        {isSelf ? (
                          <Badge
                            variant="outline"
                            className="ml-1.5 text-[9px] bg-primary/15 text-primary border-primary/30"
                          >
                            YOU
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {u.email}
                      </div>
                    </td>
                    <td className="px-3 py-3 hidden md:table-cell">
                      <code className="text-[11px] font-mono">{u.agency_id}</code>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {u.role}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 hidden sm:table-cell">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] capitalize",
                          STATUS_TINT[u.status] ?? STATUS_TINT.cancelled,
                        )}
                      >
                        {u.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 hidden md:table-cell text-center">
                      {u.mfa_enabled ? (
                        <Check className="h-3.5 w-3.5 text-ghw-forest inline-block" />
                      ) : (
                        <X className="h-3.5 w-3.5 text-muted-foreground inline-block" />
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(u)}
                        disabled={isSelf}
                        title={isSelf ? "Self-modification refused" : ""}
                        className="h-7 text-xs"
                      >
                        <Edit3 className="h-3 w-3 mr-1" />
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <EditUserDialog
        user={editing}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
  );
}

function EditUserDialog({
  user,
  onOpenChange,
}: {
  user: SuperAdminUserRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [role, setRole] = React.useState<UserRole>("agent");
  const [isActive, setIsActive] = React.useState(true);
  const [status, setStatus] = React.useState<"pending" | "active" | "rejected">(
    "active",
  );
  const [agencyId, setAgencyId] = React.useState("");

  React.useEffect(() => {
    if (user) {
      setRole(user.role);
      setIsActive(user.is_active);
      setStatus(user.status);
      setAgencyId(user.agency_id);
    }
  }, [user]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!user) throw new Error("no user");
      const payload: Parameters<typeof saApi.patchUser>[1] = {};
      if (role !== user.role) payload.role = role;
      if (isActive !== user.is_active) payload.is_active = isActive;
      if (status !== user.status) payload.status = status;
      if (agencyId !== user.agency_id) payload.agency_id = agencyId.trim();
      return saApi.patchUser(user.id, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["super-admin", "users"] });
      toast.success("User updated.");
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(isApiError(err) ? err.message : "Couldn't save."),
  });

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{user?.full_name ?? user?.email}</DialogTitle>
          <DialogDescription>
            {user?.email} ·{" "}
            <code className="font-mono">{user?.id}</code>
          </DialogDescription>
        </DialogHeader>

        {user ? (
          <div className="space-y-3">
            <Field label="Role">
              <Select
                value={role}
                onValueChange={(v) => setRole(v as UserRole)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USER_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={status}
                onValueChange={(v) =>
                  setStatus(v as "pending" | "active" | "rejected")
                }
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Agency ID">
              <Input
                value={agencyId}
                onChange={(e) => setAgencyId(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                Must reference an existing agency. Backend validates.
              </p>
            </Field>
            <div className="flex items-center gap-3 rounded-md border border-border/60 p-3">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              <div>
                <p className="text-sm font-medium">
                  {isActive ? "Active" : "Deactivated"}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Deactivation bumps token_version and kills outstanding JWTs.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1.5" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Usage tab ─────────────────────────────────────────────────────────────

function UsageTab({
  agencyId,
  onSelectAgency,
}: {
  agencyId: string | null;
  onSelectAgency: (id: string) => void;
}) {
  const agenciesQuery = useQuery({
    queryKey: ["super-admin", "agencies", "all-for-usage"],
    queryFn: () => saApi.listAgencies(),
  });

  const usageQuery = useQuery({
    queryKey: ["super-admin", "agency-usage", agencyId],
    queryFn: () => saApi.getAgencyUsage(agencyId!),
    enabled: !!agencyId,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-3 md:p-4 flex flex-wrap items-center gap-2">
          <Label className="text-[11px] text-muted-foreground">Agency</Label>
          <Select
            value={agencyId ?? ""}
            onValueChange={(v) => onSelectAgency(v)}
          >
            <SelectTrigger className="h-9 w-[280px]">
              <SelectValue placeholder="Pick an agency…" />
            </SelectTrigger>
            <SelectContent>
              {agenciesQuery.data?.agencies.map((a) => (
                <SelectItem key={a.agency_id} value={a.agency_id}>
                  {a.name} · {a.tier}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {!agencyId ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground text-sm">
            <Zap className="h-10 w-10 mx-auto mb-3" />
            Pick an agency above to inspect usage.
          </CardContent>
        </Card>
      ) : usageQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : usageQuery.isError || !usageQuery.data ? (
        <Card>
          <CardContent className="p-10 text-center text-destructive">
            Couldn&apos;t load usage.
          </CardContent>
        </Card>
      ) : (
        <UsageDetail data={usageQuery.data} />
      )}
    </div>
  );
}

function UsageDetail({
  data,
}: {
  data: NonNullable<ReturnType<typeof saApi.getAgencyUsage>> extends Promise<infer R> ? R : never;
}) {
  return (
    <Card>
      <CardContent className="p-5 space-y-5">
        <div>
          <h3 className="text-sm font-semibold">
            {data.agency.name}{" "}
            <span className="text-xs text-muted-foreground font-normal">
              · {data.billing_period}
            </span>
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-[10px] capitalize">
              {data.agency.tier}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] capitalize",
                STATUS_TINT[data.agency.billing_status] ??
                  STATUS_TINT.cancelled,
              )}
            >
              {data.agency.billing_status.replace("_", " ")}
            </Badge>
            {data.usage.live ? (
              <Badge
                variant="outline"
                className="text-[10px] bg-primary/15 text-primary border-primary/30"
              >
                live aggregate
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                rollup
              </Badge>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <UsageBar
            label="AI calls"
            value={data.usage.ai_calls_total}
            limit={data.limits.ai_calls_included}
          />
          <UsageBar
            label="Emails sent"
            value={data.usage.emails_sent}
            limit={data.limits.emails_included}
          />
          <UsageBar
            label="App intakes"
            value={data.usage.app_intakes}
            limit={data.limits.app_intakes_included}
          />
          <UsageBar
            label="Storage"
            value={data.usage.storage_gb}
            limit={data.limits.storage_gb_included}
            unit="GB"
            fractional
          />
          <UsageBar
            label="Seats"
            value={data.agency.seats_active}
            limit={
              data.agency.seats_max === -1 ? -1 : data.agency.seats_max
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

function UsageBar({
  label,
  value,
  limit,
  unit,
  fractional,
}: {
  label: string;
  value: number;
  limit: number;
  unit?: string;
  fractional?: boolean;
}) {
  const unlimited = limit === -1;
  const pct = unlimited
    ? 0
    : limit > 0
      ? Math.min(100, Math.round((value / limit) * 100))
      : 0;
  const over = !unlimited && pct >= 100;
  const near = !unlimited && pct >= 80 && pct < 100;

  function fmt(v: number) {
    if (fractional) return v.toFixed(2);
    return v.toLocaleString();
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs mb-1">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {fmt(value)}
          {unit ? ` ${unit}` : ""}
          {unlimited ? (
            <span className="ml-1 text-[10px]"> / unlimited</span>
          ) : (
            <>
              {" "}
              / {fmt(limit)}
              {unit ? ` ${unit}` : ""}
            </>
          )}
        </span>
      </div>
      {!unlimited ? (
        <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full",
              over
                ? "bg-destructive"
                : near
                  ? "bg-ghw-copper"
                  : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

// ─── System tab ────────────────────────────────────────────────────────────

function SystemTab() {
  const query = useQuery({
    queryKey: ["super-admin", "system"],
    queryFn: () => saApi.getSystem(),
    refetchInterval: 60_000,
  });

  if (query.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (query.isError || !query.data) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-destructive">
          Couldn&apos;t load system snapshot.
        </CardContent>
      </Card>
    );
  }

  const sys = query.data;
  const agencies = !isSystemError(sys.agencies) ? sys.agencies : null;
  const users = !isSystemError(sys.users) ? sys.users : null;
  const env = !isSystemError(sys.env) ? sys.env : null;
  const features = !isSystemError(sys.feature_registry)
    ? sys.feature_registry
    : null;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground tabular-nums">
        Generated {new Date(sys.generated_at).toLocaleString()} · billing
        period {sys.billing_period}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Agencies</h3>
            </div>
            {!agencies ? (
              <p className="text-xs text-destructive">unavailable</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <SystemTile label="Total" value={agencies.total} />
                <SystemTile
                  label="Active"
                  value={agencies.active}
                  tint="forest"
                />
                <SystemTile
                  label="Past due"
                  value={agencies.past_due}
                  tint={agencies.past_due > 0 ? "copper" : undefined}
                />
                <SystemTile
                  label="Suspended"
                  value={agencies.suspended}
                  tint={agencies.suspended > 0 ? "destructive" : undefined}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Users</h3>
            </div>
            {!users ? (
              <p className="text-xs text-destructive">unavailable</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <SystemTile label="Total" value={users.total} />
                <SystemTile
                  label="Active"
                  value={users.active}
                  tint="forest"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Environment</h3>
          </div>
          {!env ? (
            <p className="text-xs text-destructive">unavailable</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <EnvCheck
                icon={<CreditCard className="h-3 w-3" />}
                label="Stripe secret"
                ok={env.stripe_secret_configured}
              />
              <EnvCheck
                icon={<CreditCard className="h-3 w-3" />}
                label="Stripe webhook"
                ok={env.stripe_webhook_configured}
              />
              <EnvCheck
                icon={<Sparkles className="h-3 w-3" />}
                label="Stripe mock mode"
                ok={!env.stripe_mock_mode}
                warningInsteadOfMissing
              />
              <EnvCheck
                icon={<Mail className="h-3 w-3" />}
                label="Resend"
                ok={env.resend_configured}
              />
              <EnvCheck
                icon={<Sparkles className="h-3 w-3" />}
                label="Anthropic"
                ok={env.anthropic_configured}
              />
              <div className="col-span-2 md:col-span-3 text-xs">
                <span className="text-muted-foreground">Frontend URL:</span>{" "}
                <code className="font-mono">{env.frontend_url}</code>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {features ? (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">
                Feature registry
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  ({features.length})
                </span>
              </h3>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {features.map((f) => (
                <Badge key={f} variant="outline" className="text-[10px]">
                  {f}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SystemTile({
  label,
  value,
  tint,
}: {
  label: string;
  value: number;
  tint?: "forest" | "copper" | "destructive";
}) {
  const tintClass =
    tint === "forest"
      ? "text-ghw-forest"
      : tint === "copper"
        ? "text-ghw-copper"
        : tint === "destructive"
          ? "text-destructive"
          : "";
  return (
    <div className="rounded-md bg-secondary/30 p-2 text-center">
      <p className="text-[9px] text-muted-foreground uppercase tracking-widest">
        {label}
      </p>
      <p className={cn("text-base font-bold tabular-nums", tintClass)}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function EnvCheck({
  icon,
  label,
  ok,
  warningInsteadOfMissing,
}: {
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  warningInsteadOfMissing?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md p-2 flex items-center gap-2 text-xs border",
        ok
          ? "bg-ghw-forest/5 border-ghw-forest/30 text-ghw-forest"
          : warningInsteadOfMissing
            ? "bg-ghw-copper/5 border-ghw-copper/30 text-ghw-copper"
            : "bg-destructive/5 border-destructive/30 text-destructive",
      )}
    >
      {icon}
      <span className="flex-1 truncate font-medium">{label}</span>
      {ok ? (
        <Check className="h-3 w-3" />
      ) : warningInsteadOfMissing ? (
        <AlertCircle className="h-3 w-3" />
      ) : (
        <X className="h-3 w-3" />
      )}
    </div>
  );
}

// ─── Tiny helpers ──────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
