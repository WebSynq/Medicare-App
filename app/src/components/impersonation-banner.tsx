"use client";

import * as React from "react";
import { UserCog, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useImpersonationStore } from "@/stores";

/**
 * Impersonation banner — visible whenever the active session is
 * "viewing as" another agent (admin / coach / accounting tooling).
 * Renders null when not impersonating. Drop directly under every
 * page header that touches per-agent data.
 */
export function ImpersonationBanner() {
  const selected = useImpersonationStore((s) => s.selectedAgent);
  const clear = useImpersonationStore((s) => s.clearAgent);

  if (!selected) return null;

  return (
    <div className="mt-3 rounded-md border border-ghw-copper/40 bg-ghw-copper/10 px-3 py-2 flex items-center gap-2">
      <UserCog className="h-4 w-4 text-ghw-copper flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <span className="text-muted-foreground">Viewing as:</span>{" "}
          <span className="font-medium">{selected.name}</span>
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={clear}
        className="h-7 text-xs"
      >
        <X className="h-3 w-3 mr-1" />
        Exit
      </Button>
    </div>
  );
}
