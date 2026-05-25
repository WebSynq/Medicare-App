/**
 * MFA challenge page.
 *
 * Route: /mfa (registered OUTSIDE the Protected wrapper in App.js)
 *
 * Renders after a successful password check when the user has MFA
 * enabled. The session_token from /api/auth/login lands here via
 * navigation state (router push) OR as a ?st= query param fallback.
 * On a valid TOTP code (or backup code) the backend issues the real
 * JWT cookie and the SPA redirects to /today (or the original
 * destination preserved in router state).
 *
 * Security
 * ========
 *   - All API calls relative via the existing axios instance.
 *   - Submit button disables while in-flight.
 *   - Locks the UI after 5 failed attempts (backend already enforces
 *     a per-user lockout — UI lockout is defense in depth).
 *   - No raw backend errors surfaced — generic messages only.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import axios from "axios";

const FOREST = "#1B4332";
const COPPER = "#B5451B";
const CREAM = "#FAFAF5";
const CHARCOAL = "#1F2937";
const MUTED = "#6B7280";
const BORDER = "#E5E7EB";

const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
const mfaApi = axios.create({
  baseURL: `${BACKEND}/api`,
  withCredentials: true,
  timeout: 15000,
});

const MAX_ATTEMPTS = 5;

export default function MFAChallenge() {
  const nav = useNavigate();
  const loc = useLocation();
  const sessionToken =
    loc.state?.session_token ||
    new URLSearchParams(loc.search).get("st") ||
    "";
  const redirectTo = loc.state?.redirect || "/today";

  const [code, setCode] = useState("");
  const [usingBackup, setUsingBackup] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [attempts, setAttempts] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!sessionToken) {
      nav("/login", { replace: true });
      return;
    }
    inputRef.current?.focus();
  }, [sessionToken, nav]);

  // Auto-submit when 6 TOTP digits typed (matches authenticator UX).
  useEffect(() => {
    if (usingBackup) return;
    if (code.replace(/\D/g, "").length === 6 && !submitting) {
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, usingBackup]);

  async function submit(e) {
    if (e) e.preventDefault();
    if (submitting) return;
    if (attempts >= MAX_ATTEMPTS) return;
    setError("");
    setSubmitting(true);
    try {
      const url = usingBackup
        ? "/auth/mfa/backup-code"
        : "/auth/mfa/verify";
      const payload = usingBackup
        ? { session_token: sessionToken, backup_code: code.trim() }
        : { session_token: sessionToken, totp_code: code.replace(/\D/g, "") };
      const r = await mfaApi.post(url, payload);
      // Mirror api.js pattern: persist user + token if the SPA expects them
      // in localStorage. The httpOnly cookie is already planted server-side.
      try {
        if (r.data?.user) {
          localStorage.setItem("ghw_user", JSON.stringify(r.data.user));
        }
        if (r.data?.access_token) {
          localStorage.setItem("ghw_token", r.data.access_token);
        }
      } catch {
        /* storage failure is non-fatal */
      }
      nav(redirectTo, { replace: true });
    } catch (err) {
      const status = err?.response?.status;
      const next = attempts + 1;
      setAttempts(next);
      if (status === 429) {
        setError("Too many attempts — try again in 15 minutes.");
      } else if (status === 401) {
        setError(
          usingBackup
            ? "Invalid backup code."
            : "Invalid code. Check your authenticator app and try again."
        );
      } else if (status === 400) {
        setError("MFA isn't configured for this account.");
      } else {
        setError("Something went wrong. Please try again.");
      }
      setSubmitting(false);
      setCode("");
      inputRef.current?.focus();
    }
  }

  const locked = attempts >= MAX_ATTEMPTS;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.eyebrow}>Gruening Health &amp; Wealth</div>
        <h1 style={styles.h1}>
          {usingBackup
            ? "Enter a backup code"
            : "Enter your authenticator code"}
        </h1>
        <p style={styles.lead}>
          {usingBackup
            ? "Use one of the backup codes you saved when you turned on two-factor authentication."
            : "Open your authenticator app and enter the 6-digit code for Gruening Health & Wealth."}
        </p>

        <form onSubmit={submit} style={{ marginTop: 18 }}>
          <input
            ref={inputRef}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={usingBackup ? "XXXX-XXXX" : "123456"}
            inputMode={usingBackup ? "text" : "numeric"}
            autoComplete="one-time-code"
            maxLength={usingBackup ? 9 : 6}
            disabled={submitting || locked}
            data-testid="mfa-code-input"
            style={styles.codeInput}
          />
          {error && (
            <div style={styles.error} data-testid="mfa-error">{error}</div>
          )}
          {!locked && (
            <button
              type="submit"
              disabled={submitting || !code}
              data-testid="mfa-submit"
              style={{
                ...styles.btn,
                opacity: submitting || !code ? 0.55 : 1,
                cursor: submitting || !code ? "not-allowed" : "pointer",
              }}>
              {submitting ? "Verifying…" : "Verify"}
            </button>
          )}
          {locked && (
            <div style={{ ...styles.error, marginTop: 14 }}>
              Too many failed attempts. Please wait 15 minutes or sign in again.
            </div>
          )}
        </form>

        <div style={{ marginTop: 18, display: "flex", justifyContent: "space-between" }}>
          <button
            type="button"
            onClick={() => {
              setUsingBackup((v) => !v);
              setCode("");
              setError("");
            }}
            style={styles.linkBtn}
            data-testid="mfa-toggle-backup">
            {usingBackup
              ? "Use authenticator app instead"
              : "Use a backup code instead"}
          </button>
          <button
            type="button"
            onClick={() => nav("/login")}
            style={styles.linkBtn}
            data-testid="mfa-back-login">
            Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh", background: CREAM, color: CHARCOAL,
    fontFamily: `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`,
    padding: "40px 16px",
  },
  card: {
    maxWidth: 440, margin: "0 auto", background: "#fff",
    border: `1px solid ${BORDER}`, borderRadius: 14,
    padding: "32px 28px",
    boxShadow: "0 4px 18px rgba(27, 67, 50, 0.08)",
  },
  eyebrow: {
    color: FOREST, fontSize: 12, letterSpacing: 1.4,
    textTransform: "uppercase", fontWeight: 600, marginBottom: 6,
  },
  h1: {
    color: FOREST, fontSize: 24, fontWeight: 700,
    fontFamily: `Georgia,"Times New Roman",serif`,
    margin: "8px 0 8px 0",
  },
  lead: { color: MUTED, fontSize: 15, lineHeight: 1.5, margin: 0 },
  codeInput: {
    width: "100%", padding: "16px 14px", fontSize: 22,
    borderRadius: 10, border: `1.5px solid ${BORDER}`,
    boxSizing: "border-box", letterSpacing: 4,
    textAlign: "center", fontFamily: "monospace",
    minHeight: 56,
  },
  btn: {
    background: FOREST, color: "#fff", border: "none",
    borderRadius: 10, padding: 16, fontWeight: 700, fontSize: 16,
    width: "100%", marginTop: 14, minHeight: 52,
  },
  linkBtn: {
    background: "none", border: "none", color: COPPER,
    cursor: "pointer", padding: 0, fontWeight: 600, fontSize: 13,
  },
  error: {
    marginTop: 12, padding: "10px 12px",
    background: "#FEE2E2", color: "#991B1B",
    borderLeft: "4px solid #DC2626", borderRadius: 6,
    fontSize: 14,
  },
};
