"use client";

import { usePathname } from "next/navigation";

import { PageTabs } from "@/components/layout/page-tabs";

const tabs = [
  { label: "All Clients", href: "/clients", exact: true },
  { label: "Pipeline", href: "/clients/pipeline" },
  { label: "Birthday Rule", href: "/clients/birthday-rule" },
  { label: "Renewals", href: "/clients/renewals" },
];

const TAB_HREFS = new Set([
  "/clients",
  ...tabs.filter((t) => !t.exact).map((t) => t.href),
]);

/**
 * Clients section layout. Renders the section tabs on the index +
 * named sub-routes (Pipeline / Birthday Rule / Renewals). Detail
 * routes like /clients/[id] are conceptually "drill-downs" of the
 * All Clients tab — they suppress the tab strip so the client
 * profile owns the full vertical space.
 */
export default function ClientsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const showTabs = TAB_HREFS.has(pathname);

  if (!showTabs) {
    return (
      <div className="flex flex-col h-full overflow-y-auto bg-background">
        {children}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={tabs}
        title="Clients"
        description="Manage your client book and pipeline"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-background">
        {children}
      </div>
    </div>
  );
}
