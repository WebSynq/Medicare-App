import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Fixed-height scrollable card. Standard wrapper for any list/table
 * surface so pages don't stretch infinitely with data volume.
 *
 * Layout: card header (title + optional count badge + headerAction) is
 * fixed; the body is a constrained-height container that scrolls
 * internally. Loading/empty states are first-class so callers don't
 * have to recreate them.
 *
 * Use `height="calc(100vh - 280px)"` for full-page tables and a fixed
 * px like `"400px"` for dashboard widgets. The `ghw-scroll` class
 * inherits the thin orange scrollbar styling from index.css.
 */
export default function ScrollableCard({
  title,
  count,
  height = "400px",
  headerAction,
  emptyState,
  loading = false,
  isEmpty = false,
  bodyClassName = "",
  cardClassName = "",
  children,
  testId,
}) {
  return (
    <Card className={`bg-surface ${cardClassName}`} data-testid={testId}>
      <CardContent className="p-0">
        {(title || headerAction) && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              {title && (
                <h3
                  className="text-sm font-semibold tracking-tight truncate"
                  style={{ fontFamily: "Outfit" }}
                >
                  {title}
                </h3>
              )}
              {typeof count === "number" && (
                <Badge className="rounded-full bg-secondary text-foreground/70 border-0 text-[10px] font-medium">
                  {count.toLocaleString()}
                </Badge>
              )}
            </div>
            {headerAction && (
              <div className="flex-shrink-0 flex items-center gap-2">
                {headerAction}
              </div>
            )}
          </div>
        )}
        <div
          className={`ghw-scroll overflow-y-auto ${bodyClassName}`}
          style={{ maxHeight: height, height }}
        >
          {loading ? (
            <ScrollableCardSkeleton />
          ) : isEmpty ? (
            <div className="h-full grid place-items-center text-xs text-muted-foreground p-6 text-center">
              {emptyState || "Nothing to show yet."}
            </div>
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ScrollableCardSkeleton() {
  return (
    <div className="p-4 space-y-3" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-10 rounded-md bg-secondary/40 animate-pulse"
        />
      ))}
    </div>
  );
}
