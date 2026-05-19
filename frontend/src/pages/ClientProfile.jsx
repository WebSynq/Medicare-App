import { useEffect, useMemo, useRef, useState } from "react";
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
  ExternalLink,
  RefreshCw,
  ArrowLeft,
  Pencil,
  Check,
  X,
  FileSignature,
  Plus,
  Download,
  Upload,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const STATUS_BADGE = {
  new: "bg-blue-100 text-blue-900",
  contacted: "bg-amber-100 text-amber-900",
  qualified: "bg-emerald-50 text-emerald-900",
  enrolled: "bg-emerald-100 text-emerald-900",
  lost: "bg-gray-200 text-gray-700",
};

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

// ── Policies tab — collect any product blocks present on the lead doc.
// The lead model currently surfaces only the "submitting" plan_type_premium;
// per-product details land here once /applications/submit pushes them through.
const POLICY_GROUPS = [
  { code: "medsupp", label: "Medicare Supplement", prefix: "medsupp_" },
  { code: "ma", label: "Medicare Advantage", prefix: "ma_" },
  { code: "pdp", label: "Prescription Drug Plan", prefix: "pdp_" },
  { code: "cancer", label: "Cancer", prefix: "cancer_" },
  { code: "hs", label: "Heart/Stroke", prefix: "hs_" },
  { code: "hip", label: "Hospital Indemnity", prefix: "hip_" },
  { code: "rc", label: "Recovery Care", prefix: "rc_" },
  { code: "dvh", label: "Dental/Vision/Hearing", prefix: "dvh_" },
  { code: "life", label: "Life / Final Expense", prefix: "life_" },
];

function policiesFromLead(lead) {
  if (!lead) return [];
  const out = [];
  for (const g of POLICY_GROUPS) {
    const fields = Object.entries(lead).filter(
      ([k, v]) => k.startsWith(g.prefix) && v !== null && v !== undefined && v !== ""
    );
    if (!fields.length) continue;
    const obj = Object.fromEntries(fields);
    out.push({
      ...g,
      carrier: obj[`${g.prefix}carrier`] || lead[`final_expense_carrier`],
      plan: obj[`${g.prefix}plan`] || obj[`${g.prefix}plan_name`] || obj[`${g.prefix}product_name`],
      policy: obj[`${g.prefix}policy_id`] || obj[`${g.prefix}policy_number`],
      premium: obj[`${g.prefix}premium`] || obj[`${g.prefix}client_premium`],
      status: obj[`${g.prefix}policy_status`] || obj[`${g.prefix}status`],
      effective: obj[`${g.prefix}effective_date`] || obj[`life_coverage_effective_date`],
      renewal: obj[`${g.prefix}renewal_date`],
    });
  }
  return out;
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

  const policies = useMemo(() => policiesFromLead(lead), [lead]);

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

  const ghlUrl =
    lead.ghl_contact_id && !lead.ghl_contact_id.startsWith("mock_")
      ? `https://app.gohighlevel.com/v2/location/contacts/${lead.ghl_contact_id}`
      : null;

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
                <div className="flex items-center gap-2 mt-2">
                  <Badge
                    className={`rounded-full capitalize ${
                      STATUS_BADGE[lead.status] || "bg-secondary"
                    }`}
                  >
                    {lead.status === "lost" ? "inactive" : lead.status}
                  </Badge>
                  {lead.soa_signed && (
                    <Badge className="rounded-full bg-emerald-100 text-emerald-900 border-0">
                      <FileSignature className="w-3 h-3 mr-1" /> SOA Signed
                    </Badge>
                  )}
                </div>
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
                {ghlUrl && (
                  <a
                    href={ghlUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm hover:bg-secondary"
                    data-testid="client-view-ghl"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> View in GHL
                  </a>
                )}
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
            <TabsTrigger value="documents" data-testid="tab-documents">
              Documents
            </TabsTrigger>
            <TabsTrigger value="notes" data-testid="tab-notes">
              Notes &amp; Activity
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: Overview */}
          <TabsContent value="overview" className="space-y-4 mt-4">
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

          {/* Tab 2: Policies */}
          <TabsContent value="policies" className="mt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Policies on file</h3>
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
            {policies.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center text-sm text-muted-foreground">
                  No policies on file. Submit an application to add coverage.
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 gap-3">
                {policies.map((p) => (
                  <Card key={p.code} data-testid={`policy-card-${p.code}`}>
                    <CardContent className="p-5 space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                            {p.label}
                          </div>
                          <div className="font-semibold text-base">
                            {p.carrier || "—"}
                          </div>
                        </div>
                        {p.status && (
                          <Badge
                            variant="secondary"
                            className="rounded-full capitalize"
                          >
                            {p.status}
                          </Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <div className="text-muted-foreground">Plan</div>
                          <div className="font-medium">{p.plan || "—"}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Policy #</div>
                          <div className="font-medium font-mono">
                            {p.policy || "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Premium</div>
                          <div className="font-medium">
                            {p.premium ? `$${p.premium}` : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Effective</div>
                          <div className="font-medium">{fmtDate(p.effective)}</div>
                        </div>
                        {p.renewal && (
                          <div>
                            <div className="text-muted-foreground">Renewal</div>
                            <div className="font-medium">{fmtDate(p.renewal)}</div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
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

          {/* Tab 4: Notes & Activity */}
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
