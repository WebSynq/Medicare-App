import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Settings as SettingsIcon,
  Building2,
  Users2,
  Activity,
  CreditCard,
  Save,
  ShieldOff,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Plus,
  Copy,
  Sparkles,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

import { api, auth } from "@/lib/api";
import InviteAgentModal from "@/components/InviteAgentModal";


const TIER_LABELS = {
  beta: "Beta",
  foundation: "Foundation",
  growth: "Growth",
  domination: "Domination",
};
const TIER_PRICE_LABELS = {
  beta: "$297 / mo",
  foundation: "$297 / mo",
  growth: "$497 / mo",
  domination: "$997 / mo",
};
const TIER_BADGE = {
  beta:       "bg-slate-200 text-slate-900",
  foundation: "bg-blue-100 text-blue-900",
  growth:     "bg-purple-100 text-purple-900",
  domination: "bg-amber-100 text-amber-900",
};
const BILLING_BADGE = {
  trialing:  "bg-sky-100 text-sky-900",
  active:    "bg-emerald-100 text-emerald-900",
  past_due:  "bg-amber-100 text-amber-900",
  suspended: "bg-rose-100 text-rose-900",
  cancelled: "bg-gray-200 text-gray-700",
};

// Roles that can write through the owner settings surface. Mirrors
// the backend's _require_owner_or_admin gate exactly so the SPA
// hides controls the server would 403 anyway.
const WRITE_ROLES = new Set(["owner", "admin"]);


// ═══════════════════════════════════════════════════════════════════
// Top-level page
// ═══════════════════════════════════════════════════════════════════
export default function OwnerSettings() {
  const navigate = useNavigate();
  const me = auth.getUser();
  const canWrite = me && WRITE_ROLES.has((me.role || "").toLowerCase());

  // Owner gate — non-owner/admin roles get bounced to /today with a
  // toast. We also enforce server-side; this is just to avoid a
  // confused user landing on a page they can't use.
  useEffect(() => {
    if (!me) {
      navigate("/login", { replace: true });
      return;
    }
    if (!canWrite) {
      toast.error("Owner access required for agency settings.",
                   { id: "owner-settings-denied" });
      navigate("/today", { replace: true });
    }
  }, [me, canWrite, navigate]);

  const [tab, setTab] = useState("agency");

  if (!me || !canWrite) return null;

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-[1200px] mx-auto w-full">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <SettingsIcon className="w-4 h-4 text-[#e85d2f]" />
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              Agency
            </p>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Agency Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your agency identity, team seats, current-period
            usage, and billing.
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList>
            <TabsTrigger value="agency" data-testid="owner-tab-agency">
              <Building2 className="w-3.5 h-3.5 mr-1.5" />
              Agency
            </TabsTrigger>
            <TabsTrigger value="seats" data-testid="owner-tab-seats">
              <Users2 className="w-3.5 h-3.5 mr-1.5" />
              Seats
            </TabsTrigger>
            <TabsTrigger value="usage" data-testid="owner-tab-usage">
              <Activity className="w-3.5 h-3.5 mr-1.5" />
              Usage
            </TabsTrigger>
            <TabsTrigger value="billing" data-testid="owner-tab-billing">
              <CreditCard className="w-3.5 h-3.5 mr-1.5" />
              Billing
            </TabsTrigger>
          </TabsList>

          <TabsContent value="agency" className="mt-4">
            <AgencyTab />
          </TabsContent>
          <TabsContent value="seats" className="mt-4">
            <SeatsTab />
          </TabsContent>
          <TabsContent value="usage" className="mt-4">
            <UsageTab />
          </TabsContent>
          <TabsContent value="billing" className="mt-4">
            <BillingTab />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// Agency tab — display name edit + read-only identity
// ═══════════════════════════════════════════════════════════════════
function AgencyTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/agency/settings");
      setData(data);
      setName(data?.name || "");
    } catch (err) {
      toast.error(err?.response?.data?.detail
                   || "Failed to load agency settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!name.trim()) {
      toast.error("Name cannot be empty");
      return;
    }
    if (name.trim() === data?.name) {
      toast.message("No changes to save");
      return;
    }
    setSaving(true);
    try {
      const { data: updated } = await api.patch(
        "/agency/settings", { name: name.trim() },
      );
      setData(updated);
      toast.success("Agency name updated");
    } catch (err) {
      toast.error(err?.response?.data?.detail
                   || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground p-6">Loading…</p>;
  }
  if (!data) return null;

  return (
    <Card>
      <CardContent className="p-5 space-y-5">
        <div>
          <Label htmlFor="agency-name" className="text-xs uppercase tracking-wider">
            Agency name
          </Label>
          <div className="flex gap-2 mt-1">
            <Input
              id="agency-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              data-testid="owner-agency-name"
            />
            <Button onClick={save} disabled={saving}
                     data-testid="owner-agency-save">
              <Save className="w-4 h-4 mr-1" />
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4 pt-2 border-t border-border">
          <ReadOnlyField label="Agency ID" value={data.agency_id} copyable />
          <ReadOnlyField label="Slug" value={data.slug} />
          <ReadOnlyField
            label="Current tier"
            value={
              <Badge className={`rounded-full ${TIER_BADGE[data.tier] || "bg-gray-100"}`}>
                {TIER_LABELS[data.tier] || data.tier}
              </Badge>
            }
            footnote="Tier changes are managed by the GHW platform team."
          />
          <ReadOnlyField
            label="Billing status"
            value={
              <Badge className={`rounded-full capitalize ${BILLING_BADGE[data.billing_status] || "bg-gray-100"}`}>
                {(data.billing_status || "").replace("_", " ")}
              </Badge>
            }
          />
          <ReadOnlyField
            label="Seats included"
            value={data.seats_included === -1 ? "Unlimited" : data.seats_included}
          />
          <ReadOnlyField
            label="Seats max"
            value={data.seats_max === -1 ? "Unlimited" : data.seats_max}
          />
        </div>
      </CardContent>
    </Card>
  );
}


function ReadOnlyField({ label, value, copyable, footnote }) {
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      toast.success("Copied");
    } catch { toast.error("Couldn't copy"); }
  };
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider">{label}</Label>
      <div className="mt-1 flex items-center gap-2 text-sm">
        <div className="font-medium truncate">{value || "—"}</div>
        {copyable && value && (
          <Button variant="ghost" size="icon" onClick={onCopy}
                   className="h-7 w-7">
            <Copy className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
      {footnote && (
        <p className="text-xs text-muted-foreground mt-1">{footnote}</p>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// Seats tab
// ═══════════════════════════════════════════════════════════════════
function SeatsTab() {
  const [rows, setRows] = useState([]);
  const [agencyData, setAgencyData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: usersRes }, { data: settingsRes }] = await Promise.all([
        api.get("/agency/users"),
        api.get("/agency/settings"),
      ]);
      setRows(usersRes?.users || []);
      setAgencyData(settingsRes);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to load seats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const me = auth.getUser();
  const myId = me?.id;

  const deactivate = async (userId) => {
    try {
      await api.patch(`/agency/users/${encodeURIComponent(userId)}`,
                       { is_active: false });
      setRows((r) =>
        r.map((u) => (u.id === userId ? { ...u, is_active: false } : u)),
      );
      toast.success("User deactivated");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to deactivate");
    }
  };

  const reactivate = async (userId) => {
    try {
      await api.patch(`/agency/users/${encodeURIComponent(userId)}`,
                       { is_active: true });
      setRows((r) =>
        r.map((u) => (u.id === userId ? { ...u, is_active: true } : u)),
      );
      toast.success("User reactivated");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to reactivate");
    }
  };

  const activeCount = rows.filter((u) => u.is_active).length;
  const seatsMax = agencyData?.seats_max;
  const seatsLabel =
    seatsMax === -1 || seatsMax === undefined || seatsMax === null
      ? "Unlimited"
      : seatsMax;
  const atCap = seatsMax !== -1 && seatsMax !== undefined
                 && seatsMax !== null && activeCount >= seatsMax;

  return (
    <>
      <Card className="mb-3">
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="font-semibold">{activeCount}</span>
            <span className="text-muted-foreground"> active</span>
            <span className="text-muted-foreground"> / </span>
            <span className="font-semibold">{seatsLabel}</span>
            <span className="text-muted-foreground"> seats</span>
            {atCap && (
              <Badge className="ml-3 bg-amber-100 text-amber-900">
                AT CAP
              </Badge>
            )}
          </div>
          <Button onClick={() => setShowInvite(true)} disabled={atCap}
                   data-testid="owner-seats-invite">
            <Plus className="w-4 h-4 mr-1" />
            Invite teammate
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5}
                              className="text-center text-sm text-muted-foreground py-6">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}
                              className="text-center text-sm text-muted-foreground py-6">
                    No teammates yet. Invite your first one above.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((u) => (
                <TableRow key={u.id}
                           data-testid={`owner-seats-row-${u.id}`}>
                  <TableCell className="font-medium">
                    {u.full_name || u.agent_name || "—"}
                  </TableCell>
                  <TableCell className="text-sm">{u.email}</TableCell>
                  <TableCell className="text-sm capitalize">
                    {u.role?.replace("_", " ")}
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
                  <TableCell className="text-right">
                    {u.id === myId ? (
                      <span className="text-xs text-muted-foreground">
                        That's you
                      </span>
                    ) : u.is_active ? (
                      <Button size="sm" variant="outline"
                               onClick={() => deactivate(u.id)}
                               data-testid={`owner-seats-deactivate-${u.id}`}>
                        <ShieldOff className="w-3.5 h-3.5 mr-1" />
                        Deactivate
                      </Button>
                    ) : (
                      <Button size="sm"
                               onClick={() => reactivate(u.id)}
                               data-testid={`owner-seats-reactivate-${u.id}`}>
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

      {showInvite && (
        <InviteAgentModal onClose={() => {
          setShowInvite(false);
          // Refresh the list so a fresh invite shows up if/when the
          // user accepts. The roster won't include unaccepted invites
          // (they live in invite_tokens, not users) — that's a Phase 6
          // follow-up if owners need the pending list.
          load();
        }} />
      )}
    </>
  );
}


// ═══════════════════════════════════════════════════════════════════
// Usage tab — current-period AI + email + intakes + storage + seats
// ═══════════════════════════════════════════════════════════════════
function UsageTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/agency/usage");
        if (alive) setData(data);
      } catch (err) {
        toast.error(err?.response?.data?.detail
                     || "Failed to load usage");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) {
    return <p className="text-sm text-muted-foreground p-6">Loading…</p>;
  }
  if (!data) return null;

  const u = data.usage || {};
  const limits = data.limits || {};
  const seats = data.seats || {};

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-muted-foreground">
          Period <strong>{data.billing_period}</strong>
          {u.live && (
            <Badge className="ml-2 text-[10px] bg-blue-100 text-blue-900">
              LIVE
            </Badge>
          )}
        </p>
      </div>
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
        />
        <UsageStat
          label="Seats"
          current={seats.active || 0}
          limit={seats.max}
        />
      </div>
    </>
  );
}

function UsageStat({ label, current, limit }) {
  const isUnlimited =
    limit === -1 || limit === undefined || limit === null;
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
// Billing tab
// ═══════════════════════════════════════════════════════════════════
function BillingTab() {
  const [sub, setSub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openingPortal, setOpeningPortal] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/billing/subscription");
        if (alive) setSub(data);
      } catch (err) {
        toast.error(err?.response?.data?.detail
                     || "Failed to load billing info");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const openPortal = async () => {
    setOpeningPortal(true);
    try {
      const { data } = await api.post("/billing/portal");
      if (data?.url) {
        window.location.href = data.url;
      } else {
        toast.error("Stripe didn't return a portal URL");
      }
    } catch (err) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail
                   : "Failed to open billing portal");
    } finally {
      setOpeningPortal(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground p-6">Loading…</p>;
  }
  if (!sub) return null;

  const tier = sub.tier;
  const monthly = sub.monthly_base_amount_cents
    ? `$${(sub.monthly_base_amount_cents / 100).toFixed(2)} / mo`
    : (TIER_PRICE_LABELS[tier] || "—");
  const stripeReady = sub.stripe_configured && sub.has_stripe_customer;
  const mockMode = !sub.stripe_configured;

  return (
    <div className="space-y-4">
      {mockMode && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 flex items-start gap-3"
                        data-testid="owner-billing-mock-banner">
            <AlertTriangle className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-semibold text-amber-900 text-sm">
                Stripe in mock mode
              </div>
              <p className="text-xs text-amber-900/80 mt-1">
                Billing is not connected to Stripe on this environment.
                Card management and invoice access are disabled.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">
                Current plan
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xl font-bold"
                      style={{ fontFamily: "Outfit" }}>
                  {TIER_LABELS[tier] || tier}
                </span>
                <Badge className={`rounded-full ${TIER_BADGE[tier] || "bg-gray-100"}`}>
                  {monthly}
                </Badge>
                <Badge className={`rounded-full capitalize ${BILLING_BADGE[sub.billing_status] || "bg-gray-100"}`}>
                  {(sub.billing_status || "").replace("_", " ")}
                </Badge>
              </div>
              {sub.current_period_end && (
                <p className="text-xs text-muted-foreground mt-2">
                  Renews{" "}
                  <strong>
                    {new Date(sub.current_period_end).toLocaleDateString()}
                  </strong>
                </p>
              )}
              {sub.trial_ends_at && sub.billing_status === "trialing" && (
                <p className="text-xs text-muted-foreground mt-1">
                  Trial ends{" "}
                  <strong>
                    {new Date(sub.trial_ends_at).toLocaleDateString()}
                  </strong>
                </p>
              )}
              {sub.grace_period_ends_at && (
                <p className="text-xs text-amber-900 mt-1">
                  Grace period ends{" "}
                  <strong>
                    {new Date(sub.grace_period_ends_at).toLocaleDateString()}
                  </strong>
                  — restore billing before suspension.
                </p>
              )}
            </div>
            <Button onClick={openPortal}
                     disabled={!stripeReady || openingPortal}
                     data-testid="owner-billing-portal">
              <ExternalLink className="w-4 h-4 mr-1" />
              {openingPortal ? "Opening…" : "Manage billing"}
            </Button>
          </div>

          {!stripeReady && !mockMode && (
            <p className="text-xs text-muted-foreground">
              No Stripe customer on file yet. Contact the platform team
              to provision billing.
            </p>
          )}
        </CardContent>
      </Card>

      {tier !== "domination" && (
        <Card>
          <CardContent className="p-5 flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-[#e85d2f] mt-0.5" />
            <div>
              <div className="font-semibold text-sm">
                Want more out of the platform?
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Upgrade unlocks higher AI / email / storage limits +
                the next tier's feature set.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Tier upgrades are coordinated with the GHW platform
                team — reach out and we'll switch you over.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
