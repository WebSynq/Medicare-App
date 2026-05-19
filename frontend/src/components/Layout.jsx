import { useState, useEffect } from "react";
import {
  Lock,
  ShieldCheck,
  LayoutDashboard,
  Users2,
  Trophy,
  FileText,
  DollarSign,
  ClipboardList,
  Shield,
  UserCheck,
  Calculator,
  Upload,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { Link, NavLink, useNavigate, useLocation } from "react-router-dom";
import { auth } from "@/lib/api";
import { Button } from "@/components/ui/button";

const SIDEBAR_BG = "#0d1b2a";
const ACCENT = "#e85d2f";

// ── Public landing/login chrome (unchanged) ────────────────────────────────
export function PublicHeader() {
  return (
    <header className="crystal-nav sticky top-0 z-40 border-b border-border/60">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5" data-testid="brand-link">
          <div className="w-9 h-9 rounded-lg bg-primary text-primary-foreground grid place-items-center font-bold tracking-tight" style={{ fontFamily: "Outfit" }}>G</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight" style={{ fontFamily: "Outfit" }}>Gruening Health &amp; Wealth</div>
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

// ── Public footer (unchanged) ──────────────────────────────────────────────
export function Footer() {
  return (
    <footer className="border-t border-border mt-20 bg-secondary/40">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-10 grid md:grid-cols-3 gap-8 text-sm">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-md bg-primary text-primary-foreground grid place-items-center font-bold" style={{ fontFamily: "Outfit" }}>G</div>
            <span className="font-semibold" style={{ fontFamily: "Outfit" }}>Gruening Health &amp; Wealth</span>
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

// Backward-compat shim: pages still importing AppHeader render nothing.
// AppLayout now owns the authenticated chrome.
export function AppHeader() {
  return null;
}

// ── Internal helpers ───────────────────────────────────────────────────────
function initials(user) {
  const src = (user?.full_name || user?.email || "?").trim();
  const parts = src.split(/\s+|@/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function NavItem({ to, icon: Icon, label, onClick, testId }) {
  return (
    <NavLink
      to={to}
      end={to === "/dashboard"}
      onClick={onClick}
      data-testid={testId}
      className={({ isActive }) =>
        [
          "group flex items-center gap-3 px-3 py-2 text-sm rounded-md border-l-2 transition-colors",
          isActive
            ? "border-[#e85d2f] bg-[#e85d2f]/10 text-white"
            : "border-transparent text-white/55 hover:text-white hover:bg-white/5",
        ].join(" ")
      }
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="px-3 mt-5 mb-2 text-[10px] font-semibold tracking-[0.12em] text-white/40 uppercase">
      {children}
    </div>
  );
}

function SidebarContent({ user, role, onNavigate, onSignOut }) {
  const isAdmin = role === "admin";
  const isAdminOrCompliance = role === "admin" || role === "compliance";
  const displayName = user?.full_name || user?.email || "Agent";
  return (
    <div className="flex flex-col h-full text-white" style={{ background: SIDEBAR_BG }}>
      {/* Logo */}
      <div className="px-4 pt-5 pb-4 border-b border-white/5">
        <Link to="/dashboard" onClick={onNavigate} className="flex items-center gap-2.5" data-testid="sidebar-brand">
          <div
            className="w-9 h-9 rounded-lg grid place-items-center text-base font-bold text-white"
            style={{
              background: `linear-gradient(135deg, ${ACCENT} 0%, #c84416 100%)`,
              fontFamily: "Outfit",
            }}
          >
            G
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight" style={{ fontFamily: "Outfit" }}>
              Gruening H&amp;W
            </div>
            <div className="text-[11px] text-white/45 -mt-0.5">Agent Console</div>
          </div>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <SectionLabel>Main</SectionLabel>
        <div className="space-y-0.5">
          <NavItem to="/dashboard" icon={LayoutDashboard} label="Dashboard" onClick={onNavigate} testId="nav-dashboard" />
          <NavItem to="/clients" icon={Users2} label="Clients" onClick={onNavigate} testId="nav-clients" />
          <NavItem to="/leaderboard" icon={Trophy} label="Leaderboard" onClick={onNavigate} testId="nav-leaderboard" />
          <NavItem to="/applications" icon={FileText} label="Applications" onClick={onNavigate} testId="nav-applications" />
          <NavItem to="/commissions" icon={DollarSign} label="Commissions" onClick={onNavigate} testId="nav-commissions" />
        </div>

        {isAdminOrCompliance && (
          <>
            <SectionLabel>Admin</SectionLabel>
            <div className="space-y-0.5">
              <NavItem to="/audit" icon={ClipboardList} label="Audit Log" onClick={onNavigate} testId="nav-audit" />
              <NavItem to="/admin/compliance" icon={Shield} label="Compliance" onClick={onNavigate} testId="nav-compliance" />
              <NavItem to="/admin/commissions" icon={UserCheck} label="Agent Commissions" onClick={onNavigate} testId="nav-admin-commissions" />
              {isAdmin && (
                <NavItem to="/admin/accounting" icon={Calculator} label="Accounting" onClick={onNavigate} testId="nav-accounting" />
              )}
              {isAdmin && (
                <NavItem to="/admin/import" icon={Upload} label="Data Import" onClick={onNavigate} testId="nav-data-import" />
              )}
            </div>
          </>
        )}
      </nav>

      {/* HIPAA + user */}
      <div className="px-3 pb-4">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-300 mb-3">
          <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">HIPAA-aligned · AWS Bedrock</span>
        </div>

        <div className="flex items-center gap-2.5 px-2 py-2 rounded-md bg-white/5">
          <div
            className="w-8 h-8 rounded-full grid place-items-center text-xs font-bold text-white flex-shrink-0"
            style={{ background: `linear-gradient(135deg, ${ACCENT} 0%, #c84416 100%)` }}
            aria-hidden="true"
          >
            {initials(user)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-white truncate" data-testid="sidebar-user-name">
              {displayName}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-white/45 truncate">
              {role || "agent"}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onSignOut}
          className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 text-xs text-white/65 hover:text-white hover:bg-white/5 rounded-md transition-colors"
          data-testid="logout-btn"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </button>
      </div>
    </div>
  );
}

// ── AppLayout ──────────────────────────────────────────────────────────────
// Fixed 220px sidebar on the left, scrollable main content on the right.
// On <md screens the sidebar is hidden by default and opens as an overlay.
export function AppLayout({ children }) {
  const user = auth.getUser();
  const role = user?.role;
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  function handleSignOut() {
    auth.logout();
    navigate("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex fixed inset-y-0 left-0 w-[220px] z-40 border-r border-white/5"
        data-testid="app-sidebar"
      >
        <SidebarContent
          user={user}
          role={role}
          onNavigate={() => {}}
          onSignOut={handleSignOut}
        />
      </aside>

      {/* Mobile top bar */}
      <header
        className="md:hidden sticky top-0 z-30 flex items-center justify-between h-12 px-3 border-b border-border bg-surface/90 backdrop-blur-md"
        data-testid="mobile-topbar"
      >
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="p-2 -ml-2 text-foreground"
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          data-testid="mobile-menu-toggle"
        >
          <Menu className="w-5 h-5" />
        </button>
        <Link to="/dashboard" className="flex items-center gap-2" data-testid="mobile-brand">
          <div
            className="w-6 h-6 rounded-md grid place-items-center text-[11px] font-bold text-white"
            style={{
              background: `linear-gradient(135deg, ${ACCENT} 0%, #c84416 100%)`,
              fontFamily: "Outfit",
            }}
          >
            G
          </div>
          <span className="text-sm font-semibold tracking-tight" style={{ fontFamily: "Outfit" }}>
            Gruening H&amp;W
          </span>
        </Link>
        <div className="w-9" aria-hidden="true" />
      </header>

      {/* Mobile drawer + backdrop */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50" data-testid="mobile-menu">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-[260px] max-w-[80vw] shadow-xl">
            <div className="flex justify-end absolute top-2 right-2 z-10">
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="p-2 text-white/70 hover:text-white"
                aria-label="Close menu"
                data-testid="mobile-menu-close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <SidebarContent
              user={user}
              role={role}
              onNavigate={() => setMobileOpen(false)}
              onSignOut={() => {
                setMobileOpen(false);
                handleSignOut();
              }}
            />
          </aside>
        </div>
      )}

      {/* Main content */}
      <main className="md:pl-[220px] min-h-screen">{children}</main>
    </div>
  );
}
