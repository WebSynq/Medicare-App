import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ShieldCheck, Lock, FileSignature, Upload, Cable, ClipboardList, ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PublicHeader, Footer } from "@/components/Layout";

const HERO_IMG = "https://static.prod-images.emergentagent.com/jobs/778a7dbc-8686-4d3e-87fc-fce3fac48f67/images/bcce0aae6e4600a7d511d4a7490ed04419512e890a959bd46527182b19272479.png";
const COUPLE_IMG = "https://images.unsplash.com/photo-1761839257647-df30867afd54?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NjZ8MHwxfHNlYXJjaHwxfHxzZW5pb3IlMjBjb3VwbGUlMjBzbWlsaW5nJTIwb3V0ZG9vcnN8ZW58MHx8fHwxNzc4OTUzOTc2fDA&ixlib=rb-4.1.0&q=85";

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
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-balance leading-[1.05]" style={{fontFamily:'Outfit'}}>
              The secure Medicare intake portal for Gruening Health &amp; Wealth.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground leading-relaxed max-w-xl">
              Replace fragile n8n forms with a compliant intake experience that captures eligibility, signs the SOA, securely uploads documents, and syncs every lead to GoHighLevel — without ever leaking PHI.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" className="rounded-full px-7 h-12 text-base" data-testid="hero-start-intake">
                <Link to="/intake">Begin secure intake <ArrowRight className="ml-2 w-4 h-4" /></Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="rounded-full px-7 h-12 text-base" data-testid="hero-agent-login">
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
                  <div className="text-xl font-semibold" style={{fontFamily:'Outfit'}}>{s.n}</div>
                  <div className="text-xs text-muted-foreground">{s.l}</div>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div {...fade(0.15)} className="relative">
            <div className="relative rounded-2xl overflow-hidden border border-border shadow-sm">
              <img src={HERO_IMG} alt="Medicare consultation office" className="w-full h-[440px] object-cover" />
              <div className="absolute inset-0 bg-gradient-to-tr from-primary/30 via-transparent to-transparent" />
            </div>
            <motion.div {...fade(0.4)} className="absolute -bottom-6 -left-6 bg-surface border border-border rounded-xl p-4 shadow-sm w-64 hidden sm:block">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-primary" />
                <span className="text-xs font-medium">GHL Sync · success</span>
              </div>
              <div className="text-xs text-muted-foreground">Contact upserted with custom fields, tagged <span className="font-medium text-foreground">Medicare-Lead</span>.</div>
            </motion.div>
            <motion.div {...fade(0.55)} className="absolute -top-5 -right-3 bg-surface border border-border rounded-xl p-3 shadow-sm hidden sm:flex items-center gap-2">
              <Lock className="w-4 h-4 text-primary" />
              <span className="text-xs">Documents encrypted at rest</span>
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

      {/* SCOPE / COST */}
      <ScopeAndCostSection />

      <Footer />
    </div>
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
