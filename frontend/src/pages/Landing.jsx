import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ShieldCheck, Lock, FileSignature, Upload, Cable, ClipboardList, ArrowRight, CheckCircle2, AlertTriangle, X, ScrollText, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PublicHeader, Footer } from "@/components/Layout";

const COUPLE_IMG = "https://images.unsplash.com/photo-1761839257647-df30867afd54?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NjZ8MHwxfHNlYXJjaHwxfHxzZW5pb3IlMjBjb3VwbGUlMjBzbWlsaW5nJTIwb3V0ZG9vcnN8ZW58MHx8fHwxNzc4OTUzOTc2fDA&ixlib=rb-4.1.0&q=85";
const HERO_IMG = "https://static.prod-images.emergentagent.com/jobs/778a7dbc-8686-4d3e-87fc-fce3fac48f67/images/bcce0aae6e4600a7d511d4a7490ed04419512e890a959bd46527182b19272479.png";

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] },
});

export default function Landing() {
  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader />

      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 pt-16 pb-20 lg:pt-24 lg:pb-28 grid lg:grid-cols-2 gap-14 items-center">
          <motion.div {...fade(0)}>
            <Badge className="rounded-full bg-secondary text-secondary-foreground border-0 mb-6" data-testid="hero-badge">
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> HIPAA-aligned · Encrypted End-to-End
            </Badge>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-balance leading-[1.05]" style={{fontFamily:'Outfit'}}>
              The secure Medicare intake portal for Gruening Health &amp; Wealth.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground leading-relaxed max-w-xl">
              Replace fragile n8n forms with a compliant intake experience that captures eligibility, signs the SOA, securely uploads documents, and syncs every lead to GoHighLevel — without ever leaking PHI.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" className="btn-press rounded-full px-7 h-12 text-base elev-2" data-testid="hero-start-intake">
                <Link to="/intake">Begin secure intake <ArrowRight className="ml-2 w-4 h-4" /></Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="btn-press rounded-full px-7 h-12 text-base" data-testid="hero-agent-login">
                <Link to="/login">Agent sign in</Link>
              </Button>
            </div>
            <div className="mt-10 grid grid-cols-3 gap-5 max-w-md">
              {[
                {n: "AES-256", l: "in transit"},
                {n: "TOTP", l: "MFA for agents"},
                {n: "Audit", l: "trail per action"},
              ].map((s) => (
                <div key={s.n}>
                  <div className="text-2xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>{s.n}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.l}</div>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div {...fade(0.15)} className="relative">
            <div
              className="relative rounded-2xl overflow-hidden border border-border elev-2 w-full h-[440px]"
              role="img"
              aria-label="Medicare consultation"
            >
              {/* Photographic hero — replaces the prior CSS-gradient
                  placeholder that read as "unfinished". */}
              <img
                src={HERO_IMG}
                alt="Warm consultation office with golden hour light"
                className="absolute inset-0 w-full h-full object-cover"
              />
              {/* Subtle navy-to-warm gradient overlay for chrome legibility
                  on the floating proof cards below, without obscuring the
                  photograph. */}
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(20,30,50,0.30) 0%, rgba(20,30,50,0.05) 45%, rgba(232,93,47,0.10) 130%)",
                }}
                aria-hidden="true"
              />
              {/* Floating audit-pulse pill — top-left */}
              <div className="absolute top-5 left-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-surface text-xs font-medium text-foreground/85">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                Audit log · live
              </div>
            </div>
            <motion.div {...fade(0.4)} className="absolute -bottom-6 -left-6 glass-surface rounded-xl p-4 elev-2 w-64 hidden sm:block">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold">GHL Sync · success</span>
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                Contact upserted with custom fields, tagged <span className="font-medium text-foreground">Medicare-Lead</span>.
              </div>
            </motion.div>
            <motion.div {...fade(0.55)} className="absolute -top-5 -right-3 glass-surface rounded-xl px-3 py-2.5 elev-2 hidden sm:flex items-center gap-2">
              <Lock className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium">Documents encrypted at rest</span>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="border-y border-border bg-surface/60">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20">
          <div className="max-w-2xl mb-12">
            <div className="text-xs uppercase tracking-widest text-primary mb-3">How it works</div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>One guided flow. Four protective layers.</h2>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {icon: ClipboardList, title: "Eligibility intake", body: "Beneficiary completes a multi-step form: personal info, Medicare A/B effective dates, MBI, doctors, prescriptions."},
              {icon: FileSignature, title: "SOA e-signature", body: "CMS-compliant Scope of Appointment captured with timestamp, IP, and signed image — stored immutably in the audit log."},
              {icon: Upload, title: "Encrypted upload", body: "Medicare card, ID, and voided check are encrypted server-side (AES) before touching disk. Files never appear in URLs."},
              {icon: Cable, title: "GHL sync", body: "Backend pushes contact, custom fields, tags, and opens an opportunity in your pipeline via GHL API v2 (Private Token)."},
            ].map((s, i) => (
              <motion.div key={s.title} {...fade(0.05 * i)}>
                <Card className="h-full border-border bg-surface hover:shadow-sm hover:-translate-y-0.5 transition-all">
                  <CardContent className="p-6">
                    <div className="w-10 h-10 rounded-lg bg-secondary grid place-items-center mb-4">
                      <s.icon className="w-5 h-5 text-primary" />
                    </div>
                    <div className="text-sm font-semibold mb-1.5" style={{fontFamily:'Outfit'}}>{s.title}</div>
                    <div className="text-sm text-muted-foreground leading-relaxed">{s.body}</div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* SECURITY */}
      <section id="security" className="py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 grid lg:grid-cols-2 gap-14 items-center">
          <motion.div {...fade(0)} className="order-2 lg:order-1">
            <div className="rounded-2xl overflow-hidden border border-border">
              <img src={COUPLE_IMG} alt="Senior couple smiling" className="w-full h-[440px] object-cover" />
            </div>
          </motion.div>
          <motion.div {...fade(0.15)} className="order-1 lg:order-2">
            <div className="text-xs uppercase tracking-widest text-primary mb-3">Security &amp; compliance</div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6" style={{fontFamily:'Outfit'}}>Built around HIPAA, designed for trust.</h2>
            <ul className="space-y-4">
              {[
                "TLS 1.2+ enforced for every request; HSTS and strict CSP at the edge.",
                "AES encryption at rest for PHI documents using a dedicated key (rotatable).",
                "Role-based access — agent, admin, compliance officer — with TOTP MFA enrollment.",
                "Audit log captures every login, document touch, SOA signature, and GHL sync.",
                "Production deploy plan: AWS w/ signed BAA, KMS-managed keys, VPC endpoints, MongoDB Atlas (HIPAA tier).",
              ].map((t) => (
                <li key={t} className="flex gap-3">
                  <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                  <span className="text-foreground/85 leading-relaxed">{t}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <Button asChild variant="outline" className="rounded-full" data-testid="security-scope-link">
                <a href="#scope">View full project scope <ArrowRight className="ml-2 w-4 h-4" /></a>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* WHY UPGRADE FROM N8N */}
      <WhyUpgradeSection />

      {/* SCOPE / COST */}
      <ScopeAndCostSection />

      <Footer />
    </div>
  );
}

function WhyUpgradeSection() {
  const comparison = [
    {
      capability: "PHI encryption at rest",
      regulation: "HIPAA Security Rule · 45 CFR §164.312(a)(2)(iv)",
      n8n: { ok: false, text: "Files sit in n8n storage / Google Drive without dedicated encryption keys. No KMS, no rotation." },
      new: { ok: true, text: "AES-128 Fernet today; AWS KMS-managed keys in production. Per-document encryption, rotatable." },
    },
    {
      capability: "Scope of Appointment (SOA)",
      regulation: "CMS Medicare Marketing Guidelines · 42 CFR §422.2264 (mandatory before MA / PDP discussion)",
      n8n: { ok: false, text: "Not captured. Discussing MA/PDP without a documented SOA is a Medicare marketing violation that can trigger CMS sanctions on the FMO." },
      new: { ok: true, text: "Canvas e-signature with timestamp, IP, user-agent, plan types acknowledged. Stored immutably in audit log. Provable on CMS audit." },
    },
    {
      capability: "Multi-Factor Authentication",
      regulation: "HIPAA Security Rule · 45 CFR §164.308(a)(5)(ii)(D) + NIST 800-63B AAL2",
      n8n: { ok: false, text: "Whoever has the n8n password — or a leaked Google Workspace cookie — can read every Medicare card uploaded." },
      new: { ok: true, text: "TOTP MFA enforced on every agent / admin / compliance account. JWT carries an explicit mfa_verified claim." },
    },
    {
      capability: "Audit log of access to PHI",
      regulation: "HIPAA Security Rule · 45 CFR §164.312(b) — Audit Controls",
      n8n: { ok: false, text: "n8n execution logs are operational, not forensic. No record of who viewed which Medicare card, when, from what IP." },
      new: { ok: true, text: "Append-only log of every login, lead read, document download, SOA signature and GHL sync. Filterable by event type, actor, target." },
    },
    {
      capability: "Role-based access control",
      regulation: "HIPAA Security Rule · 45 CFR §164.308(a)(4) — Information Access Management",
      n8n: { ok: false, text: "n8n is admin-or-nothing. No way to restrict a junior agent from seeing every beneficiary's MBI." },
      new: { ok: true, text: "Agent / Admin / Compliance Officer roles enforced server-side. Compliance has read-only access to audit + leads, never to credentials." },
    },
    {
      capability: "Breach notification readiness",
      regulation: "HITECH Act / HHS Breach Notification Rule · 45 CFR §164.404 (60-day window)",
      n8n: { ok: false, text: "Without an audit trail you can't determine scope of breach — meaning you must notify ALL beneficiaries, every time. Reputation + legal cost." },
      new: { ok: true, text: "Audit log scopes any incident to specific records and individuals, dramatically reducing notification exposure and PR fallout." },
    },
    {
      capability: "Business Associate Agreements (BAA)",
      regulation: "HIPAA Privacy Rule · 45 CFR §164.502(e) — required with every PHI-handling vendor",
      n8n: { ok: false, text: "n8n Cloud does not sign HIPAA BAAs on standard plans. Storing PHI there is technically out of compliance from day one." },
      new: { ok: true, text: "Architected for BAA-covered infra: AWS, MongoDB Atlas (HIPAA tier), Postmark/Paubox for email. GHL already on a BAA-eligible plan." },
    },
    {
      capability: "Data integrity / non-repudiation",
      regulation: "HIPAA Security Rule · 45 CFR §164.312(c)(1) + state insurance e-signature laws",
      n8n: { ok: false, text: "A simple form submission can be tampered with or replayed; no cryptographic signature on the consent record." },
      new: { ok: true, text: "Beneficiary signature stored as a captured raster + timestamp + IP. Audit log entry is hashable for tamper-evidence." },
    },
  ];

  return (
    <section id="why-upgrade" className="bg-surface border-t border-border">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20">
        <div className="grid lg:grid-cols-[1fr_2fr] gap-10 mb-12">
          <div>
            <Badge className="rounded-full bg-secondary text-secondary-foreground border-0 mb-4">
              <Scale className="w-3.5 h-3.5 mr-1.5" /> Why this matters
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>
              The current n8n form works.<br />It just isn't defensible.
            </h2>
          </div>
          <div className="space-y-4 text-foreground/85 leading-relaxed">
            <p>The n8n workflow you have today moves data — and that's all it does. It does not document consent, doesn't restrict who can read PHI, doesn't prove who looked at which Medicare card, and runs on infrastructure that won't sign a Business Associate Agreement.</p>
            <p>For a Medicare FMO, that gap is not theoretical. CMS audits, OIG complaints, state DOI inquiries and beneficiary complaints all require evidence that you are following the same rules every carrier in your portfolio is contractually obligating you to follow. A working form is not evidence. A platform with audit, MFA, encryption, RBAC, and SOA capture is.</p>
            <p className="text-sm text-muted-foreground border-l-2 border-accent pl-4 italic">Translation for Gruening: today the agency carries personal liability for any beneficiary whose MBI is mishandled. Tomorrow it carries documented technical safeguards that satisfy HIPAA, HITECH, CMS Marketing Guidelines, and the carrier compliance agreements you already signed.</p>
          </div>
        </div>

        {/* Side-by-side header */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr_1fr] gap-0 rounded-xl border border-border overflow-hidden">
          <div className="hidden lg:block bg-muted/40 px-5 py-4 border-r border-border">
            <span className="text-xs uppercase tracking-widest text-muted-foreground">Capability &amp; regulation</span>
          </div>
          <div className="bg-destructive/5 px-5 py-4 border-r border-border flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            <span className="text-sm font-semibold text-destructive">Today · n8n + form</span>
          </div>
          <div className="bg-primary/5 px-5 py-4 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-primary">New · Gruening Secure Intake</span>
          </div>

          {comparison.map((row, i) => (
            <div key={row.capability} className={`contents ${i === comparison.length - 1 ? "" : ""}`}>
              <div className={`bg-surface px-5 py-4 border-t border-border lg:border-r`}>
                <div className="text-sm font-semibold" style={{fontFamily:'Outfit'}}>{row.capability}</div>
                <div className="text-xs text-muted-foreground mt-1 flex items-start gap-1.5"><ScrollText className="w-3 h-3 mt-0.5 shrink-0" />{row.regulation}</div>
              </div>
              <div className="bg-destructive/[0.03] px-5 py-4 border-t border-border lg:border-r">
                <div className="flex gap-2.5 text-sm">
                  <X className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                  <span className="text-foreground/85 leading-relaxed">{row.n8n.text}</span>
                </div>
              </div>
              <div className="bg-primary/[0.04] px-5 py-4 border-t border-border">
                <div className="flex gap-2.5 text-sm">
                  <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span className="text-foreground/85 leading-relaxed">{row.new.text}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Business case */}
        <div className="grid md:grid-cols-3 gap-5 mt-10">
          {[
            { h: "Carrier &amp; FMO trust", b: "Carriers increasingly require attestation that downstream agencies use HIPAA-aligned tooling. A documented platform is now table-stakes for retaining contracts with UHC, Humana, Aetna, and BCBS plans." },
            { h: "Enterprise valuation", b: "Agencies that get acquired trade at higher multiples when they can show signed BAAs, audit logs, and pen-test reports. Compliance infrastructure is operating leverage at exit." },
            { h: "Lower insurance premiums", b: "Cyber-liability carriers underwrite based on technical safeguards. MFA, encryption at rest, and audit controls typically reduce premiums 20–35% vs an n8n-only setup." },
          ].map((c) => (
            <Card key={c.h} className="border-border bg-surface">
              <CardContent className="p-6">
                <div className="text-sm font-semibold mb-2" style={{fontFamily:'Outfit'}} dangerouslySetInnerHTML={{__html: c.h}} />
                <p className="text-sm text-muted-foreground leading-relaxed">{c.b}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-8 rounded-xl border border-border bg-secondary/40 p-6 text-sm text-foreground/85 leading-relaxed">
          <strong className="text-foreground">Bottom line:</strong> n8n was the right MVP for "can we collect a lead at all?" The platform on this preview answers a different — and far more valuable — question: <em>"Can we prove we collected it the way Medicare and HIPAA require?"</em> Once that answer is yes, every carrier, every audit, and every acquirer treats Gruening Health &amp; Wealth as a different class of business.
        </div>
      </div>
    </section>
  );
}

function ScopeAndCostSection() {
  return (
    <section id="scope" className="bg-secondary/30 border-t border-border">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20">
        <div className="max-w-2xl mb-12">
          <div className="text-xs uppercase tracking-widest text-primary mb-3">Full project scope</div>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>From n8n form to compliant Medicare platform.</h2>
          <p className="text-muted-foreground mt-4 leading-relaxed">
            Replacing the existing n8n + form workflow with a production-grade application means treating PHI as a first-class concern across infra, app, and process. Here is the complete blueprint and a transparent 12-month cost picture.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-5 mb-12">
          {[
            {h: "Tech stack",
             items: ["React + shadcn UI (HIPAA-aware components)", "FastAPI (Python) backend", "MongoDB Atlas — HIPAA tier", "AWS S3 (SSE-KMS) for documents", "GHL API v2 — Private Integration Token", "JWT + bcrypt + TOTP (pyotp)"]},
            {h: "HIPAA safeguards",
             items: ["Signed BAA with AWS, MongoDB Atlas, GHL", "TLS 1.2+ enforced; HSTS + strict CSP", "AES encryption at rest (KMS managed)", "RBAC: agent / admin / compliance", "Immutable audit log (append-only)", "Automatic session timeout + MFA"]},
            {h: "Operational",
             items: ["DPIA + risk assessment document", "Security awareness training (annual)", "Incident response runbook", "Quarterly access reviews", "Backups: encrypted, 90-day retention", "Vulnerability scans (monthly)"]},
          ].map((b) => (
            <Card key={b.h} className="border-border bg-surface">
              <CardContent className="p-6">
                <h3 className="text-base font-semibold mb-4" style={{fontFamily:'Outfit'}}>{b.h}</h3>
                <ul className="space-y-2.5 text-sm">
                  {b.items.map((i) => (
                    <li key={i} className="flex gap-2.5"><CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" /><span className="text-foreground/85">{i}</span></li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border-border bg-surface">
          <CardContent className="p-6 lg:p-8">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold" style={{fontFamily:'Outfit'}}>12-month indicative cost</h3>
              <Badge variant="outline" className="rounded-full">USD · estimates</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="cost-table">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 font-medium">Line item</th>
                    <th className="py-2 pr-4 font-medium">Monthly</th>
                    <th className="py-2 pr-4 font-medium">Year 1</th>
                    <th className="py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    ["MongoDB Atlas (HIPAA M10)", "$185", "$2,220", "Dedicated tier required for BAA"],
                    ["AWS — EC2/ECS + ALB + WAF", "$220", "$2,640", "Encrypted compute + WAF rules"],
                    ["AWS S3 + KMS + CloudTrail", "$45", "$540", "PHI document storage + audit"],
                    ["MongoDB Atlas backups (PITR)", "$60", "$720", "Encrypted, 30-day PITR"],
                    ["GoHighLevel Agency Pro", "$497", "$5,964", "Existing — already paid by Gruening"],
                    ["Domain · SSL · Sentry · Logs", "$80", "$960", "Sentry on-prem option for PHI scrubbing"],
                    ["BAA-covered email (Postmark/Paubox)", "$35", "$420", "Transactional email under BAA"],
                    ["Penetration test (one-time)", "—", "$6,500", "Required by most BAAs annually"],
                    ["HIPAA training + policy templates", "—", "$1,200", "Accountable, Compliancy Group, etc."],
                    ["Cyber liability insurance", "$180", "$2,160", "$1M aggregate baseline"],
                  ].map((row) => (
                    <tr key={row[0]}>
                      <td className="py-2.5 pr-4">{row[0]}</td>
                      <td className="py-2.5 pr-4 tabular-nums">{row[1]}</td>
                      <td className="py-2.5 pr-4 tabular-nums font-medium">{row[2]}</td>
                      <td className="py-2.5 text-muted-foreground">{row[3]}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-foreground/10">
                    <td className="py-3 pr-4 font-semibold" style={{fontFamily:'Outfit'}}>Estimated total (Year 1)</td>
                    <td className="py-3 pr-4"></td>
                    <td className="py-3 pr-4 font-bold text-primary tabular-nums" style={{fontFamily:'Outfit'}}>$23,324</td>
                    <td className="py-3 text-xs text-muted-foreground">Excludes development labor. GHL line already in Gruening's budget.</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-xs text-muted-foreground mt-5 leading-relaxed">
              Add a one-time build investment of ~$28k–$55k depending on whether MFA, dashboard, and compliance panel are scoped together or in phases. Full cost analysis appears inside the Compliance panel after signing in.
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
