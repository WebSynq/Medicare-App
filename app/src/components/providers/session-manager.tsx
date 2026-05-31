"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/api";
import {
  bumpActivity,
  installSessionManager,
  resetSessionTimers,
} from "@/lib/session";
import { useAuthStore } from "@/stores";

/**
 * Mounts the idle session manager + renders the warning modal.
 *
 * Behavior:
 *   - At 25 min of inactivity → modal opens with a "Stay signed in"
 *     CTA. Clicking it calls /api/auth/refresh and resets the timer.
 *   - At 30 min of inactivity → modal force-logs out (server logout
 *     best-effort, store cleared, router pushes /login).
 *   - Any user activity inside the warning window also dismisses
 *     the modal automatically (the watch poll re-checks every 60s).
 *
 * The manager itself is module-scoped (single instance per tab),
 * so this component is safe to mount once inside the authed layout
 * and let it tear down when the user signs out.
 */
export function SessionManager(): React.ReactElement | null {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const clearAuth = useAuthStore((s) => s.clear);

  const [warning, setWarning] = React.useState<{
    msUntilLogout: number;
  } | null>(null);
  const [extending, setExtending] = React.useState(false);

  const handleLogout = React.useCallback(
    async (reason: string) => {
      try {
        await auth.logout();
      } catch {
        // best-effort — backend may already have invalidated
      }
      clearAuth();
      setWarning(null);
      const url =
        reason === "idle_timeout"
          ? "/login?reason=session_expired"
          : "/login";
      router.replace(url);
    },
    [router, clearAuth],
  );

  React.useEffect(() => {
    if (status !== "authed") return;
    // A fresh authed status means a new login (or refresh) — reset
    // the idle clock so a stale background timer doesn't trip
    // immediately.
    resetSessionTimers();
    const teardown = installSessionManager({
      onIdleWarning: (info) => setWarning(info),
      onIdleLogout: (reason) => {
        void handleLogout(reason);
      },
    });
    return teardown;
  }, [status, handleLogout]);

  // Clear the warning when status flips away from "authed" (e.g.
  // logout from another tab), so the modal doesn't stay mounted
  // over the login screen.
  React.useEffect(() => {
    if (status !== "authed") setWarning(null);
  }, [status]);

  async function stayLoggedIn() {
    setExtending(true);
    try {
      await auth.refreshSession();
      bumpActivity();
      resetSessionTimers();
      setWarning(null);
    } catch {
      await handleLogout("refresh_failed");
    } finally {
      setExtending(false);
    }
  }

  const open = status === "authed" && warning !== null;
  const minutesLeft = warning
    ? Math.max(1, Math.ceil(warning.msUntilLogout / 60_000))
    : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't allow ESC / overlay click to dismiss without an
        // explicit choice — the modal is a session-safety control,
        // not a casual surface.
        if (!next) return;
      }}
    >
      <DialogContent
        className="max-w-sm"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Are you still there?
          </DialogTitle>
          <DialogDescription>
            For HIPAA-aligned session safety we&rsquo;ll sign you out in about{" "}
            {minutesLeft} minute{minutesLeft === 1 ? "" : "s"} if there&rsquo;s
            no activity.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => handleLogout("user_signed_out")}
            disabled={extending}
          >
            Sign out
          </Button>
          <Button onClick={stayLoggedIn} disabled={extending}>
            {extending ? "Refreshing…" : "Stay signed in"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
