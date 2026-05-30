"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth, isApiError } from "@/lib/api";
import { useAuthStore } from "@/stores";

/**
 * Magic-link landing page.
 *
 * The email contains an absolute URL like
 *   https://app.ghwcrm.com/auth/magic?token=<opaque>
 *
 * This page reads the token, posts it to /api/auth/magic-link/verify,
 * and on success redirects to /today (or /mfa if the user has MFA
 * enrolled and the verify flow chose to require it).
 *
 * StrictMode-safe via a ref gate — we run the verify exactly once
 * even when React double-invokes the effect on mount. The Suspense
 * wrapper isolates useSearchParams so the prerender can finish
 * without bailing the route out of static generation.
 */
export default function MagicLinkVerifyPage() {
  return (
    <React.Suspense fallback={<MagicVerifyFallback />}>
      <MagicLinkVerifyInner />
    </React.Suspense>
  );
}

function MagicVerifyFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}

function MagicLinkVerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const setUser = useAuthStore((s) => s.setUser);

  const token = params.get("token");
  const consumed = React.useRef(false);
  const [status, setStatus] = React.useState<"working" | "error">("working");
  const [errorMessage, setErrorMessage] = React.useState<string>("");

  React.useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    if (!token) {
      setStatus("error");
      setErrorMessage("That sign-in link is missing its token. Try again from the email.");
      return;
    }
    (async () => {
      try {
        const response = await auth.verifyMagicLink({ token });
        if (response.mfa_required) {
          sessionStorage.setItem("ghw:mfa_session", response.session_token);
          router.replace("/mfa");
          return;
        }
        setUser(response.user);
        toast.success("Signed in.");
        router.replace("/today");
      } catch (err) {
        setStatus("error");
        if (isApiError(err)) {
          setErrorMessage(err.message);
        } else {
          setErrorMessage("The link couldn't be verified. Request a new one.");
        }
      }
    })();
  }, [token, setUser, router]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md border-border/70 bg-card/90">
        <CardHeader className="text-center space-y-1">
          <CardTitle>Verifying your sign-in link</CardTitle>
          {status === "working" && (
            <CardDescription>One moment…</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {status === "working" ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{errorMessage}</p>
              <Button
                className="w-full"
                onClick={() => router.replace("/login")}
              >
                Back to sign-in
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
