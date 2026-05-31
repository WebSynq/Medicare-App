"use client";

import { FileClock } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

/**
 * Application History — endpoint not yet implemented. The current
 * backend exposes GET /api/applications/extracted-data/{lead_id}
 * which is per-client. A cross-client rollup is on the roadmap;
 * styled empty state stands in until that lands.
 */
export default function ApplicationsHistoryPage() {
  return (
    <Card className="border-dashed">
      <CardContent className="p-12 md:p-16">
        <div className="flex flex-col items-center text-center max-w-md mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
            <FileClock className="h-7 w-7 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            Application History
          </h2>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            Application history will show all submitted applications and their
            carrier status. Coming in the next update.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
