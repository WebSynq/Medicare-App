import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Mail,
  Phone,
  Cake,
  MapPin,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  ArrowLeft,
  Pencil,
  Check,
  X,
  FileSignature,
  FileText,
  Plus,
  Download,
  Upload,
  Clock,
  DollarSign,
  Activity,
  ChevronDown,
  ChevronUp,
  Copy,
  AlertTriangle,
  Sparkles,
  Headphones,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";

const STATUS_BADGE = {
  new: "bg-blue-100 text-blue-900",
  contacted: "bg-amber-100 text-amber-900",
  qualified: "bg-emerald-50 text-emerald-900",
  enrolled: "bg-emerald-100 text-emerald-900",
  lost: "bg-gray-200 text-gray-700",
};

// Per-product palette for the Policies tab — keyed by the product_type
// short code stored on each policy row so it never drifts when display
// labels change. Matches the server-side PRODUCT_COLORS map.
const PRODUCT_BADGE = {
  medsupp: "bg-blue-100 text-blue-900",
  ma: "bg-purple-100 text-purple-900",
  pdp: "bg-teal-100 text-teal-900",
  cancer: "bg-rose-100 text-rose-900",
  hs: "bg-red-100 text-red-900",
  hip: "bg-orange-100 text-orange-900",
  rc: "bg-amber-100 text-amber-900",
  dvh: "bg-green-100 text-green-900",
  life: "bg-indigo-100 text-indigo-900",
  annuity: "bg-slate-200 text-slate-900",
};

// Small inline pill summarising the GHL sync state of a lead. Sits next
// to the "Sync to GHL" button so the agent has a constant answer to
// "is this contact in GHL?" without expanding the timeline.
//   green  — ghl_sync_status in ("synced", "mock") AND ghl_contact_id set
//   orange — ghl_contact_id set but most recent sync errored / pending
//   grey   — no ghl_contact_id (never reached GHL)
function GhlSyncPill({ lead }) {
  const cid = lead?.ghl_contact_id;
  const status = (lead?.ghl_sync_status || "").toLowerCase();
  let dot = "bg-gray-400";
  let label = "Not in GHL";
  let testid = "ghl-sync-pill-none";
  if (cid) {
    if (status === "synced" || status === "mock") {
      dot = "bg-emerald-500";
      label = status === "mock" ? "Synced (mock)" : "Synced to GHL";
      testid = "ghl-sync-pill-ok";
    } else {
      dot = "bg-amber-500";
      label = status === "error" ? "Sync error" : "Sync pending";
      testid = "ghl-sync-pill-pending";
    }
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-xs text-foreground/80"
      data-testid={testid}
      title={lead?.ghl_sync_error || undefined}
    >
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

// Header SOA badge — green when signed, amber when one or more pending
// SOAs exist, red otherwise. Reads off the parent ``lead.soa_signed``
// flag for the signed/none distinction; pending detection is done at
// the call-site via ``soaRecords`` (passed in by the parent).
function SOAStatusBadge({ lead }) {
  if (lead?.soa_signed) {
    // The dedicated "SOA Signed · <date>" badge already renders next
    // to this component; nothing more to add here.
    return null;
  }
  // Default: client has no SOA on file yet.
  return (
    <Badge
      className="rounded-full bg-rose-100 text-rose-900 border-0"
      data-testid="client-soa-badge-none"
    >
      No SOA
    </Badge>
  );
}

// Status colors for the per-policy status pill.
function policyStatusClass(status) {
  const s = (status || "").toLowerCase();
  if (s === "active") return "bg-emerald-100 text-emerald-900";
  if (s === "pending" || s === "") return "bg-amber-100 text-amber-900";
  if (s === "cancelled" || s === "lapsed" || s === "terminated")
    return "bg-red-100 text-red-900";
  return "bg-secondary text-secondary-foreground";
}

function fmtUSD(val) {
  if (val == null || val === "") return "—";
  const n = typeof val === "number" ? val : parseFloat(val);
  if (Number.isNaN(n)) return String(val);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function maskMBI(mbi) {
  if (!mbi) return "—";
  const compact = mbi.replace(/[^A-Z0-9]/gi, "");
  if (compact.length < 4) return "•".repeat(compact.length);
  const last = compact.slice(-2);
  return `****-****-XX${last}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fullAddress(c) {
  const parts = [
    c.address_line1,
    c.address_line2,
    c.city,
    c.state,
    c.zip_code,
  ].filter(Boolean);
  return parts.join(", ");
}

function IconRow({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <span className="text-muted-foreground text-xs uppercase tracking-wider w-20">
        {label}
      </span>
      <span className="font-medium truncate">{value}</span>
    </div>
  );
}


export default function ClientProfile() {
  const { leadId } = useParams();
  const navigate = useNavigate();

  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Tab 4: notes auto-save
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSavedAt, setNotesSavedAt] = useState(null);
  const notesTimer = useRef(null);

  // Tab 3: documents
  const [docs, setDocs] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const uploadRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  // Tab 2: policies (server-persisted) + summary stats for Overview
  const [serverPolicies, setServerPolicies] = useState([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [policySummary, setPolicySummary] = useState(null);

  // SOA records for this lead — drives the SOA tab and the header
  // badge. Each row carries token + public_link (built server-side).
  const [soaRecords, setSoaRecords] = useState([]);
  const [soaLoading, setSoaLoading] = useState(false);

  const loadSoaRecords = useCallback(async () => {
    if (!leadId) return;
    setSoaLoading(true);
    try {
      const { data } = await api.get(`/soa/by-lead-list/${leadId}`);
      setSoaRecords(data?.records || []);
    } catch {
      setSoaRecords([]);
    } finally {
      setSoaLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    loadSoaRecords();
  }, [loadSoaRecords]);

  async function sendNewSoa() {
    try {
      const products = lead?.product_interest ? [lead.product_interest] : [];
      const { data } = await api.post(`/soa/send/${leadId}`, { products });
      toast.success("New SOA link created");
      if (data?.public_link && navigator?.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(data.public_link);
          toast.message("Link copied to clipboard");
        } catch {
          // clipboard failure is fine — the link is in the table row.
        }
      }
      loadSoaRecords();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't send SOA");
    }
  }

  async function copyExistingSoaLink(link) {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("SOA link copied");
    } catch {
      toast.error("Couldn't copy — select the link manually.");
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get(`/leads/${leadId}`);
        if (!alive) return;
        setLead(data);
        setNotesDraft(data.notes || "");
        setEditForm({
          first_name: data.first_name || "",
          last_name: data.last_name || "",
          email: data.email || "",
          phone: data.phone || "",
          date_of_birth: data.date_of_birth || "",
          status: data.status || "new",
        });
      } catch (err) {
        toast.error(
          err?.response?.data?.detail || err?.message || "Failed to load client"
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [leadId]);

  async function loadDocs() {
    setDocsLoading(true);
    try {
      const { data } = await api.get(`/documents/by-lead/${leadId}`);
      setDocs(data || []);
    } catch (err) {
      // Non-fatal — empty list is fine.
      setDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }

  useEffect(() => {
    loadDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Policies endpoint now accepts the portal lead id directly (it
  // unions lead_id-keyed + ghl_contact_id-keyed rows server-side), so
  // we no longer have to wait for the lead to round-trip through GHL.
  // Summary endpoint still keys by ghl_contact_id, so we only fetch
  // it when that id is available.
  useEffect(() => {
    if (!leadId) return;
    let alive = true;
    (async () => {
      setPoliciesLoading(true);
      try {
        const polRes = await api.get(
          `/clients/${encodeURIComponent(leadId)}/policies`,
        );
        if (!alive) return;
        setServerPolicies(polRes.data?.policies || []);

        const cid = lead?.ghl_contact_id;
        if (cid) {
          try {
            const sumRes = await api.get(
              `/clients/${encodeURIComponent(cid)}/summary`,
            );
            if (alive) setPolicySummary(sumRes.data || null);
          } catch {
            if (alive) setPolicySummary(null);
          }
        } else {
          if (alive) setPolicySummary(null);
        }
      } catch (err) {
        if (!alive) return;
        setServerPolicies([]);
        setPolicySummary(null);
      } finally {
        if (alive) setPoliciesLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [leadId, lead?.ghl_contact_id]);

  async function saveEdits() {
    setSaving(true);
    try {
      // /leads PATCH only accepts a narrow set of fields; everything else is
      // immutable for now. Save just the editable ones server-side.
      const patch = { status: editForm.status, notes: lead.notes };
      const { data } = await api.patch(`/leads/${leadId}`, patch);
      setLead(data);
      setEditing(false);
      toast.success("Saved");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function syncToGhl() {
    setSyncing(true);
    try {
      const { data } = await api.post(`/leads/${leadId}/sync-ghl`);
      setLead(data);
      toast.success(
        data.ghl_sync_status === "mock"
          ? "Synced to GHL (mock mode)"
          : "Synced to GHL"
      );
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  // Notes auto-save — fires 1.2s after the user stops typing.
  function onNotesChange(v) {
    setNotesDraft(v);
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(async () => {
      try {
        const { data } = await api.patch(`/leads/${leadId}`, { notes: v });
        setLead(data);
        setNotesSavedAt(new Date());
      } catch (err) {
        toast.error("Notes save failed");
      }
    }, 1200);
  }

  async function handleUpload(file) {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("doc_type", "other");
      await api.post(`/documents/upload/${leadId}`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success("Uploaded");
      loadDocs();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function downloadDoc(doc) {
    try {
      const resp = await api.get(`/documents/${doc.id}/download`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error("Download failed");
    }
  }

  // Timeline — derived from lead fields. Each item must have a stable key.
  const timeline = useMemo(() => {
    if (!lead) return [];
    const items = [];
    if (lead.created_at) {
      items.push({
        ts: lead.created_at,
        label: "Submitted",
        detail: "Intake created",
      });
    }
    if (lead.soa_signed && lead.soa_signed_at) {
      items.push({
        ts: lead.soa_signed_at,
        label: "SOA signed",
        detail: "Scope of Appointment captured",
      });
    }
    if (lead.ghl_synced_at) {
      items.push({
        ts: lead.ghl_synced_at,
        label: "Synced to GHL",
        detail:
          lead.ghl_sync_status === "mock"
            ? "Sync ran in mock mode"
            : "Pushed to GoHighLevel",
      });
    }
    docs.forEach((d) => {
      if (d.uploaded_at) {
        items.push({
          ts: d.uploaded_at,
          label: "Document uploaded",
          detail: d.filename,
          key: `doc-${d.id}`,
        });
      }
    });
    if (lead.updated_at && lead.updated_at !== lead.created_at) {
      items.push({
        ts: lead.updated_at,
        label: "Updated",
        detail: "Profile edited",
      });
    }
    return items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }, [lead, docs]);

  if (loading) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-5xl mx-auto text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-5xl mx-auto">
          <Link
            to="/clients"
            className="text-sm text-muted-foreground inline-flex items-center hover:text-[#e85d2f]"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Clients
          </Link>
          <div className="mt-6 text-muted-foreground">Client not found.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-5xl mx-auto w-full space-y-5">
        <Link
          to="/clients"
          className="text-sm text-muted-foreground inline-flex items-center hover:text-[#e85d2f]"
          data-testid="back-to-clients"
        >
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Clients
        </Link>

        {/* Header card */}
        <Card className="bg-surface">
          <CardContent className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1
                  className="text-2xl font-bold tracking-tight"
                  style={{ fontFamily: "Outfit" }}
                  data-testid="client-name"
                >
                  {lead.first_name} {lead.last_name}
                </h1>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <Badge
                    className={`rounded-full capitalize ${
                      STATUS_BADGE[lead.status] || "bg-secondary"
                    }`}
                  >
                    {lead.status === "lost" ? "inactive" : lead.status}
                  </Badge>
                  <SOAStatusBadge lead={lead} />
                  {lead.soa_signed && (
                    <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
                      <FileSignature className="w-3 h-3 mr-1" /> SOA Signed
                      {lead.soa_signed_at && (
                        <span className="ml-1 opacity-80">
                          · {new Date(lead.soa_signed_at).toLocaleDateString()}
                        </span>
                      )}
                    </Badge>
                  )}
                  {lead.tcpa_consent ? (
                    <Badge
                      className="rounded-full bg-emerald-100 text-emerald-900 border-0"
                      data-testid="client-tcpa-badge-ok"
                      title={
                        lead.tcpa_consent_text || "TCPA consent on file"
                      }
                    >
                      <ShieldCheck className="w-3 h-3 mr-1" /> TCPA Consented
                      {lead.tcpa_consent_timestamp && (
                        <span className="ml-1 opacity-80">
                          · {new Date(lead.tcpa_consent_timestamp).toLocaleDateString()}
                        </span>
                      )}
                    </Badge>
                  ) : (
                    <Badge
                      className="rounded-full bg-rose-100 text-rose-900 border-0"
                      data-testid="client-tcpa-badge-none"
                    >
                      <ShieldAlert className="w-3 h-3 mr-1" /> No TCPA Consent —
                      Do not SMS
                    </Badge>
                  )}
                  {lead.client_success_rep && (
                    <Badge
                      className="rounded-full bg-secondary text-secondary-foreground border-0"
                      data-testid="client-cs-rep-badge"
                    >
                      <Headphones className="w-3 h-3 mr-1" /> CS Rep: {lead.client_success_rep}
                    </Badge>
                  )}
                </div>
                <ImpersonationBanner />
                {!lead.tcpa_consent && (
                  <div
                    className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                    data-testid="client-tcpa-warning"
                  >
                    <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>
                      This contact has not granted TCPA consent. Do not send
                      marketing SMS or auto-dial. Capture consent via a fresh
                      Quick-Add or in-person form before outreach.
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(false)}
                    >
                      <X className="w-3.5 h-3.5 mr-1.5" /> Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveEdits}
                      disabled={saving}
                      data-testid="client-save-btn"
                    >
                      <Check className="w-3.5 h-3.5 mr-1.5" />
                      {saving ? "Saving…" : "Save"}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(true)}
                    data-testid="client-edit-btn"
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
                  </Button>
                )}
                <GhlSyncPill lead={lead} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={syncToGhl}
                  disabled={syncing}
                  data-testid="client-sync-ghl"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 mr-1.5 ${syncing ? "animate-spin" : ""}`}
                  />
                  {syncing ? "Syncing…" : "Sync to GHL"}
                </Button>
              </div>
            </div>

            {editing ? (
              <div className="grid md:grid-cols-2 gap-3 mt-5">
                <div>
                  <Label className="text-xs">Status</Label>
                  <select
                    value={editForm.status}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, status: e.target.value }))
                    }
                    className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                    data-testid="client-edit-status"
                  >
                    <option value="new">New</option>
                    <option value="contacted">Contacted</option>
                    <option value="qualified">Qualified</option>
                    <option value="enrolled">Enrolled</option>
                    <option value="lost">Inactive</option>
                  </select>
                </div>
                <p className="text-xs text-muted-foreground self-end pb-2">
                  Inline edit currently covers status. Other fields are read-only
                  for now — use New Intake to recreate or contact the source
                  system for changes.
                </p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-3 mt-5">
                <IconRow icon={Mail} label="Email" value={lead.email} />
                <IconRow icon={Phone} label="Phone" value={lead.phone} />
                <IconRow
                  icon={Cake}
                  label="DOB"
                  value={fmtDate(lead.date_of_birth)}
                />
                <IconRow
                  icon={MapPin}
                  label="Address"
                  value={fullAddress(lead)}
                />
                <IconRow
                  icon={ShieldCheck}
                  label="MBI"
                  value={maskMBI(lead.mbi_number)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tabs */}
        <Tabs defaultValue="overview" className="w-full">
          <TabsList>
            <TabsTrigger value="overview" data-testid="tab-overview">
              Overview
            </TabsTrigger>
            <TabsTrigger value="policies" data-testid="tab-policies">
              Policies
            </TabsTrigger>
            <TabsTrigger value="soa" data-testid="tab-soa">
              SOA
            </TabsTrigger>
            <TabsTrigger value="documents" data-testid="tab-documents">
              Documents
            </TabsTrigger>
            <TabsTrigger value="application-data" data-testid="tab-application-data">
              Application Data
            </TabsTrigger>
            <TabsTrigger value="notes" data-testid="tab-notes">
              Notes &amp; Activity
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: Overview */}
          <TabsContent value="overview" className="space-y-4 mt-4">
            {policySummary && (
              <div className="grid grid-cols-3 gap-3" data-testid="policy-summary">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-xs uppercase tracking-widest text-muted-foreground">
                        Active policies
                      </div>
                      <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div
                      className="text-2xl font-bold mt-1 tabular-nums"
                      style={{ fontFamily: "Outfit" }}
                    >
                      {policySummary.active_count}
                      {policySummary.total_count > policySummary.active_count && (
                        <span className="text-sm text-muted-foreground font-normal">
                          {" "}
                          / {policySummary.total_count}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-xs uppercase tracking-widest text-muted-foreground">
                        Monthly premium
                      </div>
                      <DollarSign className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div
                      className="text-2xl font-bold mt-1 tabular-nums"
                      style={{ fontFamily: "Outfit" }}
                    >
                      {fmtUSD(policySummary.total_monthly_premium)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-xs uppercase tracking-widest text-muted-foreground">
                        Last activity
                      </div>
                      <Activity className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div
                      className="text-sm font-medium mt-2"
                      style={{ fontFamily: "Outfit" }}
                    >
                      {policySummary.last_activity
                        ? fmtDate(policySummary.last_activity)
                        : "—"}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            <Card>
              <CardContent className="p-5">
                <h3 className="text-sm font-semibold mb-3">Scope of Appointment</h3>
                {lead.soa_signed ? (
                  <div className="text-sm space-y-1">
                    <div>
                      <span className="text-muted-foreground">Status: </span>
                      <span className="text-emerald-700 font-medium">
                        Signed
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Signed at: </span>
                      {fmtDateTime(lead.soa_signed_at)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Agent: </span>
                      {lead.sales_submitting_agent || "—"}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    SOA not yet signed.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <h3 className="text-sm font-semibold mb-3">
                  Medicare Eligibility
                </h3>
                <div className="grid md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wider">
                      Part A effective
                    </div>
                    <div className="font-medium">
                      {fmtDate(lead.medicare_part_a_effective)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wider">
                      Part B effective
                    </div>
                    <div className="font-medium">
                      {fmtDate(lead.medicare_part_b_effective)}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <h3 className="text-sm font-semibold mb-3">Current Coverage</h3>
                <div className="grid md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wider">
                      Carrier
                    </div>
                    <div className="font-medium">{lead.current_carrier || "—"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs uppercase tracking-wider">
                      Plan
                    </div>
                    <div className="font-medium">{lead.current_plan || "—"}</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <h3 className="text-sm font-semibold mb-3">Recent Activity</h3>
                {timeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No activity yet.
                  </p>
                ) : (
                  <ol className="space-y-3">
                    {timeline.slice(0, 6).map((t, i) => (
                      <li
                        key={t.key || `${t.ts}-${i}`}
                        className="flex gap-3 text-sm"
                      >
                        <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium">{t.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {t.detail} · {fmtDateTime(t.ts)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 2: Policies — sourced from /api/clients/{contact_id}/policies.
              Each row is one submitted application; the contact ID comes from
              the lead document's ghl_contact_id field (populated at GHL sync). */}
          <TabsContent value="policies" className="mt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">
                Policies on file
                {serverPolicies.length > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground font-normal">
                    ({serverPolicies.length})
                  </span>
                )}
              </h3>
              <Button
                size="sm"
                onClick={() =>
                  navigate(
                    `/applications?contact_id=${encodeURIComponent(
                      lead.ghl_contact_id || ""
                    )}`
                  )
                }
                data-testid="add-application-btn"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Application
              </Button>
            </div>
            {policiesLoading ? (
              <Card>
                <CardContent className="p-8 text-center text-sm text-muted-foreground">
                  Loading policies…
                </CardContent>
              </Card>
            ) : serverPolicies.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center space-y-3">
                  <p className="text-sm text-muted-foreground">
                    No policies on file yet.
                    <br />
                    Submit an application to add coverage records.
                  </p>
                  <Button
                    size="sm"
                    onClick={() =>
                      navigate(
                        `/applications?contact_id=${encodeURIComponent(
                          lead.ghl_contact_id || ""
                        )}`
                      )
                    }
                    data-testid="empty-submit-application-btn"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Submit Application
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 gap-3">
                {serverPolicies.map((p, idx) => (
                  <Card
                    key={`${p.product_type}-${p.submitted_at || idx}`}
                    data-testid={`policy-card-${p.product_type}`}
                  >
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Badge
                            className={`rounded-full text-[10px] mb-2 ${
                              PRODUCT_BADGE[p.product_type] ||
                              "bg-secondary text-secondary-foreground"
                            }`}
                          >
                            {p.product_label || p.product_type}
                          </Badge>
                          <div className="font-semibold text-base truncate">
                            {p.carrier || "—"}
                          </div>
                          {p.plan && (
                            <div className="text-sm text-muted-foreground truncate">
                              {p.plan}
                            </div>
                          )}
                        </div>
                        <Badge
                          className={`rounded-full capitalize ${policyStatusClass(
                            p.policy_status
                          )}`}
                        >
                          {p.policy_status || "Pending"}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-muted-foreground">Premium / mo</div>
                          <div className="font-medium">{fmtUSD(p.premium)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Policy #</div>
                          <div className="font-medium font-mono truncate">
                            {p.policy_id || "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Effective</div>
                          <div className="font-medium">
                            {fmtDate(p.effective_date)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Renewal</div>
                          <div className="font-medium">
                            {fmtDate(p.renewal_date) || "—"}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between pt-2 border-t border-border">
                        <div className="text-[11px] text-muted-foreground">
                          {p.submitted_by ? `By ${p.submitted_by} · ` : ""}
                          {fmtDateTime(p.submitted_at)}
                        </div>
                        {(p.s3_key || p.s3_url || p.pdf_url) && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const { data } = await api.get(
                                  `/policies/${encodeURIComponent(p.policy_id || p.id || "")}/pdf`,
                                );
                                if (data?.url) {
                                  window.open(data.url, "_blank", "noopener,noreferrer");
                                } else {
                                  toast.error("PDF link unavailable");
                                }
                              } catch (err) {
                                toast.error(
                                  err?.response?.data?.detail || "Could not open PDF",
                                );
                              }
                            }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-[#e85d2f] hover:underline"
                            data-testid={`policy-view-pdf-${p.product_type}`}
                          >
                            <FileText className="w-3.5 h-3.5" /> View PDF
                          </button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Tab 2.5: SOA — pending + signed records. Send New mints a
              fresh token and pushes the SOA-Pending tag to GHL. */}
          <TabsContent value="soa" className="mt-4">
            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h3 className="text-sm font-semibold">
                    Scope of Appointment ({soaRecords.length})
                  </h3>
                  <Button
                    size="sm"
                    onClick={sendNewSoa}
                    data-testid="soa-send-new"
                  >
                    Send New SOA
                  </Button>
                </div>
                {soaLoading && (
                  <p className="text-xs text-muted-foreground py-4 text-center">
                    Loading…
                  </p>
                )}
                {!soaLoading && soaRecords.length === 0 && (
                  <p className="text-xs text-muted-foreground py-6 text-center">
                    No SOA records yet. Send the client a link to start.
                  </p>
                )}
                {!soaLoading && soaRecords.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground border-b border-border">
                          <th className="text-left py-2 font-medium">Status</th>
                          <th className="text-left py-2 font-medium">Products</th>
                          <th className="text-left py-2 font-medium">Sent</th>
                          <th className="text-left py-2 font-medium">Signed</th>
                          <th className="text-right py-2 font-medium">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {soaRecords.map((r) => {
                          const status = (r.status || "").toLowerCase();
                          const statusClass =
                            status === "signed"
                              ? "bg-emerald-100 text-emerald-900"
                              : status === "expired"
                                ? "bg-rose-100 text-rose-900"
                                : "bg-amber-100 text-amber-900";
                          return (
                            <tr
                              key={r.id}
                              className="border-b border-border last:border-0"
                              data-testid={`soa-row-${r.id}`}
                            >
                              <td className="py-2">
                                <Badge
                                  className={`rounded-full capitalize ${statusClass} border-0`}
                                >
                                  {status || "pending"}
                                </Badge>
                              </td>
                              <td className="py-2 text-xs text-foreground/70 max-w-[220px] truncate">
                                {(r.products_to_discuss || []).join(", ") || "—"}
                              </td>
                              <td className="py-2 text-xs text-muted-foreground">
                                {fmtDateTime(r.created_at)}
                              </td>
                              <td className="py-2 text-xs text-muted-foreground">
                                {r.signed_at ? fmtDateTime(r.signed_at) : "—"}
                              </td>
                              <td className="py-2 text-right">
                                {status === "pending" && r.public_link && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => copyExistingSoaLink(r.public_link)}
                                    data-testid={`soa-copy-${r.id}`}
                                  >
                                    Resend Link
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 3: Documents */}
          <TabsContent value="documents" className="mt-4">
            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    Documents ({docs.length})
                  </h3>
                  <input
                    ref={uploadRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => handleUpload(e.target.files?.[0])}
                    data-testid="doc-upload-input"
                  />
                  <Button
                    size="sm"
                    onClick={() => uploadRef.current?.click()}
                    disabled={uploading}
                    data-testid="doc-upload-btn"
                  >
                    <Upload className="w-3.5 h-3.5 mr-1.5" />
                    {uploading ? "Uploading…" : "Upload"}
                  </Button>
                </div>
                {docsLoading && (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                )}
                {!docsLoading && docs.length === 0 && (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No documents yet.
                  </p>
                )}
                <ul className="divide-y divide-border">
                  {docs.map((d) => (
                    <li
                      key={d.id}
                      className="py-3 flex items-center justify-between gap-3"
                      data-testid={`doc-row-${d.id}`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">{d.filename}</div>
                        <div className="text-xs text-muted-foreground">
                          {d.doc_type} ·{" "}
                          {(d.size_bytes / 1024).toFixed(1)} KB ·{" "}
                          {fmtDateTime(d.uploaded_at)}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => downloadDoc(d)}
                        data-testid={`doc-download-${d.id}`}
                      >
                        <Download className="w-3.5 h-3.5 mr-1.5" />
                        Download
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab: Application Data — full extracted dataset */}
          <TabsContent value="application-data" className="mt-4 space-y-4">
            <ApplicationDataTab leadId={leadId} />
          </TabsContent>

          {/* Tab 5: Notes & Activity */}
          <TabsContent value="notes" className="mt-4 space-y-4">
            <Card>
              <CardContent className="p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Notes</h3>
                  <span className="text-[11px] text-muted-foreground">
                    {notesSavedAt
                      ? `Saved ${notesSavedAt.toLocaleTimeString()}`
                      : "Auto-saves as you type"}
                  </span>
                </div>
                <Textarea
                  rows={8}
                  value={notesDraft}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="Add notes about this client…"
                  data-testid="notes-textarea"
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5">
                <h3 className="text-sm font-semibold mb-3">Activity timeline</h3>
                {timeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing recorded yet.
                  </p>
                ) : (
                  <ol className="space-y-3">
                    {timeline.map((t, i) => (
                      <li
                        key={t.key || `${t.ts}-${i}`}
                        className="flex gap-3 text-sm"
                      >
                        <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium">{t.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {t.detail} · {fmtDateTime(t.ts)}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Application Data tab
//
// Renders the most-recent extracted-data document for this lead, grouped
// by source document type, with per-field copy-to-clipboard and a
// conflict card at the top when extracted values disagree across docs.

const DOC_TYPE_TITLES = {
  main_application: "Main Application",
  soa: "Scope of Appointment",
  election_notice: "Election Notice",
  eft_form: "EFT / Bank Authorization",
  phi_auth: "PHI Authorization",
  id_copy: "ID Copy / Medicare Card",
  prescriptions: "Prescriptions",
  agent_attestation: "Agent Attestation",
  other: "Other Document",
};

function confidenceTone(score) {
  if (score == null) return "muted";
  if (score >= 0.85) return "ok";
  if (score >= 0.6) return "warn";
  return "low";
}

function fmtFieldValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    if (typeof v[0] === "object") {
      // Prescriptions array of meds, etc.
      return v
        .map((x) => Object.entries(x).map(([k, val]) => `${k}: ${val}`).join(", "))
        .join("\n");
    }
    return v.join(", ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function CopyableField({ name, value, score, testId }) {
  const tone = confidenceTone(score);
  const text = fmtFieldValue(value);
  const empty = text === "";
  const toneStyle =
    tone === "ok"
      ? "border-emerald-200"
      : tone === "warn"
        ? "border-amber-300"
        : tone === "low"
          ? "border-red-300"
          : "border-border";
  function copy() {
    if (empty) return;
    try {
      navigator.clipboard.writeText(text);
      toast.success(`Copied ${name.replace(/_/g, " ")}`);
    } catch {
      /* ignore */
    }
  }
  return (
    <div
      className={`rounded-lg border ${toneStyle} p-2.5 flex items-start gap-2`}
      data-testid={testId}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          {name.replace(/_/g, " ")}
          {tone === "ok" ? (
            <Badge className="text-[9px] rounded-full border-0 bg-emerald-100 text-emerald-900">
              {Math.round(score * 100)}%
            </Badge>
          ) : tone === "warn" ? (
            <Badge className="text-[9px] rounded-full border-0 bg-amber-100 text-amber-900">
              Verify · {Math.round(score * 100)}%
            </Badge>
          ) : tone === "low" ? (
            <Badge className="text-[9px] rounded-full border-0 bg-red-100 text-red-900">
              Not detected
            </Badge>
          ) : null}
        </div>
        <div
          className={`mt-1 text-sm break-words whitespace-pre-wrap ${
            empty ? "text-muted-foreground italic" : "font-medium"
          }`}
        >
          {empty ? "—" : text}
        </div>
      </div>
      <button
        type="button"
        onClick={copy}
        disabled={empty}
        className="p-2 text-muted-foreground hover:text-[#e85d2f] disabled:opacity-30 min-w-[44px] min-h-[44px] grid place-items-center"
        aria-label={`Copy ${name}`}
        data-testid={`${testId}-copy`}
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function DocCollapsible({ docType, title, fields, confidences, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const entries = Object.entries(fields || {});
  const populated = entries.filter(
    ([, v]) => v !== null && v !== undefined && String(v).trim() !== "",
  ).length;
  return (
    <Card data-testid={`appdata-${docType}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left min-h-[44px]"
      >
        <FileText className="w-4 h-4 text-[#e85d2f]" />
        <span className="text-sm font-semibold flex-1">{title}</span>
        <Badge variant="outline" className="text-[10px] tabular-nums">
          {populated}/{entries.length || 0} fields
        </Badge>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
      {open ? (
        <CardContent className="pt-0 pb-4 px-4">
          {entries.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2">
              No fields extracted for this document.
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-2">
              {entries.map(([k, v]) => (
                <CopyableField
                  key={k}
                  name={k}
                  value={v}
                  score={(confidences || {})[k]}
                  testId={`appdata-${docType}-${k}`}
                />
              ))}
            </div>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

function ApplicationDataTab({ leadId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/applications/extracted-data/${leadId}`);
      setData(data);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Could not load application data",
      );
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">
          Loading extracted data…
        </CardContent>
      </Card>
    );
  }
  if (!data || data.empty) {
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-2">
          <Sparkles className="w-6 h-6 text-[#e85d2f] mx-auto" />
          <h3 className="text-sm font-semibold">No application data yet</h3>
          <p className="text-xs text-muted-foreground">
            Once an application is submitted for this client, the full
            AI-extracted dataset will appear here — organized by source
            document.
          </p>
          <Button asChild size="sm" className="mt-2 min-h-[44px]">
            <Link to="/applications">Submit Application</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const byDoc = data.by_doc || {};
  const confByDoc = data.confidences_by_doc || {};
  const conflicts = data.conflicts || [];
  const supporting = data.supporting_summaries || [];
  const docOrder = [
    "main_application", "soa", "election_notice", "eft_form",
    "phi_auth", "id_copy", "prescriptions", "agent_attestation", "other",
  ];
  const docEntries = docOrder
    .filter((dt) => byDoc[dt])
    .map((dt) => [dt, byDoc[dt]]);

  return (
    <div className="space-y-3">
      {conflicts.length > 0 ? (
        <div
          className="rounded-lg border border-red-300 bg-red-50 p-3 space-y-2"
          data-testid="appdata-conflicts"
        >
          <div className="flex items-center gap-1.5 text-sm font-medium text-red-900">
            <AlertTriangle className="w-4 h-4" />
            {conflicts.length} field{conflicts.length === 1 ? "" : "s"}{" "}
            disagree across documents
          </div>
          <ul className="space-y-1 text-xs">
            {conflicts.map((c) => (
              <li
                key={c.canonical}
                data-testid={`appdata-conflict-${c.canonical}`}
              >
                <div className="font-medium">
                  {c.canonical.replace(/_/g, " ")}
                </div>
                <ul className="ml-3 list-disc">
                  {(c.sources || []).map((s, i) => (
                    <li key={i}>
                      {DOC_TYPE_TITLES[s.doc_type] || s.doc_type}:{" "}
                      <span className="font-mono">{String(s.value)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {supporting.length > 0 ? (
        <Card>
          <CardContent className="p-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Attached files
            </div>
            <ul className="text-xs space-y-1">
              {supporting.map((s) => (
                <li
                  key={s.file_id || s.s3_url || s.filename}
                  className="flex items-center gap-2"
                >
                  <FileText className="w-3 h-3 text-[#e85d2f]" />
                  <span className="flex-1 truncate">{s.filename}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {s.file_label}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {docEntries.length === 0 ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            No extracted fields available.
          </CardContent>
        </Card>
      ) : (
        docEntries.map(([dt, fields], idx) => (
          <DocCollapsible
            key={dt}
            docType={dt}
            title={DOC_TYPE_TITLES[dt] || dt}
            fields={fields}
            confidences={confByDoc[dt]}
            defaultOpen={idx === 0}
          />
        ))
      )}
    </div>
  );
}
