/**
 * Sidebar nav configuration — single source of truth for the
 * left-rail link tree. With the GHL-style refactor every section's
 * sub-pages render in a top tab bar inside that section's layout.tsx;
 * the sidebar now only carries top-level section entries.
 */

import {
  Building2,
  BarChart3,
  CalendarClock,
  DollarSign,
  FileText,
  LayoutDashboard,
  Settings,
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
    title: "Workspace",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { label: "Clients", href: "/clients", icon: Users },
      { label: "Appointments", href: "/appointments", icon: CalendarClock },
      { label: "Applications", href: "/applications", icon: FileText },
      { label: "Commissions", href: "/commissions", icon: DollarSign },
      { label: "Reports", href: "/reports", icon: BarChart3 },
      { label: "Settings", href: "/settings", icon: Settings },
    ],
  },
  {
    title: "Admin",
    items: [
      // Admin section gate handled in the /admin layout — leaders see
      // Agency Overview / Audit / Ops, super admins also see the
      // platform tab. Whole section vanishes for regular agents.
      {
        label: "Admin",
        href: "/admin",
        icon: Building2,
        roles: ADMIN_ROLES,
      },
    ],
  },
];

/** Bottom-anchored items. Empty — every nav row lives in NAV. */
export const NAV_FOOTER: readonly NavItem[] = [];
