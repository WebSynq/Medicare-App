import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users2,
  Trophy,
  Cake,
  CalendarClock,
  FileText,
  DollarSign,
  Users,
  Building2,
  Calculator,
  UserCheck,
  Upload,
  Settings as SettingsIcon,
  ShieldCheck,
  LogOut,
  ClipboardList,
  Plus,
  Activity,
  CircleHelp,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { auth } from "@/lib/api";

// ──────────────────────────────────────────────────────────────────────────
// CommandPalette — global ⌘K / Ctrl+K launcher.
//
// Why a single component (vs. per-page menus):
//   • A consistent "jump-to" surface across the whole console saves
//     agents from learning per-page menus.
//   • Quick actions ("Quick add lead", "Sign out") deduplicate UI that
//     currently lives in multiple corners of the chrome.
//
// Role gating mirrors the sidebar: items hidden from the sidebar are
// hidden here too. We don't refetch role on every open — the user object
// is already in localStorage via auth helpers.
// ──────────────────────────────────────────────────────────────────────────

const COMPLIANCE_LIKE_ROLES = new Set([
  "compliance",
  "cyber_security",
  "sales_manager",
]);

export default function CommandPalette({ onQuickAddLead }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const user = auth.getUser();
  const role = user?.role;
  const isAdmin = role === "admin";
  const isAdminOrCompliance = isAdmin || COMPLIANCE_LIKE_ROLES.has(role);

  // ── Keyboard binding ────────────────────────────────────────────────────
  // ⌘K (mac) / Ctrl+K (win/linux) toggles the palette. We listen on
  // window so it works regardless of focus context.
  useEffect(() => {
    const handler = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const go = useCallback(
    (path) => {
      setOpen(false);
      // Small defer so the dialog close animation doesn't race the route
      // change (helps avoid focus-trap flicker on slower devices).
      setTimeout(() => navigate(path), 30);
    },
    [navigate],
  );

  const handleQuickAdd = () => {
    setOpen(false);
    if (onQuickAddLead) {
      setTimeout(onQuickAddLead, 60);
    } else {
      // Fallback: clients page (will hit Quick Add CTA there).
      setTimeout(() => navigate("/clients"), 30);
    }
  };

  const handleSignOut = () => {
    setOpen(false);
    setTimeout(() => {
      auth.logout();
      navigate("/login");
    }, 30);
  };

  if (!user) return null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Quick navigation"
      description="Search pages, jump to records, or run common actions."
    >
      <CommandInput placeholder="Search pages, actions…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Quick actions">
          <CommandItem onSelect={handleQuickAdd} value="quick add lead new client">
            <Plus className="mr-2 h-4 w-4" />
            <span>Quick add lead</span>
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/settings")} value="settings preferences profile mfa">
            <SettingsIcon className="mr-2 h-4 w-4" />
            <span>Open settings</span>
          </CommandItem>
          <CommandItem onSelect={handleSignOut} value="sign out logout">
            <LogOut className="mr-2 h-4 w-4" />
            <span>Sign out</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Main">
          <CommandItem onSelect={() => go("/dashboard")} value="dashboard home overview">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            <span>Dashboard</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/clients")} value="clients leads beneficiaries">
            <Users2 className="mr-2 h-4 w-4" />
            <span>Clients</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/leaderboard")} value="leaderboard rankings top agents">
            <Trophy className="mr-2 h-4 w-4" />
            <span>Leaderboard</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/birthday-rule")} value="birthday rule reminders">
            <Cake className="mr-2 h-4 w-4" />
            <span>Birthday Rule</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/renewals")} value="renewals expiring policies">
            <CalendarClock className="mr-2 h-4 w-4" />
            <span>Renewals</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/applications")} value="applications enrollment forms">
            <FileText className="mr-2 h-4 w-4" />
            <span>Applications</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/commissions")} value="commissions payouts statements">
            <DollarSign className="mr-2 h-4 w-4" />
            <span>Commissions</span>
          </CommandItem>
        </CommandGroup>

        {isAdminOrCompliance && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Admin">
              {isAdmin && (
                <CommandItem onSelect={() => go("/agency")} value="agency hierarchy organization">
                  <Building2 className="mr-2 h-4 w-4" />
                  <span>Agency</span>
                </CommandItem>
              )}
              <CommandItem onSelect={() => go("/admin/commissions")} value="agent commissions admin">
                <UserCheck className="mr-2 h-4 w-4" />
                <span>Agent Commissions</span>
              </CommandItem>
              {isAdmin && (
                <CommandItem onSelect={() => go("/admin/accounting")} value="accounting books finance">
                  <Calculator className="mr-2 h-4 w-4" />
                  <span>Accounting</span>
                </CommandItem>
              )}
              <CommandItem onSelect={() => go("/agents")} value="team agents users members">
                <Users className="mr-2 h-4 w-4" />
                <span>Team</span>
              </CommandItem>
              {isAdmin && (
                <CommandItem onSelect={() => go("/admin/import")} value="data import csv upload">
                  <Upload className="mr-2 h-4 w-4" />
                  <span>Data Import</span>
                </CommandItem>
              )}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />

        <CommandGroup heading="Compliance">
          <CommandItem onSelect={() => go("/settings?tab=audit")} value="audit log compliance">
            <Activity className="mr-2 h-4 w-4" />
            <span>Audit log</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/settings?tab=security")} value="security mfa totp">
            <ShieldCheck className="mr-2 h-4 w-4" />
            <span>Security &amp; MFA</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/security")} value="public security page">
            <CircleHelp className="mr-2 h-4 w-4" />
            <span>Public security page</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
