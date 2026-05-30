"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Skeleton } from "@/components/ui/skeleton";
import { AgencySettingsTab } from "@/components/settings/agency-tab";
import { useAuthStore, selectHasAgencyScope } from "@/stores/auth";

/**
 * Settings · Agency (admin/owner only). Layout already hides the
 * Agency tab for non-admin users, but agents could still deep-link
 * here directly — this guard bounces them home.
 */
export default function SettingsAgencyPage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const hasAgencyScope = useAuthStore(selectHasAgencyScope);

  const allowed = status === "authed" && hasAgencyScope;

  React.useEffect(() => {
    if (status === "authed" && !allowed) {
      router.replace("/settings");
    }
  }, [status, allowed, router]);

  if (status !== "authed" || !allowed) {
    return <Skeleton className="h-64 w-full max-w-3xl" />;
  }

  return <AgencySettingsTab />;
}
