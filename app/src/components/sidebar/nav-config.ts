/**
 * Sidebar nav configuration — single source of truth for the
 * left-rail link tree. Each entry carries a role gate; the
 * sidebar component filters by the current user's role on
 * render.
 */

import {
  BarChart3,
  Building2,
  CalendarDays,
  Clock,
  Crown,
  DollarSign,
  FileText,
  Kanban,
  LayoutDashboard,
  Settings,
  Shield,
  Terminal,
  Trophy,
  Users,
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

export const NAV: readonly NavSection[] = [
  {
    title: "Main",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Clients", href: "/clients", icon: Users },
      { label: "Pipeline", href: "/pipeline", icon: Kanban },
      { label: "Appointments", href: "/appointments", icon: Clock },
      { label: "Calendar", href: "/calendar", icon: CalendarDays },
    ],
  },
  {
    title: "Revenue",
    items: [
      { label: "Commissions", href: "/commissions", icon: DollarSign },
      { label: "Leaderboard", href: "/leaderboard", icon: Trophy },
      { label: "Applications", href: "/applications", icon: FileText },
    ],
  },
  {
    title: "Admin",
    items: [
      {
        label: "Agency",
        href: "/agency",
        icon: Building2,
        roles: ADMIN_ROLES,
      },
      {
        // No /reports landing page exists yet — the only built reports
        // route is /reports/lead-sources, so the link targets that.
        // Re-target once a reports index lands.
        label: "Reports",
        href: "/reports/lead-sources",
        icon: BarChart3,
        roles: ADMIN_ROLES,
      },
      {
        label: "Audit Log",
        href: "/audit",
        icon: Shield,
        roles: ADMIN_ROLES,
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        label: "Ops Console",
        href: "/ops",
        icon: Terminal,
        roles: ADMIN_ROLES,
      },
      // Settings stays ungated — every agent manages their own
      // profile / password / MFA / calendar / booking page from
      // here. The "System (admin/owner only)" section header in
      // the design spec referred to Ops Console; gating Settings
      // would lock regular agents out of their own account.
      { label: "Settings", href: "/settings", icon: Settings },
    ],
  },
  {
    title: "Super Admin",
    items: [
      {
        label: "Super Admin",
        href: "/super-admin",
        icon: Crown,
        superAdminOnly: true,
      },
    ],
  },
];

/** Bottom-anchored items. Empty now that Settings lives in the
 *  System section — kept exported so the sidebar component's
 *  render path stays stable. */
export const NAV_FOOTER: readonly NavItem[] = [];
