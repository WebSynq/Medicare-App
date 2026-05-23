import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  GraduationCap,
  Heart,
  Lock,
  ShieldCheck,
  Star,
  CheckCircle2,
  Mail,
  KeyRound,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";

const ACCENT = "#e85d2f";
const ACCENT_HOVER = "#d04d22";

const HERO_IMG =
  "https://static.prod-images.emergentagent.com/jobs/778a7dbc-8686-4d3e-87fc-fce3fac48f67/images/bcce0aae6e4600a7d511d4a7490ed04419512e890a959bd46527182b19272479.png";

// Match Login.jsx — 60s between resend attempts.
const RESEND_COOLDOWN_SECONDS = 60;

export default function HomePortal() {
  const nav = useNavigate();
  const [mode, setMode] = useState("magic"); // "magic" | "password"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [sentToEmail, setSentToEmail] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef(null);

  useEffect(() => {
    const prev = document.title;
    document.title = "GHW Agent Portal";
    return () => {
      document.title = prev;
    };
  }, []);

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
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Could not send link — try again.",
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
      auth.saveSession(res.data.access_token, res.data.user);
      toast.success("Welcome back");
      nav("/today");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr]" data-testid="home-portal">
      {/* ---------- Left: photographic brand panel ---------- */}
      <aside
        className="relative flex flex-col justify-between px-8 py-10 md:px-12 lg:px-14 lg:py-14 text-white overflow-hidden"
        data-testid="home-brand-panel"
      >
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${HERO_IMG})` }}
          aria-hidden="true"
        />
        <div className="absolute inset-0 hero-photo-overlay" aria-hidden="true" />

        <div className="relative z-10 flex flex-col h-full justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-xl grid place-items-center text-lg font-bold tracking-tight elev-2"
              style={{ fontFamily: "Outfit", backgroundColor: ACCENT, color: "white" }}
              aria-hidden="true"
            >
              G
            </div>
            <div className="leading-none" style={{ fontFamily: "Outfit" }}>
              <div className="flex items-center gap-2.5">
                <span className="text-[15px] md:text-[16px] font-bold tracking-[0.16em]">GRUENING</span>
                <span className="h-3.5 w-px bg-white/40" aria-hidden="true" />
                <span className="text-[15px] md:text-[16px] font-bold tracking-[0.16em]">HEALTH &amp; WEALTH</span>
              </div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-white/60 mt-2">
                Agent &amp; Compliance Portal
              </div>
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="my-12 lg:my-0 max-w-xl"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-surface-dark mb-6 text-xs">
              <ShieldCheck className="w-3.5 h-3.5" style={{ color: "#ffb997" }} />
              <span className="text-white/85">HIPAA-aligned · Encrypted end-to-end</span>
            </div>
            <h1
              className="text-3xl md:text-4xl xl:text-[46px] font-semibold leading-[1.08] tracking-tight"
              style={{ fontFamily: "Outfit" }}
            >
              Medicare &amp; retirement planning,
              <br />
              <span className="text-white/85">handled with care.</span>
            </h1>
            <p className="text-white/80 mt-5 leading-relaxed max-w-md text-[15px]">
              Secure agent console for the Gruening Health &amp; Wealth team — encrypted intake,
              audit trails, and GoHighLevel sync in one place.
            </p>

            <div className="mt-8 hidden md:flex items-center gap-3 text-xs text-white/70">
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
          </motion.div>

          <div>
            <div className="flex flex-wrap gap-2.5" data-testid="trust-badges">
              <Badge icon={Star} label="200+ 5-Star Reviews" />
              <Badge icon={GraduationCap} label="Education Focused" />
              <Badge icon={Heart} label="Treat You Like Family" />
            </div>

            <div className="mt-6 flex items-center gap-1">
              <Link to="/privacy" className="text-xs text-white/55 hover:text-white/85 hover:underline">
                Privacy Policy
              </Link>
              <span className="text-xs text-white/25"> · </span>
              <Link to="/security" className="text-xs text-white/55 hover:text-white/85 hover:underline">
                Security
              </Link>
            </div>
          </div>
        </div>
      </aside>

      {/* ---------- Right: login form ---------- */}
      <section className="flex flex-col items-center justify-center bg-background px-6 py-12 sm:px-10 lg:px-14 relative">
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
          <div className="mb-7">
            <div
              className="text-[11px] uppercase tracking-[0.22em] font-semibold mb-2"
              style={{ color: ACCENT }}
            >
              Agent Portal
            </div>
            <h2
              className="text-[28px] sm:text-[32px] font-semibold tracking-tight text-foreground"
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
            <form onSubmit={submitMagic} className="space-y-4" data-testid="home-login-form">
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
                  data-testid="home-email"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-press w-full h-12 rounded-full text-white font-semibold text-[15px] inline-flex items-center justify-center elev-2 disabled:opacity-60"
                style={{ backgroundColor: ACCENT }}
                onMouseEnter={(e) => {
                  if (!loading) e.currentTarget.style.backgroundColor = ACCENT_HOVER;
                }}
                onMouseLeave={(e) => {
                  if (!loading) e.currentTarget.style.backgroundColor = ACCENT;
                }}
                data-testid="home-magic-submit"
              >
                {loading ? (
                  "Sending..."
                ) : (
                  <>
                    <Mail className="w-4 h-4 mr-2" /> Send Login Link
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => setMode("password")}
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline pt-1"
                data-testid="home-show-password"
              >
                Sign in with password instead
              </button>
            </form>
          ) : (
            <form onSubmit={submitPassword} className="space-y-4" data-testid="home-login-form">
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
                  data-testid="home-email"
                />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium text-foreground">Password</Label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    data-testid="home-forgot-link"
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
                  data-testid="home-password"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-press w-full h-12 rounded-full text-white font-semibold text-[15px] inline-flex items-center justify-center elev-2 disabled:opacity-60"
                style={{ backgroundColor: ACCENT }}
                onMouseEnter={(e) => {
                  if (!loading) e.currentTarget.style.backgroundColor = ACCENT_HOVER;
                }}
                onMouseLeave={(e) => {
                  if (!loading) e.currentTarget.style.backgroundColor = ACCENT;
                }}
                data-testid="home-submit"
              >
                {loading ? (
                  "Signing in..."
                ) : (
                  <>
                    <KeyRound className="w-4 h-4 mr-2" /> Sign in
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => setMode("magic")}
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline pt-1"
                data-testid="home-show-magic"
              >
                Email me a sign-in link instead
              </button>
            </form>
          )}

          <div className="flex items-center justify-between pt-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Lock className="w-3 h-3" /> Encrypted in transit
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Audit-logged
            </span>
          </div>

          <div className="border-t border-border pt-4 mt-4 text-center text-sm text-muted-foreground">
            New to the team?{" "}
            <Link
              to="/register"
              className="font-semibold hover:underline"
              style={{ color: ACCENT }}
              data-testid="home-to-register"
            >
              Request Access
            </Link>
          </div>

          <div className="mt-8 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5" />
            HIPAA-aligned · TLS 1.2+ · Audit-logged
          </div>
        </motion.div>
      </section>
    </div>
  );
}

function MagicSentCard({ email, cooldown, loading, onResend, onUseDifferentEmail }) {
  return (
    <div className="space-y-4" data-testid="home-magic-sent">
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

      <button
        type="button"
        disabled={loading || cooldown > 0}
        onClick={onResend}
        className="w-full h-11 rounded-full text-sm font-medium border border-border bg-background hover:bg-secondary disabled:opacity-60"
        data-testid="home-magic-resend"
      >
        {cooldown > 0
          ? `Resend in ${cooldown}s`
          : loading
          ? "Sending..."
          : "Resend link"}
      </button>

      <button
        type="button"
        onClick={onUseDifferentEmail}
        className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
        data-testid="home-magic-change-email"
      >
        Use a different email
      </button>
    </div>
  );
}

function Badge({ icon: Icon, label }) {
  return (
    <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full glass-surface-dark">
      <Icon className="w-3.5 h-3.5" style={{ color: "#ffb997" }} />
      <span className="text-[12px] md:text-[13px] font-medium tracking-wide text-white/95">
        {label}
      </span>
    </div>
  );
}
