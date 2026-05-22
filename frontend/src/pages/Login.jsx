import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Lock, ShieldCheck, ArrowRight, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";

const ACCENT = "#e85d2f";

// Same hero photo as HomePortal — keeps the two sign-in entry points
// visually unified rather than the previous "two different products" feel
// (navy block vs. orange block).
const HERO_IMG =
  "https://static.prod-images.emergentagent.com/jobs/778a7dbc-8686-4d3e-87fc-fce3fac48f67/images/bcce0aae6e4600a7d511d4a7490ed04419512e890a959bd46527182b19272479.png";

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("reason") === "session_expired") {
      setSessionExpired(true);
    }
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post("/auth/login", { email, password, mfa_code: mfaCode || undefined });
      if (res.data.mfa_required) {
        setNeedsMfa(true);
        toast.message("Enter your 6-digit MFA code");
      } else {
        auth.saveSession(res.data.access_token, res.data.user);
        toast.success("Welcome back");
        nav("/today");
      }
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
              into GoHighLevel — with TOTP-backed MFA on every agent account.
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
            <span>TOTP MFA</span>
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
                  Sign in to access your dashboard, leads, and compliance tools.
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
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <Label className="text-sm font-medium text-foreground">Email</Label>
                  <Input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@agency.com"
                    className="h-12 mt-1.5 text-[15px]"
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
                    data-testid="login-password"
                  />
                </div>
                {needsMfa && (
                  <div>
                    <Label className="text-sm font-medium text-foreground mb-2 block">
                      Authenticator code
                    </Label>
                    <InputOTP maxLength={6} value={mfaCode} onChange={setMfaCode} data-testid="login-mfa">
                      <InputOTPGroup>
                        {[0, 1, 2, 3, 4, 5].map((i) => (
                          <InputOTPSlot key={i} index={i} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                )}
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
                      Sign in <ArrowRight className="w-4 h-4 ml-2" />
                    </>
                  )}
                </Button>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Lock className="w-3 h-3" /> Secured with TOTP MFA
                  </span>
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Audit-logged
                  </span>
                </div>
                <div className="border-t border-border pt-4 text-center text-sm text-muted-foreground">
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
              </form>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
