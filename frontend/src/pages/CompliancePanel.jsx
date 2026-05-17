import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ShieldCheck, FileWarning, Network, Server, Lock, FileSignature, Cloud } from "lucide-react";
import { AppHeader, Footer } from "@/components/Layout";

export default function CompliancePanel() {
  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader />
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-10">
        <div className="mb-8">
          <div className="text-xs uppercase tracking-widest text-primary mb-2">Internal · Compliance &amp; Build Plan</div>
          <h1 className="text-3xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>Project blueprint &amp; cost analysis</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl">A compact reference covering the architecture, HIPAA safeguards, GHL integration plan, and a 12-month cost estimate to migrate Gruening Health &amp; Wealth from the n8n workflow to a production-grade Medicare intake platform.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-5 mb-7">
          <Card className="border-border bg-surface"><CardContent className="p-6">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2"><Server className="w-4 h-4 text-primary" />Architecture</h3>
            <ul className="space-y-3 text-sm">
              {[
                ["Frontend", "React + shadcn UI · Tailwind · framer-motion · react-dropzone"],
                ["Backend", "FastAPI · Pydantic · Motor (async MongoDB) · httpx for GHL"],
                ["Auth", "JWT (HS256) · bcrypt · TOTP (pyotp) · RBAC (admin / agent / compliance)"],
                ["Storage", "MongoDB (lead + audit) · AES-128 Fernet at rest for documents (MVP) → AWS S3 SSE-KMS in production"],
                ["Sync", "GoHighLevel API v2 · Private Integration Token · upsert + tag + opportunity"],
                ["Observability", "Structured audit log · per-action immutable record · request IPs / UA"],
              ].map(([k,v]) => (
                <li key={k} className="grid grid-cols-[110px_1fr] gap-3"><span className="text-muted-foreground">{k}</span><span>{v}</span></li>
              ))}
            </ul>
          </CardContent></Card>

          <Card className="border-border bg-surface"><CardContent className="p-6">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" />HIPAA technical safeguards</h3>
            <ul className="space-y-2.5 text-sm">
              {[
                "TLS 1.2+ enforced; HSTS + strict CSP at ingress",
                "AES encryption at rest for PHI (Fernet MVP → KMS-managed in prod)",
                "TOTP MFA enrollable on every agent / admin / compliance account",
                "Append-only audit log of auth, leads, documents, SOA, GHL sync",
                "RBAC dependency on every admin/compliance route",
                "PHI never appears in URLs, query strings, or log lines",
                "Idempotent admin seeding; no default credentials in source",
                "Session timeout enforced via short-lived JWT (60 min)",
              ].map((t) => (
                <li key={t} className="flex gap-2.5"><CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />{t}</li>
              ))}
            </ul>
          </CardContent></Card>

          <Card className="border-border bg-surface"><CardContent className="p-6">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2"><Network className="w-4 h-4 text-primary" />GoHighLevel integration</h3>
            <ul className="space-y-2.5 text-sm">
              {[
                "Auth: GHL Private Integration Token + Location ID + Version header",
                "Endpoint: POST /contacts/upsert (idempotent by email/phone)",
                "Custom field mapping: MBI, Part A/B effective, carrier, plan, doctors, Rx, SOA flag",
                "Tags applied per state: Medicare-Lead, SOA-Signed, Docs-Uploaded",
                "Opportunity created in configured pipeline + stage",
                "Mock mode: when no token configured, sync still completes locally so demo flow is unblocked",
              ].map((t) => (
                <li key={t} className="flex gap-2.5"><CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />{t}</li>
              ))}
            </ul>
          </CardContent></Card>

          <Card className="border-border bg-surface"><CardContent className="p-6">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2"><FileWarning className="w-4 h-4 text-primary" />Operational requirements (out of scope of code)</h3>
            <ul className="space-y-2.5 text-sm">
              {[
                "Sign Business Associate Agreements: AWS, MongoDB Atlas, GoHighLevel, transactional email",
                "Annual HIPAA security risk assessment + DPIA",
                "Incident response runbook and 60-day breach notification plan",
                "Quarterly access review · principle of least privilege",
                "Annual penetration test + remediation",
                "Cyber-liability insurance (≥$1M aggregate)",
                "Workforce HIPAA awareness training (annual + onboarding)",
              ].map((t) => (
                <li key={t} className="flex gap-2.5"><CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />{t}</li>
              ))}
            </ul>
          </CardContent></Card>
        </div>

        <Card className="border-border bg-surface">
          <CardContent className="p-6 lg:p-8">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold flex items-center gap-2" style={{fontFamily:'Outfit'}}><Cloud className="w-4 h-4 text-primary" />12-month indicative cost</h3>
              <Badge variant="outline" className="rounded-full">USD · estimates</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="compliance-cost-table">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 font-medium">Category</th>
                    <th className="py-2 pr-4 font-medium">Line item</th>
                    <th className="py-2 pr-4 font-medium">Monthly</th>
                    <th className="py-2 pr-4 font-medium">Year 1</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    ["Infra","MongoDB Atlas (HIPAA M10)","$185","$2,220"],
                    ["Infra","AWS — EC2/ECS + ALB + WAF","$220","$2,640"],
                    ["Infra","AWS S3 + KMS + CloudTrail","$45","$540"],
                    ["Infra","Atlas backups (PITR 30d)","$60","$720"],
                    ["Infra","Domain · SSL · Sentry · Logs","$80","$960"],
                    ["Integrations","GoHighLevel Agency Pro (existing)","$497","$5,964"],
                    ["Integrations","Postmark / Paubox (BAA email)","$35","$420"],
                    ["Compliance","Penetration test (annual)","—","$6,500"],
                    ["Compliance","HIPAA training + policy bundle","—","$1,200"],
                    ["Compliance","Cyber liability insurance","$180","$2,160"],
                  ].map((r,i) => (
                    <tr key={i}>
                      <td className="py-2 pr-4 text-muted-foreground">{r[0]}</td>
                      <td className="py-2 pr-4">{r[1]}</td>
                      <td className="py-2 pr-4 tabular-nums">{r[2]}</td>
                      <td className="py-2 pr-4 tabular-nums font-medium">{r[3]}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-foreground/10">
                    <td className="py-3 pr-4 font-semibold">Subtotal — recurring</td><td></td>
                    <td className="py-3 pr-4 tabular-nums">~$1,302</td>
                    <td className="py-3 pr-4 tabular-nums font-bold text-primary">$23,324</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold">One-time build (Phase 1 MVP)</td><td className="text-muted-foreground">~6 weeks</td><td></td>
                    <td className="py-2 pr-4 tabular-nums font-bold text-primary">$28,000 – $42,000</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-semibold">Phase 2 hardening (BAA + KMS + pen test fixes)</td><td className="text-muted-foreground">~4 weeks</td><td></td>
                    <td className="py-2 pr-4 tabular-nums font-bold text-primary">$12,000 – $18,000</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>

        <div className="mt-7 grid md:grid-cols-3 gap-5 text-sm">
          <Card className="border-border bg-secondary/40"><CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2"><Lock className="w-4 h-4 text-primary" /><span className="font-semibold">Phase 1 — MVP</span></div>
            <p className="text-muted-foreground">Multi-step intake, SOA e-sign, encrypted upload, agent dashboard, GHL sync (mock), audit log.</p>
          </CardContent></Card>
          <Card className="border-border bg-secondary/40"><CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2"><FileSignature className="w-4 h-4 text-primary" /><span className="font-semibold">Phase 2 — Hardening</span></div>
            <p className="text-muted-foreground">Move to AWS w/ BAA, KMS-managed keys, MongoDB Atlas HIPAA tier, signed BAAs, pen test, HIPAA policy pack.</p>
          </CardContent></Card>
          <Card className="border-border bg-secondary/40"><CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2"><Network className="w-4 h-4 text-primary" /><span className="font-semibold">Phase 3 — Scale</span></div>
            <p className="text-muted-foreground">GHL webhook bidirectional sync, AEP campaign workflows, agent commission tracking, e-fax integration, analytics.</p>
          </CardContent></Card>
        </div>
      </main>
      <Footer />
    </div>
  );
}
