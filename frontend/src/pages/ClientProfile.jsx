import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  ArrowLeftRight,
} from "lucide-react";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import LeadNotesPanel from "@/components/LeadNotesPanel";
import TagBadge, { AddTagPopover, useTagLibrary } from "@/components/TagBadge";

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

  // Feature A — most recent appointment for this lead. Drives the
  // outcome-buttons card on the Overview tab. We pull the latest row
  // only (limit=1) because the card is a single-row view; the full
  // history lives on the dedicated Appointments page.
  const [recentAppt, setRecentAppt] = useState(null);
  const [outcomeSaving, setOutcomeSaving] = useState(false);

  // SOA records for this lead — drives the SOA tab and the header
  // badge. Each row carries token + public_link (built server-side).
  const [soaRecords, setSoaRecords] = useState([]);
  const [soaLoading, setSoaLoading] = useState(false);

  // CNA + AI Client Intelligence. ``cna`` is the live form state
  // (autosaved on blur). ``ai`` is the cached recommendation surfaced
  // on the Overview panel. ``activeTab`` lets the "Save & Generate AI"
  // button jump back to Overview after a fresh analysis.
  const [cna, setCna] = useState(null);
  const [cnaExists, setCnaExists] = useState(false);
  const [cnaSavedAt, setCnaSavedAt] = useState(null);
  const [cnaSaving, setCnaSaving] = useState(false);
  const [ai, setAi] = useState(null);
  const [aiGeneratedAt, setAiGeneratedAt] = useState(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");

  // Pull the latest appointment for this lead. Newest-first sort lives
  // on the server (list_appointments orders by date+time asc, so we
  // reverse here). Quietly empties on any error — the card just
  // renders the empty-state copy.
  const loadRecentAppt = useCallback(async () => {
    if (!leadId) return;
    try {
      const { data } = await api.get(
        `/appointments?lead_id=${encodeURIComponent(leadId)}&limit=50`,
      );
      const rows = data?.appointments || [];
      // Pick the most recent by appointment_date desc, then time desc.
      rows.sort((a, b) => {
        const da = `${a.appointment_date} ${a.appointment_time || ""}`;
        const db = `${b.appointment_date} ${b.appointment_time || ""}`;
        return db.localeCompare(da);
      });
      setRecentAppt(rows[0] || null);
    } catch {
      setRecentAppt(null);
    }
  }, [leadId]);

  useEffect(() => {
    loadRecentAppt();
  }, [loadRecentAppt]);

  // Feature A — outcome button handler. POSTs the chosen outcome,
  // navigates to /applications on "sold", and refreshes the card on
  // any other outcome so the badge + history line update inline.
  const setAppointmentOutcome = useCallback(
    async (outcome) => {
      if (!recentAppt?.appointment_id) return;
      setOutcomeSaving(true);
      try {
        await api.post(
          `/appointments/${encodeURIComponent(recentAppt.appointment_id)}/outcome`,
          { outcome },
        );
        if (outcome === "sold") {
          // ApplicationSubmission Step 1 reads ?lead_id and pre-loads
          // the contact (existing two-tab flow already handles this).
          navigate(`/applications?lead_id=${encodeURIComponent(leadId)}`);
          return;
        }
        toast.success(
          outcome === "no_show"
            ? "Marked no-show — reschedule email sent."
            : `Marked ${outcome.replace("_", " ")}.`,
        );
        await loadRecentAppt();
      } catch (err) {
        toast.error(
          err?.response?.data?.detail || "Couldn't save the outcome.",
        );
      } finally {
        setOutcomeSaving(false);
      }
    },
    [recentAppt, leadId, navigate, loadRecentAppt],
  );

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

  const loadCna = useCallback(async () => {
    if (!leadId) return;
    try {
      const { data } = await api.get(`/cna/${leadId}`);
      setCna(data?.cna || null);
      setCnaExists(Boolean(data?.exists));
      setCnaSavedAt(data?.cna?.updated_at || data?.cna?.completed_at || null);
      setAi(data?.cna?.ai_recommendation || null);
      setAiGeneratedAt(data?.cna?.ai_generated_at || null);
    } catch {
      setCna(null);
      setCnaExists(false);
    }
  }, [leadId]);

  useEffect(() => {
    loadCna();
  }, [loadCna]);

  // Persist a partial CNA update. Used by the autosave-on-blur handlers
  // and by the explicit Save buttons. ``runAi`` triggers a fresh AI
  // analysis on the same round-trip and flips back to the Overview tab.
  const saveCna = useCallback(
    async (patch = {}, { runAi = false, silent = false } = {}) => {
      if (!leadId) return;
      const next = { ...(cna || {}), ...patch };
      setCna(next);
      setCnaSaving(true);
      if (runAi) setAiRunning(true);
      try {
        const url = runAi
          ? `/cna/${leadId}?run_ai=true`
          : `/cna/${leadId}`;
        const { data } = await api.post(url, next);
        setCna(data?.cna || next);
        setCnaExists(true);
        setCnaSavedAt(data?.cna?.updated_at || new Date().toISOString());
        if (runAi) {
          setAi(data?.ai_recommendation || null);
          setAiGeneratedAt(data?.ai_generated_at || null);
          if (!silent) {
            toast.success("AI analysis ready");
          }
          setActiveTab("overview");
          window?.scrollTo?.({ top: 0, behavior: "smooth" });
        } else if (!silent) {
          // Soft "saved" indicator handled by cnaSavedAt — no toast.
        }
      } catch (err) {
        if (!silent) {
          toast.error(
            err?.response?.data?.detail || "Couldn't save the CNA"
          );
        }
      } finally {
        setCnaSaving(false);
        setAiRunning(false);
      }
    },
    [leadId, cna],
  );

  const refreshAi = useCallback(async () => {
    if (!leadId) return;
    setAiRunning(true);
    try {
      const { data } = await api.post(`/cna/${leadId}/ai-analysis`);
      setAi(data?.ai_recommendation || null);
      setAiGeneratedAt(data?.ai_generated_at || null);
      toast.success("AI analysis refreshed");
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Couldn't refresh AI analysis"
      );
    } finally {
      setAiRunning(false);
    }
  }, [leadId]);

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
          address_line1: data.address_line1 || "",
          address_line2: data.address_line2 || "",
          city: data.city || "",
          state: data.state || "",
          zip_code: data.zip_code || "",
          current_carrier: data.current_carrier || "",
          current_plan: data.current_plan || "",
          product_interest: data.product_interest || "",
          medicare_part_a_effective: data.medicare_part_a_effective || "",
          medicare_part_b_effective: data.medicare_part_b_effective || "",
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
      // Send only fields that have a non-empty value. Backend strips
      // None via `if v is not None`, so omitting an empty string keeps
      // the existing DB value rather than blanking it.
      const patch = {};
      const fields = [
        "first_name", "last_name", "email", "phone", "date_of_birth",
        "address_line1", "address_line2", "city", "state", "zip_code",
        "current_carrier", "current_plan", "product_interest",
        "medicare_part_a_effective", "medicare_part_b_effective",
      ];
      fields.forEach((f) => {
        if (editForm[f] !== undefined && editForm[f] !== "") {
          patch[f] = editForm[f];
        }
      });
      // Status always goes (enum, defaults to "new" so we can clear).
      patch.status = editForm.status || "new";
      // Preserve free-text notes — the Notes tab is the editor, but a
      // concurrent edit there shouldn't be blown away by this save.
      if (lead?.notes !== undefined) patch.notes = lead.notes;

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

  // ── Agent transfer (admin / coach) ─────────────────────────────────────
  const currentUser = auth.getUser();
  const canTransfer =
    currentUser?.role === "admin" ||
    currentUser?.role === "owner" ||
    currentUser?.role === "coach";
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferAgents, setTransferAgents] = useState([]);
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferLoadingAgents, setTransferLoadingAgents] = useState(false);
  const [transferring, setTransferring] = useState(false);

  // Reset sheet state every time it closes so reopening starts clean.
  useEffect(() => {
    if (!transferOpen) {
      setTransferTargetId("");
      setTransferReason("");
      setTransferring(false);
    }
  }, [transferOpen]);

  // Fetch the agent list lazily — only when the sheet actually opens.
  // Filter to role=agent so admins/coach/CS accounts don't appear as
  // transfer targets (backend rejects them anyway with 422).
  useEffect(() => {
    if (!transferOpen) return;
    let alive = true;
    setTransferLoadingAgents(true);
    (async () => {
      try {
        const res = await api.get("/agents");
        if (!alive) return;
        const all = res?.data?.agents || [];
        setTransferAgents(
          all.filter(
            (a) => a.role === "agent" && a.is_active !== false &&
                    a.id !== lead?.agent_id,
          ),
        );
      } catch {
        if (alive) setTransferAgents([]);
      } finally {
        if (alive) setTransferLoadingAgents(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [transferOpen, lead?.agent_id]);

  async function submitTransfer() {
    if (!transferTargetId) {
      toast.error("Pick an agent");
      return;
    }
    setTransferring(true);
    try {
      const payload = { new_agent_id: transferTargetId };
      if (transferReason.trim()) payload.reason = transferReason.trim();
      const { data } = await api.patch(
        `/leads/${leadId}/transfer`,
        payload,
      );
      setLead(data);
      const target = transferAgents.find((a) => a.id === transferTargetId);
      toast.success(
        `Client transferred to ${target?.full_name || target?.agent_name || "agent"}`,
      );
      setTransferOpen(false);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Transfer failed");
    } finally {
      setTransferring(false);
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
                <LeadTagsRow
                  lead={lead}
                  onChange={(tags) => setLead((p) => (p ? { ...p, tags } : p))}
                />
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
                {canTransfer && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTransferOpen(true)}
                    data-testid="client-transfer-btn"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 mr-1.5" />
                    Transfer Client
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
                <p className="col-span-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-2">
                  Personal Info
                </p>
                <div className="col-span-2 md:col-span-1">
                  <Label className="text-xs">First Name</Label>
                  <Input
                    value={editForm.first_name || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, first_name: e.target.value }))
                    }
                    data-testid="client-edit-first-name"
                  />
                </div>
                <div>
                  <Label className="text-xs">Last Name</Label>
                  <Input
                    value={editForm.last_name || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, last_name: e.target.value }))
                    }
                    data-testid="client-edit-last-name"
                  />
                </div>
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input
                    type="email"
                    value={editForm.email || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, email: e.target.value }))
                    }
                    data-testid="client-edit-email"
                  />
                </div>
                <div>
                  <Label className="text-xs">Phone</Label>
                  <Input
                    type="tel"
                    value={editForm.phone || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, phone: e.target.value }))
                    }
                    data-testid="client-edit-phone"
                  />
                </div>
                <div>
                  <Label className="text-xs">Date of Birth</Label>
                  <Input
                    type="date"
                    value={(editForm.date_of_birth || "").slice(0, 10)}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        date_of_birth: e.target.value,
                      }))
                    }
                    data-testid="client-edit-dob"
                  />
                </div>

                <p className="col-span-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-2">
                  Address
                </p>
                <div className="col-span-2">
                  <Label className="text-xs">Address Line 1</Label>
                  <Input
                    value={editForm.address_line1 || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        address_line1: e.target.value,
                      }))
                    }
                    data-testid="client-edit-addr1"
                  />
                </div>
                <div className="col-span-2">
                  <Label className="text-xs">Address Line 2</Label>
                  <Input
                    value={editForm.address_line2 || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        address_line2: e.target.value,
                      }))
                    }
                    data-testid="client-edit-addr2"
                  />
                </div>
                <div>
                  <Label className="text-xs">City</Label>
                  <Input
                    value={editForm.city || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, city: e.target.value }))
                    }
                    data-testid="client-edit-city"
                  />
                </div>
                <div>
                  <Label className="text-xs">State</Label>
                  <Input
                    value={editForm.state || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        state: e.target.value.toUpperCase(),
                      }))
                    }
                    maxLength={2}
                    data-testid="client-edit-state"
                  />
                </div>
                <div>
                  <Label className="text-xs">Zip Code</Label>
                  <Input
                    value={editForm.zip_code || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, zip_code: e.target.value }))
                    }
                    data-testid="client-edit-zip"
                  />
                </div>

                <p className="col-span-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-2">
                  Coverage
                </p>
                <div>
                  <Label className="text-xs">Current Carrier</Label>
                  <Input
                    value={editForm.current_carrier || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        current_carrier: e.target.value,
                      }))
                    }
                    data-testid="client-edit-carrier"
                  />
                </div>
                <div>
                  <Label className="text-xs">Current Plan</Label>
                  <Input
                    value={editForm.current_plan || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        current_plan: e.target.value,
                      }))
                    }
                    data-testid="client-edit-plan"
                  />
                </div>
                <div className="col-span-2">
                  <Label className="text-xs">Product Interest</Label>
                  <Input
                    value={editForm.product_interest || ""}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        product_interest: e.target.value,
                      }))
                    }
                    data-testid="client-edit-product"
                  />
                </div>

                <p className="col-span-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-2">
                  Medicare
                </p>
                <div>
                  <Label className="text-xs">Part A Effective</Label>
                  <Input
                    type="date"
                    value={(editForm.medicare_part_a_effective || "").slice(0, 10)}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        medicare_part_a_effective: e.target.value,
                      }))
                    }
                    data-testid="client-edit-part-a"
                  />
                </div>
                <div>
                  <Label className="text-xs">Part B Effective</Label>
                  <Input
                    type="date"
                    value={(editForm.medicare_part_b_effective || "").slice(0, 10)}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        medicare_part_b_effective: e.target.value,
                      }))
                    }
                    data-testid="client-edit-part-b"
                  />
                </div>

                <p className="col-span-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-2">
                  Status
                </p>
                <div className="col-span-2">
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
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
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
            <TabsTrigger value="cna" data-testid="tab-cna">
              CNA
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
            <AIIntelligencePanel
              ai={ai}
              generatedAt={aiGeneratedAt}
              cnaExists={cnaExists}
              running={aiRunning}
              onRefresh={refreshAi}
              onStartCna={() => setActiveTab("cna")}
            />

            {/* Feature A — appointment outcome buttons. Shows the most
                recent appointment + four outcome actions. "Sold"
                navigates to the application wizard; "No Show" fires a
                reschedule email server-side; "Showed" / "Not Sold"
                stamp the outcome only. */}
            {recentAppt && (
              <Card data-testid="appointment-outcome-card">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-sm font-semibold">
                        Most recent appointment
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {fmtDate(recentAppt.appointment_date)}
                        {recentAppt.appointment_time
                          ? ` · ${recentAppt.appointment_time}`
                          : ""}
                        {recentAppt.type
                          ? ` · ${recentAppt.type.replace(/_/g, " ")}`
                          : ""}
                      </p>
                    </div>
                    {recentAppt.outcome && (
                      <Badge
                        variant="outline"
                        className="text-[11px]"
                        data-testid="appointment-outcome-badge"
                      >
                        {recentAppt.outcome.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={outcomeSaving}
                      onClick={() => setAppointmentOutcome("showed")}
                      data-testid="outcome-btn-showed"
                    >
                      Showed
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={outcomeSaving}
                      onClick={() => setAppointmentOutcome("no_show")}
                      data-testid="outcome-btn-no-show"
                    >
                      No Show
                    </Button>
                    <Button
                      size="sm"
                      disabled={outcomeSaving}
                      onClick={() => setAppointmentOutcome("sold")}
                      data-testid="outcome-btn-sold"
                      className="bg-emerald-600 hover:bg-emerald-700"
                    >
                      Sold
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={outcomeSaving}
                      onClick={() => setAppointmentOutcome("not_sold")}
                      data-testid="outcome-btn-not-sold"
                    >
                      Not Sold
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

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

          {/* Tab 2.75: Client Needs Assessment */}
          <TabsContent value="cna" className="mt-4">
            <CnaTab
              cna={cna || {}}
              savedAt={cnaSavedAt}
              saving={cnaSaving}
              aiRunning={aiRunning}
              onPatch={(patch) => saveCna(patch, { silent: true })}
              onSaveAndGenerate={() => saveCna({}, { runAi: true })}
            />
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
            <LeadNotesPanel leadId={leadId} />
            <Card>
              <CardContent className="p-5 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Client Notes (legacy)</h3>
                  <span className="text-[11px] text-muted-foreground">
                    {notesSavedAt
                      ? `Saved ${notesSavedAt.toLocaleTimeString()}`
                      : "Auto-saves as you type"}
                  </span>
                </div>
                <Textarea
                  rows={6}
                  value={notesDraft}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="Free-text notes about this client…"
                  data-testid="notes-textarea"
                />
                <p className="text-[11px] text-muted-foreground">
                  Use the entries above for structured calls / emails /
                  tasks; this free-text field stays available for
                  pre-existing notes captured before that feature shipped.
                </p>
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

      {/* Transfer Client sheet — admin + coach only, opens from the
          header action row. Server-side require_roles("admin", "coach")
          plus a destination-must-be-role-agent check is the source of
          truth; this UI is the friendly path. */}
      <Sheet open={transferOpen} onOpenChange={setTransferOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle>
              Transfer {lead?.first_name} {lead?.last_name} to a
              different agent
            </SheetTitle>
            <SheetDescription>
              Pick the destination agent. Historical records (notes,
              documents, audit trail) stay with this client — only
              future activity routes to the new agent.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4">
            <div>
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5 block">
                Destination agent *
              </Label>
              <Select
                value={transferTargetId}
                onValueChange={setTransferTargetId}
                disabled={transferLoadingAgents}
              >
                <SelectTrigger className="h-10" data-testid="transfer-agent-select">
                  <SelectValue
                    placeholder={
                      transferLoadingAgents ? "Loading agents…" : "Pick an agent"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {transferAgents.length === 0 && !transferLoadingAgents && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      No other agents available.
                    </div>
                  )}
                  {transferAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.full_name || a.agent_name || a.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5 block">
                Reason (optional)
              </Label>
              <Input
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
                maxLength={200}
                placeholder="Territory change, agent departure, load balancing…"
                data-testid="transfer-reason"
              />
              <p className="text-[10px] text-muted-foreground mt-1 text-right">
                {transferReason.length}/200
              </p>
            </div>

            <div
              className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                This will move all future activity to the selected
                agent. Historical records are preserved.
              </span>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setTransferOpen(false)}
                disabled={transferring}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="flex-1 bg-[#e85d2f] hover:bg-[#c84416]"
                onClick={submitTransfer}
                disabled={transferring || !transferTargetId}
                data-testid="transfer-confirm"
              >
                {transferring ? "Transferring…" : "Confirm Transfer"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Tags row — sits under the header badge row in the client profile. Reads
// the current names off the parent lead, calls the parent's onChange to
// keep the parent state in sync after each add/remove (so the rest of
// the page that depends on lead.tags never goes stale).
function LeadTagsRow({ lead, onChange }) {
  const { byName } = useTagLibrary();
  const names = lead?.tags || [];

  async function add(tag) {
    try {
      const { data } = await api.post(`/leads/${lead.id}/tags`, {
        tag: tag.name,
      });
      onChange?.(data?.tags || []);
      toast.success(`Tagged ${tag.label}`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't add tag");
    }
  }

  async function remove(name) {
    try {
      const { data } = await api.delete(
        `/leads/${lead.id}/tags/${encodeURIComponent(name)}`,
      );
      onChange?.(data?.tags || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't remove tag");
    }
  }

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2"
      data-testid="client-tags-row"
    >
      <span className="text-[11px] uppercase tracking-widest text-muted-foreground mr-1">
        Tags
      </span>
      {names.length === 0 && (
        <span className="text-xs text-muted-foreground">No tags yet.</span>
      )}
      {names.map((n) => (
        <TagBadge
          key={n}
          tag={byName.get(n)}
          name={n}
          onRemove={() => remove(n)}
          testId={`client-tag-${n}`}
        />
      ))}
      <AddTagPopover
        appliedNames={names}
        onPick={add}
        triggerTestId="client-add-tag-btn"
      />
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


// ─────────────────────────────────────────────────────────────────────────
// AI Intelligence Panel — drops in at the top of the Overview tab.
// Renders three states:
//   1. No CNA yet → empty card with "Start CNA →" button
//   2. CNA saved but AI not run / pending → empty card with "Generate AI"
//   3. AI available → full recommendation panel (urgency, plan, talking
//      points, formal script)
// ─────────────────────────────────────────────────────────────────────────
function _urgencyTone(score) {
  if (score >= 75) return { label: "URGENT", bar: "bg-red-500", text: "text-red-700" };
  if (score >= 50) return { label: "HIGH PRIORITY", bar: "bg-amber-500", text: "text-amber-700" };
  if (score >= 25) return { label: "MODERATE", bar: "bg-blue-500", text: "text-blue-700" };
  return { label: "LOW", bar: "bg-gray-400", text: "text-gray-600" };
}

function _severityDot(severity) {
  const s = (severity || "").toLowerCase();
  if (s === "high") return "bg-red-500";
  if (s === "medium") return "bg-amber-500";
  return "bg-emerald-500";
}

function AIIntelligencePanel({
  ai,
  generatedAt,
  cnaExists,
  running,
  onRefresh,
  onStartCna,
}) {
  // No CNA yet — empty-state card pointing the agent at the CNA tab.
  if (!cnaExists) {
    return (
      <Card
        className="border-l-4 border-l-[#1B4332]"
        data-testid="ai-panel-empty"
      >
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-[#1B4332] mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold mb-1">
                AI Client Intelligence
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                Complete the Client Needs Assessment to unlock AI-powered
                recommendations for this client.
              </p>
              <Button size="sm" onClick={onStartCna}>
                Start CNA →
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // CNA saved but no AI yet (or AI cache was cleared by an update).
  if (!ai) {
    return (
      <Card className="border-l-4 border-l-[#1B4332]">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-[#1B4332] mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold mb-1">
                AI Client Intelligence
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                CNA on file. Generate an AI recommendation to see urgency,
                plan suggestion, and talking points.
              </p>
              <Button
                size="sm"
                onClick={onRefresh}
                disabled={running}
                data-testid="ai-panel-generate"
              >
                {running ? "Analyzing…" : "Generate AI Analysis"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const score = Number(ai.urgency_score || 0);
  const tone = _urgencyTone(score);
  const exposures = ai.key_exposures || [];
  const cross = ai.cross_sell_opportunities || [];
  const talkingPoints = ai.talking_points || [];
  const objections = ai.objection_handles || [];
  const generatedLabel = generatedAt
    ? new Date(generatedAt).toLocaleString()
    : "—";

  return (
    <Card
      className="border-l-4 border-l-[#1B4332]"
      data-testid="ai-panel"
    >
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#1B4332]" />
            <h3 className="text-sm font-semibold">AI Client Intelligence</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Generated {generatedLabel}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={running}
              data-testid="ai-panel-refresh"
            >
              <RefreshCw className={`w-4 h-4 ${running ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Urgency score */}
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-xs uppercase tracking-widest text-muted-foreground">
              Urgency score
            </span>
            <span
              className="text-2xl font-bold tabular-nums"
              style={{ fontFamily: "Outfit" }}
            >
              {score}
              <span className="text-sm text-muted-foreground font-normal">
                /100
              </span>
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
            <div
              className={`${tone.bar} h-full transition-all`}
              style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between items-center text-xs">
            <span className={`font-semibold ${tone.text}`}>{tone.label}</span>
            {ai.urgency_reason && (
              <span className="text-muted-foreground truncate ml-2">
                {ai.urgency_reason}
              </span>
            )}
          </div>
        </div>

        {/* Recommendation summary */}
        <div className="bg-gray-50 rounded-md p-3">
          <div className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
            Recommendation
          </div>
          <div className="font-semibold text-sm">
            Medicare{" "}
            {ai.recommended_plan_type === "supplement"
              ? "Supplement"
              : ai.recommended_plan_type === "advantage"
                ? "Advantage"
                : "Supplement or Advantage"}{" "}
            + Umbrella {ai.recommended_umbrella || "—"}
          </div>
          {ai.estimated_monthly_range && (
            <div className="text-xs text-muted-foreground mt-0.5">
              Estimated {ai.estimated_monthly_range} ·{" "}
              {ai.confidence || "medium"} confidence
            </div>
          )}
          {ai.primary_reason && (
            <p className="text-sm mt-2">{ai.primary_reason}</p>
          )}
        </div>

        {/* Exposures + cross-sell side by side */}
        {(exposures.length > 0 || cross.length > 0) && (
          <div className="grid md:grid-cols-2 gap-4">
            {exposures.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground mb-2">
                  Key exposures
                </div>
                <ul className="space-y-1.5">
                  {exposures.map((x, i) => (
                    <li
                      key={`exp-${i}`}
                      className="flex items-start gap-2 text-sm"
                    >
                      <span
                        className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${_severityDot(x.severity)}`}
                      />
                      <div className="min-w-0">
                        <div className="font-medium">{x.description}</div>
                        {x.talking_point && (
                          <div className="text-xs text-muted-foreground">
                            {x.talking_point}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {cross.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground mb-2">
                  Cross-sell
                </div>
                <ul className="space-y-1.5">
                  {cross.map((c, i) => (
                    <li
                      key={`cross-${i}`}
                      className="flex items-start gap-2 text-sm"
                    >
                      <DollarSign className="w-3.5 h-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium">
                          {(c.product || "").toString().replace(/_/g, " ")}
                          {c.priority === "immediate" && (
                            <Badge className="ml-2 bg-amber-100 text-amber-900 text-[10px]">
                              IMMEDIATE
                            </Badge>
                          )}
                        </div>
                        {c.reason && (
                          <div className="text-xs text-muted-foreground">
                            {c.reason}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Talking points */}
        {talkingPoints.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground mb-2">
              Talking points
            </div>
            <ul className="space-y-1 text-sm list-disc list-inside marker:text-muted-foreground">
              {talkingPoints.map((tp, i) => (
                <li key={`tp-${i}`}>{tp}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Objection handles */}
        {objections.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground mb-2">
              Objection handles
            </div>
            <ul className="space-y-2 text-sm">
              {objections.map((o, i) => (
                <li
                  key={`obj-${i}`}
                  className="border-l-2 border-amber-300 pl-3"
                >
                  <div className="font-medium">{o.objection}</div>
                  {o.response && (
                    <div className="text-muted-foreground text-xs mt-0.5">
                      {o.response}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Formal script + copy */}
        {ai.formal_recommendation_script && (
          <div className="bg-gray-50 rounded-md p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-widest text-muted-foreground">
                Formal recommendation script
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      ai.formal_recommendation_script,
                    );
                    toast.success("Script copied");
                  } catch {
                    toast.error("Couldn't copy");
                  }
                }}
                data-testid="ai-panel-copy-script"
              >
                <Copy className="w-3.5 h-3.5 mr-1" /> Copy
              </Button>
            </div>
            <p className="text-sm italic">{ai.formal_recommendation_script}</p>
          </div>
        )}

        {/* Next best action */}
        {ai.next_best_action && (
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
              Next best action
            </div>
            <p className="text-sm font-medium">{ai.next_best_action}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// CNA Tab — the structured assessment form. Every field calls back into
// ``onPatch`` on blur so partial answers persist without an explicit
// save action. The "Save & Generate AI" button does one final round-
// trip with run_ai=true, which the parent uses to jump to Overview.
// ─────────────────────────────────────────────────────────────────────────
function CnaTab({ cna, savedAt, saving, aiRunning, onPatch, onSaveAndGenerate }) {
  // Local mirror so typing doesn't trip every keystroke through the
  // server. We only fire ``onPatch`` on blur or list-mutating actions.
  const [draft, setDraft] = useState(cna || {});

  useEffect(() => {
    setDraft(cna || {});
  }, [cna]);

  const set = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  // Patch on blur — only fire when the field actually changed since
  // last persisted value.
  const flush = (key) => {
    const next = draft[key];
    const prev = (cna || {})[key];
    if (next === prev) return;
    onPatch({ [key]: next });
  };

  // List helpers — used by prescriptions + preferred doctors.
  const addRow = (key, blank) => {
    const list = Array.isArray(draft[key]) ? [...draft[key]] : [];
    list.push(blank);
    setDraft((d) => ({ ...d, [key]: list }));
    onPatch({ [key]: list });
  };
  const removeRow = (key, idx) => {
    const list = Array.isArray(draft[key]) ? [...draft[key]] : [];
    list.splice(idx, 1);
    setDraft((d) => ({ ...d, [key]: list }));
    onPatch({ [key]: list });
  };
  const updateRow = (key, idx, patch, persistImmediately = false) => {
    const list = Array.isArray(draft[key]) ? [...draft[key]] : [];
    list[idx] = { ...(list[idx] || {}), ...patch };
    setDraft((d) => ({ ...d, [key]: list }));
    if (persistImmediately) onPatch({ [key]: list });
  };

  const savedLabel = savedAt
    ? new Date(savedAt).toLocaleString()
    : "Not saved yet";

  return (
    <Card>
      <CardContent className="p-5 space-y-6" data-testid="cna-form">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold">Client Needs Assessment</h3>
            <p className="text-xs text-muted-foreground">
              Based on COACHG Initial Appointment Script
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {saving ? "Saving…" : `Last saved: ${savedLabel}`}
          </span>
        </div>

        {/* Appointment goal */}
        <section>
          <Label htmlFor="cna-goal" className="text-xs uppercase tracking-wider">
            Appointment goal
          </Label>
          <Textarea
            id="cna-goal"
            rows={2}
            placeholder="What would you like to accomplish today?"
            value={draft.appointment_goal || ""}
            onChange={(e) => set("appointment_goal", e.target.value)}
            onBlur={() => flush("appointment_goal")}
            className="mt-1"
          />
        </section>

        {/* Employment & Income */}
        <CnaSection title="Employment & Income">
          <CnaSelect
            label="Current situation"
            value={draft.employment_status || ""}
            onChange={(v) => { set("employment_status", v); onPatch({ employment_status: v }); }}
            options={[
              { value: "working", label: "Working" },
              { value: "retired", label: "Retired" },
              { value: "other", label: "Other" },
            ]}
          />
          <CnaYesNo
            label="Drawing Social Security"
            value={draft.drawing_social_security}
            onChange={(v) => { set("drawing_social_security", v); onPatch({ drawing_social_security: v }); }}
          />
          <CnaSelect
            label="Household income range"
            value={draft.household_income_range || ""}
            onChange={(v) => { set("household_income_range", v); onPatch({ household_income_range: v }); }}
            options={[
              { value: "under_85k", label: "Under $85k" },
              { value: "85k_107k", label: "$85k–$107k" },
              { value: "107k_133k", label: "$107k–$133k" },
              { value: "133k_160k", label: "$133k–$160k" },
              { value: "over_160k", label: "Over $160k" },
            ]}
          />
          <CnaYesNo
            label="Qualified assets >$200k"
            value={draft.has_qualified_assets_200k}
            onChange={(v) => { set("has_qualified_assets_200k", v); onPatch({ has_qualified_assets_200k: v }); }}
          />
        </CnaSection>

        {/* Current Coverage */}
        <CnaSection title="Current Coverage">
          <CnaSelect
            label="Coverage type"
            value={draft.current_coverage_type || ""}
            onChange={(v) => { set("current_coverage_type", v); onPatch({ current_coverage_type: v }); }}
            options={[
              { value: "employer", label: "Employer" },
              { value: "marketplace", label: "Marketplace" },
              { value: "medicaid", label: "Medicaid" },
              { value: "tricare", label: "TRICARE" },
              { value: "none", label: "None" },
              { value: "other", label: "Other" },
            ]}
          />
          <CnaText
            label="Carrier"
            value={draft.current_carrier || ""}
            onChange={(v) => set("current_carrier", v)}
            onBlur={() => flush("current_carrier")}
          />
          <CnaYesNo
            label="Employer-sponsored"
            value={draft.is_employer_sponsored}
            onChange={(v) => { set("is_employer_sponsored", v); onPatch({ is_employer_sponsored: v }); }}
          />
          <CnaNumber
            label="Monthly premium ($)"
            value={draft.current_monthly_premium}
            onChange={(v) => set("current_monthly_premium", v)}
            onBlur={() => flush("current_monthly_premium")}
          />
          <CnaNumber
            label="Deductible ($)"
            value={draft.current_deductible}
            onChange={(v) => set("current_deductible", v)}
            onBlur={() => flush("current_deductible")}
          />
          <CnaNumber
            label="Max out-of-pocket ($)"
            value={draft.current_max_oop}
            onChange={(v) => set("current_max_oop", v)}
            onBlur={() => flush("current_max_oop")}
          />
          <CnaYesNo
            label="Hit deductible this year"
            value={draft.hit_deductible_this_year}
            onChange={(v) => { set("hit_deductible_this_year", v); onPatch({ hit_deductible_this_year: v }); }}
          />
        </CnaSection>

        {/* Health & Prescriptions */}
        <CnaSection title="Health & Prescriptions">
          <div className="md:col-span-2">
            <Label className="text-xs uppercase tracking-wider">
              Health history notes
            </Label>
            <Textarea
              rows={2}
              value={draft.health_history_notes || ""}
              onChange={(e) => set("health_history_notes", e.target.value)}
              onBlur={() => flush("health_history_notes")}
              className="mt-1"
            />
          </div>
          <CnaNumber
            label="Prescription count"
            value={draft.prescription_count}
            onChange={(v) => set("prescription_count", v)}
            onBlur={() => flush("prescription_count")}
          />
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs uppercase tracking-wider">
                Prescriptions
              </Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addRow("prescriptions", { name: "", condition: "" })
                }
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
            </div>
            <div className="space-y-2">
              {(draft.prescriptions || []).map((rx, i) => (
                <div key={`rx-${i}`} className="flex gap-2 items-center">
                  <Input
                    placeholder="Medication"
                    value={rx?.name || ""}
                    onChange={(e) =>
                      updateRow("prescriptions", i, { name: e.target.value })
                    }
                    onBlur={() => onPatch({ prescriptions: draft.prescriptions })}
                  />
                  <Input
                    placeholder="Treats"
                    value={rx?.condition || ""}
                    onChange={(e) =>
                      updateRow("prescriptions", i, {
                        condition: e.target.value,
                      })
                    }
                    onBlur={() => onPatch({ prescriptions: draft.prescriptions })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow("prescriptions", i)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <CnaSelect
            label="Critical illness history"
            value={draft.critical_illness_history || ""}
            onChange={(v) => { set("critical_illness_history", v); onPatch({ critical_illness_history: v }); }}
            options={[
              { value: "personal", label: "Personal" },
              { value: "family", label: "Family" },
              { value: "both", label: "Both" },
              { value: "none", label: "None" },
            ]}
          />
          <div className="md:col-span-2">
            <Label className="text-xs uppercase tracking-wider">
              Critical illness notes
            </Label>
            <Textarea
              rows={2}
              value={draft.critical_illness_notes || ""}
              onChange={(e) => set("critical_illness_notes", e.target.value)}
              onBlur={() => flush("critical_illness_notes")}
              className="mt-1"
            />
          </div>
          <CnaYesNo
            label="Skilled nursing experience"
            value={draft.skilled_nursing_experience}
            onChange={(v) => { set("skilled_nursing_experience", v); onPatch({ skilled_nursing_experience: v }); }}
          />
          <CnaYesNo
            label="Home healthcare experience"
            value={draft.home_healthcare_experience}
            onChange={(v) => { set("home_healthcare_experience", v); onPatch({ home_healthcare_experience: v }); }}
          />
        </CnaSection>

        {/* Coverage Gaps */}
        <CnaSection title="Coverage Gaps">
          <CnaYesNo
            label="Dental important"
            value={draft.dental_important}
            onChange={(v) => { set("dental_important", v); onPatch({ dental_important: v }); }}
          />
          <CnaYesNo
            label="Has dental coverage"
            value={draft.has_dental_coverage}
            onChange={(v) => { set("has_dental_coverage", v); onPatch({ has_dental_coverage: v }); }}
          />
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs uppercase tracking-wider">
                Preferred doctors
              </Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  addRow("preferred_doctors", { name: "", specialty: "" })
                }
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
            </div>
            <div className="space-y-2">
              {(draft.preferred_doctors || []).map((d, i) => (
                <div key={`doc-${i}`} className="flex gap-2 items-center">
                  <Input
                    placeholder="Name"
                    value={d?.name || ""}
                    onChange={(e) =>
                      updateRow("preferred_doctors", i, { name: e.target.value })
                    }
                    onBlur={() =>
                      onPatch({ preferred_doctors: draft.preferred_doctors })
                    }
                  />
                  <Input
                    placeholder="Specialty"
                    value={d?.specialty || ""}
                    onChange={(e) =>
                      updateRow("preferred_doctors", i, {
                        specialty: e.target.value,
                      })
                    }
                    onBlur={() =>
                      onPatch({ preferred_doctors: draft.preferred_doctors })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow("preferred_doctors", i)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <CnaSelect
            label="Knows MA vs Supplement difference"
            value={draft.knows_ma_vs_supp_difference || ""}
            onChange={(v) => { set("knows_ma_vs_supp_difference", v); onPatch({ knows_ma_vs_supp_difference: v }); }}
            options={[
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
              { value: "somewhat", label: "Somewhat" },
            ]}
          />
        </CnaSection>

        {/* Financial Protection */}
        <CnaSection title="Financial Protection">
          <CnaYesNo
            label="Has life insurance"
            value={draft.has_life_insurance}
            onChange={(v) => { set("has_life_insurance", v); onPatch({ has_life_insurance: v }); }}
          />
          <CnaSelect
            label="Life insurance type"
            value={draft.life_insurance_type || ""}
            onChange={(v) => { set("life_insurance_type", v); onPatch({ life_insurance_type: v }); }}
            options={[
              { value: "permanent", label: "Permanent" },
              { value: "term", label: "Term" },
              { value: "none", label: "None" },
            ]}
          />
          <CnaYesNo
            label="Important to them"
            value={draft.life_insurance_important}
            onChange={(v) => { set("life_insurance_important", v); onPatch({ life_insurance_important: v }); }}
          />
          <CnaYesNo
            label="Final expense covered"
            value={draft.final_expense_covered}
            onChange={(v) => { set("final_expense_covered", v); onPatch({ final_expense_covered: v }); }}
          />
          <CnaYesNo
            label="Retirement questions"
            value={draft.has_retirement_questions}
            onChange={(v) => { set("has_retirement_questions", v); onPatch({ has_retirement_questions: v }); }}
          />
        </CnaSection>

        {/* Medicare Direction */}
        <CnaSection title="Medicare Direction">
          <div className="md:col-span-2">
            <Label className="text-xs uppercase tracking-wider">
              Leaning toward
            </Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {[
                { value: "supplement", label: "Medicare Supplement" },
                { value: "advantage", label: "Medicare Advantage" },
                { value: "undecided", label: "Undecided" },
              ].map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  variant={
                    draft.medicare_direction_preference === opt.value
                      ? "default"
                      : "outline"
                  }
                  size="sm"
                  onClick={() => {
                    set("medicare_direction_preference", opt.value);
                    onPatch({ medicare_direction_preference: opt.value });
                  }}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs uppercase tracking-wider">
              Direction notes
            </Label>
            <Textarea
              rows={2}
              value={draft.direction_notes || ""}
              onChange={(e) => set("direction_notes", e.target.value)}
              onBlur={() => flush("direction_notes")}
              className="mt-1"
            />
          </div>
        </CnaSection>

        <div className="flex items-center justify-between flex-wrap gap-2 pt-3 border-t border-border">
          <span className="text-xs text-muted-foreground">
            Fields autosave on blur.
          </span>
          <Button
            type="button"
            onClick={onSaveAndGenerate}
            disabled={aiRunning}
            data-testid="cna-save-generate"
          >
            <Sparkles className="w-4 h-4 mr-1" />
            {aiRunning ? "Analyzing…" : "Save & Generate AI Analysis →"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}


// ── CNA sub-components ──────────────────────────────────────────────────
function CnaSection({ title, children }) {
  return (
    <section>
      <h4 className="text-xs uppercase tracking-widest text-muted-foreground mb-3 border-b border-border pb-1">
        {title}
      </h4>
      <div className="grid md:grid-cols-2 gap-4">{children}</div>
    </section>
  );
}

function CnaText({ label, value, onChange, onBlur }) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider">{label}</Label>
      <Input
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="mt-1"
      />
    </div>
  );
}

function CnaNumber({ label, value, onChange, onBlur }) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider">{label}</Label>
      <Input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onChange(null);
          else onChange(Number(v));
        }}
        onBlur={onBlur}
        className="mt-1"
      />
    </div>
  );
}

function CnaSelect({ label, value, onChange, options }) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider">{label}</Label>
      <Select value={value || ""} onValueChange={onChange}>
        <SelectTrigger className="mt-1">
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CnaYesNo({ label, value, onChange }) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wider">{label}</Label>
      <div className="flex gap-2 mt-1">
        <Button
          type="button"
          size="sm"
          variant={value === true ? "default" : "outline"}
          onClick={() => onChange(value === true ? null : true)}
        >
          Yes
        </Button>
        <Button
          type="button"
          size="sm"
          variant={value === false ? "default" : "outline"}
          onClick={() => onChange(value === false ? null : false)}
        >
          No
        </Button>
      </div>
    </div>
  );
}
