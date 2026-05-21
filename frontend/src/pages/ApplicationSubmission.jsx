import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
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
  CheckCircle2,
  UploadCloud,
  FileText,
  FileImage,
  Sparkles,
  ExternalLink,
  Plus,
  Trash2,
  Paperclip,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";

// Multi-file supporting-document constants — must match the backend
// caps in backend/application_router.py. Single source of truth lives
// server-side; these are the client mirror for early validation.
const SUPPORTING_LABELS = [
  "SOA",
  "Election Notice",
  "EFT Form",
  "PHI Auth",
  "ID Copy",
  "Other",
];
const SUPPORTING_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";
const SUPPORTING_EXTS = [".pdf", ".jpg", ".jpeg", ".png"];
const MAX_PER_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_TOTAL = 10; // primary PDF + up to 9 supporting

function bytesToMb(n) {
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function hasAllowedExt(name) {
  const lower = (name || "").toLowerCase();
  return SUPPORTING_EXTS.some((e) => lower.endsWith(e));
}

// Step machine — no STEP_SELECT_TYPE; AI auto-detects from PDF content.
const STEP = {
  FIND_CLIENT: 0,
  UPLOAD: 1,
  REVIEW: 2,
  DONE: 3,
};

const STEP_LABELS = ["Find Client", "Upload PDF", "Review", "Done"];

function contactDisplay(c) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return name || c.name || c.email || c.id;
}

function StepBar({ current }) {
  return (
    <ol className="flex items-center gap-2 mb-8" aria-label="Submission progress">
      {STEP_LABELS.map((label, idx) => {
        const isDone = idx < current;
        const isActive = idx === current;
        return (
          <li key={label} className="flex items-center gap-2 flex-1">
            <div
              className={[
                "w-7 h-7 rounded-full grid place-items-center text-xs font-semibold flex-shrink-0 border",
                isDone
                  ? "bg-[#e85d2f] border-[#e85d2f] text-white"
                  : isActive
                    ? "bg-white border-[#e85d2f] text-[#e85d2f]"
                    : "bg-white border-border text-muted-foreground",
              ].join(" ")}
              aria-current={isActive ? "step" : undefined}
            >
              {isDone ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
            </div>
            <span
              className={[
                "text-xs tracking-tight",
                isActive
                  ? "text-foreground font-medium"
                  : isDone
                    ? "text-foreground/70"
                    : "text-muted-foreground",
              ].join(" ")}
            >
              {label}
            </span>
            {idx < STEP_LABELS.length - 1 && (
              <span
                className={[
                  "flex-1 h-px",
                  idx < current ? "bg-[#e85d2f]" : "bg-border",
                ].join(" ")}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function ApplicationSubmission() {
  const [step, setStep] = useState(STEP.FIND_CLIENT);

  // Step 1: contact
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState(null);

  // Step 2: upload
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const fileInputRef = useRef(null);

  // Step 3: review
  const [extracted, setExtracted] = useState(null);
  const [productType, setProductType] = useState("");
  const [productLabel, setProductLabel] = useState("");
  const [fieldsAvailable, setFieldsAvailable] = useState([]);
  const [autoDetected, setAutoDetected] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");
  const [primarySize, setPrimarySize] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Supporting documents. Each row:
  //   { local_id, status: "uploading"|"done"|"error",
  //     filename, size_bytes, content_type, label, progress,
  //     file_id, s3_url, s3_key, error }
  // status="done" rows ship in the /submit body. "uploading"/"error" rows
  // do not — the submit button stays disabled while anything is still
  // mid-flight so the agent can't ship a half-written attachment list.
  const [supportingDocs, setSupportingDocs] = useState([]);
  const supportingInputRef = useRef(null);

  // Step 4: done
  const [syncedCount, setSyncedCount] = useState(0);
  const [ghlMock, setGhlMock] = useState(false);
  // Populated from /api/applications/submit response. The portal lead id
  // is what /clients/:leadId expects — NOT the GHL contact id — and the
  // backend auto-creates a lead row on submission if one didn't exist.
  const [submittedLeadId, setSubmittedLeadId] = useState(null);
  const [submittedLeadName, setSubmittedLeadName] = useState("");
  const [leadCreated, setLeadCreated] = useState(false);

  useEffect(() => {
    const q = contactQuery.trim();
    if (q.length < 2) {
      setContacts([]);
      return;
    }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get("/applications/search-contacts", {
          params: { query: q },
        });
        setContacts(data.contacts || []);
      } catch (err) {
        const detail =
          err?.response?.data?.detail || err?.message || "Search failed";
        toast.error(detail);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [contactQuery]);

  function pickContact(c) {
    setSelectedContact(c);
    setStep(STEP.UPLOAD);
  }

  function pickFile(f) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      toast.error("PDF files only.");
      return;
    }
    if (f.size > MAX_PER_FILE_BYTES) {
      toast.error("PDF exceeds 10MB.");
      return;
    }
    setFile(f);
    setPrimarySize(f.size);
  }

  // ── Supporting documents helpers ──
  function totalBytes(extraSize = 0) {
    return (
      primarySize +
      supportingDocs.reduce((s, d) => s + (d.size_bytes || 0), 0) +
      extraSize
    );
  }

  function totalFileCount(extra = 0) {
    // primary PDF counts as 1; supporting docs add to it.
    return (file ? 1 : 0) + supportingDocs.length + extra;
  }

  function updateSupportingDoc(localId, patch) {
    setSupportingDocs((prev) =>
      prev.map((d) => (d.local_id === localId ? { ...d, ...patch } : d)),
    );
  }

  async function uploadSupportingFile(localId, fileObj, label) {
    const fd = new FormData();
    fd.append("files", fileObj);
    fd.append("labels", JSON.stringify([label]));
    try {
      const { data } = await api.post(
        "/applications/upload-supporting",
        fd,
        {
          headers: { "Content-Type": "multipart/form-data" },
          onUploadProgress: (evt) => {
            if (!evt.total) return;
            updateSupportingDoc(localId, {
              progress: Math.min(99, Math.round((evt.loaded / evt.total) * 100)),
            });
          },
        },
      );
      const meta = (data.files && data.files[0]) || {};
      updateSupportingDoc(localId, {
        status: "done",
        progress: 100,
        file_id: meta.file_id || null,
        s3_url: meta.s3_url || "",
        s3_key: meta.s3_key || "",
        content_type: meta.content_type || fileObj.type,
        // Server may have coerced an invalid label to "Other"; trust it.
        label: meta.file_label || label,
        size_bytes: meta.size_bytes || fileObj.size,
        error: null,
      });
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Upload failed";
      updateSupportingDoc(localId, {
        status: "error",
        progress: 0,
        error: detail,
      });
      toast.error(detail);
    }
  }

  function addSupportingFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (incoming.length === 0) return;
    const toQueue = [];
    let runningTotal = totalBytes();
    for (const f of incoming) {
      if (!hasAllowedExt(f.name)) {
        toast.error(`${f.name}: PDF, JPG, or PNG only.`);
        continue;
      }
      if (f.size > MAX_PER_FILE_BYTES) {
        toast.error(`${f.name}: exceeds 10 MB.`);
        continue;
      }
      if (totalFileCount(toQueue.length) >= MAX_FILES_TOTAL) {
        toast.error(`Max ${MAX_FILES_TOTAL} files per submission.`);
        break;
      }
      if (runningTotal + f.size > MAX_TOTAL_BYTES) {
        toast.error(
          `${f.name}: would exceed the 50 MB total cap for this submission.`,
        );
        continue;
      }
      runningTotal += f.size;
      toQueue.push(f);
    }
    if (toQueue.length === 0) return;
    // Default label heuristic: any PDF that looks SOA-ish gets "SOA",
    // images get "ID Copy", everything else "Other". Agent can change.
    const seeded = toQueue.map((f) => {
      const lower = f.name.toLowerCase();
      let label = "Other";
      if (/soa|scope/.test(lower)) label = "SOA";
      else if (/eft|bank|ach/.test(lower)) label = "EFT Form";
      else if (/phi|hipaa/.test(lower)) label = "PHI Auth";
      else if (/election|notice/.test(lower)) label = "Election Notice";
      else if (/id|driver|license/.test(lower)) label = "ID Copy";
      return {
        local_id:
          (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : `doc-${Math.random().toString(36).slice(2)}`,
        file: f,
        filename: f.name,
        size_bytes: f.size,
        content_type: f.type,
        label,
        status: "uploading",
        progress: 0,
        file_id: null,
        s3_url: "",
        s3_key: "",
        error: null,
      };
    });
    setSupportingDocs((prev) => [...prev, ...seeded]);
    // Fire uploads concurrently.
    seeded.forEach((d) => uploadSupportingFile(d.local_id, d.file, d.label));
  }

  function removeSupportingDoc(localId) {
    setSupportingDocs((prev) => prev.filter((d) => d.local_id !== localId));
  }

  function changeSupportingLabel(localId, label) {
    updateSupportingDoc(localId, { label });
  }

  const supportingUploading = supportingDocs.some(
    (d) => d.status === "uploading",
  );
  const supportingDone = supportingDocs.filter((d) => d.status === "done");

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    pickFile(f);
  }

  async function handleExtract() {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    // No product_type — backend auto-detects from PDF content.
    setExtracting(true);
    try {
      const { data } = await api.post("/applications/extract", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setExtracted(data.extracted || {});
      setProductType(data.product_type || "");
      setProductLabel(data.product_label || "");
      setFieldsAvailable(data.fields_available || []);
      setAutoDetected(!!data.auto_detected);
      setPdfUrl(data.pdf_url || "");
      toast.success(
        `AI detected ${data.product_label || "application"} · ${data.field_count} field(s)`
      );
      setStep(STEP.REVIEW);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Extraction failed";
      toast.error(detail);
    } finally {
      setExtracting(false);
    }
  }

  function updateField(key, value) {
    setExtracted((prev) => ({ ...prev, [key]: value === "" ? null : value }));
  }

  const filledCount = useMemo(() => {
    if (!extracted) return 0;
    return Object.values(extracted).filter(
      (v) => v !== null && v !== undefined && String(v).trim() !== ""
    ).length;
  }, [extracted]);

  async function handleSubmit() {
    if (!selectedContact || !extracted) return;
    setSubmitting(true);
    try {
      const { data } = await api.post("/applications/submit", {
        contact_id: selectedContact.id,
        product_type: productType,
        extracted,
        contact_name: contactDisplay(selectedContact),
        pdf_url: pdfUrl || undefined,
        supporting_documents: supportingDone.map((d) => ({
          file_id: d.file_id,
          filename: d.filename,
          file_label: d.label,
          s3_url: d.s3_url,
          s3_key: d.s3_key,
          size_bytes: d.size_bytes,
          content_type: d.content_type,
        })),
      });
      setSyncedCount(data.fields_synced || 0);
      setGhlMock(!!data.ghl_mock);
      setSubmittedLeadId(data.lead_id || null);
      setSubmittedLeadName(
        data.lead_name || contactDisplay(selectedContact) || "Client",
      );
      setLeadCreated(!!data.lead_created);
      setStep(STEP.DONE);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Submit failed";
      toast.error(detail);
    } finally {
      setSubmitting(false);
    }
  }

  function resetAll() {
    setStep(STEP.FIND_CLIENT);
    setContactQuery("");
    setContacts([]);
    setSelectedContact(null);
    setFile(null);
    setPrimarySize(0);
    setExtracted(null);
    setProductType("");
    setProductLabel("");
    setFieldsAvailable([]);
    setAutoDetected(false);
    setPdfUrl("");
    setSupportingDocs([]);
    setSyncedCount(0);
    setGhlMock(false);
  }

  // "Submit Another" path — keep the same contact selected, clear everything
  // else, and drop the agent back at the upload step. Saves the contact-search
  // detour when the same client has multiple products on the same day.
  function submitAnotherForSameContact() {
    setFile(null);
    setPrimarySize(0);
    setExtracted(null);
    setProductType("");
    setProductLabel("");
    setFieldsAvailable([]);
    setAutoDetected(false);
    setPdfUrl("");
    setSupportingDocs([]);
    setSyncedCount(0);
    setGhlMock(false);
    setStep(STEP.UPLOAD);
  }

  return (
    <div className="p-6 md:p-8">
      <main className="max-w-3xl w-full mx-auto">
        <div className="mb-6">
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Submit Application
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload a signed insurance application PDF. AI identifies the product
            type and extracts the fields automatically.
          </p>
          <ImpersonationBanner />
        </div>

        <StepBar current={step} />

        {/* Step 1: Find Client */}
        {step === STEP.FIND_CLIENT && (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div>
                <Label htmlFor="contact-search">Search contact by name or email</Label>
                <Input
                  id="contact-search"
                  placeholder="At least 2 characters"
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  autoFocus
                  data-testid="contact-search-input"
                />
                {searching && (
                  <p className="text-xs text-muted-foreground mt-1">Searching…</p>
                )}
              </div>
              <div className="max-h-96 overflow-auto space-y-1">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => pickContact(c)}
                    className="w-full text-left px-3 py-2.5 rounded-md border border-border hover:border-[#e85d2f] hover:bg-[#e85d2f]/5 text-sm transition"
                    data-testid={`contact-option-${c.id}`}
                  >
                    <div className="font-medium">{contactDisplay(c)}</div>
                    {c.email && (
                      <div className="text-xs text-muted-foreground">{c.email}</div>
                    )}
                  </button>
                ))}
                {!searching &&
                  contactQuery.trim().length >= 2 &&
                  contacts.length === 0 && (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No matches.
                    </p>
                  )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Upload PDF */}
        {step === STEP.UPLOAD && (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center justify-between text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Submitting for
                  </div>
                  <div className="font-medium" data-testid="selected-contact-name">
                    {contactDisplay(selectedContact)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setStep(STEP.FIND_CLIENT)}
                  className="text-xs text-muted-foreground hover:text-[#e85d2f]"
                  data-testid="change-contact-btn"
                >
                  Change
                </button>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={[
                  "rounded-lg border-2 border-dashed transition cursor-pointer text-center p-8",
                  dragOver
                    ? "border-[#e85d2f] bg-[#e85d2f]/5"
                    : "border-border hover:border-[#e85d2f]/60 hover:bg-secondary/30",
                ].join(" ")}
                data-testid="pdf-dropzone"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                  data-testid="pdf-input"
                />
                {file ? (
                  <div className="flex items-center justify-center gap-3 text-sm">
                    <FileText className="w-5 h-5 text-[#e85d2f]" />
                    <div className="text-left">
                      <div className="font-medium">{file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <UploadCloud className="w-10 h-10 text-muted-foreground mx-auto" />
                    <div className="text-sm font-medium">
                      Drop the signed application PDF here
                    </div>
                    <div className="text-xs text-muted-foreground">
                      or click to browse · max 10MB
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                {file && (
                  <Button
                    variant="outline"
                    onClick={() => setFile(null)}
                    data-testid="clear-file-btn"
                  >
                    Clear
                  </Button>
                )}
                <Button
                  onClick={handleExtract}
                  disabled={!file || extracting}
                  data-testid="extract-btn"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  {extracting ? "Analyzing PDF…" : "Extract with AI"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Review */}
        {step === STEP.REVIEW && extracted && (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Submitting for
                  </div>
                  <div className="font-medium">
                    {contactDisplay(selectedContact)}
                  </div>
                </div>
                <Badge
                  variant="secondary"
                  className="bg-[#e85d2f]/10 text-[#e85d2f] border-[#e85d2f]/20"
                  data-testid="ai-detected-badge"
                >
                  <Sparkles className="w-3 h-3 mr-1.5" />
                  AI detected: {productLabel || productType}
                </Badge>
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground border-y border-border py-2">
                <span>
                  {filledCount} of{" "}
                  {fieldsAvailable.length || Object.keys(extracted).length}{" "}
                  fields populated
                </span>
                <span>{autoDetected ? "Auto-detected" : "Pre-classified"}</span>
              </div>

              <div className="grid md:grid-cols-2 gap-3">
                {(fieldsAvailable.length
                  ? fieldsAvailable
                  : Object.keys(extracted)
                ).map((key) => (
                  <div key={key}>
                    <Label
                      htmlFor={`fld-${key}`}
                      className="text-[11px] uppercase tracking-wider text-muted-foreground"
                    >
                      {key}
                    </Label>
                    <Input
                      id={`fld-${key}`}
                      value={
                        extracted[key] === null || extracted[key] === undefined
                          ? ""
                          : String(extracted[key])
                      }
                      onChange={(e) => updateField(key, e.target.value)}
                      placeholder="—"
                      data-testid={`fld-${key}`}
                    />
                  </div>
                ))}
              </div>

              {/* ── Supporting documents (optional, up to 9) ─────────── */}
              <div className="pt-4 border-t border-border space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      <Paperclip className="w-3.5 h-3.5 text-[#e85d2f]" />
                      Supporting documents
                      <Badge variant="outline" className="text-[10px] ml-1">
                        Optional
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      SOA, EFT, election notice, ID — up to{" "}
                      {MAX_FILES_TOTAL - 1} files · PDF/JPG/PNG · 10 MB each
                      · 50 MB total
                    </div>
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {supportingDocs.length}/{MAX_FILES_TOTAL - 1} files ·{" "}
                    {bytesToMb(totalBytes())} of {bytesToMb(MAX_TOTAL_BYTES)}
                  </div>
                </div>

                <input
                  ref={supportingInputRef}
                  type="file"
                  multiple
                  accept={SUPPORTING_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    addSupportingFiles(e.target.files);
                    // Reset so the same file can be re-picked after remove.
                    if (e.target) e.target.value = "";
                  }}
                  data-testid="supporting-file-input"
                />

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => supportingInputRef.current?.click()}
                  disabled={totalFileCount() >= MAX_FILES_TOTAL}
                  data-testid="add-supporting-btn"
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Add file
                </Button>

                {supportingDocs.length > 0 ? (
                  <ul className="space-y-2" data-testid="supporting-list">
                    {supportingDocs.map((d) => (
                      <li
                        key={d.local_id}
                        className="rounded-lg border border-border p-2.5 flex flex-wrap items-center gap-2"
                        data-testid={`supporting-row-${d.local_id}`}
                      >
                        {d.content_type?.startsWith("image/") ? (
                          <FileImage className="w-4 h-4 text-[#e85d2f] flex-shrink-0" />
                        ) : (
                          <FileText className="w-4 h-4 text-[#e85d2f] flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium truncate">
                            {d.filename}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {bytesToMb(d.size_bytes || 0)}
                            {d.status === "uploading" ? " · uploading…" : null}
                            {d.status === "error" ? (
                              <span className="text-red-600 inline-flex items-center gap-1 ml-1">
                                <AlertCircle className="w-3 h-3" />
                                {d.error || "Upload failed"}
                              </span>
                            ) : null}
                          </div>
                          {d.status === "uploading" ? (
                            <div className="w-full h-1 rounded-full bg-secondary mt-1 overflow-hidden">
                              <div
                                className="h-full transition-all"
                                style={{
                                  width: `${d.progress || 5}%`,
                                  background:
                                    "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
                                }}
                              />
                            </div>
                          ) : null}
                        </div>
                        <Select
                          value={d.label}
                          onValueChange={(v) =>
                            changeSupportingLabel(d.local_id, v)
                          }
                          disabled={d.status === "uploading"}
                        >
                          <SelectTrigger
                            className="h-7 w-36 text-xs"
                            data-testid={`supporting-label-${d.local_id}`}
                          >
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
                        <button
                          type="button"
                          onClick={() => removeSupportingDoc(d.local_id)}
                          className="text-muted-foreground hover:text-red-600 p-1"
                          aria-label={`Remove ${d.filename}`}
                          data-testid={`supporting-remove-${d.local_id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-border">
                <Button
                  variant="outline"
                  onClick={() => setStep(STEP.UPLOAD)}
                  data-testid="back-to-upload-btn"
                >
                  Back
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={submitting || supportingUploading}
                  data-testid="submit-btn"
                >
                  {submitting
                    ? "Submitting…"
                    : supportingUploading
                      ? "Waiting for uploads…"
                      : "Submit to GoHighLevel"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Done */}
        {step === STEP.DONE && (
          <Card>
            <CardContent className="pt-10 pb-10 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-emerald-100 grid place-items-center mx-auto">
                <CheckCircle2 className="w-7 h-7 text-emerald-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">
                  Application submitted successfully!
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Policy saved for{" "}
                  <span className="font-medium text-foreground">
                    {submittedLeadName || contactDisplay(selectedContact)}
                  </span>
                  {ghlMock ? " (mock mode)" : ""}.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Pushed {syncedCount} field{syncedCount === 1 ? "" : "s"} to GHL
                  {leadCreated ? " · new client added to your book" : ""}.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                {submittedLeadId && (
                  <Button asChild data-testid="view-client-profile-btn">
                    <Link to={`/clients/${submittedLeadId}`}>
                      <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                      View Client Profile
                    </Link>
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={submitAnotherForSameContact}
                  data-testid="submit-another-same-contact-btn"
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Submit Another for {submittedLeadName || contactDisplay(selectedContact)}
                </Button>
                <Button
                  variant="ghost"
                  onClick={resetAll}
                  data-testid="submit-another-btn"
                >
                  Submit Another (new client)
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
