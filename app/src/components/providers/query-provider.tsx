"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { isApiError } from "@/lib/api";

/**
 * TanStack Query v5 provider.
 *
 * The QueryClient instance is created with `useState` so it
 * lives once per browser tab (vs once per render). Defaults
 * lean conservative — agents care more about freshness than
 * cache hits, and we have a fast Render backend:
 *
 *   - staleTime  30s    (lists feel live; refetch on focus)
 *   - retry      Don't retry on 4xx (auth / validation errors
 *                       are deterministic — retrying just
 *                       wastes the user's attention)
 *   - refetchOnWindowFocus: true (catch stale data after
 *                       lunch / context switch)
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) => {
              // Don't retry deterministic client errors.
              if (isApiError(error) && error.status >= 400 && error.status < 500) {
                return false;
              }
              return failureCount < 2;
            },
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
