import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

// Public page — token is the auth substitute. Read from ?token=… in
// the URL the user clicked from the reset email. On success we
// redirect to /login with a toast; on failure we surface the server's
// detail message (expired / used / invalid).
export default function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!token) {
      setErr("This link is missing a token. Request a new reset email.");
      return;
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    setErr("");
    setSubmitting(true);
    try {
      await api.post("/profile/reset-password", {
        token,
        new_password: password,
      });
      toast.success("Password updated — please sign in");
      navigate("/login");
    } catch (e2) {
      const detail = e2?.response?.data?.detail;
      setErr(
        detail ||
          "This link has expired or already been used. Please request a new one.",
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
                Reset your password
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Set a new password for your GHW Agent Portal account.
              </p>
            </div>

            {err && (
              <div
                className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900"
                data-testid="reset-error"
              >
                {err}
              </div>
            )}

            <form onSubmit={submit} className="space-y-4">
              <div>
                <Label className="text-sm">New password</Label>
                <Input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 mt-1.5"
                  data-testid="reset-password"
                  autoFocus
                />
              </div>
              <div>
                <Label className="text-sm">Confirm password</Label>
                <Input
                  type="password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-11 mt-1.5"
                  data-testid="reset-confirm"
                />
              </div>
              <Button
                type="submit"
                disabled={submitting || !token}
                className="w-full h-11 rounded-full text-base"
                data-testid="reset-submit"
              >
                {submitting ? "Resetting…" : "Reset Password"}
              </Button>
            </form>

            <div className="text-xs text-muted-foreground text-center pt-1">
              <Link
                to="/login"
                className="inline-flex items-center gap-1 text-primary hover:underline"
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
