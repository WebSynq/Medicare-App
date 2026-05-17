import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, Link } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { ShieldCheck, Lock, ArrowRight, ArrowLeft, Upload, FileText, IdCard, Building2, CheckCircle2, X, FileSignature, ClipboardList, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PublicHeader, Footer } from "@/components/Layout";

const STEPS = ["Personal", "Medicare", "Application Details", "SOA Signature", "Documents", "Review"];

export default function IntakeWizard() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [createdLeadId, setCreatedLeadId] = useState(null);
  const [data, setData] = useState({
    first_name: "", last_name: "", email: "", phone: "",
    date_of_birth: "", address_line1: "", city: "", state: "", zip_code: "",
    mbi_number: "", medicare_part_a_effective: "", medicare_part_b_effective: "",
    current_carrier: "", current_plan: "",
    doctors: "", prescriptions: "",
    preferred_contact_time: "Anytime",
    notes: "",
    // Application Details (GHW app sale submission)
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
    consent_acknowledged: false,
    plan_types: { MA: false, MAPD: false, PDP: false, MedSupp: false },
  });

  const update = (k, v) => setData((d) => ({ ...d, [k]: v }));

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const submitLead = async () => {
    setSubmitting(true);
    try {
      const numApps = data.number_of_apps === "" || data.number_of_apps == null
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
        doctors: data.doctors ? data.doctors.split(",").map((s) => s.trim()).filter(Boolean) : [],
        prescriptions: data.prescriptions ? data.prescriptions.split(",").map((s) => s.trim()).filter(Boolean) : [],
        preferred_contact_time: data.preferred_contact_time || undefined,
        notes: data.notes || undefined,
        // Application Details
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

  // Personal step validity
  const personalValid = data.first_name.trim() && data.last_name.trim() && (data.email.trim() || data.phone.trim());

  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader />
      <main className="flex-1 py-10 lg:py-14">
        <div className="max-w-2xl mx-auto px-6">
          <div className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <Badge className="rounded-full bg-secondary text-secondary-foreground border-0" data-testid="step-indicator">
                Step {step + 1} of {STEPS.length} · {STEPS[step]}
              </Badge>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="w-3.5 h-3.5 text-primary" /> Encrypted submission
              </div>
            </div>
            <Progress value={((step + 1) / STEPS.length) * 100} className="h-1.5" />
          </div>

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
              {step === 3 && <SoaStep data={data} update={update} createdLeadId={createdLeadId} ensureLead={ensureLead} onSigned={() => next()} />}
              {step === 4 && <DocumentsStep leadId={createdLeadId} />}
              {step === 5 && <ReviewStep data={data} leadId={createdLeadId} onDone={() => nav(`/intake-complete?lead=${createdLeadId}`)} />}
            </motion.div>
          </AnimatePresence>

          {step !== 3 && step !== 5 && step !== 4 && (
            <div className="flex justify-between mt-8">
              <Button variant="ghost" onClick={back} disabled={step === 0} data-testid="wizard-back">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back
              </Button>
              {step === 2 ? (
                <Button
                  className="rounded-full px-6 h-11"
                  disabled={!personalValid || submitting}
                  onClick={async () => { try { await ensureLead(); next(); } catch (_) { /* toast already shown */ } }}
                  data-testid="wizard-next-after-app-details"
                >
                  {submitting ? "Securing..." : "Continue to SOA"} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              ) : (
                <Button
                  className="rounded-full px-6 h-11"
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
            <div className="flex justify-between mt-8">
              <Button variant="ghost" onClick={back} data-testid="wizard-back-docs"><ArrowLeft className="w-4 h-4 mr-2" /> Back</Button>
              <Button className="rounded-full px-6 h-11" onClick={next} data-testid="wizard-review">Review &amp; finish <ArrowRight className="w-4 h-4 ml-2" /></Button>
            </div>
          )}

          <div className="mt-10 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
            <ShieldCheck className="w-3.5 h-3.5 text-primary" /> Your data is transmitted over TLS and stored encrypted at rest.
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function PersonalStep({ data, update }) {
  return (
    <Card className="border-border bg-surface">
      <CardContent className="p-8 lg:p-10">
        <h2 className="text-2xl font-bold tracking-tight mb-2" style={{fontFamily:'Outfit'}}>Tell us about you</h2>
        <p className="text-muted-foreground mb-7">We use this only to verify eligibility and to follow up. Required fields marked with <span className="text-destructive">*</span>.</p>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="First name *">
            <Input className="h-12 text-base" value={data.first_name} onChange={(e) => update("first_name", e.target.value)} data-testid="intake-first-name" />
          </Field>
          <Field label="Last name *">
            <Input className="h-12 text-base" value={data.last_name} onChange={(e) => update("last_name", e.target.value)} data-testid="intake-last-name" />
          </Field>
          <Field label="Email (optional if phone)">
            <Input type="email" className="h-12 text-base" value={data.email} onChange={(e) => update("email", e.target.value)} data-testid="intake-email" />
          </Field>
          <Field label="Phone *">
            <Input className="h-12 text-base" value={data.phone} onChange={(e) => update("phone", e.target.value)} data-testid="intake-phone" />
          </Field>
          <Field label="Date of birth">
            <Input type="date" className="h-12 text-base" value={data.date_of_birth} onChange={(e) => update("date_of_birth", e.target.value)} data-testid="intake-dob" />
          </Field>
          <Field label="Preferred contact time">
            <Input className="h-12 text-base" value={data.preferred_contact_time} onChange={(e) => update("preferred_contact_time", e.target.value)} data-testid="intake-contact-time" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Input className="h-12 text-base" value={data.address_line1} onChange={(e) => update("address_line1", e.target.value)} data-testid="intake-address" />
          </Field>
          <Field label="City"><Input className="h-12 text-base" value={data.city} onChange={(e) => update("city", e.target.value)} data-testid="intake-city" /></Field>
          <Field label="State / ZIP">
            <div className="flex gap-3">
              <Input className="h-12 text-base w-1/3" placeholder="ST" value={data.state} onChange={(e) => update("state", e.target.value)} data-testid="intake-state" />
              <Input className="h-12 text-base flex-1" placeholder="ZIP" value={data.zip_code} onChange={(e) => update("zip_code", e.target.value)} data-testid="intake-zip" />
            </div>
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

function MedicareStep({ data, update }) {
  return (
    <Card className="border-border bg-surface">
      <CardContent className="p-8 lg:p-10">
        <h2 className="text-2xl font-bold tracking-tight mb-2" style={{fontFamily:'Outfit'}}>Medicare details</h2>
        <p className="text-muted-foreground mb-7">Find these on your red, white, and blue Medicare card. Skip anything you don't have handy — we'll collect it on the call.</p>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="MBI number">
            <Input className="h-12 text-base font-mono tracking-wider" placeholder="1AB2-CD3-EF45" value={data.mbi_number} onChange={(e) => update("mbi_number", e.target.value)} data-testid="intake-mbi" />
          </Field>
          <Field label="Current carrier (if any)">
            <Input className="h-12 text-base" value={data.current_carrier} onChange={(e) => update("current_carrier", e.target.value)} data-testid="intake-carrier" />
          </Field>
          <Field label="Part A effective date">
            <Input type="date" className="h-12 text-base" value={data.medicare_part_a_effective} onChange={(e) => update("medicare_part_a_effective", e.target.value)} data-testid="intake-part-a" />
          </Field>
          <Field label="Part B effective date">
            <Input type="date" className="h-12 text-base" value={data.medicare_part_b_effective} onChange={(e) => update("medicare_part_b_effective", e.target.value)} data-testid="intake-part-b" />
          </Field>
          <Field label="Current plan name" className="sm:col-span-2">
            <Input className="h-12 text-base" value={data.current_plan} onChange={(e) => update("current_plan", e.target.value)} data-testid="intake-plan" />
          </Field>
          <Field label="Doctors (comma-separated)" className="sm:col-span-2">
            <Textarea rows={2} value={data.doctors} onChange={(e) => update("doctors", e.target.value)} placeholder="Dr. Smith, Dr. Lee" data-testid="intake-doctors" />
          </Field>
          <Field label="Prescriptions (comma-separated)" className="sm:col-span-2">
            <Textarea rows={2} value={data.prescriptions} onChange={(e) => update("prescriptions", e.target.value)} placeholder="Lisinopril, Atorvastatin" data-testid="intake-prescriptions" />
          </Field>
          <Field label="Anything else?" className="sm:col-span-2">
            <Textarea rows={3} value={data.notes} onChange={(e) => update("notes", e.target.value)} data-testid="intake-notes" />
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

function ApplicationDetailsStep({ data, update }) {
  return (
    <Card className="border-border bg-surface">
      <CardContent className="p-8 lg:p-10">
        <div className="flex items-center gap-2 mb-2">
          <ClipboardList className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "Outfit" }}>Application Details</h2>
        </div>
        <p className="text-muted-foreground mb-7">Sales submission details for the back-office team. Skip anything that doesn't apply yet — these can be updated later.</p>
        <div className="grid sm:grid-cols-2 gap-5">
          <Field label="Sales submitting agent">
            <Input
              className="h-12 text-base"
              value={data.sales_submitting_agent}
              onChange={(e) => update("sales_submitting_agent", e.target.value)}
              placeholder="Agent name"
              data-testid="intake-sales-agent"
            />
          </Field>
          <Field label="Agency or Personal">
            <Select value={data.agency_or_personal} onValueChange={(v) => update("agency_or_personal", v)}>
              <SelectTrigger className="h-12 text-base" data-testid="intake-agency-or-personal"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Agency">Agency</SelectItem>
                <SelectItem value="Personal">Personal</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="New or Current client">
            <Select value={data.new_or_current_client} onValueChange={(v) => update("new_or_current_client", v)}>
              <SelectTrigger className="h-12 text-base" data-testid="intake-new-or-current"><SelectValue placeholder="Select…" /></SelectTrigger>
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
              className="h-12 text-base"
              value={data.number_of_apps}
              onChange={(e) => update("number_of_apps", e.target.value)}
              placeholder="e.g. 1"
              data-testid="intake-number-of-apps"
            />
          </Field>
          <Field label="Replacement app">
            <Select value={data.replacement_app} onValueChange={(v) => update("replacement_app", v)}>
              <SelectTrigger className="h-12 text-base" data-testid="intake-replacement-app"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Yes">Yes</SelectItem>
                <SelectItem value="No">No</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Lead source">
            <Input
              className="h-12 text-base"
              value={data.lead_source}
              onChange={(e) => update("lead_source", e.target.value)}
              placeholder="Referral, web, AEP mailer…"
              data-testid="intake-lead-source"
            />
          </Field>
          <Field label="Plan type / Premium" className="sm:col-span-2">
            <Input
              className="h-12 text-base"
              value={data.plan_type_premium}
              onChange={(e) => update("plan_type_premium", e.target.value)}
              placeholder="e.g. MAPD HMO — $0 / mo"
              data-testid="intake-plan-premium"
            />
          </Field>
          <Field label="Underwriting approved">
            <Select value={data.underwriting_approved} onValueChange={(v) => update("underwriting_approved", v)}>
              <SelectTrigger className="h-12 text-base" data-testid="intake-underwriting"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Yes">Yes</SelectItem>
                <SelectItem value="No">No</SelectItem>
                <SelectItem value="Pending">Pending</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Cancel old plan">
            <Select value={data.cancel_old_plan} onValueChange={(v) => update("cancel_old_plan", v)}>
              <SelectTrigger className="h-12 text-base" data-testid="intake-cancel-old"><SelectValue placeholder="Select…" /></SelectTrigger>
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
              value={data.admin_requests}
              onChange={(e) => update("admin_requests", e.target.value)}
              placeholder="Anything the back-office team should know — special requests, urgency, follow-ups."
              data-testid="intake-admin-requests"
            />
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

function SoaStep({ data, update, ensureLead, onSigned }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#14532D"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
  }, []);

  const startDraw = (e) => {
    drawingRef.current = true;
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath(); ctx.moveTo(x, y);
  };
  const move = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const { x, y } = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineTo(x, y); ctx.stroke();
    setHasDrawn(true);
  };
  const stopDraw = () => { drawingRef.current = false; };
  const pos = (e) => {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: ((t.clientX - rect.left) * c.width) / rect.width, y: ((t.clientY - rect.top) * c.height) / rect.height };
  };
  const clearSig = () => {
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    setHasDrawn(false);
  };

  const togglePlan = (k) => update("plan_types", { ...data.plan_types, [k]: !data.plan_types[k] });

  const submit = async () => {
    if (!hasDrawn) { toast.error("Please draw your signature."); return; }
    if (!data.consent_acknowledged) { toast.error("Please acknowledge consent."); return; }
    const planTypes = Object.entries(data.plan_types).filter(([, v]) => v).map(([k]) => k);
    if (planTypes.length === 0) { toast.error("Please select at least one plan type."); return; }

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
      toast.success("SOA signed and recorded.");
      onSigned();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to record SOA.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-border bg-surface">
      <CardContent className="p-8 lg:p-10">
        <div className="flex items-center gap-2 mb-2">
          <FileSignature className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>Scope of Appointment</h2>
        </div>
        <p className="text-muted-foreground mb-6">CMS requires a signed SOA before discussing Medicare Advantage or Part D plans. This is your record that we may only discuss the plan types you've authorized.</p>

        <div className="rounded-lg border border-border p-5 bg-muted/40 mb-6 leading-relaxed text-sm">
          <p className="mb-3"><strong>I, {data.first_name || "_______"} {data.last_name || "_______"}</strong>, authorize Gruening Health &amp; Wealth and its licensed agents to contact me to discuss the Medicare plan types I've checked below. The agent will not discuss plan types I have not authorized. This SOA does not obligate me to enroll, affect my current enrollment, or guarantee enrollment in any new plan.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            {[["MA","Medicare Advantage"], ["MAPD","MA + Drug"], ["PDP","Stand-alone Part D"], ["MedSupp","Medicare Supplement"]].map(([k, label]) => (
              <label key={k} className="flex items-start gap-2.5 p-3 rounded-md border border-border bg-surface cursor-pointer hover:border-primary/40">
                <Checkbox checked={data.plan_types[k]} onCheckedChange={() => togglePlan(k)} data-testid={`soa-plan-${k.toLowerCase()}`} />
                <div>
                  <div className="text-xs font-medium">{k}</div>
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="mb-2 text-sm font-medium">Sign here</div>
        <div className="rounded-lg border-2 border-dashed border-primary/30 bg-white p-2">
          <canvas
            ref={canvasRef}
            width={720} height={180}
            className="w-full h-44 rounded touch-none"
            onMouseDown={startDraw} onMouseMove={move} onMouseUp={stopDraw} onMouseLeave={stopDraw}
            onTouchStart={startDraw} onTouchMove={move} onTouchEnd={stopDraw}
            data-testid="soa-canvas"
          />
        </div>
        <div className="flex items-center justify-between mt-2 text-xs">
          <button type="button" onClick={clearSig} className="text-muted-foreground hover:text-destructive" data-testid="soa-clear">Clear signature</button>
          <span className="text-muted-foreground flex items-center gap-1.5"><Lock className="w-3 h-3" /> IP and timestamp recorded</span>
        </div>

        <label className="flex items-start gap-3 mt-6 p-4 rounded-md bg-secondary/60 cursor-pointer">
          <Checkbox checked={data.consent_acknowledged} onCheckedChange={(v) => update("consent_acknowledged", !!v)} data-testid="soa-consent" />
          <span className="text-sm text-foreground/90 leading-relaxed">I acknowledge this constitutes my electronic signature and authorize Gruening Health &amp; Wealth to discuss the plan types selected above. I understand my data is encrypted and protected under HIPAA.</span>
        </label>

        <div className="flex justify-end mt-7">
          <Button onClick={submit} disabled={submitting} className="rounded-full px-7 h-12 text-base" data-testid="soa-submit">
            {submitting ? "Recording..." : <>Sign &amp; continue <ArrowRight className="w-4 h-4 ml-2" /></>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DocumentsStep({ leadId }) {
  return (
    <Card className="border-border bg-surface">
      <CardContent className="p-8 lg:p-10">
        <h2 className="text-2xl font-bold tracking-tight mb-2" style={{fontFamily:'Outfit'}}>Upload documents</h2>
        <p className="text-muted-foreground mb-7">Up to 5 documents. PDF or image (JPG, PNG, WEBP) up to 15MB each. Files are encrypted on our servers — they never appear in URLs or logs.</p>
        <div className="space-y-5">
          <DropZone leadId={leadId} docType="medicare_card" icon={IdCard} label="1 · Medicare card" hint="Front and back if possible" />
          <DropZone leadId={leadId} docType="id" icon={FileText} label="2 · Government ID" hint="Driver's license or state ID" />
          <DropZone leadId={leadId} docType="voided_check" icon={Building2} label="3 · Voided check (optional)" hint="Only if you'd like premium auto-pay" />
          <DropZone leadId={leadId} docType="other" icon={Paperclip} label="4 · Additional document" hint="Application form, prescription list, etc." testIdSuffix="other-1" />
          <DropZone leadId={leadId} docType="other" icon={Paperclip} label="5 · Additional document" hint="Anything else the back-office team needs" testIdSuffix="other-2" />
        </div>
      </CardContent>
    </Card>
  );
}

function DropZone({ leadId, docType, icon: Icon, label, hint, testIdSuffix }) {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  const onDrop = async (accepted) => {
    if (!leadId) { toast.error("Please complete the previous steps first."); return; }
    setUploading(true);
    for (const file of accepted) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("doc_type", docType);
        const res = await api.post(`/documents/upload/${leadId}`, fd, { headers: { "Content-Type": "multipart/form-data" } });
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
    accept: { "image/*": [".png",".jpg",".jpeg",".webp"], "application/pdf": [".pdf"] },
    maxSize: 15 * 1024 * 1024,
  });

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">· {hint}</span>
      </div>
      <div
        {...getRootProps()}
        className={`rounded-xl border-2 border-dashed p-6 cursor-pointer transition-colors ${isDragActive ? "border-primary bg-secondary/60" : "border-border bg-muted/40 hover:border-primary/50"}`}
        data-testid={`dropzone-${testIdSuffix || docType}`}
      >
        <input {...getInputProps()} />
        <div className="flex items-center gap-3 text-sm">
          <div className="w-10 h-10 rounded-lg bg-surface border border-border grid place-items-center">
            <Upload className="w-4 h-4 text-primary" />
          </div>
          <div>
            <div className="font-medium">{isDragActive ? "Drop here" : "Drag & drop or click to upload"}</div>
            <div className="text-xs text-muted-foreground">Encrypted server-side · max 15MB</div>
          </div>
          {uploading && <span className="ml-auto text-xs text-muted-foreground">Encrypting...</span>}
        </div>
      </div>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="w-3.5 h-3.5 text-primary" /> {f.filename} <span>· {(f.size_bytes/1024).toFixed(1)} KB</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewStep({ data, leadId }) {
  return (
    <Card className="border-border bg-surface">
      <CardContent className="p-8 lg:p-10 text-center">
        <div className="w-16 h-16 mx-auto rounded-full bg-secondary grid place-items-center mb-5">
          <CheckCircle2 className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-3xl font-bold tracking-tight mb-3" style={{fontFamily:'Outfit'}}>You're all set, {data.first_name}.</h2>
        <p className="text-muted-foreground max-w-md mx-auto mb-6">Your intake has been securely transmitted and is now visible to your assigned Medicare advisor at Gruening Health &amp; Wealth. We'll reach out shortly during your preferred contact window.</p>
        <div className="rounded-lg border border-border p-4 bg-muted/40 text-sm inline-block">
          <span className="text-muted-foreground">Reference:</span> <span className="font-mono">{leadId?.slice(0,8)}…</span>
        </div>
        <div className="mt-8">
          <Button asChild variant="outline" className="rounded-full" data-testid="review-home">
            <Link to="/">Return home</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children, className = "" }) {
  return (
    <div className={className}>
      <Label className="text-sm mb-1.5 block">{label}</Label>
      {children}
    </div>
  );
}
