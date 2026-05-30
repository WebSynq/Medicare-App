"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { PageTabs } from "@/components/layout/page-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAuthStore,
  selectHasAgencyScope,
  selectIsSuperAdmin,
} from "@/stores/auth";

const BASE_TABS = [
  { label: "Agency Overview", href: "/admin", exact: true },
  { label: "Audit Log", href: "/admin/audit" },
  { label: "Ops Console", href: "/admin/ops" },
];

const SUPER_ADMIN_TAB = { label: "Super Admin", href: "/admin/super-admin" };

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const allowed =
    status === "authed" && (hasAgencyScope || isSuperAdmin);

  React.useEffect(() => {
    if (status === "authed" && !allowed) {
      router.replace("/dashboard");
    }
  }, [status, allowed, router]);

  const tabs = React.useMemo(
    () => (isSuperAdmin ? [...BASE_TABS, SUPER_ADMIN_TAB] : BASE_TABS),
    [isSuperAdmin],
  );

  if (status !== "authed" || !allowed) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={tabs}
        title="Admin"
        description="Agency KPIs, audit log, operations, and platform controls"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-background">
        {children}
      </div>
    </div>
  );
}
