import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, UploadCloud, FileText, Sparkles, ExternalLink, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import ImpersonationBanner from "@/components/ImpersonationBanner";

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
  const [submitting, setSubmitting] = useState(false);

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
    if (f.size > 20 * 1024 * 1024) {
      toast.error("PDF exceeds 20MB.");
      return;
    }
    setFile(f);
  }

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
    setExtracted(null);
    setProductType("");
    setProductLabel("");
    setFieldsAvailable([]);
    setAutoDetected(false);
    setPdfUrl("");
    setSyncedCount(0);
    setGhlMock(false);
  }

  // "Submit Another" path — keep the same contact selected, clear everything
  // else, and drop the agent back at the upload step. Saves the contact-search
  // detour when the same client has multiple products on the same day.
  function submitAnotherForSameContact() {
    setFile(null);
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
                      or click to browse · max 20MB
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
                  disabled={submitting}
                  data-testid="submit-btn"
                >
                  {submitting ? "Submitting…" : "Submit to GoHighLevel"}
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
