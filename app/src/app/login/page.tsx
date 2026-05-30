"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Mail, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <div className="min-h-screen bg-background flex items-center justify-center">
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
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-background">
      {/* Left panel — brand */}
      <BrandPanel />

      {/* Right panel — sign-in form */}
      <div className="flex items-center justify-center px-6 py-12 bg-surface lg:bg-surface border-l border-border lg:border-l">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1">
            <h2 className="text-2xl font-bold font-display tracking-tight">
              Sign in
            </h2>
            <p className="text-sm text-foreground-muted">
              Access your GHW agent workspace.
            </p>
          </div>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "magic" | "password")}
          >
            <TabsList className="grid w-full grid-cols-2 mb-6 bg-elevated">
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

          <p className="text-[10px] text-foreground-subtle text-center flex items-center justify-center gap-1">
            <ShieldCheck className="h-3 w-3" />
            Secure session · HIPAA-aligned audit logging
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Brand panel ─────────────────────────────────────────────────────

function BrandPanel() {
  return (
    <div className="hidden lg:flex flex-col justify-between bg-background p-12 relative overflow-hidden">
      {/* Soft radial gold glow in the corner — keeps the panel from
          feeling like a flat block of navy. */}
      <div
        className="absolute -top-32 -left-32 h-96 w-96 rounded-full opacity-20 blur-3xl"
        style={{ background: "hsl(var(--primary))" }}
        aria-hidden
      />
      <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full opacity-10 blur-3xl"
        style={{ background: "hsl(var(--primary))" }}
        aria-hidden
      />

      <div className="relative z-10 flex items-center gap-3">
        <div className="h-12 w-12 rounded-lg bg-primary/15 ring-1 ring-primary/30 flex items-center justify-center">
          <span className="text-xl font-bold text-primary font-display">G</span>
        </div>
        <div>
          <div className="text-base font-semibold font-display">GHW Portal</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-foreground-subtle">
            Gruening Health &amp; Wealth
          </div>
        </div>
      </div>

      <div className="relative z-10 space-y-6 max-w-md">
        <Sparkles className="h-8 w-8 text-primary" />
        <h1 className="text-4xl font-bold font-display tracking-tight leading-tight">
          Run your day,
          <br />
          not the other way.
        </h1>
        <p className="text-sm text-foreground-muted leading-relaxed">
          The portal that surfaces your urgent calls, books your
          appointments, and writes your applications — so you can
          focus on the conversation.
        </p>
        <div className="grid grid-cols-3 gap-3 pt-2">
          <Stat label="AI brief" value="Daily" />
          <Stat label="Bookings" value="Auto" />
          <Stat label="Audit" value="7 yr" />
        </div>
      </div>

      <div className="relative z-10 text-[10px] text-foreground-subtle">
        © Gruening Health &amp; Wealth · grueninghealthwealth.com
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-elevated/60 border border-border/60 p-3">
      <div className="text-[9px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </div>
      <div className="text-sm font-bold text-foreground mt-0.5">{value}</div>
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
          className="bg-elevated border-border text-foreground"
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
          className="bg-elevated border-border text-foreground"
        />
      </div>
      <Button
        type="submit"
        disabled={submitting || !email || !password}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : null}
        Sign in
      </Button>
      <div className="text-xs text-foreground-muted text-center">
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
          <p className="text-xs text-foreground-muted">
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
          className="border-border bg-elevated hover:bg-accent-hover"
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
          className="bg-elevated border-border text-foreground"
        />
      </div>
      <Button
        type="submit"
        disabled={submitting || !email}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        Email me a sign-in link
      </Button>
      <p className="text-xs text-foreground-muted text-center">
        No password needed. Click the link in your email to sign in.
      </p>
    </form>
  );
}
