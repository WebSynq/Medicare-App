/**
 * Sidebar nav configuration — single source of truth for the
 * left-rail link tree.
 *
 * Mirrors `frontend/src/components/Layout.jsx` (CRA) section-for-
 * section and role-gate-for-role-gate. The CRA is the authoritative
 * reference for what nav items every role sees; if these two ever
 * drift, fix Next.js to match CRA, not the other way around.
 *
 * Routes that don't yet exist in `app/src/app/(authed)/**` will
 * Next.js-404 — that's intentional feedback about what still needs
 * to be ported. The parity-merge ships the links; the page ports
 * follow in their own workstreams.
 */

import {
  Activity,
  BarChart2,
  Bell,
  Building2,
  Calculator,
  CalendarClock,
  CalendarDays,
  DollarSign,
  FileText,
  PieChart,
  Settings,
  Shield,
  Sparkles,
  Trophy,
  Upload,
  UserCheck,
  Users,
  UsersRound,
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

// ── Role gate sets ────────────────────────────────────────────────
// Mirror the CRA Layout.jsx constants exactly. Changes here MUST
// also land in `frontend/src/components/Layout.jsx` (and vice versa)
// so the two frontends gate identically.

const ADMIN_ROLES: readonly UserRole[] = ["admin", "owner"] as const;

/** isAdminOrCompliance — CRA Layout.jsx line 537. Admin plus the
 *  three compliance-bucket roles. Sees admin tools that aren't
 *  destructive-config (Agent Commissions, Team). */
const ADMIN_OR_COMPLIANCE_ROLES: readonly UserRole[] = [
  "admin",
  "owner",
  "compliance",
  "cyber_security",
  "sales_manager",
] as const;

/** COMMAND_CENTER_ROLES_SET — CRA Layout.jsx lines 530-532. Mirrors
 *  the backend `agency_dashboard_router.AGENCY_ROLES` and the
 *  `COMMAND_CENTER_ROLES` export in `frontend/src/lib/api.js`. */
const COMMAND_CENTER_ROLES: readonly UserRole[] = [
  "owner",
  "admin",
  "coach",
  "sales_manager",
  "compliance",
  "accounting",
] as const;

/** IMPERSONATION_ROLES — also in `types/auth.ts`. Mirrors the
 *  backend deps.IMPERSONATION_ROLES list. owner + admin + the
 *  three roles that legitimately need "view as agent" without
 *  the destructive-admin powers. */
const IMPERSONATION_ROLES: readonly UserRole[] = [
  "admin",
  "owner",
  "compliance",
  "coach",
  "accounting",
] as const;

export const NAV: readonly NavSection[] = [
  // ── Main ────────────────────────────────────────────────────────
  // Mirrors CRA Layout.jsx "Main" section (lines 639-662). Order
  // matches the CRA exactly. Command Center is gated to the
  // leadership / cross-agent roles; every other item is visible to
  // every authenticated user.
  {
    title: "Main",
    items: [
      {
        label: "Command Center",
        href: "/agency-dashboard",
        icon: BarChart2,
        roles: COMMAND_CENTER_ROLES,
      },
      // Today is the canonical agent landing — /dashboard route still
      // exists but is no longer in the top nav (Today serves that need).
      // Pipeline / Birthday Rule / Renewals are surfaced as tabs inside
      // the Clients page, so they're redundant here. Page routes are
      // untouched — deep links still work.
      { label: "Today", href: "/today", icon: Sparkles },
      { label: "Appointments", href: "/appointments", icon: CalendarClock },
      { label: "Calendar", href: "/calendar", icon: CalendarDays },
      { label: "Clients", href: "/clients", icon: Users },
      { label: "Leaderboard", href: "/commissions/leaderboard", icon: Trophy },
      { label: "Applications", href: "/applications", icon: FileText },
      { label: "Commissions", href: "/commissions", icon: DollarSign },
    ],
  },

  // ── Reports ─────────────────────────────────────────────────────
  // Mirrors CRA Layout.jsx "Reports" section (lines 664-667). One
  // visible item today; designed as a section so additional reports
  // slot in alongside without churning the main nav.
  {
    title: "Reports",
    items: [
      {
        label: "Lead Sources",
        href: "/reports/lead-sources",
        icon: PieChart,
      },
    ],
  },

  // ── Platform ────────────────────────────────────────────────────
  // Mirrors CRA Layout.jsx "Platform" section (lines 669-680). The
  // sidebar component's `canSee()` treats `superAdminOnly: true` as
  // a hard gate on `User.super_admin === true`. A regular admin on
  // a tenant agency must NEVER see this section; the backend gate
  // on `/api/super-admin/*` enforces the same rule server-side.
  //
  // CRA links to top-level `/super-admin`; Next.js mounts the page
  // at `/admin/super-admin`. The href below targets the actual
  // Next.js path so the link works; the CRA path can be added as a
  // Next.js redirect later if we want URL parity too.
  {
    title: "Platform",
    items: [
      {
        label: "Super Admin",
        href: "/admin/super-admin",
        icon: Shield,
        superAdminOnly: true,
      },
    ],
  },

  // ── Admin ───────────────────────────────────────────────────────
  // Mirrors CRA Layout.jsx "Admin" section (lines 682-702). The
  // whole section vanishes for non-admin / non-compliance roles
  // because every item carries either ADMIN_ROLES or
  // ADMIN_OR_COMPLIANCE_ROLES.
  //
  // Per-item role splits exactly as in CRA:
  //   - Agency / Accounting / Data Import / Ops → admin+owner only
  //     (destructive config or finance — wider compliance roles
  //     can read these surfaces but not navigate to them from
  //     here; deep links still work for direct URLs).
  //   - Agent Commissions / Team → admin+owner+compliance buckets.
  //
  // Ops Console URL drift mirrors Super Admin: CRA `/ops`, Next.js
  // `/admin/ops` — linking to the Next.js path so the link works.
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
        label: "Agent Commissions",
        href: "/admin/commissions",
        icon: UserCheck,
        roles: ADMIN_OR_COMPLIANCE_ROLES,
      },
      {
        label: "Accounting",
        href: "/admin/accounting",
        icon: Calculator,
        roles: ADMIN_ROLES,
      },
      {
        label: "Team",
        href: "/agents",
        icon: Users,
        roles: ADMIN_OR_COMPLIANCE_ROLES,
      },
      {
        label: "Data Import",
        href: "/admin/import",
        icon: Upload,
        roles: ADMIN_ROLES,
      },
      {
        label: "Ops Console",
        href: "/admin/ops",
        icon: Activity,
        roles: ADMIN_ROLES,
      },
    ],
  },
];

/**
 * Bottom-anchored items — render below the scrollable nav above
 * the user/sign-out card. Mirrors CRA Layout.jsx's persistent
 * controls cluster (lines 704-774): notifications bell + agency
 * switcher + Settings.
 *
 * **Notifications (placeholder).** CRA renders this as a button
 * that opens an in-app NotificationPanel with a poll-driven unread
 * badge. The Next.js port of that wiring is a separate follow-up;
 * for now this is a plain link to `/notifications` (which will
 * 404 until the panel + API hookup land on their own branch).
 *
 * **Agent Switcher (placeholder).** CRA renders this as an
 * in-sidebar Popover that sets AgentContext + drives the
 * `X-Agent-ID` Axios interceptor. The Next.js app currently uses
 * a Zustand auth store with no impersonation interceptor; porting
 * AgentContext and the interceptor is its own follow-up. For now
 * this item links to `/agents` (the Team roster — closest sensible
 * landing surface) so users can at least see who they'd switch to.
 */
export const NAV_FOOTER: readonly NavItem[] = [
  {
    label: "Notifications",
    href: "/notifications",
    icon: Bell,
  },
  {
    label: "Switch Agent",
    href: "/agents",
    icon: UsersRound,
    roles: IMPERSONATION_ROLES,
  },
  { label: "Settings", href: "/settings", icon: Settings },
];
