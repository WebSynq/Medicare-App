"use client";

import * as React from "react";

import { auth, isApiError } from "@/lib/api";
import { useAuthStore } from "@/stores";

/**
 * Auth bootstrap — runs once on the client after hydration.
 *
 * Calls /api/auth/me to populate useAuthStore. On 401 (no
 * session or expired) flips the store to "anon"; on other
 * errors (network, 5xx) also flips to anon — the SPA should
 * always render against a known-state store, never the
 * "unknown" placeholder.
 *
 * Doesn't render anything — just runs the effect. Mount it
 * once inside the root layout's body.
 */
export function AuthBootstrap(): null {
  const setUser = useAuthStore((s) => s.setUser);
  const clear = useAuthStore((s) => s.clear);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await auth.getMe();
        if (!cancelled) setUser(user);
      } catch (err) {
        // Any error → treat as anonymous. The middleware will
        // have already gated protected routes; this just flips
        // the store from "unknown" to "anon" so consumers can
        // render their public-state UI.
        if (!cancelled) {
          clear();
          if (!isApiError(err) || err.status !== 401) {
            // Log non-401 errors — they're worth seeing in the
            // dev console even though we recover.
            console.warn("[auth-bootstrap] /me failed:", err);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setUser, clear]);

  return null;
}
