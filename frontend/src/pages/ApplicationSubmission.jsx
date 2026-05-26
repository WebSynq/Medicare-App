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
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileImage,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UploadCloud,
  UserPlus,
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
  "Prescription List",
  "Agent Attestation",
  "Other",
];
const ALL_LABELS = [MAIN_LABEL, ...SUPPORTING_LABELS];

// Canonical doc-type keys — must match backend/extraction_schemas.py.
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
const LABEL_TO_DOC_TYPE = {
  "Main Application": "main_application",
  SOA: "soa",
  "Election Notice": "election_notice",
  "EFT Form": "eft_form",
  "PHI Auth": "phi_auth",
  "ID Copy": "id_copy",
  "Prescription List": "prescriptions",
  "Agent Attestation": "agent_attestation",
  Other: "other",
};
function labelToDocType(label) {
  return LABEL_TO_DOC_TYPE[label] || "other";
}

// Confidence buckets (mirrored from spec):
//   >= 0.85 → green (auto)
//   0.60..0.85 → amber Verify
//   < 0.60 → red Not detected (blank shown)
function confidenceTone(score) {
  if (score == null) return "muted";
  if (score >= 0.85) return "ok";
  if (score >= 0.6) return "warn";
  return "low";
}
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

// Small wrapper around the new-client confirm-form input. Adds the
// required-asterisk, a confidence badge when the AI gave us one, and an
// amber outline ring when confidence is "warn" so the agent's eye lands
// on the fields most likely to need correction.
function NewClientField({
  label, field, value, confidence, type = "text", required, onChange,
}) {
  const tone = confidenceTone(confidence);
  const ring =
    tone === "warn"
      ? "border-amber-300 bg-amber-50/30 focus:border-amber-500"
      : tone === "low"
        ? "border-red-300 bg-red-50/30 focus:border-red-500"
        : "border-border";
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label className="text-xs">
          {label}
          {required && (
            <span className="text-[#B5451B] font-semibold ml-0.5">*</span>
          )}
        </Label>
        {confidence != null && <ConfidenceBadge score={confidence} />}
      </div>
      <Input
        type={type}
        value={value || ""}
        onChange={(e) => onChange(field, e.target.value)}
        className={`min-h-[44px] ${ring}`}
        data-testid={`new-client-field-${field}`}
      />
    </div>
  );
}


function ConfidenceBadge({ score }) {
  const tone = confidenceTone(score);
  if (tone === "ok")
    return (
      <Badge className="text-[9px] rounded-full border-0 bg-emerald-100 text-emerald-900">
        {Math.round(score * 100)}%
      </Badge>
    );
  if (tone === "warn")
    return (
      <Badge className="text-[9px] rounded-full border-0 bg-amber-100 text-amber-900">
        Verify · {Math.round(score * 100)}%
      </Badge>
    );
  if (tone === "low")
    return (
      <Badge className="text-[9px] rounded-full border-0 bg-red-100 text-red-900">
        Not detected
      </Badge>
    );
  return null;
}

function ExtractedFieldRow({
  fieldName, value, confidence, onChange, testId,
}) {
  const tone = confidenceTone(confidence);
  const border =
    tone === "ok"
      ? "border-emerald-200"
      : tone === "warn"
        ? "border-amber-300"
        : tone === "low"
          ? "border-red-300"
          : "border-border";
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <Label
          htmlFor={testId}
          className="text-[10px] uppercase tracking-wider text-muted-foreground"
        >
          {fieldName.replace(/_/g, " ")}
        </Label>
        <ConfidenceBadge score={confidence} />
      </div>
      <Input
        id={testId}
        value={
          value === null || value === undefined
            ? ""
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value)
        }
        onChange={(e) => onChange(e.target.value)}
        placeholder={tone === "low" ? "Manual entry…" : "—"}
        className={`min-h-[44px] ${border}`}
        data-testid={testId}
      />
    </div>
  );
}

function DocSection({
  docType, title, fields, confidences, edits, onEditField, defaultOpen,
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const entries = Object.entries(fields || {});
  const populated = entries.filter(
    ([, v]) => v !== null && v !== undefined && String(v).trim() !== "",
  ).length;
  return (
    <div
      className="rounded-lg border border-border"
      data-testid={`doc-section-${docType}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left min-h-[44px]"
      >
        <FileText className="w-4 h-4 text-[#e85d2f]" />
        <span className="text-sm font-medium flex-1">{title}</span>
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
        entries.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground border-t border-border">
            No fields extracted — was this an image or scanned doc? You can
            still attach it to the application.
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3 px-3 py-3 border-t border-border">
            {entries.map(([fieldName, value]) => (
              <ExtractedFieldRow
                key={fieldName}
                fieldName={fieldName}
                value={
                  edits && fieldName in edits ? edits[fieldName] : value
                }
                confidence={(confidences || {})[fieldName]}
                onChange={(v) => onEditField(fieldName, v)}
                testId={`extracted-${docType}-${fieldName}`}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

// Client-side cross-reference: spot canonical fields where two documents
// disagree. Mirrors the backend detect_conflicts() — kept simple, just
// surfaces the cards on the review screen so the agent can resolve
// before submit.
function detectClientConflicts(extractedByDoc) {
  const aliases = {
    applicant_full_name: "full_name",
    client_name: "full_name",
    account_holder_name: "full_name",
    applicant_dob: "dob",
    client_dob: "dob",
    applicant_address: "address",
    client_address: "address",
    applicant_phone: "phone",
    client_phone: "phone",
    applicant_medicare_id: "medicare_id",
    medicare_beneficiary_id: "medicare_id",
    date_of_appointment: "soa_date_signed",
    soa_date_signed: "soa_date_signed",
    plan_name: "plan_name",
    carrier: "carrier",
    policy_id: "policy_id",
    effective_date: "effective_date",
    premium: "premium",
    agent_npn: "agent_npn",
    agent_name: "agent_name",
  };
  const normalize = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (Array.isArray(v)) {
      if (v.length === 0) return null;
      return v.map((x) => String(x).toLowerCase().trim()).sort().join(",");
    }
    const s = String(v).toLowerCase().trim();
    if (!s) return null;
    return s.replace(/[\s.,;:]+/g, " ").trim();
  };
  const byCanon = {};
  Object.entries(extractedByDoc || {}).forEach(([docType, fields]) => {
    Object.entries(fields || {}).forEach(([k, v]) => {
      const canonical = aliases[k] || k;
      const norm = normalize(v);
      if (norm === null) return;
      (byCanon[canonical] = byCanon[canonical] || []).push({
        docType,
        field: k,
        value: v,
        norm,
      });
    });
  });
  const conflicts = [];
  Object.entries(byCanon).forEach(([canonical, sources]) => {
    if (sources.length < 2) return;
    const norms = new Set(sources.map((s) => s.norm));
    if (norms.size <= 1) return;
    conflicts.push({ canonical, sources });
  });
  return conflicts;
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
  // `clientMode` gates the two-tab Step 1 UX added in 2026-05.
  //   null      → "New Client" vs "Existing Client" choice screen
  //   "new"     → upload-and-extract flow that creates a fresh lead
  //   "existing"→ legacy search-by-name/phone/email flow (unchanged)
  // The existing Step-1 search code below works identically; the
  // mode just controls which UI is rendered around it.
  const [clientMode, setClientMode] = useState(null);
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState(null);

  // Step 1 — New Client sub-flow state.
  // newClientSubStep:
  //   "upload"  → drop-zone before any file is picked
  //   "confirm" → AI extraction running OR pre-filled form for review
  const [newClientFile, setNewClientFile] = useState(null);
  const [newClientExtracting, setNewClientExtracting] = useState(false);
  const [newClientExtracted, setNewClientExtracted] = useState(null);
  const [newClientConfidences, setNewClientConfidences] = useState({});
  const [newClientForm, setNewClientForm] = useState({
    first_name: "", last_name: "", phone: "", email: "",
    date_of_birth: "", state: "", mbi_number: "",
    current_carrier: "", current_plan: "",
  });
  const [newClientCreating, setNewClientCreating] = useState(false);
  const [newClientSubStep, setNewClientSubStep] = useState("upload");
  const newClientPickerRef = useRef(null);
  const [newClientDragOver, setNewClientDragOver] = useState(false);

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
  // Full-schema Main Application extraction (separate from the
  // product-type ``extracted`` dict — that one still drives the GHL
  // product-specific custom fields).
  const [mainExtracted, setMainExtracted] = useState({});
  const [mainConfidences, setMainConfidences] = useState({});
  // Local edits to the per-doc extracted data. Keyed by local_id ->
  // {field_name: edited_value}. Empty by default; only populated when
  // the agent actually changes something on the review screen.
  const [docEdits, setDocEdits] = useState({});

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
          doc_type: meta.doc_type || labelToDocType(doc.label),
          extracted_fields: meta.extracted || {},
          extracted_confidences: meta.confidences || {},
          extracted_field_count: meta.extracted_field_count || 0,
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
      setMainExtracted(data.main_extracted || {});
      setMainConfidences(data.main_confidences || {});
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
        .map((d) => {
          const edits = docEdits[d.local_id] || {};
          const merged = { ...(d.extracted_fields || {}), ...edits };
          return {
            file_id: d.file_id,
            filename: d.filename,
            file_label: d.label,
            doc_type: d.doc_type || labelToDocType(d.label),
            s3_url: d.s3_url,
            s3_key: d.s3_key,
            size_bytes: d.size_bytes,
            content_type: d.content_type,
            extracted: merged,
            confidences: d.extracted_confidences || {},
          };
        });
      // Merge any review-screen edits onto the Main App schema before
      // shipping. ``docEdits["main"]`` is the special key for the
      // primary doc since it doesn't have a local_id.
      const mainEditsMerged = {
        ...mainExtracted,
        ...(docEdits.main || {}),
      };
      const { data } = await api.post("/applications/submit", {
        contact_id: selectedContact.id,
        product_type: productType,
        extracted,
        contact_name: contactDisplay(selectedContact),
        pdf_url: pdfUrl || undefined,
        supporting_documents: supporting,
        main_extracted: mainEditsMerged,
        main_confidences: mainConfidences,
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
    setClientMode(null);
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
    setMainExtracted({});
    setMainConfidences({});
    setDocEdits({});
    setSyncedCount(0);
    setGhlMock(false);
    resetNewClient();
  }

  // ── New-client sub-flow handlers ──────────────────────────────────────
  // Wipes only the new-client state — used by "Start over" inside the
  // new-client flow, and from resetAll() at the end of the wizard.
  function resetNewClient() {
    setNewClientFile(null);
    setNewClientExtracting(false);
    setNewClientExtracted(null);
    setNewClientConfidences({});
    setNewClientSubStep("upload");
    setNewClientForm({
      first_name: "", last_name: "", phone: "", email: "",
      date_of_birth: "", state: "", mbi_number: "",
      current_carrier: "", current_plan: "",
    });
    setNewClientDragOver(false);
  }

  function resetClientMode() {
    setClientMode(null);
    resetNewClient();
    setContactQuery("");
    setContacts([]);
    setSelectedContact(null);
  }

  async function handleNewClientFileUpload(file) {
    if (!file) return;
    setNewClientFile(file);
    setNewClientExtracting(true);
    // Flip to the confirm view immediately so the agent sees the
    // "AI is reading…" state where the form will appear, rather than
    // staring at a frozen upload zone.
    setNewClientSubStep("confirm");
    try {
      const formData = new FormData();
      formData.append("file", file);
      // No product_type — the backend auto-detects.
      const { data } = await api.post(
        "/applications/extract", formData,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      const ext = data?.main_extracted || {};
      const conf = data?.main_confidences || {};

      // Try first_name/last_name fields first; fall back to splitting
      // applicant_full_name. AI extractors are inconsistent about
      // which shape they return.
      const fullName = (ext.applicant_full_name || "").trim();
      const parts = fullName.split(/\s+/).filter(Boolean);
      const firstFromFull = parts[0] || "";
      const lastFromFull = parts.slice(1).join(" ");

      setNewClientForm({
        first_name: ext.first_name || firstFromFull || "",
        last_name: ext.last_name || lastFromFull || "",
        phone: ext.applicant_phone || ext.phone || "",
        email: ext.applicant_email || ext.email || "",
        date_of_birth: ext.applicant_dob || ext.date_of_birth || "",
        state: ext.applicant_state || ext.state || "",
        mbi_number: ext.applicant_medicare_id || ext.mbi_number || "",
        current_carrier: ext.carrier || ext.current_carrier || "",
        current_plan: ext.plan_name || ext.current_plan || "",
      });
      setNewClientExtracted(ext);
      setNewClientConfidences(conf);
    } catch (err) {
      toast.error(
        err?.response?.data?.detail ||
        "Could not extract from this file. Please check it's a valid application.",
      );
      // Bounce back to upload so the agent can retry with a different
      // file rather than being stuck on an empty confirm form.
      setNewClientSubStep("upload");
      setNewClientFile(null);
    } finally {
      setNewClientExtracting(false);
    }
  }

  async function handleCreateNewClient() {
    if (!newClientForm.first_name.trim() || !newClientForm.last_name.trim()) {
      toast.error("First name and last name are required.");
      return;
    }
    if (!newClientForm.phone.trim()) {
      toast.error("Phone number is required.");
      return;
    }
    setNewClientCreating(true);
    try {
      const { data } = await api.post("/leads", {
        first_name: newClientForm.first_name.trim(),
        last_name: newClientForm.last_name.trim(),
        phone: newClientForm.phone.trim(),
        email: newClientForm.email.trim() || undefined,
        date_of_birth: newClientForm.date_of_birth || undefined,
        state: newClientForm.state || undefined,
        mbi_number: newClientForm.mbi_number || undefined,
        current_carrier: newClientForm.current_carrier || undefined,
        current_plan: newClientForm.current_plan || undefined,
        status: "new",
      });
      // Shape matches the GHL contact-search result the rest of the
      // wizard expects (contactDisplay reads firstName/lastName).
      setSelectedContact({
        id: data.id,
        ghl_contact_id: data.ghl_contact_id,
        firstName: data.first_name,
        lastName: data.last_name,
        email: data.email,
        phone: data.phone,
        name: `${data.first_name} ${data.last_name}`.trim(),
      });
      toast.success(
        `Client created: ${data.first_name} ${data.last_name}`.trim(),
      );
      setStep(STEP.UPLOAD);
    } catch (err) {
      const detail =
        err?.response?.data?.detail ||
        err?.message ||
        "Could not create client.";
      toast.error(typeof detail === "string" ? detail : "Could not create client.");
    } finally {
      setNewClientCreating(false);
    }
  }

  function onNewClientFieldChange(field, value) {
    setNewClientForm((f) => ({ ...f, [field]: value }));
  }

  function onNewClientDrop(e) {
    e.preventDefault();
    setNewClientDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleNewClientFileUpload(file);
  }

  function submitAnotherForSameContact() {
    setDocuments([]);
    setExtracted(null);
    setProductType("");
    setProductLabel("");
    setFieldsAvailable([]);
    setAutoDetected(false);
    setPdfUrl("");
    setMainExtracted({});
    setMainConfidences({});
    setDocEdits({});
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

        {/* Step 1: Find Client — three phases gated by clientMode.
            Phase A (clientMode === null): pick "New" vs "Existing".
            Phase B (clientMode === "new"): upload + AI-extract + confirm,
                                            then POST /api/leads to mint
                                            the new lead row.
            Phase C (clientMode === "existing"): legacy search UI,
                                                 unchanged. */}
        {step === STEP.FIND_CLIENT && clientMode === null && (
          <Card data-testid="client-mode-card">
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground mb-5">
                Is this a new client or someone already in the system?
              </p>
              <div className="grid sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setClientMode("new")}
                  data-testid="client-mode-new"
                  className="text-left rounded-xl border-[1.5px] border-border bg-white p-7 transition hover:border-[#1B4332] hover:bg-[#D8F3DC] focus:outline-none focus-visible:border-[#1B4332] focus-visible:bg-[#D8F3DC] min-h-[180px]"
                >
                  <UserPlus className="w-12 h-12 text-[#1B4332] mb-3" />
                  <div className="text-lg font-bold text-[#1B4332]">
                    New Client
                  </div>
                  <p className="text-sm text-gray-600 mt-1.5 leading-relaxed">
                    Upload their application and we'll create their
                    profile automatically.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setClientMode("existing")}
                  data-testid="client-mode-existing"
                  className="text-left rounded-xl border-[1.5px] border-border bg-white p-7 transition hover:border-[#1B4332] hover:bg-[#D8F3DC] focus:outline-none focus-visible:border-[#1B4332] focus-visible:bg-[#D8F3DC] min-h-[180px]"
                >
                  <Search className="w-12 h-12 text-[#1B4332] mb-3" />
                  <div className="text-lg font-bold text-[#1B4332]">
                    Existing Client
                  </div>
                  <p className="text-sm text-gray-600 mt-1.5 leading-relaxed">
                    Search by name, phone, or email.
                  </p>
                </button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Phase B — New Client */}
        {step === STEP.FIND_CLIENT && clientMode === "new" && (
          <Card data-testid="new-client-card">
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={resetClientMode}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-[#1B4332]"
                  data-testid="new-client-back"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to client choice
                </button>
              </div>

              {newClientSubStep === "upload" && (
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-[#B5451B] font-semibold mb-1">
                    Step 1A · New Client
                  </div>
                  <h3 className="text-lg font-semibold text-[#1B4332]">
                    Upload the application to create this client
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    We'll read the PDF (or photo) with AI and pre-fill
                    a confirmation form so you can review before the
                    client record is created.
                  </p>

                  <label
                    htmlFor="new-client-file-picker"
                    onDragOver={(e) => {
                      e.preventDefault();
                      setNewClientDragOver(true);
                    }}
                    onDragLeave={() => setNewClientDragOver(false)}
                    onDrop={onNewClientDrop}
                    data-testid="new-client-dropzone"
                    className={`mt-4 block cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition ${
                      newClientDragOver
                        ? "border-[#1B4332] bg-[#D8F3DC]"
                        : "border-border hover:border-[#1B4332] hover:bg-[#D8F3DC]/40"
                    }`}
                  >
                    <UploadCloud className="w-10 h-10 mx-auto text-[#1B4332]" />
                    <div className="font-semibold mt-3 text-[#1B4332]">
                      Drop the application here, or click to pick a file
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      PDF, JPG, or PNG · single file
                    </div>
                    <input
                      id="new-client-file-picker"
                      ref={newClientPickerRef}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      className="hidden"
                      data-testid="new-client-file-input"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleNewClientFileUpload(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
              )}

              {newClientSubStep === "confirm" && (
                <div data-testid="new-client-confirm">
                  <div className="text-[11px] uppercase tracking-widest text-[#B5451B] font-semibold mb-1">
                    Step 1B · Confirm New Client
                  </div>
                  <h3 className="text-lg font-semibold text-[#1B4332]">
                    Creating new client
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Review the fields the AI pulled from the application.
                    Edit anything that looks wrong — required fields are
                    marked with{" "}
                    <span className="text-[#B5451B] font-semibold">*</span>.
                  </p>

                  {newClientExtracting && (
                    <div
                      className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-secondary/40 p-4"
                      data-testid="new-client-extracting"
                    >
                      <Loader2 className="w-4 h-4 text-[#1B4332] animate-spin" />
                      <div className="text-sm">
                        <div className="font-medium">
                          AI is reading the application…
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Usually takes 5–15 seconds.
                        </div>
                      </div>
                    </div>
                  )}

                  {!newClientExtracting && (
                    <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <NewClientField
                        label="First Name" required
                        field="first_name"
                        value={newClientForm.first_name}
                        confidence={newClientConfidences.first_name}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="Last Name" required
                        field="last_name"
                        value={newClientForm.last_name}
                        confidence={newClientConfidences.last_name}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="Phone" required
                        field="phone"
                        type="tel"
                        value={newClientForm.phone}
                        confidence={newClientConfidences.applicant_phone}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="Email"
                        field="email"
                        type="email"
                        value={newClientForm.email}
                        confidence={newClientConfidences.applicant_email}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="Date of Birth"
                        field="date_of_birth"
                        type="date"
                        value={(newClientForm.date_of_birth || "").slice(0, 10)}
                        confidence={newClientConfidences.applicant_dob}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="State"
                        field="state"
                        value={newClientForm.state}
                        confidence={newClientConfidences.applicant_state}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="Medicare ID (MBI)"
                        field="mbi_number"
                        value={newClientForm.mbi_number}
                        confidence={newClientConfidences.applicant_medicare_id}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="Current Carrier"
                        field="current_carrier"
                        value={newClientForm.current_carrier}
                        confidence={newClientConfidences.carrier}
                        onChange={onNewClientFieldChange}
                      />
                      <NewClientField
                        label="Current Plan"
                        field="current_plan"
                        value={newClientForm.current_plan}
                        confidence={newClientConfidences.plan_name}
                        onChange={onNewClientFieldChange}
                      />
                    </div>
                  )}

                  {!newClientExtracting && (
                    <div className="mt-6 flex flex-wrap items-center gap-3">
                      <Button
                        onClick={handleCreateNewClient}
                        disabled={newClientCreating}
                        data-testid="new-client-confirm-btn"
                        className="bg-[#1B4332] hover:bg-[#163829] text-white font-semibold w-full sm:w-auto sm:min-w-[280px]"
                      >
                        {newClientCreating ? "Creating…" : "Confirm & Continue"}
                      </Button>
                      <button
                        type="button"
                        onClick={resetNewClient}
                        className="text-xs text-muted-foreground hover:text-[#B5451B]"
                        data-testid="new-client-start-over"
                      >
                        Start over
                      </button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Phase C — Existing Client (unchanged behaviour) */}
        {step === STEP.FIND_CLIENT && clientMode === "existing" && (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={resetClientMode}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-[#1B4332]"
                  data-testid="existing-client-back"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to client choice
                </button>
              </div>
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

              {/* Per-document extraction sections (full schema) */}
              {(() => {
                const byDoc = { main_application: { ...mainExtracted } };
                const confByDoc = { main_application: mainConfidences };
                const editsByDoc = { main_application: docEdits.main || {} };
                documents
                  .filter((d) => d.label !== MAIN_LABEL && d.status === "done")
                  .forEach((d) => {
                    const dt = d.doc_type || labelToDocType(d.label);
                    byDoc[dt] = {
                      ...(byDoc[dt] || {}),
                      ...(d.extracted_fields || {}),
                    };
                    confByDoc[dt] = {
                      ...(confByDoc[dt] || {}),
                      ...(d.extracted_confidences || {}),
                    };
                    if (docEdits[d.local_id]) {
                      editsByDoc[dt] = {
                        ...(editsByDoc[dt] || {}),
                        ...docEdits[d.local_id],
                      };
                    }
                  });
                const conflicts = detectClientConflicts({
                  // Apply edits before running the conflict scan so the
                  // agent's typed corrections silence flagged rows.
                  ...Object.fromEntries(
                    Object.entries(byDoc).map(([dt, fields]) => [
                      dt,
                      { ...fields, ...(editsByDoc[dt] || {}) },
                    ]),
                  ),
                });
                return (
                  <div className="space-y-2 pt-3 border-t border-border">
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#e85d2f]" />
                      Full extracted data
                      <Badge variant="outline" className="text-[10px] ml-1">
                        {Object.keys(byDoc).length} document
                        {Object.keys(byDoc).length === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    {conflicts.length > 0 ? (
                      <div
                        className="rounded-lg border border-red-300 bg-red-50 p-3 space-y-2"
                        data-testid="conflicts-card"
                      >
                        <div className="flex items-center gap-1.5 text-sm font-medium text-red-900">
                          <AlertTriangle className="w-4 h-4" />
                          {conflicts.length} field
                          {conflicts.length === 1 ? "" : "s"} disagree across
                          documents — review before submit.
                        </div>
                        <ul className="space-y-1 text-xs">
                          {conflicts.map((c) => (
                            <li
                              key={c.canonical}
                              data-testid={`conflict-${c.canonical}`}
                            >
                              <div className="font-medium">
                                {c.canonical.replace(/_/g, " ")}
                              </div>
                              <ul className="ml-3 list-disc">
                                {c.sources.map((s, i) => (
                                  <li key={i}>
                                    {DOC_TYPE_TITLES[s.docType] || s.docType}:{" "}
                                    <span className="font-mono">
                                      {String(s.value)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {Object.entries(byDoc).map(([dt, fields], idx) => {
                      const isMain = dt === "main_application";
                      const editKey = isMain
                        ? "main"
                        : (documents.find(
                            (d) =>
                              (d.doc_type || labelToDocType(d.label)) === dt
                              && d.status === "done",
                          ) || {}).local_id || dt;
                      return (
                        <DocSection
                          key={dt}
                          docType={dt}
                          title={DOC_TYPE_TITLES[dt] || dt}
                          fields={fields}
                          confidences={confByDoc[dt]}
                          edits={docEdits[editKey]}
                          onEditField={(fieldName, val) =>
                            setDocEdits((prev) => ({
                              ...prev,
                              [editKey]: {
                                ...(prev[editKey] || {}),
                                [fieldName]: val,
                              },
                            }))
                          }
                          defaultOpen={idx === 0}
                        />
                      );
                    })}
                  </div>
                );
              })()}

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
