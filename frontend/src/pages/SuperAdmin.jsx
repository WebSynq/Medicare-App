import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Sparkles,
  Building2,
  Users2,
  Activity,
  Settings as SettingsIcon,
  Search,
  Save,
  X,
  CheckCircle2,
  AlertTriangle,
  ShieldOff,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

import { api } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────
// Tier + status palettes mirror the backend's billing_status enum +
// the four tier keys.  Keep the colour math in one place so a tier
// rename only needs editing here.
// ─────────────────────────────────────────────────────────────────────
const TIER_KEYS = ["beta", "foundation", "growth", "domination"];
const TIER_LABELS = {
  beta: "Beta",
  foundation: "Foundation",
  growth: "Growth",
  domination: "Domination",
};
const TIER_BADGE = {
  beta:        "bg-slate-200 text-slate-900",
  foundation:  "bg-blue-100 text-blue-900",
  growth:      "bg-purple-100 text-purple-900",
  domination:  "bg-amber-100 text-amber-900",
};

const BILLING_STATUSES = [
  "trialing", "active", "past_due", "suspended", "cancelled",
];
const BILLING_BADGE = {
  trialing:  "bg-sky-100 text-sky-900",
  active:    "bg-emerald-100 text-emerald-900",
  past_due:  "bg-amber-100 text-amber-900",
  suspended: "bg-rose-100 text-rose-900",
  cancelled: "bg-gray-200 text-gray-700",
};

const USER_ROLES = [
  "admin", "owner", "agent", "compliance",
  "va", "support", "crm_specialist",
  "cyber_security", "sales_manager", "onboarding",
  "client_success", "coach", "accounting",
];

// ─────────────────────────────────────────────────────────────────────
// Top-level page — owns the access guard, current tab, and the four
// per-tab data fetches.  Tab data is fetched lazily on first visit so
// opening the page doesn't fan out four parallel requests.
// ─────────────────────────────────────────────────────────────────────
export default function SuperAdmin() {
  const navigate = useNavigate();
  const [accessChecked, setAccessChecked] = useState(false);
  const [accessOk, setAccessOk] = useState(false);
  const [tab, setTab] = useState("agencies");

  // Single authoritative ping — if we can hit /super-admin/system the
  // server thinks we're a super admin.  Anything else (403/401/500)
  // bounces back to /today.  Keeps the gate honest even if a stale
  // JWT in localStorage claims super_admin.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await api.get("/super-admin/system");
        if (alive) {
          setAccessOk(true);
          setAccessChecked(true);
        }
      } catch (err) {
        if (!alive) return;
        setAccessOk(false);
        setAccessChecked(true);
        const code = err?.response?.status;
        if (code === 401) {
          navigate("/login", { replace: true });
        } else {
          // 403, 404, or any failure — surface to /dashboard.
          toast.error(
            "Super admin access required.",
            { id: "super-admin-denied" },
          );
          navigate("/today", { replace: true });
        }
      }
    })();
    return () => { alive = false; };
  }, [navigate]);

  if (!accessChecked) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        Verifying super admin access…
      </div>
    );
  }
  if (!accessOk) {
    // We've already navigated away by the time we hit this — render
    // a blank to avoid a flash of the table on the way out.
    return null;
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1400px] mx-auto w-full">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-[#e85d2f]" />
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Platform
            </p>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Super Admin Console
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cross-tenant view of every agency, user, and platform-wide
            health signal. Every action on this page is audit-logged.
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList>
            <TabsTrigger value="agencies" data-testid="super-tab-agencies">
              <Building2 className="w-3.5 h-3.5 mr-1.5" />
              Agencies
            </TabsTrigger>
            <TabsTrigger value="users" data-testid="super-tab-users">
              <Users2 className="w-3.5 h-3.5 mr-1.5" />
              Users
            </TabsTrigger>
            <TabsTrigger value="usage" data-testid="super-tab-usage">
              <Activity className="w-3.5 h-3.5 mr-1.5" />
              Usage
            </TabsTrigger>
            <TabsTrigger value="system" data-testid="super-tab-system">
              <SettingsIcon className="w-3.5 h-3.5 mr-1.5" />
              System
            </TabsTrigger>
          </TabsList>

          <TabsContent value="agencies" className="mt-4">
            <AgenciesTab />
          </TabsContent>
          <TabsContent value="users" className="mt-4">
            <UsersTab />
          </TabsContent>
          <TabsContent value="usage" className="mt-4">
            <UsageTab />
          </TabsContent>
          <TabsContent value="system" className="mt-4">
            <SystemTab />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// Agencies tab
// ═══════════════════════════════════════════════════════════════════
function AgenciesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [editing, setEditing] = useState(null);   // agency dict or null

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (q.trim()) params.q = q.trim();
      if (tierFilter !== "all") params.tier = tierFilter;
      const { data } = await api.get("/super-admin/agencies", { params });
      setRows(data?.agencies || []);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Failed to load agencies",
      );
    } finally {
      setLoading(false);
    }
  }, [q, tierFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <Card className="mb-3">
        <CardContent className="p-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name or slug…"
              className="pl-9 h-10"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="super-agencies-search"
            />
          </div>
          <Select value={tierFilter} onValueChange={setTierFilter}>
            <SelectTrigger className="w-40 h-10"
                            data-testid="super-agencies-tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tiers</SelectItem>
              {TIER_KEYS.map((t) => (
                <SelectItem key={t} value={t}>{TIER_LABELS[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead>Seats</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={8}
                              className="text-center text-sm text-muted-foreground py-6">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8}
                              className="text-center text-sm text-muted-foreground py-6">
                    No agencies match these filters.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((a) => (
                <TableRow key={a.agency_id}
                           data-testid={`super-agency-row-${a.agency_id}`}>
                  <TableCell className="font-medium">
                    {a.name}
                    {a.super_admin && (
                      <Badge className="ml-2 bg-amber-100 text-amber-900 text-[10px]">
                        SUPER
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.slug}
                  </TableCell>
                  <TableCell>
                    <Badge className={`rounded-full capitalize ${TIER_BADGE[a.tier] || "bg-gray-100"}`}>
                      {TIER_LABELS[a.tier] || a.tier}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={`rounded-full capitalize ${BILLING_BADGE[a.billing_status] || "bg-gray-100"}`}>
                      {a.billing_status?.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {a.seats_active_live ?? 0}
                    {a.seats_max !== undefined && a.seats_max !== -1
                      ? ` / ${a.seats_max}`
                      : a.seats_max === -1 ? " / ∞" : ""}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {a.owner_email}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.created_at
                      ? new Date(a.created_at).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline"
                             onClick={() => setEditing(a)}
                             data-testid={`super-agency-edit-${a.agency_id}`}>
                      Manage
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing && (
        <AgencyEditDialog
          agency={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setRows((r) =>
              r.map((row) =>
                row.agency_id === updated.agency_id
                  ? { ...row, ...updated }
                  : row,
              ),
            );
            setEditing(null);
            toast.success("Agency updated");
          }}
        />
      )}
    </>
  );
}


// ─────────────────────────────────────────────────────────────────────
// Edit-agency dialog — tier picker, billing status, seats_max, and a
// feature-flag toggle grid grouped by tier band.  The dialog only
// PATCHes fields the user actually touched — keeps the audit log
// noise-free.
// ─────────────────────────────────────────────────────────────────────
function AgencyEditDialog({ agency, onClose, onSaved }) {
  const [tier, setTier] = useState(agency.tier || "beta");
  const [billing, setBilling] = useState(agency.billing_status || "trialing");
  const [seatsMax, setSeatsMax] = useState(
    agency.seats_max === undefined ? "" : String(agency.seats_max),
  );
  const [features, setFeatures] = useState(agency.features || {});
  const [applyDefaults, setApplyDefaults] = useState(false);
  const [saving, setSaving] = useState(false);

  // Group feature keys for the toggle grid.  Mirrors the conceptual
  // tier bands but is presentational only — the backend's
  // FEATURE_REGISTRY is the source of truth for which keys exist.
  const FEATURE_GROUPS = useMemo(() => ({
    "Foundation": [
      "crm", "leads", "clients", "documents", "soa",
      "birthday_rule", "renewals", "pipeline", "leaderboard",
      "basic_automations", "audit_log", "commission_tracking",
    ],
    "Growth": [
      "booking_system", "advanced_automations",
      "ai_application_intake", "ghl_import", "ai_daily_brief",
      "lead_scoring",
    ],
    "Domination": [
      "cna", "ai_client_intelligence", "aep_war_room",
      "agency_dashboard", "ops_console",
    ],
    "Add-ons": [
      "va_access", "meta_attribution", "dialer", "quoting",
      "api_access", "custom_reporting",
    ],
  }), []);

  const toggleFeature = (key) => {
    setFeatures((f) => ({ ...f, [key]: !f?.[key] }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {};
      if (tier !== agency.tier) body.tier = tier;
      if (billing !== agency.billing_status) body.billing_status = billing;
      // Only send features that actually differ — keeps the audit row
      // metadata short.
      const featuresDiff = {};
      for (const k of Object.keys(features || {})) {
        if ((agency.features || {})[k] !== features[k]) {
          featuresDiff[k] = features[k];
        }
      }
      if (Object.keys(featuresDiff).length > 0) {
        body.features = featuresDiff;
      }
      const desiredSeats = seatsMax === "" ? null : Number(seatsMax);
      if (desiredSeats !== null && desiredSeats !== agency.seats_max) {
        body.seats_max = desiredSeats;
      }
      if (applyDefaults && body.tier) {
        body.apply_tier_defaults = true;
      }
      if (Object.keys(body).length === 0) {
        toast.message("No changes to save");
        setSaving(false);
        return;
      }
      const { data } = await api.patch(
        `/super-admin/agencies/${encodeURIComponent(agency.agency_id)}`,
        body,
      );
      onSaved(data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage {agency.name}</DialogTitle>
          <DialogDescription>
            Agency ID <code>{agency.agency_id}</code>.
            Every save here is written to the audit log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider">
                Tier
              </Label>
              <Select value={tier} onValueChange={setTier}>
                <SelectTrigger data-testid="super-edit-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIER_KEYS.map((t) => (
                    <SelectItem key={t} value={t}>{TIER_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider">
                Billing status
              </Label>
              <Select value={billing} onValueChange={setBilling}>
                <SelectTrigger data-testid="super-edit-billing">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILLING_STATUSES.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider">
                Seats max
              </Label>
              <Input
                type="number"
                value={seatsMax}
                onChange={(e) => setSeatsMax(e.target.value)}
                placeholder="-1 for unlimited"
                data-testid="super-edit-seats-max"
              />
            </div>
          </div>

          {tier !== agency.tier && (
            <label className="flex items-start gap-2 text-sm rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
              <input
                type="checkbox"
                checked={applyDefaults}
                onChange={(e) => setApplyDefaults(e.target.checked)}
                data-testid="super-edit-apply-defaults"
              />
              <span>
                Reset feature flags + limits to <strong>{TIER_LABELS[tier]}</strong> defaults.
                Wipes any custom overrides.
              </span>
            </label>
          )}

          <div>
            <Label className="text-xs uppercase tracking-wider">
              Feature flags
            </Label>
            <div className="space-y-3 mt-2">
              {Object.entries(FEATURE_GROUPS).map(([group, keys]) => (
                <div key={group}>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">
                    {group}
                  </div>
                  <div className="grid md:grid-cols-2 gap-x-3 gap-y-1.5">
                    {keys.map((k) => (
                      <label
                        key={k}
                        className="flex items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(features?.[k])}
                          onChange={() => toggleFeature(k)}
                          data-testid={`super-edit-feature-${k}`}
                        />
                        <span className="font-mono text-xs">{k}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}
                   disabled={saving}>
            <X className="w-4 h-4 mr-1" /> Cancel
          </Button>
          <Button onClick={save} disabled={saving}
                   data-testid="super-edit-save">
            <Save className="w-4 h-4 mr-1" />
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


// ═══════════════════════════════════════════════════════════════════
// Users tab
// ═══════════════════════════════════════════════════════════════════
function UsersTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [agencyFilter, setAgencyFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (q.trim()) params.q = q.trim();
      if (agencyFilter.trim()) params.agency_id = agencyFilter.trim();
      const { data } = await api.get("/super-admin/users", { params });
      setRows(data?.users || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [q, agencyFilter]);

  useEffect(() => { load(); }, [load]);

  const patch = async (user_id, body) => {
    try {
      const { data } = await api.patch(
        `/super-admin/users/${encodeURIComponent(user_id)}`,
        body,
      );
      setRows((r) =>
        r.map((u) => (u.id === user_id ? { ...u, ...data } : u)),
      );
      toast.success("User updated");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to update user");
    }
  };

  return (
    <>
      <Card className="mb-3">
        <CardContent className="p-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by email or name…"
              className="pl-9 h-10"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="super-users-search"
            />
          </div>
          <Input
            placeholder="Agency ID filter"
            className="w-56 h-10"
            value={agencyFilter}
            onChange={(e) => setAgencyFilter(e.target.value)}
            data-testid="super-users-agency"
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Agency</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={7}
                              className="text-center text-sm text-muted-foreground py-6">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7}
                              className="text-center text-sm text-muted-foreground py-6">
                    No users match these filters.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((u) => (
                <TableRow key={u.id}
                           data-testid={`super-user-row-${u.id}`}>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell className="text-sm">
                    {u.full_name || u.agent_name || "—"}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={u.role}
                      onValueChange={(v) => patch(u.id, { role: v })}
                    >
                      <SelectTrigger className="h-8 w-36 text-xs"
                                      data-testid={`super-user-role-${u.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {USER_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {u.agency_id || "—"}
                  </TableCell>
                  <TableCell>
                    {u.is_active ? (
                      <Badge className="bg-emerald-100 text-emerald-900">
                        Active
                      </Badge>
                    ) : (
                      <Badge className="bg-gray-200 text-gray-700">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.created_at
                      ? new Date(u.created_at).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {u.is_active ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => patch(u.id, { is_active: false })}
                        data-testid={`super-user-deactivate-${u.id}`}
                      >
                        <ShieldOff className="w-3.5 h-3.5 mr-1" />
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => patch(u.id, { is_active: true })}
                        data-testid={`super-user-reactivate-${u.id}`}
                      >
                        Reactivate
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}


// ═══════════════════════════════════════════════════════════════════
// Usage tab — pick an agency, view their period usage
// ═══════════════════════════════════════════════════════════════════
function UsageTab() {
  const [agencies, setAgencies] = useState([]);
  const [selected, setSelected] = useState("");
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/super-admin/agencies");
        const list = data?.agencies || [];
        setAgencies(list);
        if (list.length > 0 && !selected) {
          setSelected(list[0].agency_id);
        }
      } catch {
        // handled by sibling tabs
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get(
          `/super-admin/agencies/${encodeURIComponent(selected)}/usage`,
        );
        if (alive) setUsage(data);
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Failed to load usage");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [selected]);

  const limits = usage?.limits || {};
  const u = usage?.usage || {};
  const a = usage?.agency || {};

  return (
    <>
      <Card className="mb-3">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <Label className="text-xs uppercase tracking-wider">
            Agency
          </Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="w-72 h-10"
                            data-testid="super-usage-picker">
              <SelectValue placeholder="Pick an agency…" />
            </SelectTrigger>
            <SelectContent>
              {agencies.map((ag) => (
                <SelectItem key={ag.agency_id} value={ag.agency_id}>
                  {ag.name} ({ag.slug})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {usage && (
            <span className="text-xs text-muted-foreground">
              Period {usage.billing_period}
              {u.live && (
                <Badge className="ml-2 text-[10px] bg-blue-100 text-blue-900">
                  LIVE
                </Badge>
              )}
            </span>
          )}
        </CardContent>
      </Card>

      {loading && (
        <p className="text-sm text-muted-foreground text-center py-6">
          Loading…
        </p>
      )}

      {!loading && usage && (
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
          <UsageStat
            label="AI calls"
            current={u.ai_calls_total || 0}
            limit={limits.ai_calls_included}
          />
          <UsageStat
            label="Emails sent"
            current={u.emails_sent || 0}
            limit={limits.emails_included}
          />
          <UsageStat
            label="App intakes"
            current={u.app_intakes || 0}
            limit={limits.app_intakes_included}
          />
          <UsageStat
            label="Storage (GB)"
            current={Number(u.storage_gb || 0).toFixed(2)}
            limit={limits.storage_gb_included}
            decimals
          />
          <UsageStat
            label="Seats"
            current={a.seats_active || 0}
            limit={a.seats_max}
          />
        </div>
      )}
    </>
  );
}

function UsageStat({ label, current, limit, decimals = false }) {
  const isUnlimited = limit === -1 || limit === undefined || limit === null;
  const pct = isUnlimited || limit === 0
    ? 0
    : Math.min(100, (Number(current) / Number(limit)) * 100);
  const bar = pct >= 90 ? "bg-rose-500"
    : pct >= 70 ? "bg-amber-500"
    : "bg-emerald-500";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div className="text-2xl font-bold mt-1 tabular-nums"
             style={{ fontFamily: "Outfit" }}>
          {current}
          <span className="text-sm text-muted-foreground font-normal">
            {" "}/ {isUnlimited ? "∞" : limit}
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2 mt-2 overflow-hidden">
          <div className={`${bar} h-full`}
               style={{ width: isUnlimited ? "0%" : `${pct}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}


// ═══════════════════════════════════════════════════════════════════
// System tab — env health + tallies
// ═══════════════════════════════════════════════════════════════════
function SystemTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/super-admin/system");
        if (alive) setData(data);
      } catch (err) {
        toast.error(
          err?.response?.data?.detail || "Failed to load system status",
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        Loading…
      </p>
    );
  }
  if (!data) return null;

  const env = data.env || {};
  const agenciesT = data.agencies || {};
  const usersT = data.users || {};

  return (
    <div className="space-y-4">
      {env.stripe_mock_mode && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 flex items-start gap-3"
                        data-testid="super-stripe-mock-banner">
            <AlertTriangle className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-semibold text-amber-900 text-sm">
                Stripe in mock mode
              </div>
              <p className="text-xs text-amber-900/80 mt-1">
                <code>STRIPE_SECRET_KEY</code> is not set. Checkout +
                portal endpoints will 503. Set the key on Render to
                go live.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total agencies" value={agenciesT.total ?? "—"} />
        <StatCard label="Active / trialing" value={agenciesT.active ?? "—"} />
        <StatCard label="Past due" value={agenciesT.past_due ?? "—"}
                   tone={agenciesT.past_due ? "amber" : "default"} />
        <StatCard label="Suspended" value={agenciesT.suspended ?? "—"}
                   tone={agenciesT.suspended ? "rose" : "default"} />
        <StatCard label="Total users" value={usersT.total ?? "—"} />
        <StatCard label="Active users" value={usersT.active ?? "—"} />
        <StatCard label="Billing period" value={data.billing_period} />
        <StatCard label="Feature keys"
                   value={(data.feature_registry || []).length} />
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="text-xs uppercase tracking-widest text-muted-foreground mb-2">
            Environment health
          </div>
          <div className="grid md:grid-cols-2 gap-y-1.5">
            <EnvRow label="Stripe API key" ok={env.stripe_secret_configured} />
            <EnvRow label="Stripe webhook secret" ok={env.stripe_webhook_configured} />
            <EnvRow label="Resend (email)" ok={env.resend_configured} />
            <EnvRow label="Anthropic (AI)" ok={env.anthropic_configured} />
            <EnvRow label="Frontend URL"
                     ok={Boolean(env.frontend_url)}
                     detail={env.frontend_url || "unset"} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, tone = "default" }) {
  const ring =
    tone === "amber" ? "ring-1 ring-amber-300"
    : tone === "rose" ? "ring-1 ring-rose-300"
    : "";
  return (
    <Card className={ring}>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div className="text-2xl font-bold mt-1 tabular-nums"
             style={{ fontFamily: "Outfit" }}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function EnvRow({ label, ok, detail }) {
  return (
    <div className="flex items-center gap-2 text-sm"
         data-testid={`super-env-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      {ok ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
      ) : (
        <AlertTriangle className="w-4 h-4 text-amber-600" />
      )}
      <span className="text-muted-foreground w-44 flex-shrink-0">
        {label}
      </span>
      <span className="font-medium">
        {detail ? detail : (ok ? "Configured" : "Not set")}
      </span>
    </div>
  );
}
