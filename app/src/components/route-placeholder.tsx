import * as React from "react";
import { Sparkles } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

/**
 * Uniform placeholder rendered by every Week-1 stub route. Lets the
 * router + middleware + sidebar all compile and exercise their
 * happy paths while the real per-page implementations land in
 * weeks 2+.
 */
export function RoutePlaceholder({
  title,
  description,
  backendRoute,
}: {
  title: string;
  description?: string;
  backendRoute?: string;
}) {
  return (
    <div className="p-6 md:p-10 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-eyebrow">Placeholder</span>
      </div>
      <h1
        className="text-3xl font-bold tracking-tight font-display"
        style={{ fontFamily: "var(--font-geist-sans)" }}
      >
        {title}
      </h1>
      {description ? (
        <p className="mt-2 text-sm text-muted-foreground max-w-prose">
          {description}
        </p>
      ) : null}

      <Card className="mt-6 border-dashed bg-card/40">
        <CardContent className="p-5 text-xs text-muted-foreground space-y-2">
          <p>
            This route compiles, routes, and respects auth gating. The
            real page lands in a later phase.
          </p>
          {backendRoute ? (
            <p>
              <span className="font-medium text-foreground/80">Backend:</span>{" "}
              <code className="font-mono">{backendRoute}</code>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
