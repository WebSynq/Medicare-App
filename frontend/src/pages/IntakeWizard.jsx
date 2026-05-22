import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, Link } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import {
  ShieldCheck,
  Lock,
  ArrowRight,
  ArrowLeft,
  Upload,
  FileText,
  IdCard,
  Building2,
  CheckCircle2,
  X,
  FileSignature,
  ClipboardList,
  Paperclip,
  User,
  HeartPulse,
  Cloud,
  RotateCcw,
  Info,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PublicHeader, Footer } from "@/components/Layout";

// ──────────────────────────────────────────────────────────────────────────
// Step metadata is centralised — adding/removing a step only requires
// editing this list. Icons + per-step time estimates feed the progress
// header without prop-drilling them through each component.
// ──────────────────────────────────────────────────────────────────────────
const STEPS = [
  { key: "personal", label: "About you", icon: User, mins: 2 },
  { key: "medicare", label: "Medicare", icon: HeartPulse, mins: 2 },
  { key: "application", label: "Application", icon: ClipboardList, mins: 3 },
  { key: "soa", label: "SOA signature", icon: FileSignature, mins: 1 },
  { key: "documents", label: "Documents", icon: Upload, mins: 2 },
  { key: "review", label: "Done", icon: CheckCircle2, mins: 0 },
];

const DRAFT_KEY = "ghw.intake.draft.v1";
const AUTOSAVE_DEBOUNCE_MS = 600;

// ──────────────────────────────────────────────────────────────────────────
// AutosaveBadge — sits in the header and reflects three states:
//   "saved"  → quiet, ambient confirmation
//   "saving" → small spinning dot during the debounce window
//   "dirty"  → unsaved changes (rare; only visible momentarily)
// Designed to be unobtrusive so it never competes with the step bar.
// ──────────────────────────────────────────────────────────────────────────
function AutosaveBadge({ status }) {
  const map = {
    saved: { text: "Saved", color: "text-emerald-700", dot: "bg-emerald-500" },
    saving: { text: "Saving…", color: "text-amber-700", dot: "bg-amber-500 animate-pulse" },
    dirty: { text: "Pending", color: "text-amber-700", dot: "bg-amber-500" },
  };
  const m = map[status] || map.saved;
  return (
    <div
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${m.color}`}
      aria-live="polite"
      data-testid="intake-autosave"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.text}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// StepperHeader — the new "thermometer" progress bar. Replaces the cramped
// Badge + Progress combo. Each step is a numbered pill that shows label,
// is clickable (only to revisit completed steps), and animates the
// completion track between steps.
// ──────────────────────────────────────────────────────────────────────────
function StepperHeader({ step, maxReached, onJump, autosave }) {
  const pct = Math.round(((step + 1) / STEPS.length) * 100);
  const remainingMins = STEPS.slice(step + 1).reduce((acc, s) => acc + s.mins, 0);
  return (
    <div className="mb-8" data-testid="intake-stepper">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[11px] uppercase tracking-[0.18em] font-semibold text-primary">
            Step {step + 1} of {STEPS.length}
          </span>
          <span
            className="text-base font-semibold text-foreground"
            style={{ fontFamily: "Outfit" }}
          >
            {STEPS[step].label}
          </span>
          {remainingMins > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" /> ~{remainingMins} min left
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <AutosaveBadge status={autosave} />
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="w-3.5 h-3.5 text-primary" /> Encrypted
          </span>
        </div>
      </div>

      {/* Pill row — desktop. Mobile shows a slim track + count only to
          keep the small-screen header from cramping the form below. */}
      <div className="hidden sm:flex items-center gap-1.5" role="list">
        {STEPS.map((s, i) => {
          const done = i < step;
          const current = i === step;
          const reachable = i <= maxReached;
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              type="button"
              role="listitem"
              onClick={() => reachable && onJump(i)}
              disabled={!reachable}
              aria-current={current ? "step" : undefined}
              className={`flex-1 group relative rounded-md py-2 px-2 text-left transition-colors ${
                current
                  ? "bg-primary/8 ring-1 ring-primary/30"
                  : done
                  ? "bg-emerald-50 hover:bg-emerald-100"
                  : reachable
                  ? "bg-muted/40 hover:bg-muted/60"
                  : "bg-muted/30 opacity-60 cursor-not-allowed"
              }`}
              data-testid={`stepper-${s.key}`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-6 h-6 rounded-full grid place-items-center text-[11px] font-bold flex-shrink-0 ${
                    done
                      ? "bg-emerald-600 text-white"
                      : current
                      ? "bg-primary text-primary-foreground elev-1"
                      : "bg-muted text-muted-foreground"
                  }`}
                  aria-hidden="true"
                >
                  {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-foreground truncate">
                    {s.label}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Slim animated completion track (visible on both mobile + desktop
          beneath the pills) — extra reassurance for users who scan vertically. */}
      <div
        className="mt-3 h-1.5 rounded-full bg-muted/60 overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <motion.div
          className="h-full rounded-full"
          style={{
            background:
              "linear-gradient(90deg, #16a34a 0%, #e85d2f 100%)",
          }}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Field — consistent label + helper text + input slot. Helper text moves
// the "MBI looks like 1AB2-CD3-EF45" hint out of placeholder land (which
// disappears on focus) into a permanent caption — vital for seniors who
// often start typing then forget the format.
// ──────────────────────────────────────────────────────────────────────────
function Field({ label, helper, required, children, className = "" }) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between mb-1">
        <Label className="text-[15px] font-medium text-foreground">
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </Label>
      </div>
      {children}
      {helper && (
        <div className="mt-1.5 text-[12px] text-muted-foreground flex items-start gap-1.5">
          <Info className="w-3 h-3 mt-0.5 flex-shrink-0 opacity-70" />
          <span>{helper}</span>
        </div>
      )}
    </div>
  );
}

// Trust ribbon shown at the top of every step — quiet but persistent
// reminder that this form is safer than the legacy n8n flow it replaces.
function TrustRibbon() {
  return (
    <div
      className="mb-6 flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 border border-emerald-200 text-[12px] text-emerald-800 w-fit"
      data-testid="intake-trust-ribbon"
    >
      <ShieldCheck className="w-3.5 h-3.5" />
      <span>Your information is encrypted before it leaves this device. HIPAA-aligned.</span>
    </div>
  );
}

const INITIAL_DATA = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  date_of_birth: "",
  address_line1: "",
  city: "",
  state: "",
  zip_code: "",
  mbi_number: "",
  medicare_part_a_effective: "",
  medicare_part_b_effective: "",
  current_carrier: "",
  current_plan: "",
  doctors: "",
  prescriptions: "",
  preferred_contact_time: "Anytime",
  notes: "",
  sales_submitting_agent: "",
  agency_or_personal: "",
  new_or_current_client: "",
  number_of_apps: "",
  replacement_app: "",
  lead_source: "",
  plan_type_premium: "",
  underwriting_approved: "",
  cancel_old_plan: "",
  admin_requests: "",
  client_success_rep: "",
  consent_acknowledged: false,
  plan_types: { MA: false, MAPD: false, PDP: false, MedSupp: false },
};

export default function IntakeWizard() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [createdLeadId, setCreatedLeadId] = useState(null);
  const [data, setData] = useState(INITIAL_DATA);
  const [autosaveStatus, setAutosaveStatus] = useState("saved");

  // ── Restore draft from localStorage on first mount ────────────────────
  // We only surface the resume banner if a non-trivial draft exists,
  // i.e. user actually typed something. Empty restorations would be noise.
  const [restorePrompt, setRestorePrompt] = useState(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const looksMeaningful =
        parsed?.data &&
        (parsed.data.first_name || parsed.data.last_name || parsed.data.email || parsed.data.phone);
      if (looksMeaningful) {
        setRestorePrompt(parsed);
      }
    } catch {
      // Corrupt draft — silently ignore.
    }
  }, []);

  const acceptRestore = () => {
    if (!restorePrompt) return;
    setData({ ...INITIAL_DATA, ...(restorePrompt.data || {}) });
    setStep(Math.min(STEPS.length - 1, restorePrompt.step || 0));
    setMaxReached(Math.min(STEPS.length - 1, restorePrompt.maxReached || 0));
    setRestorePrompt(null);
    toast.success("Welcome back — we restored your draft.");
  };
  const discardRestore = () => {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {}
    setRestorePrompt(null);
  };

  // ── Debounced autosave ────────────────────────────────────────────────
  // We persist `{ data, step, maxReached, savedAt }` rather than just the
  // form data so resuming lands the user back on the exact step they left.
  useEffect(() => {
    if (restorePrompt) return; // Don't autosave over a pending restore.
    setAutosaveStatus("saving");
    const id = setTimeout(() => {
      try {
        window.localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ data, step, maxReached, savedAt: Date.now() }),
        );
        setAutosaveStatus("saved");
      } catch {
        // Storage full / private mode — drop silently. Status returns
        // to dirty so the user can see we couldn't save.
        setAutosaveStatus("dirty");
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [data, step, maxReached, restorePrompt]);

  const update = useCallback((k, v) => {
    setData((d) => ({ ...d, [k]: v }));
  }, []);

  const goTo = useCallback((i) => {
    setStep(i);
    setMaxReached((m) => Math.max(m, i));
    // Scroll to top of step container on transition — long forms can
    // otherwise leave the user mid-page after pressing "Continue".
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const next = () => goTo(Math.min(STEPS.length - 1, step + 1));
  const back = () => goTo(Math.max(0, step - 1));

  const submitLead = async () => {
    setSubmitting(true);
    try {
      const numApps =
        data.number_of_apps === "" || data.number_of_apps == null
          ? undefined
          : Number(data.number_of_apps);
      const payload = {
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email || undefined,
        phone: data.phone || undefined,
        date_of_birth: data.date_of_birth || undefined,
        address_line1: data.address_line1 || undefined,
        city: data.city || undefined,
        state: data.state || undefined,
        zip_code: data.zip_code || undefined,
        mbi_number: data.mbi_number || undefined,
        medicare_part_a_effective: data.medicare_part_a_effective || undefined,
        medicare_part_b_effective: data.medicare_part_b_effective || undefined,
        current_carrier: data.current_carrier || undefined,
        current_plan: data.current_plan || undefined,
        doctors: data.doctors
          ? data.doctors.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        prescriptions: data.prescriptions
          ? data.prescriptions.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        preferred_contact_time: data.preferred_contact_time || undefined,
        notes: data.notes || undefined,
        sales_submitting_agent: data.sales_submitting_agent || undefined,
        agency_or_personal: data.agency_or_personal || undefined,
        new_or_current_client: data.new_or_current_client || undefined,
        number_of_apps: Number.isFinite(numApps) ? numApps : undefined,
        replacement_app: data.replacement_app || undefined,
        lead_source: data.lead_source || undefined,
        plan_type_premium: data.plan_type_premium || undefined,
        underwriting_approved: data.underwriting_approved || undefined,
        cancel_old_plan: data.cancel_old_plan || undefined,
        admin_requests: data.admin_requests || undefined,
        client_success_rep: data.client_success_rep || undefined,
      };
      const res = await api.post("/leads", payload);
      setCreatedLeadId(res.data.id);
      toast.success("Lead created — proceed to sign your SOA.");
      return res.data.id;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create lead.");
      throw e;
    } finally {
      setSubmitting(false);
    }
  };

  const ensureLead = async () => createdLeadId || submitLead();

  const personalValid = useMemo(
    () => !!(data.first_name.trim() && data.last_name.trim() && (data.email.trim() || data.phone.trim())),
    [data.first_name, data.last_name, data.email, data.phone],
  );

  const onComplete = () => {
    // Clear draft on successful submission — nothing to restore.
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {}
    nav(`/intake-complete?lead=${createdLeadId}`);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader />
      <main className="flex-1 py-8 lg:py-12">
        <div className="max-w-3xl mx-auto px-6">
          {/* Resume draft banner — only shown if a meaningful prior draft
              exists. Lets the user opt-in to restore so we never silently
              overwrite a fresh start. */}
          {restorePrompt && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6 rounded-lg border border-primary/20 bg-primary/5 p-4 flex items-start gap-3"
              data-testid="intake-restore-banner"
            >
              <Cloud className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground">
                  Pick up where you left off?
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  We saved your last entry locally. Restore it or start fresh.
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={discardRestore}
                  className="rounded-full h-8"
                  data-testid="restore-discard"
                >
                  Start fresh
                </Button>
                <Button
                  size="sm"
                  onClick={acceptRestore}
                  className="rounded-full h-8 btn-press"
                  data-testid="restore-accept"
                >
                  <RotateCcw className="w-3 h-3 mr-1.5" /> Restore
                </Button>
              </div>
            </motion.div>
          )}

          <StepperHeader
            step={step}
            maxReached={maxReached}
            onJump={goTo}
            autosave={autosaveStatus}
          />

          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.3 }}
            >
              {step === 0 && <PersonalStep data={data} update={update} />}
              {step === 1 && <MedicareStep data={data} update={update} />}
              {step === 2 && <ApplicationDetailsStep data={data} update={update} />}
              {step === 3 && (
                <SoaStep
                  data={data}
                  update={update}
                  createdLeadId={createdLeadId}
                  ensureLead={ensureLead}
                  onSigned={() => next()}
                />
              )}
              {step === 4 && <DocumentsStep leadId={createdLeadId} />}
              {step === 5 && <ReviewStep data={data} leadId={createdLeadId} onDone={onComplete} />}
            </motion.div>
          </AnimatePresence>

          {/* Step nav — hidden on SOA + Documents + Review (those have
              their own primary CTAs to keep flow obvious). */}
          {step !== 3 && step !== 5 && step !== 4 && (
            <div className="flex justify-between mt-8 gap-3">
              <Button
                variant="ghost"
                onClick={back}
                disabled={step === 0}
                className="h-12 px-5 text-[15px]"
                data-testid="wizard-back"
              >
                <ArrowLeft className="w-4 h-4 mr-2" /> Back
              </Button>
              {step === 2 ? (
                <Button
                  className="btn-press rounded-full px-7 h-12 text-[15px] elev-2"
                  disabled={!personalValid || submitting}
                  onClick={async () => {
                    try {
                      await ensureLead();
                      next();
                    } catch {
                      /* toast already shown */
                    }
                  }}
                  data-testid="wizard-next-after-app-details"
                >
                  {submitting ? "Securing..." : "Continue to SOA"}{" "}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              ) : (
                <Button
                  className="btn-press rounded-full px-7 h-12 text-[15px] elev-2"
                  disabled={step === 0 && !personalValid}
                  onClick={next}
                  data-testid="wizard-next"
                >
                  Continue <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="flex justify-between mt-8 gap-3">
              <Button
                variant="ghost"
                onClick={back}
                className="h-12 px-5 text-[15px]"
                data-testid="wizard-back-docs"
              >
                <ArrowLeft className="w-4 h-4 mr-2" /> Back
              </Button>
              <Button
                className="btn-press rounded-full px-7 h-12 text-[15px] elev-2"
                onClick={next}
                data-testid="wizard-review"
              >
                Review &amp; finish <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          )}

          <div className="mt-10 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
            <ShieldCheck className="w-3.5 h-3.5 text-primary" /> Your data is transmitted over TLS
            and stored encrypted at rest.
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// PersonalStep
// ──────────────────────────────────────────────────────────────────────────
function PersonalStep({ data, update }) {
  return (
    <Card className="border-border bg-surface elev-1">
      <CardContent className="p-8 lg:p-10">
        <TrustRibbon />
        <h2
          className="text-[28px] font-semibold tracking-tight mb-2"
          style={{ fontFamily: "Outfit" }}
        >
          Tell us about you
        </h2>
        <p className="text-muted-foreground mb-7 leading-relaxed">
          We use this only to verify eligibility and to follow up.
          Required fields are marked with <span className="text-destructive">*</span>.
        </p>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="First name" required>
            <Input
              className="h-14 text-[16px]"
              value={data.first_name}
              onChange={(e) => update("first_name", e.target.value)}
              data-testid="intake-first-name"
            />
          </Field>
          <Field label="Last name" required>
            <Input
              className="h-14 text-[16px]"
              value={data.last_name}
              onChange={(e) => update("last_name", e.target.value)}
              data-testid="intake-last-name"
            />
          </Field>
          <Field label="Email" helper="Optional if you provide a phone number.">
            <Input
              type="email"
              className="h-14 text-[16px]"
              value={data.email}
              onChange={(e) => update("email", e.target.value)}
              data-testid="intake-email"
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Phone" required helper="We'll only call during your preferred contact time below.">
            <Input
              className="h-14 text-[16px]"
              value={data.phone}
              onChange={(e) => update("phone", e.target.value)}
              data-testid="intake-phone"
              placeholder="(555) 123-4567"
            />
          </Field>
          <Field label="Date of birth" helper="Used only to verify Medicare eligibility window.">
            <Input
              type="date"
              className="h-14 text-[16px]"
              value={data.date_of_birth}
              onChange={(e) => update("date_of_birth", e.target.value)}
              data-testid="intake-dob"
            />
          </Field>
          <Field label="Preferred contact time">
            <Input
              className="h-14 text-[16px]"
              value={data.preferred_contact_time}
              onChange={(e) => update("preferred_contact_time", e.target.value)}
              data-testid="intake-contact-time"
              placeholder="Anytime, mornings, after 5pm…"
            />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Input
              className="h-14 text-[16px]"
              value={data.address_line1}
              onChange={(e) => update("address_line1", e.target.value)}
              data-testid="intake-address"
              placeholder="123 Main St"
            />
          </Field>
          <Field label="City">
            <Input
              className="h-14 text-[16px]"
              value={data.city}
              onChange={(e) => update("city", e.target.value)}
              data-testid="intake-city"
            />
          </Field>
          <Field label="State / ZIP">
            <div className="flex gap-3">
              <Input
                className="h-14 text-[16px] w-1/3"
                placeholder="ST"
                value={data.state}
                onChange={(e) => update("state", e.target.value)}
                data-testid="intake-state"
                maxLength={2}
              />
              <Input
                className="h-14 text-[16px] flex-1"
                placeholder="ZIP"
                value={data.zip_code}
                onChange={(e) => update("zip_code", e.target.value)}
                data-testid="intake-zip"
                inputMode="numeric"
              />
            </div>
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// MedicareStep
// ──────────────────────────────────────────────────────────────────────────
function MedicareStep({ data, update }) {
  return (
    <Card className="border-border bg-surface elev-1">
      <CardContent className="p-8 lg:p-10">
        <TrustRibbon />
        <h2
          className="text-[28px] font-semibold tracking-tight mb-2"
          style={{ fontFamily: "Outfit" }}
        >
          Medicare details
        </h2>
        <p className="text-muted-foreground mb-7 leading-relaxed">
          Find these on your red, white, and blue Medicare card. Skip anything you don't
          have handy — we'll collect it on the call.
        </p>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field
            label="MBI number"
            helper="The Medicare Beneficiary Identifier looks like 1AB2-CD3-EF45 (11 characters)."
          >
            <Input
              className="h-14 text-[16px] font-mono tracking-wider uppercase"
              placeholder="1AB2-CD3-EF45"
              value={data.mbi_number}
              onChange={(e) => update("mbi_number", e.target.value.toUpperCase())}
              data-testid="intake-mbi"
            />
          </Field>
          <Field label="Current carrier (if any)" helper="e.g. UnitedHealthcare, Humana, Aetna.">
            <Input
              className="h-14 text-[16px]"
              value={data.current_carrier}
              onChange={(e) => update("current_carrier", e.target.value)}
              data-testid="intake-carrier"
            />
          </Field>
          <Field label="Part A effective date">
            <Input
              type="date"
              className="h-14 text-[16px]"
              value={data.medicare_part_a_effective}
              onChange={(e) => update("medicare_part_a_effective", e.target.value)}
              data-testid="intake-part-a"
            />
          </Field>
          <Field label="Part B effective date">
            <Input
              type="date"
              className="h-14 text-[16px]"
              value={data.medicare_part_b_effective}
              onChange={(e) => update("medicare_part_b_effective", e.target.value)}
              data-testid="intake-part-b"
            />
          </Field>
          <Field label="Current plan name" className="sm:col-span-2">
            <Input
              className="h-14 text-[16px]"
              value={data.current_plan}
              onChange={(e) => update("current_plan", e.target.value)}
              data-testid="intake-plan"
            />
          </Field>
          <Field
            label="Doctors"
            helper="Separate names with commas. We'll check if they're in-network."
            className="sm:col-span-2"
          >
            <Textarea
              rows={2}
              className="text-[15px]"
              value={data.doctors}
              onChange={(e) => update("doctors", e.target.value)}
              placeholder="Dr. Smith, Dr. Lee"
              data-testid="intake-doctors"
            />
          </Field>
          <Field
            label="Prescriptions"
            helper="Separate medications with commas. We'll check Tier coverage."
            className="sm:col-span-2"
          >
            <Textarea
              rows={2}
              className="text-[15px]"
              value={data.prescriptions}
              onChange={(e) => update("prescriptions", e.target.value)}
              placeholder="Lisinopril, Atorvastatin"
              data-testid="intake-prescriptions"
            />
          </Field>
          <Field label="Anything else?" className="sm:col-span-2">
            <Textarea
              rows={3}
              className="text-[15px]"
              value={data.notes}
              onChange={(e) => update("notes", e.target.value)}
              data-testid="intake-notes"
              placeholder="Special requests, questions, life changes…"
            />
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ApplicationDetailsStep
// ──────────────────────────────────────────────────────────────────────────
function ApplicationDetailsStep({ data, update }) {
  return (
    <Card className="border-border bg-surface elev-1">
      <CardContent className="p-8 lg:p-10">
        <TrustRibbon />
        <div className="flex items-center gap-2 mb-2">
          <ClipboardList className="w-5 h-5 text-primary" />
          <h2
            className="text-[28px] font-semibold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Application Details
          </h2>
        </div>
        <p className="text-muted-foreground mb-7 leading-relaxed">
          Sales submission details for the back-office team. Skip anything that doesn't apply
          yet — these can be updated later.
        </p>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="Sales submitting agent">
            <Input
              className="h-14 text-[16px]"
              value={data.sales_submitting_agent}
              onChange={(e) => update("sales_submitting_agent", e.target.value)}
              placeholder="Agent name"
              data-testid="intake-sales-agent"
            />
          </Field>
          <Field label="Agency or Personal">
            <Select
              value={data.agency_or_personal}
              onValueChange={(v) => update("agency_or_personal", v)}
            >
              <SelectTrigger className="h-14 text-[16px]" data-testid="intake-agency-or-personal">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Agency">Agency</SelectItem>
                <SelectItem value="Personal">Personal</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="New or Current client">
            <Select
              value={data.new_or_current_client}
              onValueChange={(v) => update("new_or_current_client", v)}
            >
              <SelectTrigger className="h-14 text-[16px]" data-testid="intake-new-or-current">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="New">New</SelectItem>
                <SelectItem value="Current">Current</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Number of apps">
            <Input
              type="number"
              min={0}
              step={1}
              className="h-14 text-[16px]"
              value={data.number_of_apps}
              onChange={(e) => update("number_of_apps", e.target.value)}
              placeholder="e.g. 1"
              data-testid="intake-number-of-apps"
            />
          </Field>
          <Field label="Replacement app">
            <Select
              value={data.replacement_app}
              onValueChange={(v) => update("replacement_app", v)}
            >
              <SelectTrigger className="h-14 text-[16px]" data-testid="intake-replacement-app">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Yes">Yes</SelectItem>
                <SelectItem value="No">No</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Lead source">
            <Input
              className="h-14 text-[16px]"
              value={data.lead_source}
              onChange={(e) => update("lead_source", e.target.value)}
              placeholder="Referral, web, AEP mailer…"
              data-testid="intake-lead-source"
            />
          </Field>
          <Field label="Plan type / Premium" className="sm:col-span-2">
            <Input
              className="h-14 text-[16px]"
              value={data.plan_type_premium}
              onChange={(e) => update("plan_type_premium", e.target.value)}
              placeholder="e.g. MAPD HMO — $0 / mo"
              data-testid="intake-plan-premium"
            />
          </Field>
          <Field label="Underwriting approved">
            <Select
              value={data.underwriting_approved}
              onValueChange={(v) => update("underwriting_approved", v)}
            >
              <SelectTrigger className="h-14 text-[16px]" data-testid="intake-underwriting">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Yes">Yes</SelectItem>
                <SelectItem value="No">No</SelectItem>
                <SelectItem value="Pending">Pending</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Cancel old plan">
            <Select
              value={data.cancel_old_plan}
              onValueChange={(v) => update("cancel_old_plan", v)}
            >
              <SelectTrigger className="h-14 text-[16px]" data-testid="intake-cancel-old">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Yes">Yes</SelectItem>
                <SelectItem value="No">No</SelectItem>
                <SelectItem value="N/A">N/A</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Admin requests" className="sm:col-span-2">
            <Textarea
              rows={3}
              className="text-[15px]"
              value={data.admin_requests}
              onChange={(e) => update("admin_requests", e.target.value)}
              placeholder="Anything the back-office team should know — special requests, urgency, follow-ups."
              data-testid="intake-admin-requests"
            />
          </Field>
          <Field label="Assigned Client Success Rep">
            <Select
              value={data.client_success_rep}
              onValueChange={(v) => update("client_success_rep", v)}
            >
              <SelectTrigger className="h-14 text-[16px]" data-testid="intake-cs-rep">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Kelsey">Kelsey</SelectItem>
                <SelectItem value="Ashley">Ashley</SelectItem>
                <SelectItem value="Other">Other</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SoaStep — now styled as a paper-style document with corner cuts and a
// faint watermark, plus a post-sign "Locked" confirmation animation.
// ──────────────────────────────────────────────────────────────────────────
function SoaStep({ data, update, ensureLead, onSigned }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#14532D";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
  }, []);

  const startDraw = (e) => {
    if (locked) return;
    drawingRef.current = true;
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e) => {
    if (!drawingRef.current || locked) return;
    e.preventDefault();
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasDrawn(true);
  };
  const stopDraw = () => {
    drawingRef.current = false;
  };
  const pos = (e) => {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {
      x: ((t.clientX - rect.left) * c.width) / rect.width,
      y: ((t.clientY - rect.top) * c.height) / rect.height,
    };
  };
  const clearSig = () => {
    if (locked) return;
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    setHasDrawn(false);
  };

  const togglePlan = (k) =>
    update("plan_types", { ...data.plan_types, [k]: !data.plan_types[k] });

  const submit = async () => {
    if (!hasDrawn) {
      toast.error("Please draw your signature.");
      return;
    }
    if (!data.consent_acknowledged) {
      toast.error("Please acknowledge consent.");
      return;
    }
    const planTypes = Object.entries(data.plan_types)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (planTypes.length === 0) {
      toast.error("Please select at least one plan type.");
      return;
    }

    setSubmitting(true);
    try {
      const leadId = await ensureLead();
      const sig = canvasRef.current.toDataURL("image/png");
      await api.post("/soa/sign", {
        lead_id: leadId,
        signature_data_url: sig,
        beneficiary_name: `${data.first_name} ${data.last_name}`.trim(),
        agent_name: null,
        plan_types_discussed: planTypes,
        consent_acknowledged: true,
      });
      setLocked(true);
      toast.success("SOA signed and recorded.");
      // Brief delay so the user sees the locked confirmation animation.
      setTimeout(() => onSigned(), 1100);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to record SOA.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-border bg-surface elev-1">
      <CardContent className="p-8 lg:p-10">
        <TrustRibbon />
        <div className="flex items-center gap-2 mb-2">
          <FileSignature className="w-5 h-5 text-primary" />
          <h2
            className="text-[28px] font-semibold tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Scope of Appointment
          </h2>
        </div>
        <p className="text-muted-foreground mb-6 leading-relaxed">
          CMS requires a signed SOA before discussing Medicare Advantage or Part D plans.
          This is your record that we may only discuss the plan types you've authorized.
        </p>

        {/* Paper-styled document */}
        <div
          className="relative rounded-lg bg-white border border-border elev-2 p-6 sm:p-8 mb-6 overflow-hidden"
          style={{
            // Subtle paper texture via layered gradients — looks like a
            // very faint linen finish without an image dependency.
            backgroundImage:
              "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(20,30,50,0.015) 100%), repeating-linear-gradient(45deg, rgba(20,30,50,0.018) 0px, rgba(20,30,50,0.018) 1px, transparent 1px, transparent 3px)",
          }}
        >
          {/* Watermark */}
          <div
            className="pointer-events-none absolute -right-6 -top-6 text-[120px] font-bold opacity-[0.04] select-none"
            style={{ fontFamily: "Outfit", color: "#1e2d3d" }}
            aria-hidden="true"
          >
            SOA
          </div>

          <p className="text-[15px] leading-relaxed mb-4">
            <strong>
              I, {data.first_name || "_______"} {data.last_name || "_______"}
            </strong>
            , authorize Gruening Health &amp; Wealth and its licensed agents to contact me to
            discuss the Medicare plan types I've checked below. The agent will not discuss plan
            types I have not authorized. This SOA does not obligate me to enroll, affect my current
            enrollment, or guarantee enrollment in any new plan.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
            {[
              ["MA", "Medicare Advantage"],
              ["MAPD", "MA + Drug"],
              ["PDP", "Stand-alone Part D"],
              ["MedSupp", "Medicare Supplement"],
            ].map(([k, label]) => {
              const checked = data.plan_types[k];
              return (
                <label
                  key={k}
                  className={`flex items-start gap-2.5 p-3 rounded-md border cursor-pointer transition-colors ${
                    checked
                      ? "border-primary/60 bg-primary/5"
                      : "border-border bg-surface hover:border-primary/40"
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => togglePlan(k)}
                    data-testid={`soa-plan-${k.toLowerCase()}`}
                    disabled={locked}
                  />
                  <div>
                    <div className="text-xs font-semibold">{k}</div>
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">Sign here</div>
          <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
            <Lock className="w-3 h-3" /> IP &amp; timestamp will be recorded
          </div>
        </div>

        {/* Canvas wrapper with corner-cut decoration */}
        <div className="relative">
          <div
            className={`relative rounded-lg border-2 border-dashed bg-white p-2 transition-colors ${
              locked ? "border-emerald-500" : "border-primary/30"
            }`}
          >
            {/* Corner cuts — small triangles at each corner that suggest
                a real signature page. Decorative only. */}
            {[
              "top-0 left-0",
              "top-0 right-0 rotate-90",
              "bottom-0 left-0 -rotate-90",
              "bottom-0 right-0 rotate-180",
            ].map((cls) => (
              <span
                key={cls}
                aria-hidden="true"
                className={`pointer-events-none absolute ${cls} m-1`}
                style={{
                  width: 0,
                  height: 0,
                  borderTop: "8px solid hsl(var(--border))",
                  borderRight: "8px solid transparent",
                }}
              />
            ))}

            <canvas
              ref={canvasRef}
              width={720}
              height={180}
              className={`w-full h-44 rounded touch-none ${locked ? "opacity-90" : ""}`}
              onMouseDown={startDraw}
              onMouseMove={move}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
              onTouchStart={startDraw}
              onTouchMove={move}
              onTouchEnd={stopDraw}
              data-testid="soa-canvas"
            />

            {/* Locked overlay — green check sweep + confirmation chip. */}
            <AnimatePresence>
              {locked && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 flex items-center justify-center bg-emerald-500/5 backdrop-blur-[1px] rounded"
                  data-testid="soa-locked"
                >
                  <motion.div
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-600 text-white elev-2 text-sm font-semibold"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Signed &amp; timestamped
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="flex items-center justify-between mt-2 text-xs">
          <button
            type="button"
            onClick={clearSig}
            disabled={locked}
            className="text-muted-foreground hover:text-destructive disabled:opacity-40"
            data-testid="soa-clear"
          >
            Clear signature
          </button>
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Lock className="w-3 h-3" /> Locked once submitted
          </span>
        </div>

        <label className="flex items-start gap-3 mt-6 p-4 rounded-md bg-secondary/60 cursor-pointer">
          <Checkbox
            checked={data.consent_acknowledged}
            onCheckedChange={(v) => update("consent_acknowledged", !!v)}
            data-testid="soa-consent"
            disabled={locked}
          />
          <span className="text-sm text-foreground/90 leading-relaxed">
            I acknowledge this constitutes my electronic signature and authorize Gruening Health
            &amp; Wealth to discuss the plan types selected above. I understand my data is
            encrypted and protected under HIPAA.
          </span>
        </label>

        <div className="flex justify-end mt-7">
          <Button
            onClick={submit}
            disabled={submitting || locked}
            className="btn-press rounded-full px-7 h-12 text-[15px] elev-2"
            data-testid="soa-submit"
          >
            {submitting ? (
              "Recording..."
            ) : locked ? (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" /> Locked
              </>
            ) : (
              <>
                Sign &amp; continue <ArrowRight className="w-4 h-4 ml-2" />
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// DocumentsStep — Medicare card and ID drop zones now show a "card-shaped"
// alignment guide so users on phones know how to orient their photo.
// ──────────────────────────────────────────────────────────────────────────
function DocumentsStep({ leadId }) {
  return (
    <Card className="border-border bg-surface elev-1">
      <CardContent className="p-8 lg:p-10">
        <TrustRibbon />
        <h2
          className="text-[28px] font-semibold tracking-tight mb-2"
          style={{ fontFamily: "Outfit" }}
        >
          Upload documents
        </h2>
        <p className="text-muted-foreground mb-7 leading-relaxed">
          Up to 5 documents. PDF or image (JPG, PNG, WEBP) up to 15MB each. Files are encrypted
          on our servers — they never appear in URLs or logs.
        </p>
        <div className="space-y-5">
          <DropZone
            leadId={leadId}
            docType="medicare_card"
            icon={IdCard}
            label="1 · Medicare card"
            hint="Front and back if possible"
            capture="environment"
            cardGuide
          />
          <DropZone
            leadId={leadId}
            docType="id"
            icon={FileText}
            label="2 · Government ID"
            hint="Driver's license or state ID"
            capture="environment"
            cardGuide
          />
          <DropZone
            leadId={leadId}
            docType="voided_check"
            icon={Building2}
            label="3 · Voided check (optional)"
            hint="Only if you'd like premium auto-pay"
          />
          <DropZone
            leadId={leadId}
            docType="other"
            icon={Paperclip}
            label="4 · Additional document"
            hint="Application form, prescription list, etc."
            testIdSuffix="other-1"
          />
          <DropZone
            leadId={leadId}
            docType="other"
            icon={Paperclip}
            label="5 · Additional document"
            hint="Anything else the back-office team needs"
            testIdSuffix="other-2"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DropZone({ leadId, docType, icon: Icon, label, hint, testIdSuffix, capture, cardGuide }) {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  const onDrop = async (accepted) => {
    if (!leadId) {
      toast.error("Please complete the previous steps first.");
      return;
    }
    setUploading(true);
    for (const file of accepted) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("doc_type", docType);
        const res = await api.post(`/documents/upload/${leadId}`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        setFiles((f) => [...f, res.data]);
        toast.success(`${file.name} encrypted & stored`);
      } catch (e) {
        toast.error(`${file.name}: ${e?.response?.data?.detail || "upload failed"}`);
      }
    }
    setUploading(false);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp"], "application/pdf": [".pdf"] },
    maxSize: 15 * 1024 * 1024,
  });

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-muted-foreground">· {hint}</span>
      </div>
      <div
        {...getRootProps()}
        className={`relative rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
          isDragActive
            ? "border-primary bg-secondary/60"
            : "border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/50"
        } ${cardGuide ? "p-3" : "p-6"}`}
        data-testid={`dropzone-${testIdSuffix || docType}`}
      >
        <input {...getInputProps(capture ? { capture } : {})} />

        {cardGuide ? (
          <div className="flex items-center gap-4">
            {/* Card-shaped alignment overlay — visually communicates the
                expected orientation (landscape, rounded corners). */}
            <div
              className="hidden sm:block flex-shrink-0 rounded-lg border-2 border-dashed border-primary/40 bg-white/70"
              style={{ width: 96, height: 60 }}
              aria-hidden="true"
            >
              <div className="h-full w-full grid place-items-center text-[10px] text-primary/60 uppercase tracking-wider">
                Align here
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm flex-1 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-surface border border-border grid place-items-center flex-shrink-0">
                <Upload className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold truncate">
                  {isDragActive ? "Drop here" : "Drag &amp; drop, or tap to take a photo"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Encrypted server-side · max 15MB
                </div>
              </div>
              {uploading && (
                <span className="ml-auto text-xs text-muted-foreground">Encrypting…</span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <div className="w-10 h-10 rounded-lg bg-surface border border-border grid place-items-center">
              <Upload className="w-4 h-4 text-primary" />
            </div>
            <div>
              <div className="font-semibold">
                {isDragActive ? "Drop here" : "Drag & drop or click to upload"}
              </div>
              <div className="text-xs text-muted-foreground">
                Encrypted server-side · max 15MB
              </div>
            </div>
            {uploading && (
              <span className="ml-auto text-xs text-muted-foreground">Encrypting…</span>
            )}
          </div>
        )}
      </div>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {f.filename}{" "}
              <span>· {(f.size_bytes / 1024).toFixed(1)} KB</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ReviewStep — celebratory confirmation. We also clear the autosave draft
// from localStorage in the parent's onDone handler.
// ──────────────────────────────────────────────────────────────────────────
function ReviewStep({ data, leadId, onDone }) {
  return (
    <Card className="border-border bg-surface elev-1">
      <CardContent className="p-8 lg:p-10 text-center">
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="w-16 h-16 mx-auto rounded-full bg-emerald-100 grid place-items-center mb-5"
        >
          <CheckCircle2 className="w-9 h-9 text-emerald-600" />
        </motion.div>
        <h2
          className="text-[32px] font-semibold tracking-tight mb-3"
          style={{ fontFamily: "Outfit" }}
        >
          You're all set, {data.first_name || "and thank you"}.
        </h2>
        <p className="text-muted-foreground max-w-md mx-auto mb-6 leading-relaxed">
          Your intake has been securely transmitted and is now visible to your assigned Medicare
          advisor at Gruening Health &amp; Wealth. We'll reach out shortly during your preferred
          contact window.
        </p>
        <div className="rounded-lg border border-border p-4 bg-muted/40 text-sm inline-block">
          <span className="text-muted-foreground">Reference:</span>{" "}
          <span className="font-mono">{leadId?.slice(0, 8)}…</span>
        </div>
        <div className="mt-8 flex justify-center gap-3">
          <Button
            asChild
            variant="outline"
            className="btn-press rounded-full"
            data-testid="review-home"
          >
            <Link to="/">Return home</Link>
          </Button>
          {onDone && (
            <Button onClick={onDone} className="btn-press rounded-full elev-1" data-testid="review-done">
              Continue
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
