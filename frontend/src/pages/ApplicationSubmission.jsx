import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileImage,
  FileText,
  Paperclip,
  Plus,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";

// ── Multi-file upload constants (mirrored from backend caps) ─────────────
const MAIN_LABEL = "Main Application";
const SUPPORTING_LABELS = [
  "SOA",
  "Election Notice",
  "EFT Form",
  "PHI Auth",
  "ID Copy",
  "Other",
];
const ALL_LABELS = [MAIN_LABEL, ...SUPPORTING_LABELS];
// Mobile-friendly: accept any PDF + any image. We deliberately omit the
// `capture` attribute so iOS / Android show the full "Camera Roll, Files,
// Take Photo" sheet rather than forcing the camera. The wide image/*
// covers JPG, PNG, HEIC (which Safari quietly transcodes to JPG on upload).
const MOBILE_ACCEPT = "application/pdf,image/*";
const ALLOWED_EXTS = [".pdf", ".jpg", ".jpeg", ".png"];
const MAX_PER_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_TOTAL = 10;

function bytesToMb(n) {
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function hasAllowedExtOrImage(file) {
  const lower = (file.name || "").toLowerCase();
  if (ALLOWED_EXTS.some((e) => lower.endsWith(e))) return true;
  // iOS Safari sometimes drops the .jpeg extension when uploading from
  // the camera roll — fall back to MIME type so the picker doesn't reject
  // those files. application/pdf and image/* are the only accepts.
  const t = (file.type || "").toLowerCase();
  return t === "application/pdf" || t.startsWith("image/");
}
function isPdf(file) {
  return (
    (file.content_type || file.type || "").toLowerCase() === "application/pdf"
    || (file.filename || file.name || "").toLowerCase().endsWith(".pdf")
  );
}

// ── Step machine ─────────────────────────────────────────────────────────
const STEP = {
  FIND_CLIENT: 0,
  UPLOAD: 1,
  REVIEW: 2,
  DONE: 3,
};
const STEP_LABELS = ["Find Client", "Upload Files", "Review", "Done"];

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

// ── Image thumbnail (revokes the blob URL on unmount) ───────────────────
function ImageThumb({ file, alt }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file) return undefined;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return <FileImage className="w-8 h-8 text-[#e85d2f]" />;
  return (
    <img
      src={url}
      alt={alt || "preview"}
      className="w-10 h-10 rounded object-cover border border-border"
    />
  );
}

function FileIconOrThumb({ doc }) {
  if (doc.file && !isPdf(doc.file)) {
    return <ImageThumb file={doc.file} alt={doc.filename} />;
  }
  if (isPdf(doc)) {
    return <FileText className="w-8 h-8 text-[#e85d2f]" />;
  }
  return <FileImage className="w-8 h-8 text-[#e85d2f]" />;
}

// ── Default label heuristic ─────────────────────────────────────────────
function guessLabel(name) {
  const lower = (name || "").toLowerCase();
  if (/soa|scope/.test(lower)) return "SOA";
  if (/eft|bank|ach|void/.test(lower)) return "EFT Form";
  if (/phi|hipaa|auth/.test(lower)) return "PHI Auth";
  if (/election|notice/.test(lower)) return "Election Notice";
  if (/id\b|driver|license/.test(lower)) return "ID Copy";
  return "Other";
}

// ───────────────────────────────────────────────────────────────────────
export default function ApplicationSubmission() {
  const [step, setStep] = useState(STEP.FIND_CLIENT);

  // Step 1: contact
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState(null);

  // Step 2: documents (multi-file, unified)
  // Each entry: {
  //   local_id, file (File, kept while primary), filename, size_bytes,
  //   content_type, label, status: "primary_ready"|"uploading"|"done"|"error",
  //   progress (0-100), file_id, s3_url, s3_key, error
  // }
  const [documents, setDocuments] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const mainPickerRef = useRef(null);
  const morePickerRef = useRef(null);

  // Step 3: review
  const [extracted, setExtracted] = useState(null);
  const [productType, setProductType] = useState("");
  const [productLabel, setProductLabel] = useState("");
  const [fieldsAvailable, setFieldsAvailable] = useState([]);
  const [autoDetected, setAutoDetected] = useState(false);
  const [pdfUrl, setPdfUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Step 4: done
  const [syncedCount, setSyncedCount] = useState(0);
  const [ghlMock, setGhlMock] = useState(false);
  const [submittedLeadId, setSubmittedLeadId] = useState(null);
  const [submittedLeadName, setSubmittedLeadName] = useState("");
  const [leadCreated, setLeadCreated] = useState(false);

  // ── Contact search ─────────────────────────────────────────────────────
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

  // ── Documents helpers ──────────────────────────────────────────────────
  const totalBytes = useMemo(
    () => documents.reduce((s, d) => s + (d.size_bytes || 0), 0),
    [documents],
  );
  const totalFileCount = documents.length;
  const mainDoc = useMemo(
    () => documents.find((d) => d.label === MAIN_LABEL) || null,
    [documents],
  );
  const supportingDocs = useMemo(
    () => documents.filter((d) => d.label !== MAIN_LABEL),
    [documents],
  );
  const anyUploading = documents.some((d) => d.status === "uploading");
  // For Submit: at least one fully-uploaded supporting doc OR a main app
  // that's been extracted (pdfUrl present) gates the submission. We track
  // both states explicitly to surface the right copy in the button label.
  const anyDone =
    documents.some((d) => d.status === "done") ||
    documents.some((d) => d.status === "primary_ready");

  const updateDoc = useCallback((localId, patch) => {
    setDocuments((prev) =>
      prev.map((d) => (d.local_id === localId ? { ...d, ...patch } : d)),
    );
  }, []);

  // Upload one supporting document. Wires per-row progress through axios.
  const uploadSupporting = useCallback(
    async (doc) => {
      if (!doc.file) return;
      const fd = new FormData();
      fd.append("files", doc.file);
      fd.append("labels", JSON.stringify([doc.label]));
      try {
        const { data } = await api.post(
          "/applications/upload-supporting",
          fd,
          {
            headers: { "Content-Type": "multipart/form-data" },
            onUploadProgress: (evt) => {
              if (!evt.total) return;
              updateDoc(doc.local_id, {
                progress: Math.min(
                  99,
                  Math.round((evt.loaded / evt.total) * 100),
                ),
              });
            },
          },
        );
        const meta = (data.files && data.files[0]) || {};
        updateDoc(doc.local_id, {
          status: "done",
          progress: 100,
          file_id: meta.file_id || null,
          s3_url: meta.s3_url || "",
          s3_key: meta.s3_key || "",
          content_type: meta.content_type || doc.file.type,
          label: meta.file_label || doc.label,
          size_bytes: meta.size_bytes || doc.file.size,
          error: null,
          // Bytes already in S3 — we can release the File reference to free
          // browser memory now (the row only needs the metadata for submit).
          file: null,
        });
      } catch (err) {
        const detail =
          err?.response?.data?.detail || err?.message || "Upload failed";
        updateDoc(doc.local_id, {
          status: "error",
          progress: 0,
          error: detail,
        });
        toast.error(detail);
      }
    },
    [updateDoc],
  );

  // ── File ingestion ─────────────────────────────────────────────────────
  const addFiles = useCallback(
    (fileList) => {
      const incoming = Array.from(fileList || []);
      if (incoming.length === 0) return;
      const toQueue = [];
      let running = totalBytes;
      let count = totalFileCount;
      let mainExists = !!mainDoc;
      for (const f of incoming) {
        if (!hasAllowedExtOrImage(f)) {
          toast.error(`${f.name}: PDF, JPG, or PNG only.`);
          continue;
        }
        if (f.size > MAX_PER_FILE_BYTES) {
          toast.error(`${f.name}: exceeds 10 MB.`);
          continue;
        }
        if (count >= MAX_FILES_TOTAL) {
          toast.error(`Max ${MAX_FILES_TOTAL} files per submission.`);
          break;
        }
        if (running + f.size > MAX_TOTAL_BYTES) {
          toast.error(
            `${f.name}: would exceed the 50 MB total cap.`,
          );
          continue;
        }
        running += f.size;
        count += 1;

        // First file (PDF) defaults to Main Application; subsequent files
        // get the filename heuristic. Images can't be main (Bedrock PDF
        // extractor needs a PDF), so they always get a supporting label.
        let label;
        if (!mainExists && isPdf(f)) {
          label = MAIN_LABEL;
          mainExists = true;
        } else {
          label = guessLabel(f.name);
        }

        toQueue.push({
          local_id:
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `doc-${Math.random().toString(36).slice(2)}`,
          file: f,
          filename: f.name,
          size_bytes: f.size,
          content_type: f.type || (isPdf(f) ? "application/pdf" : "image/*"),
          label,
          status: label === MAIN_LABEL ? "primary_ready" : "uploading",
          progress: label === MAIN_LABEL ? 100 : 0,
          file_id: null,
          s3_url: "",
          s3_key: "",
          error: null,
        });
      }
      if (toQueue.length === 0) return;
      setDocuments((prev) => [...prev, ...toQueue]);
      // Fire supporting uploads concurrently. Main Application is kept
      // client-side until the agent clicks "Run AI & Continue".
      toQueue.forEach((d) => {
        if (d.label !== MAIN_LABEL) uploadSupporting(d);
      });
    },
    [mainDoc, totalBytes, totalFileCount, uploadSupporting],
  );

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }

  function removeDoc(localId) {
    setDocuments((prev) => prev.filter((d) => d.local_id !== localId));
  }

  // Label changes need to flip a row between "primary_ready" and an
  // upload — so the right bytes end up at /extract vs /upload-supporting.
  const changeLabel = useCallback(
    async (localId, newLabel) => {
      const row = documents.find((d) => d.local_id === localId);
      if (!row || row.label === newLabel) return;
      const wasMain = row.label === MAIN_LABEL;
      const willBeMain = newLabel === MAIN_LABEL;

      // Only one Main Application at a time — demote any existing main.
      if (willBeMain) {
        const existingMain = documents.find(
          (d) => d.label === MAIN_LABEL && d.local_id !== localId,
        );
        if (existingMain) {
          // Force the previous main into "Other" and upload its bytes.
          setDocuments((prev) =>
            prev.map((d) =>
              d.local_id === existingMain.local_id
                ? { ...d, label: "Other", status: "uploading", progress: 0 }
                : d,
            ),
          );
          if (existingMain.file) {
            uploadSupporting({ ...existingMain, label: "Other" });
          }
        }
      }

      if (wasMain && !willBeMain) {
        // Was held client-side; needs to ride along as a supporting doc.
        updateDoc(localId, {
          label: newLabel,
          status: "uploading",
          progress: 0,
        });
        if (row.file) uploadSupporting({ ...row, label: newLabel });
        return;
      }

      if (!wasMain && willBeMain) {
        // Promote to primary. We don't try to fetch the bytes back from
        // S3 — but we DO have row.file because we don't release it until
        // a successful supporting upload completes ... actually we do
        // release the File on done. To support late-promotion to Main,
        // we keep the File for "uploading" rows but DO need it for an
        // already-done upload. Practical UX: agents pick the Main first.
        // For done rows, surface a helpful toast.
        if (row.status === "done" && !row.file) {
          toast.error(
            "Re-pick this file if it should be the Main Application — the local copy has been released after upload.",
          );
          return;
        }
        updateDoc(localId, {
          label: MAIN_LABEL,
          status: "primary_ready",
          progress: 100,
          error: null,
        });
        return;
      }

      // Plain label swap among supporting categories — just update.
      updateDoc(localId, { label: newLabel });
    },
    [documents, updateDoc, uploadSupporting],
  );

  // ── Extract on Main Application → move to Review ─────────────────────
  async function runExtractAndContinue() {
    const main = documents.find(
      (d) => d.label === MAIN_LABEL && d.status === "primary_ready" && d.file,
    );
    if (!main) {
      toast.error("Pick a PDF and label it Main Application first.");
      return;
    }
    if (anyUploading) {
      toast.error("Wait for all uploads to finish.");
      return;
    }
    const fd = new FormData();
    fd.append("file", main.file);
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
      // Promote the primary row's status to "done" so the submit gate
      // sees something fully-handled. We keep the file ref in case the
      // agent goes Back and re-extracts.
      updateDoc(main.local_id, {
        status: "done",
        s3_url: data.pdf_url || "",
        progress: 100,
      });
      toast.success(
        `AI detected ${data.product_label || "application"} · ${data.field_count} field(s)`,
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
      (v) => v !== null && v !== undefined && String(v).trim() !== "",
    ).length;
  }, [extracted]);

  // ── Submit ─────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!selectedContact || !extracted) return;
    if (anyUploading) {
      toast.error("Wait for all uploads to finish.");
      return;
    }
    setSubmitting(true);
    try {
      const supporting = supportingDocs
        .filter((d) => d.status === "done")
        .map((d) => ({
          file_id: d.file_id,
          filename: d.filename,
          file_label: d.label,
          s3_url: d.s3_url,
          s3_key: d.s3_key,
          size_bytes: d.size_bytes,
          content_type: d.content_type,
        }));
      const { data } = await api.post("/applications/submit", {
        contact_id: selectedContact.id,
        product_type: productType,
        extracted,
        contact_name: contactDisplay(selectedContact),
        pdf_url: pdfUrl || undefined,
        supporting_documents: supporting,
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
    setDocuments([]);
    setExtracted(null);
    setProductType("");
    setProductLabel("");
    setFieldsAvailable([]);
    setAutoDetected(false);
    setPdfUrl("");
    setSyncedCount(0);
    setGhlMock(false);
  }

  function submitAnotherForSameContact() {
    setDocuments([]);
    setExtracted(null);
    setProductType("");
    setProductLabel("");
    setFieldsAvailable([]);
    setAutoDetected(false);
    setPdfUrl("");
    setSyncedCount(0);
    setGhlMock(false);
    setStep(STEP.UPLOAD);
  }

  // ── Render ─────────────────────────────────────────────────────────────
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
            Upload the signed application along with any supporting documents.
            AI extracts fields from the Main Application; everything else
            rides along as a supporting attachment.
          </p>
          <ImpersonationBanner />
        </div>

        <StepBar current={step} />

        {/* Step 1: Find Client */}
        {step === STEP.FIND_CLIENT && (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div>
                <Label htmlFor="contact-search">
                  Search contact by name or email
                </Label>
                <Input
                  id="contact-search"
                  placeholder="At least 2 characters"
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  autoFocus
                  data-testid="contact-search-input"
                  className="min-h-[44px]"
                />
                {searching && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Searching…
                  </p>
                )}
              </div>
              <div className="max-h-96 overflow-auto space-y-1">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => pickContact(c)}
                    className="w-full text-left px-3 py-2.5 rounded-md border border-border hover:border-[#e85d2f] hover:bg-[#e85d2f]/5 text-sm transition min-h-[44px]"
                    data-testid={`contact-option-${c.id}`}
                  >
                    <div className="font-medium">{contactDisplay(c)}</div>
                    {c.email && (
                      <div className="text-xs text-muted-foreground">
                        {c.email}
                      </div>
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

        {/* Step 2: Upload Files (multi-file) */}
        {step === STEP.UPLOAD && (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center justify-between text-sm gap-2 flex-wrap">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Submitting for
                  </div>
                  <div
                    className="font-medium"
                    data-testid="selected-contact-name"
                  >
                    {contactDisplay(selectedContact)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setStep(STEP.FIND_CLIENT)}
                  className="text-xs text-muted-foreground hover:text-[#e85d2f] min-h-[44px] min-w-[44px] px-2"
                  data-testid="change-contact-btn"
                >
                  Change
                </button>
              </div>

              {/* Drag/drop multi-file zone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => mainPickerRef.current?.click()}
                className={[
                  "rounded-lg border-2 border-dashed transition cursor-pointer text-center p-6 sm:p-8",
                  "min-h-[160px] flex flex-col items-center justify-center",
                  dragOver
                    ? "border-[#e85d2f] bg-[#e85d2f]/5"
                    : "border-border hover:border-[#e85d2f]/60 hover:bg-secondary/30",
                ].join(" ")}
                data-testid="multi-file-dropzone"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    mainPickerRef.current?.click();
                  }
                }}
              >
                <input
                  ref={mainPickerRef}
                  type="file"
                  multiple
                  accept={MOBILE_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    if (e.target) e.target.value = "";
                  }}
                  data-testid="multi-file-input"
                />
                <UploadCloud className="w-10 h-10 text-muted-foreground mb-2" />
                <div className="text-sm font-medium">
                  Drop files here or tap to browse
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  PDF, JPG, PNG · 10 MB per file · {MAX_FILES_TOTAL} files max ·
                  50 MB total
                </div>
              </div>

              {/* Add More Files button — separate from the dropzone so
                  agents can stack picks from different locations.  */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <input
                  ref={morePickerRef}
                  type="file"
                  multiple
                  accept={MOBILE_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    if (e.target) e.target.value = "";
                  }}
                  data-testid="add-more-input"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => morePickerRef.current?.click()}
                  disabled={totalFileCount >= MAX_FILES_TOTAL}
                  className="min-h-[44px]"
                  data-testid="add-more-btn"
                >
                  <Paperclip className="w-4 h-4 mr-2" />
                  Add More Files
                </Button>
                <div
                  className="text-[11px] text-muted-foreground tabular-nums"
                  data-testid="upload-counter"
                >
                  {totalFileCount} of {MAX_FILES_TOTAL} files ·{" "}
                  {bytesToMb(totalBytes)} of {bytesToMb(MAX_TOTAL_BYTES)} used
                </div>
              </div>

              {/* File list */}
              {documents.length > 0 ? (
                <ul
                  className="space-y-2"
                  data-testid="file-list"
                  aria-label="Files queued for submission"
                >
                  {documents.map((d) => (
                    <li
                      key={d.local_id}
                      className="rounded-lg border border-border p-3 flex flex-wrap items-center gap-3 min-h-[64px]"
                      data-testid={`file-row-${d.local_id}`}
                    >
                      <div className="flex-shrink-0">
                        <FileIconOrThumb doc={d} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {d.filename}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {bytesToMb(d.size_bytes || 0)}
                          {d.status === "uploading"
                            ? " · uploading…"
                            : d.status === "primary_ready"
                              ? " · ready"
                              : d.status === "done"
                                ? " · uploaded"
                                : ""}
                          {d.status === "error" ? (
                            <span className="text-red-600 inline-flex items-center gap-1 ml-1">
                              <AlertCircle className="w-3 h-3" />
                              {d.error || "Upload failed"}
                            </span>
                          ) : null}
                        </div>
                        {d.status === "uploading" ? (
                          <div
                            className="w-full h-1.5 rounded-full bg-secondary mt-1.5 overflow-hidden"
                            role="progressbar"
                            aria-valuenow={d.progress || 0}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
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
                        onValueChange={(v) => changeLabel(d.local_id, v)}
                        disabled={d.status === "uploading"}
                      >
                        <SelectTrigger
                          className="h-11 w-40 text-xs"
                          data-testid={`file-label-${d.local_id}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ALL_LABELS.map((l) => (
                            <SelectItem
                              key={l}
                              value={l}
                              // Block selecting Main for non-PDFs.
                              disabled={
                                l === MAIN_LABEL && d.file && !isPdf(d.file)
                              }
                            >
                              {l}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <button
                        type="button"
                        onClick={() => removeDoc(d.local_id)}
                        className="text-muted-foreground hover:text-red-600 p-2 min-w-[44px] min-h-[44px] grid place-items-center"
                        aria-label={`Remove ${d.filename}`}
                        data-testid={`file-remove-${d.local_id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <Button
                  onClick={runExtractAndContinue}
                  disabled={
                    extracting ||
                    anyUploading ||
                    !mainDoc ||
                    mainDoc.status !== "primary_ready"
                  }
                  className="min-h-[44px]"
                  data-testid="extract-btn"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  {extracting
                    ? "Analyzing Main Application…"
                    : anyUploading
                      ? "Waiting for uploads…"
                      : "Extract with AI & Continue"}
                </Button>
              </div>
              {!mainDoc && documents.length > 0 ? (
                <p className="text-[11px] text-amber-600 text-right">
                  Tag one PDF as “Main Application” to enable extraction.
                </p>
              ) : null}
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
                      className="min-h-[44px]"
                      data-testid={`fld-${key}`}
                    />
                  </div>
                ))}
              </div>

              {/* Attached files summary (read-only) */}
              <div className="pt-3 border-t border-border space-y-2">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5 text-[#e85d2f]" />
                  Attached files
                  <Badge variant="outline" className="text-[10px] ml-1">
                    {documents.length}
                  </Badge>
                </div>
                <ul className="space-y-1 text-xs" data-testid="review-files">
                  {documents.map((d) => (
                    <li
                      key={d.local_id}
                      className="flex items-center gap-2 py-1"
                    >
                      {isPdf(d) ? (
                        <FileText className="w-3.5 h-3.5 text-[#e85d2f]" />
                      ) : (
                        <FileImage className="w-3.5 h-3.5 text-[#e85d2f]" />
                      )}
                      <span className="truncate flex-1">{d.filename}</span>
                      <Badge
                        variant="outline"
                        className="text-[10px] tabular-nums"
                      >
                        {d.label}
                      </Badge>
                      <span className="text-muted-foreground tabular-nums">
                        {bytesToMb(d.size_bytes || 0)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-border">
                <Button
                  variant="outline"
                  onClick={() => setStep(STEP.UPLOAD)}
                  className="min-h-[44px]"
                  data-testid="back-to-upload-btn"
                >
                  Back
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={submitting || anyUploading || !anyDone}
                  className="min-h-[44px]"
                  data-testid="submit-btn"
                >
                  {submitting
                    ? "Submitting…"
                    : anyUploading
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
                  Pushed {syncedCount} field{syncedCount === 1 ? "" : "s"} to
                  GHL
                  {leadCreated ? " · new client added to your book" : ""}.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                {submittedLeadId && (
                  <Button
                    asChild
                    data-testid="view-client-profile-btn"
                    className="min-h-[44px]"
                  >
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
                  className="min-h-[44px]"
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Submit Another for{" "}
                  {submittedLeadName || contactDisplay(selectedContact)}
                </Button>
                <Button
                  variant="ghost"
                  onClick={resetAll}
                  data-testid="submit-another-btn"
                  className="min-h-[44px]"
                >
                  Submit Another Application
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
