import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Lock, ShieldCheck, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";

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
        nav("/dashboard");
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-primary text-primary-foreground relative">
        <div className="grain-overlay relative">
          <Link to="/" className="flex items-center gap-2.5" data-testid="login-brand">
            <div className="w-9 h-9 rounded-lg bg-primary-foreground/15 grid place-items-center font-bold" style={{fontFamily:'Outfit'}}>G</div>
            <div>
              <div className="text-sm font-semibold tracking-tight" style={{fontFamily:'Outfit'}}>Gruening · Console</div>
              <div className="text-xs text-primary-foreground/70 -mt-0.5">Agent &amp; Compliance Portal</div>
            </div>
          </Link>
        </div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }}>
          <h1 className="text-4xl xl:text-5xl font-bold leading-tight tracking-tight mb-5" style={{fontFamily:'Outfit'}}>
            Compliance and care, in one secure console.
          </h1>
          <p className="text-primary-foreground/85 leading-relaxed max-w-md">
            Review encrypted intake submissions, audit every action, and push synchronized leads into GoHighLevel — with TOTP-backed MFA on every agent account.
          </p>
        </motion.div>
        <div className="flex items-center gap-2 text-xs text-primary-foreground/80">
          <ShieldCheck className="w-4 h-4" /> HIPAA-aligned · TLS 1.2+ · TOTP MFA
        </div>
      </div>

      <div className="flex flex-col items-center justify-center p-8 lg:p-14">
        <Card className="w-full max-w-md border-border bg-surface">
          <CardContent className="p-8">
            <div className="mb-6">
              <div className="text-xs uppercase tracking-widest text-primary mb-2">Agent sign in</div>
              <h2 className="text-2xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>Welcome back</h2>
            </div>
            {sessionExpired && (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm mb-4" data-testid="session-expired-banner">
                Your session expired due to inactivity. Please sign in again.
              </div>
            )}
            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label className="text-sm">Email</Label>
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 mt-1.5" data-testid="login-email" />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Password</Label>
                  <Link
                    to="/forgot-password"
                    className="text-xs text-primary hover:underline"
                    data-testid="login-forgot-link"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 mt-1.5" data-testid="login-password" />
              </div>
              {needsMfa && (
                <div>
                  <Label className="text-sm mb-2 block">Authenticator code</Label>
                  <InputOTP maxLength={6} value={mfaCode} onChange={setMfaCode} data-testid="login-mfa">
                    <InputOTPGroup>
                      {[0,1,2,3,4,5].map((i) => <InputOTPSlot key={i} index={i} />)}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              )}
              <Button type="submit" disabled={loading} className="w-full h-11 rounded-full text-base" data-testid="login-submit">
                {loading ? "Signing in..." : <>Sign in <ArrowRight className="w-4 h-4 ml-2" /></>}
              </Button>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5"><Lock className="w-3 h-3" /> Secured with TOTP MFA</span>
                <Link to="/" className="hover:text-primary">Back to site</Link>
              </div>
              <div className="text-xs text-muted-foreground text-center pt-1">
                New agent? <Link to="/register" className="text-primary hover:underline" data-testid="login-to-register">Request access</Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
