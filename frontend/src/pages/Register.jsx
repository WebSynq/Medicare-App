import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ShieldCheck, ArrowRight, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ── Password strength helper (mirrors backend validate_password_strength) ──
function getPasswordStrength(password) {
  if (!password) return { score: 0, label: "", color: "", checks: {} };

  const checks = {
    length: password.length >= 12,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    number: /\d/.test(password),
    special: /[!@#$%^&*(),.?":{}|<>_\-+=[\]\\;'/`~]/.test(password),
  };

  const score = Object.values(checks).filter(Boolean).length;

  const labels = ["", "Very Weak", "Weak", "Fair", "Good", "Strong"];
  const colors = ["", "bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-blue-500", "bg-green-500"];

  return {
    score,
    label: labels[score] || "",
    color: colors[score] || "",
    checks,
  };
}

export default function Register() {
  const [fullName, setFullName] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  // Invite flow
  const [inviteToken, setInviteToken] = useState("");
  const [inviteState, setInviteState] = useState("checking"); // checking | valid | invalid | missing
  const [inviteError, setInviteError] = useState("");

  // Validate invite token on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setInviteState("missing");
      return;
    }
    setInviteToken(token);
    api
      .get(`/auth/invite/validate?token=${encodeURIComponent(token)}`)
      .then((res) => {
        setEmail(res.data.email || "");
        setFullName(res.data.full_name || "");
        setAgencyName(res.data.agency_name || "");
        setInviteState("valid");
      })
      .catch((err) => {
        setInviteError(err?.response?.data?.detail || "Invite link is invalid or has expired.");
        setInviteState("invalid");
      });
  }, []);

  const submit = async (e) => {
    e.preventDefault();

    const strength = getPasswordStrength(password);
    if (strength.score < 5) {
      toast.error("Password does not meet security requirements", {
        description: "Use 12+ chars with upper, lower, number, and special character.",
      });
      return;
    }

    setLoading(true);
    try {
      await api.post("/auth/register", {
        full_name: fullName,
        agency_name: agencyName,
        email,
        password,
        invite_token: inviteToken,
      });
      setSubmitted(true);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (detail && typeof detail === "object" && detail.requirements) {
        toast.error(detail.message || "Password does not meet requirements", {
          description: detail.requirements.join(" "),
        });
      } else {
        toast.error(typeof detail === "string" ? detail : "Registration failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const resendMagic = async () => {
    setResending(true);
    try {
      await api.post("/auth/magic-link", { email });
      setResent(true);
      toast.success("Sign-in link sent — check your email.");
    } catch (err) {
      toast.error(
        err?.response?.data?.detail || "Could not send link — try again.",
      );
    } finally {
      setResending(false);
    }
  };

  const strength = getPasswordStrength(password);

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-primary text-primary-foreground relative">
        <div className="grain-overlay relative">
          <Link to="/" className="flex items-center gap-2.5" data-testid="register-brand">
            <div className="w-9 h-9 rounded-lg bg-primary-foreground/15 grid place-items-center font-bold" style={{ fontFamily: "Outfit" }}>G</div>
            <div>
              <div className="text-sm font-semibold tracking-tight" style={{ fontFamily: "Outfit" }}>Gruening · Console</div>
              <div className="text-xs text-primary-foreground/70 -mt-0.5">Complete your registration</div>
            </div>
          </Link>
        </div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }}>
          <h1 className="text-4xl xl:text-5xl font-bold leading-tight tracking-tight mb-5" style={{ fontFamily: "Outfit" }}>
            Set up your Gruening agent account.
          </h1>
          <p className="text-primary-foreground/85 leading-relaxed max-w-md">
            Registration is by invitation only. Use the invite link your administrator sent you to finish creating your account.
          </p>
        </motion.div>
        <div className="flex items-center gap-2 text-xs text-primary-foreground/80">
          <ShieldCheck className="w-4 h-4" /> HIPAA-aligned · Invite-only access
        </div>
      </div>

      <div className="flex flex-col items-center justify-center p-8 lg:p-14">
        <Card className="w-full max-w-md border-border bg-surface">
          <CardContent className="p-8">
            {submitted ? (
              <div data-testid="register-submitted">
                <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center mb-4">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight mb-2" style={{ fontFamily: "Outfit" }}>
                  Account created!
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-5">
                  Thanks, {fullName.split(" ")[0] || "there"}. Check your
                  email for a sign-in link, or go to the login page and use
                  your password.
                </p>
                <div className="flex flex-col gap-2">
                  <Link
                    to="/login"
                    className="inline-flex items-center justify-center h-11 rounded-full px-5 text-sm font-semibold text-primary-foreground bg-primary hover:opacity-95"
                    data-testid="register-go-to-login"
                  >
                    Go to Login <ArrowRight className="w-4 h-4 ml-1.5" />
                  </Link>
                  <button
                    type="button"
                    onClick={resendMagic}
                    disabled={resending || resent}
                    className="inline-flex items-center justify-center h-11 rounded-full px-5 text-sm font-medium border border-border bg-background hover:bg-secondary disabled:opacity-60"
                    data-testid="register-resend-link"
                  >
                    {resending
                      ? "Sending…"
                      : resent
                      ? "Link sent — check email"
                      : "Resend Login Link"}
                  </button>
                </div>
              </div>
            ) : inviteState === "checking" ? (
              <div className="text-center py-6 text-sm text-muted-foreground" data-testid="register-invite-checking">
                Validating your invite link…
              </div>
            ) : inviteState === "missing" ? (
              <div data-testid="register-invite-missing">
                <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 grid place-items-center mb-4">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight mb-2" style={{ fontFamily: "Outfit" }}>Invite required</h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                  Registration is by invitation only. Please contact your Gruening administrator to receive an invite link.
                </p>
                <Link to="/login" className="text-sm text-primary hover:underline inline-flex items-center" data-testid="register-back-to-login">
                  Back to sign in <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </div>
            ) : inviteState === "invalid" ? (
              <div data-testid="register-invite-invalid">
                <div className="w-12 h-12 rounded-full bg-red-100 text-red-700 grid place-items-center mb-4">
                  <XCircle className="w-6 h-6" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight mb-2" style={{ fontFamily: "Outfit" }}>Invite link invalid</h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                  {inviteError}
                </p>
                <Link to="/login" className="text-sm text-primary hover:underline inline-flex items-center" data-testid="register-back-to-login">
                  Back to sign in <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </div>
            ) : (
              <>
                <div className="mb-6">
                  <div className="text-xs uppercase tracking-widest text-primary mb-2">Agent registration</div>
                  <h2 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "Outfit" }}>Create your account</h2>
                  <p className="text-sm text-muted-foreground mt-1">Your invite is valid. Set a password to finish signing up.</p>
                </div>
                <form onSubmit={submit} className="space-y-4">
                  <div>
                    <Label className="text-sm">Full name</Label>
                    <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-11 mt-1.5" data-testid="register-name" />
                  </div>
                  <div>
                    <Label className="text-sm">Agency name</Label>
                    <Input required value={agencyName} onChange={(e) => setAgencyName(e.target.value)} className="h-11 mt-1.5" data-testid="register-agency" />
                  </div>
                  <div>
                    <Label className="text-sm">Email</Label>
                    <Input
                      type="email"
                      required
                      value={email}
                      readOnly
                      className="h-11 mt-1.5 bg-muted/40 cursor-not-allowed"
                      data-testid="register-email"
                    />
                    <p className="text-xs text-muted-foreground mt-1">Locked to the address your invite was sent to.</p>
                  </div>
                  <div>
                    <Label className="text-sm">Password</Label>
                    <Input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={12}
                      className="h-11 mt-1.5"
                      data-testid="register-password"
                    />
                    {/* Password strength indicator */}
                    {password && (
                      <div className="mt-2 space-y-1" data-testid="register-password-strength">
                        <div className="flex gap-1">
                          {[1, 2, 3, 4, 5].map((i) => (
                            <div
                              key={i}
                              className={`h-1 flex-1 rounded-full transition-colors ${
                                i <= strength.score ? strength.color : "bg-gray-200"
                              }`}
                            />
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {strength.label}
                          {strength.score < 5 && " — needs: "}
                          {!strength.checks.length && "12+ chars "}
                          {!strength.checks.upper && "uppercase "}
                          {!strength.checks.lower && "lowercase "}
                          {!strength.checks.number && "number "}
                          {!strength.checks.special && "special char"}
                        </p>
                      </div>
                    )}
                    {!password && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Minimum 12 characters with upper, lower, number, and special character.
                      </p>
                    )}
                  </div>
                  <Button type="submit" disabled={loading} className="w-full h-11 rounded-full text-base" data-testid="register-submit">
                    {loading ? "Submitting..." : <>Submit request <ArrowRight className="w-4 h-4 ml-2" /></>}
                  </Button>
                  <div className="text-xs text-muted-foreground text-center">
                    Already have an account? <Link to="/login" className="text-primary hover:underline" data-testid="register-to-login">Sign in</Link>
                  </div>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
