import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { ShieldCheck, Smartphone, Copy } from "lucide-react";
import { toast } from "sonner";
import { api, auth } from "@/lib/api";
import { AppHeader, Footer } from "@/components/Layout";

export default function MfaSetup() {
  const nav = useNavigate();
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { begin(); }, []);

  const begin = async () => {
    try {
      const res = await api.post("/auth/mfa/enroll");
      setEnrollment(res.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not start MFA enrollment");
    }
  };

  const verify = async () => {
    setLoading(true);
    try {
      const res = await api.post("/auth/mfa/verify", { code });
      const me = await api.get("/auth/me");
      auth.saveSession(res.data.access_token, me.data);
      toast.success("MFA enabled — your account is now protected.");
      nav("/today");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Invalid code");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader />
      <main className="flex-1 max-w-3xl mx-auto px-6 py-12 w-full">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-widest text-primary mb-2">Account security</div>
          <h1 className="text-3xl font-bold tracking-tight" style={{fontFamily:'Outfit'}}>Enable Multi-Factor Authentication</h1>
          <p className="text-muted-foreground mt-2 max-w-xl">HIPAA-aligned platforms require MFA for accounts that can read PHI. Pair Gruening with any TOTP authenticator app — Google Authenticator, 1Password, Authy, or your password manager.</p>
        </div>

        <Card className="border-border bg-surface">
          <CardContent className="p-8 grid md:grid-cols-2 gap-8 items-start">
            <div>
              <div className="flex items-center gap-2 mb-3"><Smartphone className="w-4 h-4 text-primary" /><span className="text-sm font-medium">1. Scan this QR</span></div>
              {enrollment ? (
                <div className="rounded-lg border border-border p-4 bg-muted/40 inline-block">
                  <img src={`data:image/png;base64,${enrollment.qr_png_base64}`} alt="MFA QR" className="w-48 h-48" data-testid="mfa-qr" />
                </div>
              ) : (
                <div className="w-48 h-48 rounded-lg bg-muted animate-pulse" />
              )}
              {enrollment && (
                <div className="mt-3 text-xs text-muted-foreground flex items-center gap-2">
                  Or enter manually:
                  <code className="bg-secondary px-2 py-0.5 rounded text-foreground tracking-wider">{enrollment.secret}</code>
                  <button type="button" onClick={() => { navigator.clipboard.writeText(enrollment.secret); toast.success("Copied"); }} className="text-primary"><Copy className="w-3 h-3" /></button>
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center gap-2 mb-3"><ShieldCheck className="w-4 h-4 text-primary" /><span className="text-sm font-medium">2. Enter the 6-digit code</span></div>
              <InputOTP maxLength={6} value={code} onChange={setCode} data-testid="mfa-otp">
                <InputOTPGroup>{[0,1,2,3,4,5].map((i) => <InputOTPSlot key={i} index={i} />)}</InputOTPGroup>
              </InputOTP>
              <Button onClick={verify} disabled={loading || code.length < 6} className="mt-5 rounded-full" data-testid="mfa-verify">
                {loading ? "Verifying..." : "Verify & enable MFA"}
              </Button>
              <p className="text-xs text-muted-foreground mt-4 leading-relaxed">After enabling, every future sign-in will require your authenticator app code.</p>
            </div>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
