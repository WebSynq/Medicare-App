"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, isApiError } from "@/lib/api";

/**
 * Reset-password — public page.
 *
 * The token is passed in the URL the user clicked from the reset
 * email: `/reset-password?token=...`. On submit we POST it +
 * the new password to `/api/profile/reset-password`. On success
 * we redirect to /login with a toast; on failure (expired / used /
 * weak password) the server detail message is rendered inline.
 *
 * Password rules are enforced client-side to give immediate
 * feedback, then re-enforced server-side by
 * security.validate_password_strength — keep the two in sync.
 */

type Rule = { id: string; label: string; ok: (p: string) => boolean };

const PASSWORD_RULES: readonly Rule[] = [
  { id: "len", label: "At least 12 characters", ok: (p) => p.length >= 12 },
  { id: "upper", label: "One uppercase letter", ok: (p) => /[A-Z]/.test(p) },
  { id: "lower", label: "One lowercase letter", ok: (p) => /[a-z]/.test(p) },
  { id: "digit", label: "One number", ok: (p) => /\d/.test(p) },
  {
    id: "special",
    label: "One special character (!@#$%^&* etc.)",
    ok: (p) => /[!@#$%^&*(),.?":{}|<>_\-+=[\]\\;'/`~]/.test(p),
  },
];

function evaluatePassword(p: string): string[] {
  return PASSWORD_RULES.filter((r) => !r.ok(p)).map((r) => r.label);
}

export default function ResetPasswordPage() {
  return (
    <React.Suspense fallback={<ResetFallback />}>
      <ResetPasswordInner />
    </React.Suspense>
  );
}

function ResetFallback() {
  return (
    <div className="min-h-screen grid place-items-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}

function ResetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [err, setErr] = React.useState("");

  const failed = React.useMemo(() => evaluatePassword(password), [password]);
  const passwordMet = password.length > 0 && failed.length === 0;
  const confirmMatches = confirm.length > 0 && password === confirm;
  const canSubmit = !!token && passwordMet && confirmMatches && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setErr("This link is missing a token. Request a new reset email.");
      return;
    }
    if (failed.length > 0) {
      setErr("Password does not meet the requirements below.");
      return;
    }
    if (password !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    setErr("");
    setSubmitting(true);
    try {
      await api.post("/api/profile/reset-password", {
        token,
        new_password: password,
      });
      toast.success("Password updated — please sign in.");
      router.replace("/login");
    } catch (e2) {
      const message = isApiError(e2) ? e2.message : "";
      setErr(
        message ||
          "This link has expired or already been used. Please request a new one.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 bg-background">
      <div className="w-full max-w-md">
        <Card className="border-border/70 bg-card/90">
          <CardContent className="p-7 space-y-5">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold font-display tracking-tight">
                Reset your password
              </h1>
              <p className="text-sm text-muted-foreground">
                Set a new password for your GHW Agent Portal account.
              </p>
            </div>

            {err && (
              <div
                className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                data-testid="reset-error"
              >
                {err}
              </div>
            )}

            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-password" className="text-sm">
                  New password
                </Label>
                <Input
                  id="reset-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 bg-elevated border-border"
                  data-testid="reset-password"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reset-confirm" className="text-sm">
                  Confirm password
                </Label>
                <Input
                  id="reset-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-11 bg-elevated border-border"
                  data-testid="reset-confirm"
                />
                {confirm.length > 0 && !confirmMatches ? (
                  <p className="text-xs text-rose-300">Passwords don&rsquo;t match.</p>
                ) : null}
              </div>

              <PasswordChecklist value={password} />

              <Button
                type="submit"
                disabled={!canSubmit}
                className="w-full h-11 rounded-full text-base bg-primary text-primary-foreground hover:bg-primary/90"
                data-testid="reset-submit"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                {submitting ? "Resetting…" : "Reset Password"}
              </Button>
            </form>

            <div className="text-xs text-muted-foreground text-center pt-1">
              <Link
                href="/login"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ArrowLeft className="w-3 h-3" />
                Back to sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PasswordChecklist({ value }: { value: string }) {
  return (
    <ul className="space-y-1 text-xs">
      {PASSWORD_RULES.map((r) => {
        const ok = value.length > 0 && r.ok(value);
        const Icon = ok ? Check : X;
        return (
          <li
            key={r.id}
            className={`flex items-center gap-2 ${
              ok ? "text-emerald-300" : "text-muted-foreground"
            }`}
          >
            <Icon className="h-3 w-3 flex-shrink-0" />
            <span>{r.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
