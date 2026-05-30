"use client";

import { Inbox } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

/**
 * Application History — placeholder until a cross-lead history
 * endpoint lands. The current backend exposes
 * GET /api/applications/extracted-data/{lead_id} which is scoped to
 * a single client; we'd need an agent-wide rollup to populate this
 * tab. Empty state up front so the tab still exists and the URL
 * pattern is reserved.
 */
export default function ApplicationsHistoryPage() {
  return (
    <Card className="max-w-3xl">
      <CardContent className="p-12 text-center">
        <Inbox className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
        <p className="font-medium text-sm">No history available yet.</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          Application history rolls up per client. Open a client&apos;s
          profile and visit the Policies tab to see their submitted
          applications. A cross-client history view is on the roadmap.
        </p>
      </CardContent>
    </Card>
  );
}
