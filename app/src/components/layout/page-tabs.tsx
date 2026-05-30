"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface Tab {
  label: string;
  href: string;
  /** Match exact pathname only — used for the section's index tab so
   *  the underline doesn't latch onto sibling sub-routes. */
  exact?: boolean;
}

interface PageTabsProps {
  tabs: Tab[];
  title: string;
  description?: string;
  /** Right-rail slot — section-level action buttons (e.g. "New
   *  appointment"). Stacks under the title on small screens. */
  actions?: React.ReactNode;
}

/**
 * GHL-style section header + top tab bar. Rendered by each section's
 * layout.tsx so the title, description, and tab strip stay constant
 * while only the inner content swaps on tab navigation.
 *
 * Layout philosophy: the layout owns the section H1; sub-page files
 * should drop their own H1s so we don't render "Clients · Clients".
 */
export function PageTabs({ tabs, title, description, actions }: PageTabsProps) {
  const pathname = usePathname();

  return (
    <div className="border-b border-border bg-surface">
      <div className="px-6 pt-6 pb-0">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
          <h1 className="font-display text-2xl font-semibold text-foreground">
            {title}
          </h1>
          {actions ? <div className="flex-shrink-0">{actions}</div> : null}
        </div>
        {description ? (
          <p className="text-sm text-foreground-muted mb-4">{description}</p>
        ) : (
          <div className="mb-4" />
        )}
        <div className="flex gap-1 flex-wrap">
          {tabs.map((tab) => {
            const isActive = tab.exact
              ? pathname === tab.href
              : pathname === tab.href || pathname.startsWith(tab.href + "/");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "px-4 py-2 text-sm font-medium rounded-t-md",
                  "border-b-2 -mb-px transition-colors",
                  isActive
                    ? "border-primary text-primary bg-elevated"
                    : "border-transparent text-foreground-muted hover:text-foreground hover:border-border",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
