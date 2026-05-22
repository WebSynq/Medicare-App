import { useState, useEffect, useMemo } from "react";
import {
  Lock,
  ShieldCheck,
  LayoutDashboard,
  Building2,
  Cake,
  CalendarClock,
  Users,
  Users2,
  Trophy,
  FileText,
  DollarSign,
  ClipboardList,
  Shield,
  UserCheck,
  Calculator,
  Upload,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  X,
  Eye,
  ChevronDown,
  UsersRound,
  Activity,
  PanelLeftClose,
  PanelLeftOpen,
  Search as SearchIcon,
  Command as CommandIcon,
} from "lucide-react";
import { Link, NavLink, useNavigate, useLocation } from "react-router-dom";
import { api, auth } from "@/lib/api";
import { useAgent } from "@/context/AgentContext";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import ChatWidget from "@/components/ChatWidget";
import CommandPalette from "@/components/CommandPalette";

// Width tokens for the two sidebar states. Pulled to the top so the
// fixed sidebar, the main content padding, and the layout reserve stay
// in lockstep — never hard-code these numbers below.
const SIDEBAR_W_EXPANDED = 220;
const SIDEBAR_W_COLLAPSED = 64;
const SIDEBAR_PREF_KEY = "ghw.sidebar.collapsed";

const SIDEBAR_BG = "#0d1b2a";
const ACCENT = "#e85d2f";

// ── Public landing/login chrome (unchanged) ────────────────────────────────
export function PublicHeader() {
  return (
    <header className="crystal-nav sticky top-0 z-40 border-b border-border/60">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5" data-testid="brand-link">
          <div className="w-9 h-9 rounded-xl bg-primary text-primary-foreground grid place-items-center font-bold tracking-tight elev-1" style={{ fontFamily: "Outfit" }}>G</div>
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
          <Button asChild className="btn-press rounded-full px-5 elev-1" data-testid="header-start-intake">
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

function NavItem({ to, icon: Icon, label, onClick, testId, collapsed }) {
  // When the sidebar is collapsed we hide the text label and replace it
  // with a hover tooltip — keeps the icon row scannable while preserving
  // the navigation affordance for new users who don't yet recognise the
  // icons by sight.
  const link = (
    <NavLink
      to={to}
      end={to === "/dashboard"}
      onClick={onClick}
      data-testid={testId}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        [
          "group flex items-center gap-3 text-sm rounded-md border-l-2 transition-colors",
          collapsed ? "px-2.5 py-2 justify-center" : "px-3 py-2",
          isActive
            ? "border-[#e85d2f] bg-[#e85d2f]/10 text-white"
            : "border-transparent text-white/55 hover:text-white hover:bg-white/5",
        ].join(" ")
      }
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );

  if (!collapsed) return link;
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function SectionLabel({ children, collapsed }) {
  if (collapsed) {
    // Stand-in for the section heading when icons-only — a thin divider
    // keeps the visual rhythm without needing the text label.
    return <div className="mx-3 mt-4 mb-2 h-px bg-white/10" aria-hidden="true" />;
  }
  return (
    <div className="px-3 mt-5 mb-2 text-[10px] font-semibold tracking-[0.12em] text-white/40 uppercase">
      {children}
    </div>
  );
}

// ── Agent switcher (admin/compliance only) ────────────────────────────────
// Lives above the main nav. Two states:
//   - Not impersonating → compact dropdown ("All Agents" + list).
//   - Impersonating     → orange banner showing the target with an X to clear.
// Agents (role !== admin/compliance) never see this control. We also guard
// against the agent list being unreadable (403/network) by simply not
// rendering — the rest of the sidebar still works.
function AgentSwitcher({ role, onNavigate }) {
  const navigate = useNavigate();
  const { selectedAgent, setSelectedAgent, clearAgent, isImpersonating } = useAgent();
  const [agents, setAgents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  // Same role profile as the admin-area sidebar: anything in the
  // compliance bucket plus admin proper can impersonate.
  const canSee =
    role === "admin" ||
    role === "compliance" ||
    role === "cyber_security" ||
    role === "sales_manager";

  useEffect(() => {
    if (!canSee) return;
    let alive = true;
    (async () => {
      try {
        const res = await api.get("/agents");
        if (!alive) return;
        // Show every active team member — admin can "view as" anyone,
        // including other admins, not just agents.
        const list = (res?.data?.agents || []).filter(
          (a) => a.is_active !== false,
        );
        setAgents(list);
      } catch {
        // Silent — the switcher just stays empty. Errors here shouldn't
        // block the rest of the chrome from rendering.
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [canSee]);

  // Role-aware sort: admins first, then everyone else; alphabetical
  // within each group. Keeps the "view as" workflow predictable as
  // the team grows past a few rows.
  const sortedAgents = useMemo(() => {
    const roleWeight = (r) => (r === "admin" ? 0 : 1);
    return [...agents].sort((a, b) => {
      const rw = roleWeight(a.role) - roleWeight(b.role);
      if (rw !== 0) return rw;
      const an = (a.full_name || a.email || "").toLowerCase();
      const bn = (b.full_name || b.email || "").toLowerCase();
      return an.localeCompare(bn);
    });
  }, [agents]);

  const roleLabel = (r) => {
    if (!r) return "";
    const m = {
      admin: "Admin",
      agent: "Agent",
      compliance: "Compliance",
      sales_manager: "Sales Manager",
      cyber_security: "Cyber Security",
      va: "Virtual Assistant",
      support: "Customer Support",
      crm_specialist: "CRM Specialist",
      onboarding: "Onboarding",
    };
    return m[r] || r.replace(/_/g, " ");
  };

  if (!canSee) return null;

  function handlePick(agent) {
    setSelectedAgent(agent);
    setOpen(false);
    if (onNavigate) onNavigate();
    navigate("/dashboard");
  }

  function handleClear() {
    clearAgent();
    if (onNavigate) onNavigate();
    navigate("/dashboard");
  }

  if (isImpersonating && selectedAgent) {
    const name =
      selectedAgent.full_name ||
      selectedAgent.agent_name ||
      selectedAgent.email ||
      "Agent";
    return (
      <div className="px-3 pt-3 pb-2" data-testid="agent-switcher-banner">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium"
          style={{
            background: "rgba(232, 93, 47, 0.15)",
            border: "1px solid rgba(232, 93, 47, 0.45)",
            color: "#ffb997",
          }}
        >
          <Eye className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate flex-1" title={name}>
            {name}
          </span>
          <button
            type="button"
            onClick={handleClear}
            className="p-0.5 -mr-1 rounded hover:bg-white/10 text-white/80 hover:text-white"
            aria-label="Stop viewing as agent"
            data-testid="agent-switcher-clear"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 pt-3 pb-1 relative" data-testid="agent-switcher">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-xs text-white/70 hover:text-white bg-white/5 hover:bg-white/10 transition-colors"
        data-testid="agent-switcher-toggle"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 truncate">
          <UsersRound className="w-3.5 h-3.5 flex-shrink-0 text-white/70" aria-hidden="true" />
          <span className="truncate">All Agents</span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div
          className="absolute left-3 right-3 mt-1 max-h-72 overflow-y-auto rounded-md shadow-lg z-50 py-1 text-xs"
          style={{
            background: "#152234",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
          role="listbox"
        >
          {!loaded && (
            <div className="px-3 py-2 text-white/50">Loading…</div>
          )}
          {loaded && sortedAgents.length === 0 && (
            <div className="px-3 py-2 text-white/50">No agents</div>
          )}
          {sortedAgents.map((a) => (
            <button
              type="button"
              key={a.id}
              onClick={() => handlePick(a)}
              className="w-full text-left px-3 py-2 text-white/80 hover:text-white hover:bg-white/5 truncate"
              data-testid={`agent-switcher-pick-${a.id}`}
            >
              {a.full_name || a.email}
              {a.role && (
                <span className="ml-1 text-white/45">
                  ({roleLabel(a.role)})
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Role nav profiles. Extending the user roles without remapping nav would
// leave new team members staring at an empty sidebar — these groups give
// each role a sensible default surface area:
//   - admin               → everything (admin)
//   - compliance buckets  → see admin tools (audit, compliance panel) but
//     not destructive admin-only routes (accounting, data import).
//     Includes: compliance, cyber_security, sales_manager.
//   - agent buckets       → standard producer nav.
//     Includes: agent, va, support, crm_specialist, onboarding.
const COMPLIANCE_LIKE_ROLES = new Set([
  "compliance",
  "cyber_security",
  "sales_manager",
]);

function SidebarContent({ user, role, onNavigate, onSignOut, collapsed, onToggleCollapse, onOpenSearch, isMobile }) {
  const isAdmin = role === "admin";
  const isAdminOrCompliance =
    role === "admin" || COMPLIANCE_LIKE_ROLES.has(role);
  const displayName = user?.full_name || user?.email || "Agent";
  // Mobile drawer is always full-width — collapsed mode only applies to
  // the persistent desktop sidebar.
  const c = !!collapsed && !isMobile;
  return (
    <TooltipProvider delayDuration={120}>
    <div className="flex flex-col h-full text-white" style={{ background: SIDEBAR_BG }}>
      {/* Logo / brand */}
      <div className={`pt-5 pb-4 border-b border-white/5 ${c ? "px-2" : "px-4"}`}>
        <div className="flex items-center justify-between gap-2">
          <Link
            to="/dashboard"
            onClick={onNavigate}
            className={`flex items-center gap-2.5 min-w-0 ${c ? "justify-center w-full" : ""}`}
            data-testid="sidebar-brand"
          >
            <div
              className="w-9 h-9 rounded-xl grid place-items-center text-base font-bold text-white elev-2 flex-shrink-0"
              style={{
                background: `linear-gradient(135deg, ${ACCENT} 0%, #c84416 100%)`,
                fontFamily: "Outfit",
              }}
            >
              G
            </div>
            {!c && (
              <div className="leading-tight min-w-0">
                <div className="text-sm font-semibold tracking-tight truncate" style={{ fontFamily: "Outfit" }}>
                  Gruening H&amp;W
                </div>
                <div className="text-[11px] text-white/45 -mt-0.5">Agent Console</div>
              </div>
            )}
          </Link>
          {!isMobile && !c && onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
              className="p-1.5 -mr-1 text-white/55 hover:text-white hover:bg-white/5 rounded-md transition-colors"
              data-testid="sidebar-collapse"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>
        {!isMobile && c && onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Expand sidebar"
            className="mt-3 w-full grid place-items-center py-1.5 text-white/55 hover:text-white hover:bg-white/5 rounded-md transition-colors"
            data-testid="sidebar-expand"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ⌘K search trigger — opens the global Command Palette. Always
          visible at the top of the nav so it's the first thing agents see
          after the brand mark. */}
      {onOpenSearch && (
        <div className={c ? "px-2 pt-3 pb-1" : "px-3 pt-3 pb-1"}>
          {c ? (
            <Tooltip delayDuration={120}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenSearch}
                  aria-label="Open quick search (Cmd+K)"
                  className="w-full grid place-items-center py-2 rounded-md bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-colors"
                  data-testid="sidebar-search-collapsed"
                >
                  <SearchIcon className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                Quick search · ⌘K
              </TooltipContent>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={onOpenSearch}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-white/5 hover:bg-white/10 text-xs text-white/65 hover:text-white transition-colors"
              data-testid="sidebar-search"
            >
              <SearchIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="flex-1 text-left">Quick search…</span>
              <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-white/70 font-mono">
                <CommandIcon className="w-2.5 h-2.5" />K
              </kbd>
            </button>
          )}
        </div>
      )}

      {/* Admin-only "view as agent" switcher — hidden when collapsed
          (would need a dedicated icon-only popover; deferred to keep
          Phase 2 tight). */}
      {!c && <AgentSwitcher role={role} onNavigate={onNavigate} />}

      {/* Nav */}
      <nav className={`flex-1 overflow-y-auto py-3 ${c ? "px-2" : "px-2"}`}>
        <SectionLabel collapsed={c}>Main</SectionLabel>
        <div className="space-y-0.5">
          <NavItem to="/dashboard" icon={LayoutDashboard} label="Dashboard" onClick={onNavigate} testId="nav-dashboard" collapsed={c} />
          <NavItem to="/clients" icon={Users2} label="Clients" onClick={onNavigate} testId="nav-clients" collapsed={c} />
          <NavItem to="/leaderboard" icon={Trophy} label="Leaderboard" onClick={onNavigate} testId="nav-leaderboard" collapsed={c} />
          <NavItem to="/birthday-rule" icon={Cake} label="Birthday Rule" onClick={onNavigate} testId="nav-birthday-rule" collapsed={c} />
          <NavItem to="/renewals" icon={CalendarClock} label="Renewals" onClick={onNavigate} testId="nav-renewals" collapsed={c} />
          <NavItem to="/applications" icon={FileText} label="Applications" onClick={onNavigate} testId="nav-applications" collapsed={c} />
          <NavItem to="/commissions" icon={DollarSign} label="Commissions" onClick={onNavigate} testId="nav-commissions" collapsed={c} />
        </div>

        {isAdminOrCompliance && (
          <>
            <SectionLabel collapsed={c}>Admin</SectionLabel>
            <div className="space-y-0.5">
              {isAdmin && (
                <NavItem to="/agency" icon={Building2} label="Agency" onClick={onNavigate} testId="nav-agency" collapsed={c} />
              )}
              <NavItem to="/admin/commissions" icon={UserCheck} label="Agent Commissions" onClick={onNavigate} testId="nav-admin-commissions" collapsed={c} />
              {isAdmin && (
                <NavItem to="/admin/accounting" icon={Calculator} label="Accounting" onClick={onNavigate} testId="nav-accounting" collapsed={c} />
              )}
              <NavItem to="/agents" icon={Users} label="Team" onClick={onNavigate} testId="nav-agents" collapsed={c} />
              {isAdmin && (
                <NavItem to="/admin/import" icon={Upload} label="Data Import" onClick={onNavigate} testId="nav-data-import" collapsed={c} />
              )}
            </div>
          </>
        )}

        <div className="space-y-0.5 mt-5">
          <NavItem to="/settings" icon={SettingsIcon} label="Settings" onClick={onNavigate} testId="nav-settings" collapsed={c} />
        </div>
      </nav>

      {/* Audit pulse + user card */}
      <div className={c ? "px-2 pb-4" : "px-3 pb-4"}>
        {c ? (
          <Tooltip delayDuration={120}>
            <TooltipTrigger asChild>
              <div
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/20 mb-3"
                aria-label="Audit log live — HIPAA aligned"
              >
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Audit log · live · HIPAA-aligned
            </TooltipContent>
          </Tooltip>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-300 mb-3">
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            <span className="truncate">Audit log · live · HIPAA-aligned</span>
          </div>
        )}

        {c ? (
          <Tooltip delayDuration={120}>
            <TooltipTrigger asChild>
              <div
                className="grid place-items-center py-2 rounded-md bg-white/5"
                aria-label={`${displayName} (${role || "agent"})`}
              >
                <div
                  className="w-8 h-8 rounded-full grid place-items-center text-xs font-bold text-white"
                  style={{ background: `linear-gradient(135deg, ${ACCENT} 0%, #c84416 100%)` }}
                  aria-hidden="true"
                >
                  {initials(user)}
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              <div className="text-xs font-medium">{displayName}</div>
              <div className="text-[10px] uppercase tracking-wider text-white/60">{role || "agent"}</div>
            </TooltipContent>
          </Tooltip>
        ) : (
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
        )}

        {c ? (
          <Tooltip delayDuration={120}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onSignOut}
                aria-label="Sign out"
                className="mt-2 w-full grid place-items-center py-2 text-white/65 hover:text-white hover:bg-white/5 rounded-md transition-colors"
                data-testid="logout-btn"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Sign out
            </TooltipContent>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={onSignOut}
            className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 text-xs text-white/65 hover:text-white hover:bg-white/5 rounded-md transition-colors"
            data-testid="logout-btn"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        )}
      </div>
    </div>
    </TooltipProvider>
  );
}

// ── AppLayout ──────────────────────────────────────────────────────────────
// Fixed sidebar on the left (collapsible 64px ↔ 220px on desktop),
// scrollable main content on the right. On <md screens the sidebar is
// hidden by default and opens as an overlay (always full-width inside
// the drawer regardless of the desktop collapse preference).
export function AppLayout({ children }) {
  const user = auth.getUser();
  const role = user?.role;
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Persisted desktop sidebar collapse preference. Read synchronously
  // from localStorage on first render so we don't get a layout-shift
  // flash when navigating into the authenticated shell.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_PREF_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Imperative bridge so child components (sidebar search button,
  // ⌘K keypress inside CommandPalette) and any future page-level
  // "Open palette" CTA can open the palette without prop drilling.
  const [paletteSignal, setPaletteSignal] = useState(0);
  const openPalette = () => {
    // Synthesize the same keystroke the CommandPalette already listens
    // for. Avoids exposing an internal API.
    const evt = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    window.dispatchEvent(evt);
    setPaletteSignal((n) => n + 1);
  };

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_PREF_KEY, next ? "1" : "0");
      } catch {
        // Storage unavailable (private mode, quota) — preference simply
        // resets next visit. Not worth surfacing.
      }
      return next;
    });
  };

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  function handleSignOut() {
    auth.logout();
    navigate("/login");
  }

  const sidebarWidth = collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W_EXPANDED;

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex fixed inset-y-0 left-0 z-40 border-r border-white/5 transition-[width] duration-200 ease-out"
        style={{ width: sidebarWidth }}
        data-testid="app-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <SidebarContent
          user={user}
          role={role}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
          onOpenSearch={openPalette}
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
        <button
          type="button"
          onClick={openPalette}
          aria-label="Open quick search"
          className="p-2 -mr-2 text-foreground"
          data-testid="mobile-search-toggle"
        >
          <SearchIcon className="w-5 h-5" />
        </button>
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
              isMobile
              onNavigate={() => setMobileOpen(false)}
              onOpenSearch={() => {
                setMobileOpen(false);
                openPalette();
              }}
              onSignOut={() => {
                setMobileOpen(false);
                handleSignOut();
              }}
            />
          </aside>
        </div>
      )}

      {/* Main content — left padding mirrors the (animated) sidebar
          width so content reflows smoothly when collapsing/expanding.
          Both class strings are written literally below so Tailwind JIT
          can detect and compile them. */}
      <main
        className={`min-h-screen transition-[padding] duration-200 ease-out ${
          collapsed ? "md:pl-[64px]" : "md:pl-[220px]"
        }`}
      >
        {children}
      </main>

      {/* Global keyboard-driven launcher. Single instance lives in the
          chrome so every authenticated page gets it for free. */}
      <CommandPalette key={paletteSignal} />

      {/* Floating AI assistant — rendered outside main so it stays put
          regardless of page-level scroll containers. */}
      <ChatWidget />
    </div>
  );
}
