"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Mail } from "lucide-react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { auth, isApiError } from "@/lib/api";
import { useAuthStore } from "@/stores";

const REDIRECT_PARAM = "redirect_to";

function safeRedirectTarget(raw: string | null): string {
  // Only allow internal paths. External URLs would be an open-
  // redirect surface a phisher could chain onto a forged invite.
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/")) return "/dashboard";
  if (raw.startsWith("//")) return "/dashboard";
  return raw;
}

// Next 14: useSearchParams() forces dynamic rendering. We isolate
// the search-params read in an inner component wrapped in
// <Suspense> so the rest of the page can still prerender.
export default function LoginPage() {
  return (
    <React.Suspense fallback={<LoginFallback />}>
      <LoginPageInner />
    </React.Suspense>
  );
}

function LoginFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = safeRedirectTarget(params.get(REDIRECT_PARAM));

  // Two-tab login: password (Option B) + magic link (Option A,
  // primary path per backend CLAUDE.md). Default to magic link.
  const [tab, setTab] = React.useState<"magic" | "password">("magic");

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md border-border/70 bg-card/90 backdrop-blur">
        <CardHeader className="text-center space-y-1">
          <div className="mx-auto h-10 w-10 rounded-lg bg-primary/15 ring-1 ring-primary/30 flex items-center justify-center mb-2">
            <span className="text-base font-bold text-primary">G</span>
          </div>
          <CardTitle className="text-2xl font-display">GHW Portal</CardTitle>
          <CardDescription>Sign in to your agent account.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "magic" | "password")}
          >
            <TabsList className="grid w-full grid-cols-2 mb-6">
              <TabsTrigger value="magic">Magic link</TabsTrigger>
              <TabsTrigger value="password">Password</TabsTrigger>
            </TabsList>
            <TabsContent value="magic">
              <MagicLinkForm />
            </TabsContent>
            <TabsContent value="password">
              <PasswordForm
                onAuthenticated={() => router.replace(redirectTo)}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Password ────────────────────────────────────────────────────────

function PasswordForm({ onAuthenticated }: { onAuthenticated: () => void }) {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const response = await auth.login({ email, password });
      if (response.mfa_required) {
        // Stash the session token in sessionStorage so the /mfa
        // page can read it without a query param leak.
        sessionStorage.setItem("ghw:mfa_session", response.session_token);
        router.push("/mfa");
        return;
      }
      setUser(response.user);
      toast.success(`Welcome back, ${response.user.full_name ?? response.user.email}.`);
      onAuthenticated();
    } catch (err) {
      const message = isApiError(err) ? err.message : "Sign-in failed.";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="login-email">Email</Label>
        <Input
          id="login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@grueninghealthwealth.com"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="login-password">Password</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        disabled={submitting || !email || !password}
        className="w-full"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : null}
        Sign in
      </Button>
      <div className="text-xs text-muted-foreground text-center">
        <a
          href="/forgot-password"
          className="text-primary/80 hover:text-primary"
        >
          Forgot password?
        </a>
      </div>
    </form>
  );
}

// ── Magic link ─────────────────────────────────────────────────────

function MagicLinkForm() {
  const [email, setEmail] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);

  React.useEffect(() => {
    if (cooldown === 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await auth.requestMagicLink({ email });
      setSubmitted(true);
      setCooldown(60);
      toast.success("Check your email for a sign-in link.");
    } catch {
      // Backend opaque-200s on this endpoint, so an exception is a
      // network/rate-limit issue. Show a generic message rather
      // than leaking the actual error.
      toast.error("Could not send link. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="text-center space-y-4 py-4">
        <Mail className="h-10 w-10 mx-auto text-primary" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Check your email.</p>
          <p className="text-xs text-muted-foreground">
            We sent a sign-in link to{" "}
            <span className="text-foreground">{email}</span>. The link expires
            in 15 minutes.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={cooldown > 0}
          onClick={() => {
            setSubmitted(false);
            setEmail("");
          }}
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : "Send to a different email"}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="magic-email">Email</Label>
        <Input
          id="magic-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@grueninghealthwealth.com"
        />
      </div>
      <Button
        type="submit"
        disabled={submitting || !email}
        className="w-full"
      >
        {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        Email me a sign-in link
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        No password needed. Click the link in your email to sign in.
      </p>
    </form>
  );
}
