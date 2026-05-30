"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth, isApiError } from "@/lib/api";
import { useAuthStore } from "@/stores";

const MFA_SESSION_KEY = "ghw:mfa_session";

/**
 * MFA challenge — landed here after login/magic-link returned
 * `mfa_required: true`. The session token was stashed in
 * sessionStorage by the previous step (5-minute backend TTL).
 *
 * Two paths:
 *   - 6-digit TOTP code (default)
 *   - "Use a backup code instead" toggle (single-use backup codes
 *     generated when MFA was enrolled in Settings → Security)
 */
export default function MfaPage() {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);

  const [sessionToken, setSessionToken] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"code" | "backup">("code");
  const [value, setValue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    const token = sessionStorage.getItem(MFA_SESSION_KEY);
    if (!token) {
      // No session — bounce back to login.
      router.replace("/login");
      return;
    }
    setSessionToken(token);
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionToken) return;
    setSubmitting(true);
    try {
      const response =
        mode === "code"
          ? await auth.verifyMfa({ session_token: sessionToken, code: value })
          : await auth.consumeMfaBackupCode({
              session_token: sessionToken,
              backup_code: value,
            });
      if (response.mfa_required) {
        // Shouldn't happen — backend wouldn't ask for MFA twice.
        toast.error("MFA loop — sign in again.");
        sessionStorage.removeItem(MFA_SESSION_KEY);
        router.replace("/login");
        return;
      }
      setUser(response.user);
      sessionStorage.removeItem(MFA_SESSION_KEY);
      toast.success(`Welcome back, ${response.user.full_name ?? response.user.email}.`);
      router.replace("/dashboard");
    } catch (err) {
      const message = isApiError(err) ? err.message : "Verification failed.";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md border-border/70 bg-card/90">
        <CardHeader className="text-center space-y-1">
          <ShieldCheck className="h-8 w-8 mx-auto text-primary" />
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            {mode === "code"
              ? "Enter the 6-digit code from your authenticator."
              : "Enter one of your single-use backup codes."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mfa-code">
                {mode === "code" ? "Code" : "Backup code"}
              </Label>
              <Input
                id="mfa-code"
                inputMode={mode === "code" ? "numeric" : "text"}
                autoComplete="one-time-code"
                pattern={mode === "code" ? "[0-9]{6}" : undefined}
                maxLength={mode === "code" ? 6 : 32}
                required
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value.trim())}
                placeholder={mode === "code" ? "123456" : "XXXX-XXXX"}
                className="font-mono text-center tracking-widest"
              />
            </div>
            <Button
              type="submit"
              disabled={submitting || !value}
              className="w-full"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Verify
            </Button>
            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === "code" ? "backup" : "code"));
                setValue("");
              }}
              className="block w-full text-xs text-muted-foreground hover:text-foreground text-center"
            >
              {mode === "code"
                ? "Use a backup code instead"
                : "Use my authenticator code instead"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
