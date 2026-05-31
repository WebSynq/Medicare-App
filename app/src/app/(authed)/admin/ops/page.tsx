/**
 * /admin/ops — role gate + render the military-themed console.
 *
 * Backend: GET /api/ops/health (single aggregate, sections degrade
 * independently to {error:"unavailable"}).
 * Role gate: admin, owner, or user.ops_access=true. Mirrors backend's
 * require_ops_access() so a forbidden user is bounced client-side
 * before the backend 403 fires.
 *
 * View logic lives in `./_ops-console.tsx`. This file is a thin
 * shell so the page module stays minimal.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStore } from "@/stores/auth";

import { OpsConsoleView } from "./_ops-console";

export default function OpsConsolePage() {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const role = useAuthStore((s) => s.user?.role ?? null);
  // `ops_access` isn't on the typed `User` shape today; defensive cast
  // so the gate works without a typed-shape change.
  const opsAccess = useAuthStore(
    (s) => (s.user as { ops_access?: boolean } | null)?.ops_access ?? false,
  );

  const allowed =
    status === "authed" && (role === "admin" || role === "owner" || opsAccess);

  React.useEffect(() => {
    if (status === "authed" && !allowed) {
      router.replace("/dashboard");
    }
  }, [status, allowed, router]);

  if (status !== "authed" || !allowed) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <OpsConsoleView />;
}
