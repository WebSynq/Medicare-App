import { Link } from "react-router-dom";

function CheckIcon() {
  return (
    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  );
}

function SecurityCard({ title, icon, items }) {
  return (
    <div className="rounded-lg p-6" style={{ background: "white", border: "1px solid #e8e8e8", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl"
          style={{ background: "#f0f4f8" }}>
          {icon}
        </div>
        <h3 className="font-semibold" style={{ color: "#1e2d3d", letterSpacing: "-0.01em" }}>{title}</h3>
      </div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5" style={{ color: "#1a6b3c" }}><CheckIcon /></span>
            <span className="text-sm" style={{ color: "#555" }}>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SecurityPage() {
  return (
    <div className="min-h-screen" style={{ background: "#f8f9fa" }}>

      {/* Header */}
      <div style={{ background: "#1e2d3d", borderBottom: "3px solid #e85d2f" }}>
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "#e85d2f" }}>
              <span className="text-white font-bold text-sm">G</span>
            </div>
            <span className="text-white font-semibold text-sm">Gruening Health & Wealth</span>
          </div>
          <Link to="/login" className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
            Agent Login →
          </Link>
        </div>
      </div>

      {/* Hero */}
      <div style={{ background: "#1e2d3d", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div className="max-w-5xl mx-auto px-6 py-16 text-center">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-6 flex items-center justify-center"
            style={{ background: "rgba(232,93,47,0.15)", border: "1px solid rgba(232,93,47,0.3)" }}>
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="#e85d2f" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-white mb-3" style={{ letterSpacing: "-0.02em" }}>
            Security at Gruening Health & Wealth
          </h1>
          <p className="text-base max-w-2xl mx-auto" style={{ color: "rgba(255,255,255,0.5)" }}>
            Our clients trust us with their most sensitive Medicare information. Here is exactly how we protect it.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-12">

        {/* Compliance badges */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          {[
            { label: "HIPAA Compliant", sub: "Security Rule", color: "#1a6b3c" },
            { label: "SOC 2 Aligned", sub: "Security Controls", color: "#1a4a8a" },
            { label: "AES-256", sub: "Document Encryption", color: "#1e2d3d" },
            { label: "TLS 1.2+", sub: "Data in Transit", color: "#92400e" },
          ].map((badge, i) => (
            <div key={i} className="rounded-lg p-4 text-center"
              style={{ background: "white", border: "1px solid #e8e8e8" }}>
              <div className="w-8 h-8 rounded-full mx-auto mb-2 flex items-center justify-center"
                style={{ background: `${badge.color}15` }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={badge.color} strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <p className="text-sm font-semibold" style={{ color: "#1e2d3d" }}>{badge.label}</p>
              <p className="text-xs mt-0.5" style={{ color: "#888" }}>{badge.sub}</p>
            </div>
          ))}
        </div>

        {/* Security cards */}
        <div className="grid md:grid-cols-2 gap-6 mb-12">
          <SecurityCard
            title="Data Encryption"
            icon="🔒"
            items={[
              "AES-256 encryption on all uploaded documents at rest",
              "TLS 1.2+ for all data in transit between your device and our servers",
              "Documents are encrypted before they touch our storage — never stored in plaintext",
              "Decryption happens in-memory only during authorized downloads",
            ]}
          />
          <SecurityCard
            title="Access Control"
            icon="🛡️"
            items={[
              "JWT (JSON Web Token) authentication on every API request",
              "Multi-factor authentication (TOTP) available for all agents",
              "Role-based access — agents see only their own clients",
              "Invite-only agent registration — no unauthorized account creation",
              "Brute force protection — accounts locked after 5 failed attempts",
              "30-minute automatic session timeout for inactive sessions",
            ]}
          />
          <SecurityCard
            title="Infrastructure"
            icon="⚙️"
            items={[
              "Backend hosted on Render — auto-scaling, always-on infrastructure",
              "Database on MongoDB Atlas M10 — dedicated cluster, not shared",
              "Frontend on Vercel global CDN — 99.99% uptime SLA",
              "All infrastructure runs on HTTPS — no unencrypted endpoints",
              "CORS restricted to authorized domains only",
              "PHI never stored in third-party CRM (GoHighLevel)",
            ]}
          />
          <SecurityCard
            title="Monitoring & Incident Response"
            icon="📡"
            items={[
              "Real-time error monitoring via Sentry (PHI-scrubbed)",
              "Uptime monitoring every 3 minutes with SMS/email alerts",
              "Immutable audit log — every PHI access logged with IP and timestamp",
              "Designated HIPAA Security Officer (Matt Monacelli)",
              "Documented incident response procedure",
              "Breach notification protocol per HIPAA requirements",
            ]}
          />
          <SecurityCard
            title="HIPAA Compliance"
            icon="📋"
            items={[
              "Formal HIPAA Security Program with 12 written policies",
              "Annual risk assessment documented and reviewed",
              "Business Associate Agreements with all applicable vendors",
              "CMS-compliant Scope of Appointment capture and retention",
              "SOA records retained for minimum 10 years",
              "Workforce HIPAA training program",
            ]}
          />
          <SecurityCard
            title="Password & Credential Policy"
            icon="🔑"
            items={[
              "Minimum 12-character passwords enforced at the system level",
              "Passwords must include uppercase, lowercase, number, and special character",
              "Passwords are hashed using bcrypt — never stored in plaintext",
              "MFA via authenticator app adds a second layer of protection",
              "Credentials never transmitted in URL parameters",
              "API keys stored in environment variables — never in source code",
            ]}
          />
        </div>

        {/* Vendor security */}
        <div className="rounded-lg p-6 mb-12" style={{ background: "white", border: "1px solid #e8e8e8" }}>
          <h2 className="text-lg font-semibold mb-4" style={{ color: "#1e2d3d" }}>Vendor Security</h2>
          <p className="text-sm mb-4" style={{ color: "#555" }}>
            We carefully evaluate every vendor that touches our platform. Here is a summary of our key technology partners and their security posture:
          </p>
          <div className="space-y-3">
            {[
              { vendor: "MongoDB Atlas", role: "Database (ePHI)", cert: "SOC 2 Type II, HIPAA BAA, ISO 27001", link: "mongodb.com/cloud/atlas/security" },
              { vendor: "Render", role: "Backend hosting", cert: "SOC 2 Type II, HIPAA BAA available", link: "render.com/security" },
              { vendor: "Vercel", role: "Frontend hosting", cert: "SOC 2 Type II, ISO 27001", link: "vercel.com/security" },
              { vendor: "Sentry", role: "Error monitoring (PHI-scrubbed)", cert: "SOC 2 Type II, GDPR compliant", link: "sentry.io/security" },
            ].map((v, i) => (
              <div key={i} className="flex items-start justify-between gap-4 py-3"
                style={{ borderBottom: i < 3 ? "1px solid #f0f0f0" : "none" }}>
                <div>
                  <p className="text-sm font-medium" style={{ color: "#1e2d3d" }}>{v.vendor}</p>
                  <p className="text-xs mt-0.5" style={{ color: "#888" }}>{v.role}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs" style={{ color: "#555" }}>{v.cert}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Responsible disclosure */}
        <div className="rounded-lg p-6 mb-12" style={{ background: "#fff8f0", border: "1px solid rgba(232,93,47,0.2)" }}>
          <h2 className="text-lg font-semibold mb-2" style={{ color: "#1e2d3d" }}>Responsible Disclosure</h2>
          <p className="text-sm" style={{ color: "#555" }}>
            If you discover a security vulnerability in our platform, please report it responsibly to our HIPAA Security Officer (Matt Monacelli) through your assigned GHW agent. We will acknowledge your report within 2 business days and work to address valid security concerns promptly. We do not pursue legal action against security researchers who act in good faith.
          </p>
        </div>

        {/* Footer */}
        <div className="pt-6 border-t text-xs" style={{ color: "#999", borderColor: "#e0e0e0" }}>
          <p>© 2026 Gruening Health & Wealth. All rights reserved.</p>
          <p className="mt-1">
            <Link to="/privacy" className="hover:underline" style={{ color: "#e85d2f" }}>Privacy Policy</Link>
            {" · "}
            <Link to="/login" className="hover:underline" style={{ color: "#e85d2f" }}>Agent Login</Link>
          </p>
        </div>

      </div>
    </div>
  );
}
