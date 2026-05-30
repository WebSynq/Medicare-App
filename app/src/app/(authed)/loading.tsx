import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-group loading state. Renders while the next route's
 * server-side bundle streams in. Pages also drive their own
 * in-route skeletons via TanStack Query's isLoading; this is the
 * cold-jump fallback.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-5 w-96" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
