import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, MailCheck } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

// Public page — no auth required. Always shows the same confirmation
// message after submit regardless of whether the email matches an
// account on file, so an attacker can't probe the user list.
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!email.trim()) {
      toast.error("Email is required.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/profile/forgot-password", { email: email.trim() });
      setSent(true);
    } catch (err) {
      // The endpoint returns 200 even on unknown emails — anything that
      // bubbles up here is a transport / 5xx, surface generically.
      toast.error(
        err?.response?.data?.detail || "Something went wrong. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="min-h-screen grid place-items-center px-4"
      style={{ background: "#080E1A" }}
    >
      <div className="w-full max-w-md">
        <Card className="bg-white">
          <CardContent className="p-7 space-y-5">
            <div>
              <h1
                className="text-xl font-semibold text-[#1e2d3d]"
                style={{ fontFamily: "Outfit" }}
              >
                Forgot your password?
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Enter the email tied to your GHW Agent Portal account.
                We&rsquo;ll send a reset link if one exists.
              </p>
            </div>

            {sent ? (
              <div
                className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 flex items-start gap-2"
                data-testid="forgot-sent"
              >
                <MailCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>
                  Check your email for reset instructions. The link
                  expires in 1 hour.
                </span>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <Label className="text-sm">Email</Label>
                  <Input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-11 mt-1.5"
                    data-testid="forgot-email"
                    autoFocus
                  />
                </div>
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-11 rounded-full text-base"
                  data-testid="forgot-submit"
                >
                  {submitting ? "Sending…" : "Send Reset Link"}
                </Button>
              </form>
            )}

            <div className="text-xs text-muted-foreground text-center pt-1">
              <Link
                to="/login"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                data-testid="forgot-back-to-login"
              >
                <ArrowLeft className="w-3 h-3" />
                Back to sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
