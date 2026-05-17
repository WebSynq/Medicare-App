import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, GraduationCap, Heart, Lock, ShieldCheck, Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";

const NAVY = "#1e2d3d";
const ACCENT = "#e85d2f";
const ACCENT_HOVER = "#d04d22";

export default function HomePortal() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const prev = document.title;
    document.title = "GHW Agent Portal";
    return () => { document.title = prev; };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post("/auth/login", {
        email,
        password,
        mfa_code: mfaCode || undefined,
      });
      if (res.data.mfa_required) {
        setNeedsMfa(true);
        toast.message("Enter your 6-digit MFA code");
      } else {
        auth.saveSession(res.data.access_token, res.data.user);
        toast.success("Welcome back");
        nav("/dashboard");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2" data-testid="home-portal">
      {/* ---------- Left: brand panel ---------- */}
      <aside
        className="relative flex flex-col justify-between px-8 py-10 md:px-12 lg:px-14 lg:py-14 text-white"
        style={{ backgroundColor: NAVY }}
        data-testid="home-brand-panel"
      >
        {/* Logo wordmark */}
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-lg grid place-items-center text-lg font-bold tracking-tight"
            style={{ fontFamily: "Outfit", backgroundColor: ACCENT, color: "white" }}
            aria-hidden="true"
          >
            G
          </div>
          <div className="flex items-center gap-3 leading-none" style={{ fontFamily: "Outfit" }}>
            <span className="text-[15px] md:text-[17px] font-extrabold tracking-[0.18em]">GRUENING</span>
            <span className="h-5 w-px bg-white/40" aria-hidden="true" />
            <span className="text-[15px] md:text-[17px] font-extrabold tracking-[0.18em]">HEALTH &amp; WEALTH</span>
          </div>
        </div>

        {/* Tagline */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="my-12 lg:my-0 max-w-xl"
        >
          <h1
            className="text-3xl md:text-4xl xl:text-[44px] font-bold leading-[1.15] tracking-tight"
            style={{ fontFamily: "Outfit" }}
          >
            Medicare &amp; Retirement Planning.
            <br />
            <span className="text-white/85">It&apos;s What We Do.</span>
          </h1>
          <p className="text-white/70 mt-5 leading-relaxed max-w-md text-[15px]">
            Secure agent portal for the Gruening Health &amp; Wealth team —
            encrypted intake, audit trails, and GoHighLevel sync in one console.
          </p>
        </motion.div>

        {/* Trust badges */}
        <div className="flex flex-wrap gap-2.5 md:gap-3" data-testid="trust-badges">
          <Badge icon={Star} label="200+ 5-Star Reviews" />
          <Badge icon={GraduationCap} label="Education Focused" />
          <Badge icon={Heart} label="Treat You Like Family" />
        </div>

        {/* Public footer links */}
        <div className="mt-6 flex items-center gap-1">
          <Link to="/privacy" className="text-xs hover:underline" style={{ color: "rgba(255,255,255,0.4)" }}>
            Privacy Policy
          </Link>
          <span className="text-xs" style={{ color: "rgba(255,255,255,0.2)" }}> · </span>
          <Link to="/security" className="text-xs hover:underline" style={{ color: "rgba(255,255,255,0.4)" }}>
            Security
          </Link>
        </div>
      </aside>

      {/* ---------- Right: login form ---------- */}
      <section className="flex flex-col items-center justify-center bg-white px-6 py-12 sm:px-10 lg:px-14">
        <div className="w-full max-w-md">
          <div className="mb-7">
            <div className="text-[11px] uppercase tracking-[0.22em] font-semibold mb-2" style={{ color: ACCENT }}>
              Agent Portal
            </div>
            <h2
              className="text-[28px] sm:text-[32px] font-bold tracking-tight text-slate-900"
              style={{ fontFamily: "Outfit" }}
            >
              Sign in
            </h2>
            <p className="text-sm text-slate-500 mt-1.5">
              Access your dashboard, leads, and compliance tools.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4" data-testid="home-login-form">
            <div>
              <Label className="text-sm text-slate-700">Email</Label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@agency.com"
                className="h-11 mt-1.5"
                data-testid="home-email"
              />
            </div>
            <div>
              <Label className="text-sm text-slate-700">Password</Label>
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="h-11 mt-1.5"
                data-testid="home-password"
              />
            </div>

            {needsMfa && (
              <div>
                <Label className="text-sm text-slate-700 mb-2 block">Authenticator code</Label>
                <InputOTP maxLength={6} value={mfaCode} onChange={setMfaCode} data-testid="home-mfa">
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-12 rounded-full text-white font-semibold text-[15px] inline-flex items-center justify-center transition disabled:opacity-60"
              style={{ backgroundColor: ACCENT }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.backgroundColor = ACCENT_HOVER; }}
              onMouseLeave={(e) => { if (!loading) e.currentTarget.style.backgroundColor = ACCENT; }}
              data-testid="home-submit"
            >
              {loading ? "Signing in..." : <>Sign in <ArrowRight className="w-4 h-4 ml-2" /></>}
            </button>

            <div className="flex items-center pt-1 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <Lock className="w-3 h-3" /> Secured with TOTP MFA
              </span>
            </div>

            <div className="border-t border-slate-200 pt-4 text-center text-sm text-slate-600">
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
          </form>

          <div className="mt-8 flex items-center justify-center gap-2 text-[11px] text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5" />
            HIPAA-aligned · TLS 1.2+ · Audit-logged
          </div>
        </div>
      </section>
    </div>
  );
}

function Badge({ icon: Icon, label }) {
  return (
    <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-white/10 backdrop-blur-sm border border-white/15">
      <Icon className="w-3.5 h-3.5" style={{ color: ACCENT }} />
      <span className="text-[12px] md:text-[13px] font-medium tracking-wide">{label}</span>
    </div>
  );
}
