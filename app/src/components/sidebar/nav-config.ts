/**
 * Sidebar nav configuration — single source of truth for the
 * left-rail link tree. Each entry carries a role gate; the
 * sidebar component filters by the current user's role on
 * render.
 */

import {
  BarChart3,
  Briefcase,
  Building2,
  Cake,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Database,
  DollarSign,
  FileText,
  GitBranch,
  HardHat,
  LayoutDashboard,
  Receipt,
  RefreshCw,
  Settings,
  ShieldAlert,
  Sparkles,
  Trophy,
  UsersRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import type { UserRole } from "@/types";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Role gate. Omit (or empty) = visible to every authenticated
   *  user. Listed roles + super_admin (computed separately) see
   *  the item. */
  roles?: readonly UserRole[];
  /** Reserved for the super-admin nav row — shown to platform
   *  admins only (User.super_admin === true), regardless of role. */
  superAdminOnly?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

const ADMIN_ROLES: readonly UserRole[] = ["admin", "owner"];
const LEADERSHIP_ROLES: readonly UserRole[] = [
  "admin",
  "owner",
  "compliance",
  "coach",
  "accounting",
];

export const NAV: readonly NavSection[] = [
  {
    title: "Action",
    items: [
      { label: "Today", href: "/today", icon: Sparkles },
      { label: "Pipeline", href: "/pipeline", icon: GitBranch },
      { label: "Clients", href: "/clients", icon: UsersRound },
      { label: "Calendar", href: "/calendar", icon: CalendarDays },
      { label: "Appointments", href: "/appointments", icon: CalendarClock },
      { label: "Applications", href: "/applications", icon: ClipboardList },
    ],
  },
  {
    title: "Reports",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Lead Sources", href: "/reports/lead-sources", icon: BarChart3 },
      { label: "Leaderboard", href: "/leaderboard", icon: Trophy },
      { label: "Birthday Rule", href: "/birthday-rule", icon: Cake },
      { label: "Renewals", href: "/renewals", icon: RefreshCw },
    ],
  },
  {
    title: "Money",
    items: [
      { label: "Commissions", href: "/commissions", icon: Wallet },
      {
        label: "Admin Commissions",
        href: "/admin/commissions",
        icon: DollarSign,
        roles: LEADERSHIP_ROLES,
      },
      {
        label: "Accounting",
        href: "/admin/accounting",
        icon: Receipt,
        roles: LEADERSHIP_ROLES,
      },
    ],
  },
  {
    title: "Agency",
    items: [
      {
        label: "Agency Dashboard",
        href: "/agency-dashboard",
        icon: Building2,
        roles: LEADERSHIP_ROLES,
      },
      {
        label: "Agency",
        href: "/agency",
        icon: Briefcase,
        roles: ADMIN_ROLES,
      },
      {
        label: "Agents",
        href: "/agents",
        icon: UsersRound,
        roles: LEADERSHIP_ROLES,
      },
      {
        label: "Data Import",
        href: "/admin/import",
        icon: Database,
        roles: ADMIN_ROLES,
      },
      {
        label: "Audit Log",
        href: "/audit",
        icon: FileText,
        roles: LEADERSHIP_ROLES,
      },
      {
        label: "Ops Console",
        href: "/ops",
        icon: HardHat,
        roles: ADMIN_ROLES,
      },
      {
        label: "Super Admin",
        href: "/super-admin",
        icon: ShieldAlert,
        superAdminOnly: true,
      },
    ],
  },
];

/** Bottom-anchored items (Settings, etc.) — sit below the
 *  vertically-stacked sections in the sidebar. */
export const NAV_FOOTER: readonly NavItem[] = [
  { label: "Settings", href: "/settings", icon: Settings },
];
