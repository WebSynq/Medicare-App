import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Lock,
  ShieldCheck,
  ArrowRight,
  CheckCircle2,
  Mail,
  KeyRound,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { api, auth, landingForUser } from "@/lib/api";

const ACCENT = "#e85d2f";

const HERO_IMG =
  "https://static.prod-images.emergentagent.com/jobs/778a7dbc-8686-4d3e-87fc-fce3fac48f67/images/bcce0aae6e4600a7d511d4a7490ed04419512e890a959bd46527182b19272479.png";

// Resend cooldown — 60 seconds matches the email-provider rate-limit
// guidance and keeps users from spam-clicking when delivery is just
// slow. Matches the magic_link_tokens row a /magic-link request would
// have minted on the backend.
const RESEND_COOLDOWN_SECONDS = 60;

export default function Login() {
  const nav = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState("magic"); // "magic" | "password"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [sentToEmail, setSentToEmail] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const cooldownTimer = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("reason") === "session_expired") {
      setSessionExpired(true);
    }
  }, []);

  // Drive the resend cooldown timer. Cleared on unmount so we don't
  // leak intervals if the user navigates away mid-countdown.
  useEffect(() => {
    if (cooldown <= 0) {
      if (cooldownTimer.current) {
        clearInterval(cooldownTimer.current);
        cooldownTimer.current = null;
      }
      return;
    }
    if (!cooldownTimer.current) {
      cooldownTimer.current = setInterval(() => {
        setCooldown((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
    }
    return () => {
      if (cooldownTimer.current) {
        clearInterval(cooldownTimer.current);
        cooldownTimer.current = null;
      }
    };
  }, [cooldown]);

  async function sendMagicLink(targetEmail) {
    setLoading(true);
    try {
      await api.post("/auth/magic-link", { email: targetEmail });
      setMagicSent(true);
      setSentToEmail(targetEmail);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (e) {
      // Backend returns 200 even on unknown email so this should be
      // network-only. Surface a generic message either way.
      toast.error(
        e?.response?.data?.detail || "Could not send link — try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  const submitMagic = async (e) => {
    e.preventDefault();
    if (!email) {
      toast.error("Enter your email.");
      return;
    }
    await sendMagicLink(email.trim().toLowerCase());
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post("/auth/login", { email, password });
      // Hardening 1: MFA-gated accounts receive a session_token instead
      // of an access_token. Redirect to the MFA challenge with the
      // session token in router state (kept out of the URL bar; the
      // ?st= query fallback is in MFAChallenge.jsx for deep-link cases).
      // `from` carries through the originally-requested URL when the
      // Protected wrapper bounced an unauthenticated visit here, so
      // MFAChallenge can land the user where they were headed.
      if (res.data?.mfa_required === true && res.data?.session_token) {
        nav("/mfa", {
          state: {
            session_token: res.data.session_token,
            from: location.state?.from,
          },
        });
        return;
      }
      auth.saveSession(res.data.access_token, res.data.user);
      toast.success("Welcome back");
      nav(landingForUser(res.data.user));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr]">
      {/* ---------- Left: photographic brand panel ---------- */}
      <aside className="relative hidden lg:flex flex-col justify-between p-12 text-white overflow-hidden">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${HERO_IMG})` }}
          aria-hidden="true"
        />
        <div className="absolute inset-0 hero-photo-overlay" aria-hidden="true" />

        <div className="relative z-10 flex flex-col h-full justify-between">
          <Link to="/" className="flex items-center gap-3" data-testid="login-brand">
            <div
              className="w-11 h-11 rounded-xl grid place-items-center text-lg font-bold tracking-tight elev-2"
              style={{ fontFamily: "Outfit", backgroundColor: ACCENT, color: "white" }}
              aria-hidden="true"
            >
              G
            </div>
            <div className="leading-none" style={{ fontFamily: "Outfit" }}>
              <div className="flex items-center gap-2.5">
                <span className="text-[15px] font-bold tracking-[0.16em]">GRUENING</span>
                <span className="h-3.5 w-px bg-white/40" aria-hidden="true" />
                <span className="text-[15px] font-bold tracking-[0.16em]">HEALTH &amp; WEALTH</span>
              </div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-white/60 mt-2">
                Agent &amp; Compliance Portal
              </div>
            </div>
          </Link>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="max-w-xl"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-surface-dark mb-6 text-xs">
              <ShieldCheck className="w-3.5 h-3.5" style={{ color: "#ffb997" }} />
              <span className="text-white/85">HIPAA-aligned · Encrypted end-to-end</span>
            </div>
            <h1
              className="text-4xl xl:text-[46px] font-semibold leading-[1.08] tracking-tight mb-5"
              style={{ fontFamily: "Outfit" }}
            >
              Compliance and care,
              <br />
              <span className="text-white/85">in one secure console.</span>
            </h1>
            <p className="text-white/80 leading-relaxed max-w-md text-[15px]">
              Review encrypted intake submissions, audit every action, and push synchronized leads
              into GoHighLevel — passwordless magic-link sign-in on every agent account.
            </p>
          </motion.div>

          <div className="flex items-center gap-3 text-xs text-white/70">
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
              </span>
              <span>Audit log · live</span>
            </div>
            <span className="text-white/30">·</span>
            <span>TLS 1.2+</span>
            <span className="text-white/30">·</span>
            <span>Magic link</span>
          </div>
        </div>
      </aside>

      {/* ---------- Right: login form ---------- */}
      <div className="flex flex-col items-center justify-center p-8 lg:p-14 relative bg-background">
        <div
          className="absolute -top-32 -right-32 w-96 h-96 rounded-full opacity-[0.07] blur-3xl pointer-events-none"
          style={{ background: ACCENT }}
          aria-hidden="true"
        />

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="w-full max-w-md relative"
        >
          <Card className="border-border bg-surface elev-1">
            <CardContent className="p-8">
              <div className="mb-6">
                <div
                  className="text-[11px] uppercase tracking-[0.22em] font-semibold mb-2"
                  style={{ color: ACCENT }}
                >
                  Agent sign in
                </div>
                <h2
                  className="text-[28px] font-semibold tracking-tight text-foreground"
                  style={{ fontFamily: "Outfit" }}
                >
                  Welcome back
                </h2>
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                  {mode === "magic"
                    ? "Sign in with a one-time link — no password required."
                    : "Use your email and password to sign in."}
                </p>
              </div>

              {sessionExpired && (
                <div
                  className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm mb-4"
                  data-testid="session-expired-banner"
                >
                  Your session expired due to inactivity. Please sign in again.
                </div>
              )}

              {/* ---------- Magic-link sent confirmation ---------- */}
              {magicSent && mode === "magic" ? (
                <MagicSentCard
                  email={sentToEmail}
                  cooldown={cooldown}
                  loading={loading}
                  onResend={() => sendMagicLink(sentToEmail)}
                  onUseDifferentEmail={() => {
                    setMagicSent(false);
                    setSentToEmail("");
                    setCooldown(0);
                  }}
                />
              ) : mode === "magic" ? (
                /* ---------- Option A: magic-link form ---------- */
                <form onSubmit={submitMagic} className="space-y-4" data-testid="login-magic-form">
                  <div>
                    <Label className="text-sm font-medium text-foreground">Email</Label>
                    <Input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@agency.com"
                      className="h-12 mt-1.5 text-[15px]"
                      autoComplete="email"
                      data-testid="login-email"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="btn-press w-full h-12 rounded-full text-base elev-2"
                    style={{ backgroundColor: ACCENT, color: "white" }}
                    data-testid="login-magic-submit"
                  >
                    {loading ? (
                      "Sending..."
                    ) : (
                      <>
                        <Mail className="w-4 h-4 mr-2" /> Send Login Link
                      </>
                    )}
                  </Button>

                  <button
                    type="button"
                    onClick={() => setMode("password")}
                    className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline pt-1"
                    data-testid="login-show-password"
                  >
                    Sign in with password instead
                  </button>
                </form>
              ) : (
                /* ---------- Option B: password form ---------- */
                <form onSubmit={submitPassword} className="space-y-4" data-testid="login-password-form">
                  <div>
                    <Label className="text-sm font-medium text-foreground">Email</Label>
                    <Input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@agency.com"
                      className="h-12 mt-1.5 text-[15px]"
                      autoComplete="email"
                      data-testid="login-email"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium text-foreground">Password</Label>
                      <Link
                        to="/forgot-password"
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                        data-testid="login-forgot-link"
                      >
                        Forgot password?
                      </Link>
                    </div>
                    <Input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="h-12 mt-1.5 text-[15px]"
                      autoComplete="current-password"
                      data-testid="login-password"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="btn-press w-full h-12 rounded-full text-base elev-2"
                    style={{ backgroundColor: ACCENT, color: "white" }}
                    data-testid="login-submit"
                  >
                    {loading ? (
                      "Signing in..."
                    ) : (
                      <>
                        <KeyRound className="w-4 h-4 mr-2" /> Sign In
                      </>
                    )}
                  </Button>

                  <button
                    type="button"
                    onClick={() => setMode("magic")}
                    className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline pt-1"
                    data-testid="login-show-magic"
                  >
                    Email me a sign-in link instead
                  </button>
                </form>
              )}

              <div className="flex items-center justify-between text-xs text-muted-foreground mt-5">
                <span className="flex items-center gap-1.5">
                  <Lock className="w-3 h-3" /> Encrypted in transit
                </span>
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Audit-logged
                </span>
              </div>
              <div className="border-t border-border pt-4 text-center text-sm text-muted-foreground mt-4">
                New agent?{" "}
                <Link
                  to="/register"
                  className="font-semibold hover:underline"
                  style={{ color: ACCENT }}
                  data-testid="login-to-register"
                >
                  Request access
                </Link>
              </div>
              <div className="text-center pt-1">
                <Link to="/" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
                  ← Back to home
                </Link>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}

function MagicSentCard({ email, cooldown, loading, onResend, onUseDifferentEmail }) {
  return (
    <div className="space-y-4" data-testid="login-magic-sent">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-700 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-emerald-900">
              Check your email!
            </div>
            <p className="text-sm text-emerald-800 mt-1 leading-relaxed">
              We sent a login link to{" "}
              <span className="font-medium">{email}</span>. It expires in 15
              minutes.
            </p>
          </div>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full h-11 rounded-full"
        disabled={loading || cooldown > 0}
        onClick={onResend}
        data-testid="login-magic-resend"
      >
        {cooldown > 0
          ? `Resend in ${cooldown}s`
          : loading
          ? "Sending..."
          : "Resend link"}
      </Button>

      <button
        type="button"
        onClick={onUseDifferentEmail}
        className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
        data-testid="login-magic-change-email"
      >
        Use a different email
      </button>
    </div>
  );
}
