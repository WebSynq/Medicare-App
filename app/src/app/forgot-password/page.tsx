"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, isApiError } from "@/lib/api";

/**
 * Forgot-password — public page.
 *
 * Posts the email to `/api/profile/forgot-password`. The backend
 * returns 200 regardless of whether the email matches a user (no
 * enumeration), so any thrown error is a transport / 5xx and gets
 * a generic toast rather than the server detail string.
 *
 * After a successful submit we replace the form with a quiet
 * "check your email" card — the user has no further action here.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error("Email is required.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/profile/forgot-password", { email: trimmed });
      setSent(true);
    } catch (err) {
      toast.error(
        isApiError(err) ? err.message : "Something went wrong. Try again.",
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
                Forgot your password?
              </h1>
              <p className="text-sm text-muted-foreground">
                Enter the email tied to your GHW Agent Portal account. We&rsquo;ll
                send a reset link if one exists.
              </p>
            </div>

            {sent ? (
              <div
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200 flex items-start gap-2"
                data-testid="forgot-sent"
              >
                <MailCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>
                  Check your email for reset instructions. The link expires in
                  1 hour.
                </span>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="forgot-email" className="text-sm">
                    Email
                  </Label>
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-11 bg-elevated border-border"
                    data-testid="forgot-email"
                    autoFocus
                  />
                </div>
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-11 rounded-full text-base bg-primary text-primary-foreground hover:bg-primary/90"
                  data-testid="forgot-submit"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  {submitting ? "Sending…" : "Send Reset Link"}
                </Button>
              </form>
            )}

            <div className="text-xs text-muted-foreground text-center pt-1">
              <Link
                href="/login"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                data-testid="forgot-back-to-login"
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
