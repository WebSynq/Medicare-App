import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ShieldCheck, ArrowRight, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { api } from "@/lib/api";

export default function Register() {
  const [fullName, setFullName] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      await api.post("/auth/register", {
        full_name: fullName,
        agency_name: agencyName,
        email,
        password,
      });
      setSubmitted(true);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-primary text-primary-foreground relative">
        <div className="grain-overlay relative">
          <Link to="/" className="flex items-center gap-2.5" data-testid="register-brand">
            <div className="w-9 h-9 rounded-lg bg-primary-foreground/15 grid place-items-center font-bold" style={{fontFamily:'Outfit'}}>G</div>
            <div>
              <div className="text-sm font-semibold tracking-tight" style={{fontFamily:'Outfit'}}>Gruening · Console</div>
              <div className="text-xs text-primary-foreground/70 -mt-0.5">Request agent access</div>
            </div>
          </Link>
        </div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }}>
          <h1 className="text-4xl xl:text-5xl font-bold leading-tight tracking-tight mb-5" style={{fontFamily:'Outfit'}}>
            Apply to join the Gruening agent network.
          </h1>
          <p className="text-primary-foreground/85 leading-relaxed max-w-md">
            New accounts are reviewed and approved by a Gruening administrator before sign-in is enabled. You'll get an update once your request has been reviewed.
          </p>
        </motion.div>
        <div className="flex items-center gap-2 text-xs text-primary-foreground/80">
          <ShieldCheck className="w-4 h-4" /> HIPAA-aligned · Admin-approved access
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
                <h2 className="text-2xl font-bold tracking-tight mb-2" style={{fontFamily:'Outfit'}}>Request submitted</h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                  Thanks, {fullName.split(" ")[0] || "there"}. Your request is pending administrator approval. You'll be able to sign in once it's approved.
                </p>
                <Link to="/login" className="text-sm text-primary hover:underline inline-flex items-center" data-testid="register-back-to-login">
                  Back to sign in <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </div>
            ) : (
              <>
                <div className="mb-6">
                  <div className="text-xs uppercase tracking-widest text-primary mb-2">Agent registration</div>
                  <h2 className="text-2xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>Request access</h2>
                  <p className="text-sm text-muted-foreground mt-1">An administrator will review and approve your request.</p>
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
                    <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 mt-1.5" data-testid="register-email" />
                  </div>
                  <div>
                    <Label className="text-sm">Password</Label>
                    <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} className="h-11 mt-1.5" data-testid="register-password" />
                    <p className="text-xs text-muted-foreground mt-1">Minimum 8 characters.</p>
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
