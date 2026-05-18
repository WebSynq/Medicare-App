import { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { auth } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function PublicHeader() {
  return (
    <header className="crystal-nav sticky top-0 z-40 border-b border-border/60">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5" data-testid="brand-link">
          <div className="w-9 h-9 rounded-lg bg-primary text-primary-foreground grid place-items-center font-bold tracking-tight" style={{fontFamily:'Outfit'}}>G</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight" style={{fontFamily:'Outfit'}}>Gruening Health &amp; Wealth</div>
            <div className="text-[11px] text-muted-foreground -mt-0.5">Secure Medicare Intake Portal</div>
          </div>
        </Link>
        <nav className="hidden md:flex items-center gap-7 text-sm">
          <Link to="/security" className="text-foreground/80 hover:text-primary transition">Security</Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link to="/login" className="text-sm text-foreground/80 hover:text-primary hidden sm:inline" data-testid="header-agent-login">Agent Login</Link>
          <Button asChild className="rounded-full px-5" data-testid="header-start-intake">
            <Link to="/intake">Start Intake</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function AppHeader() {
  const user = auth.getUser();
  const navigate = useNavigate();
  const role = user?.role;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/dashboard" className="flex items-center gap-2" data-testid="app-brand">
            <div className="w-7 h-7 rounded-md bg-primary text-primary-foreground grid place-items-center text-sm font-bold" style={{fontFamily:'Outfit'}}>G</div>
            <span className="font-semibold tracking-tight text-sm" style={{fontFamily:'Outfit'}}>Gruening · Console</span>
          </Link>
          <nav className="hidden md:flex items-center gap-1 text-sm">
            <Link to="/dashboard" className="px-3 py-1.5 rounded-md hover:bg-secondary" data-testid="nav-dashboard">Leads</Link>
            <Link to="/applications" className="px-3 py-1.5 rounded-md hover:bg-secondary" data-testid="nav-applications">Applications</Link>
            <Link
              to="/commissions"
              className="text-sm font-medium hover:text-[#e85d2f] transition-colors"
            >
              Commissions
            </Link>
            {(role === "admin" || role === "compliance") && (
              <>
                <Link to="/audit" className="px-3 py-1.5 rounded-md hover:bg-secondary" data-testid="nav-audit">Audit Log</Link>
                <Link to="/admin/compliance" className="px-3 py-1.5 rounded-md hover:bg-secondary" data-testid="nav-compliance">Compliance</Link>
                <Link
                  to="/admin/commissions"
                  className="text-sm font-medium hover:text-[#e85d2f] transition-colors"
                >
                  Agent Commissions
                </Link>
              </>
            )}
            {role === "admin" && (
              <Link
                to="/admin/accounting"
                className="text-sm font-medium hover:text-[#e85d2f] transition-colors"
              >
                Accounting
              </Link>
            )}
          </nav>
        </div>
        <div className="hidden md:flex items-center gap-3 text-sm">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <span className="text-muted-foreground hidden md:inline">{user?.email}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground capitalize">{role}</span>
          <Button variant="outline" size="sm" onClick={() => { auth.logout(); navigate("/login"); }} data-testid="logout-btn">
            <Lock className="w-3.5 h-3.5 mr-1.5" /> Sign out
          </Button>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="md:hidden p-2 -mr-2 text-foreground text-2xl leading-none"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          data-testid="mobile-menu-toggle"
        >
          {menuOpen ? "✕" : "☰"}
        </button>
      </div>

      {menuOpen && (
        <div className="md:hidden bg-[#1e2d3d] border-t border-white/10 px-4 py-3 flex flex-col gap-4" data-testid="mobile-menu">
          <Link to="/dashboard" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white py-2">Leads</Link>
          <Link to="/applications" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white py-2">Applications</Link>
          <Link to="/commissions" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white py-2">Commissions</Link>
          {(role === "admin" || role === "compliance") && (
            <>
              <Link to="/audit" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white py-2">Audit Log</Link>
              <Link to="/admin/compliance" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white py-2">Compliance</Link>
              <Link to="/admin/commissions" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white py-2">Agent Commissions</Link>
            </>
          )}
          {role === "admin" && (
            <Link to="/admin/accounting" onClick={() => setMenuOpen(false)} className="text-sm text-white/80 hover:text-white py-2">Accounting</Link>
          )}
          <button
            type="button"
            onClick={() => { auth.logout(); navigate("/login"); setMenuOpen(false); }}
            className="text-sm text-red-400 hover:text-red-300 py-2 text-left"
            data-testid="mobile-logout-btn"
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border mt-20 bg-secondary/40">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-10 grid md:grid-cols-3 gap-8 text-sm">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-md bg-primary text-primary-foreground grid place-items-center font-bold" style={{fontFamily:'Outfit'}}>G</div>
            <span className="font-semibold" style={{fontFamily:'Outfit'}}>Gruening Health &amp; Wealth</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">Independent Medicare advisors helping beneficiaries navigate coverage with clarity, confidence, and care.</p>
        </div>
        <div>
          <h4 className="text-xs uppercase tracking-widest text-muted-foreground mb-3">Security</h4>
          <ul className="space-y-2 text-foreground/80">
            <li className="flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" /> HIPAA-aligned safeguards</li>
            <li className="flex items-center gap-2"><Lock className="w-4 h-4 text-primary" /> 256-bit transport encryption</li>
            <li className="flex items-center gap-2"><Lock className="w-4 h-4 text-primary" /> Encryption at rest (AES)</li>
            <li className="flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" /> TOTP MFA for agents</li>
          </ul>
        </div>
        <div>
          <h4 className="text-xs uppercase tracking-widest text-muted-foreground mb-3">Compliance Notice</h4>
          <p className="text-muted-foreground leading-relaxed text-xs">Not affiliated with or endorsed by the federal Medicare program. We do not offer every plan available in your area. Any information provided is limited to those plans we do offer in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.</p>
        </div>
      </div>
      <div className="border-t border-border/60 py-4 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Gruening Health &amp; Wealth · All rights reserved
      </div>
    </footer>
  );
}
