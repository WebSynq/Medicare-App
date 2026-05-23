import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { api, auth } from "@/lib/api";

const ACCENT = "#e85d2f";

// Route: /auth/magic?token=xxx
// Reads ?token from the URL on mount, exchanges it for a session via
// POST /api/auth/magic-link/verify, and hard-redirects to /today on
// success. Same opaque error for every failure mode so we never tell
// the user (or an attacker) whether the token was wrong, expired, or
// already used.
export default function MagicLinkVerify() {
  const nav = useNavigate();
  const [state, setState] = useState("verifying"); // verifying | ok | error
  const [errorMsg, setErrorMsg] = useState("");
  // useRef gate so React 18 / 19 StrictMode (which double-mounts
  // effects in dev) can't redeem the single-use token twice and turn
  // the second call into a spurious "already used" error.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = (params.get("token") || "").trim();

    if (!token) {
      setErrorMsg(
        "This link is missing the sign-in token. Request a new one from the login page.",
      );
      setState("error");
      return;
    }

    (async () => {
      try {
        const res = await api.post("/auth/magic-link/verify", { token });
        auth.saveSession(res.data.access_token, res.data.user);
        setState("ok");
        // Brief success flash so the user sees the confirm — then go.
        setTimeout(() => nav("/today"), 700);
      } catch (e) {
        setErrorMsg(
          e?.response?.data?.detail ||
            "This link has expired or already been used.",
        );
        setState("error");
      }
    })();
    // nav is stable; we intentionally fire this exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        <Card className="border-border bg-surface elev-1">
          <CardContent className="p-8 text-center">
            {state === "verifying" && (
              <div data-testid="magic-verify-loading">
                <div
                  className="w-12 h-12 rounded-full grid place-items-center mx-auto mb-4"
                  style={{ background: `${ACCENT}15`, color: ACCENT }}
                >
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
                <h1
                  className="text-2xl font-semibold tracking-tight"
                  style={{ fontFamily: "Outfit" }}
                >
                  Signing you in…
                </h1>
                <p className="text-sm text-muted-foreground mt-2">
                  Hang tight while we verify your login link.
                </p>
              </div>
            )}

            {state === "ok" && (
              <div data-testid="magic-verify-ok">
                <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center mx-auto mb-4">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <h1
                  className="text-2xl font-semibold tracking-tight"
                  style={{ fontFamily: "Outfit" }}
                >
                  You're in.
                </h1>
                <p className="text-sm text-muted-foreground mt-2">
                  Taking you to your dashboard…
                </p>
              </div>
            )}

            {state === "error" && (
              <div data-testid="magic-verify-error">
                <div className="w-12 h-12 rounded-full bg-red-100 text-red-700 grid place-items-center mx-auto mb-4">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <h1
                  className="text-2xl font-semibold tracking-tight"
                  style={{ fontFamily: "Outfit" }}
                >
                  Link not valid
                </h1>
                <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
                  {errorMsg}
                </p>
                <div className="mt-6 flex flex-col gap-2">
                  <Link
                    to="/login"
                    className="inline-flex items-center justify-center h-11 rounded-full px-5 text-sm font-semibold text-white"
                    style={{ background: ACCENT }}
                    data-testid="magic-verify-back-to-login"
                  >
                    Request a new link
                  </Link>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
