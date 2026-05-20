import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import axios from "axios";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Public Scope-of-Appointment page. NO auth — gated by the
// single-use token in the URL. Uses a bare axios client (not the
// shared `api` instance) so cookies / CSRF / session-timeout
// interceptors don't run for unauthenticated callers.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API_BASE = `${BACKEND_URL}/api`;

// Product-code → human label. Matches the labels we show in the
// in-app calculator. Falls back to the raw code when an unfamiliar
// product slips through.
const PRODUCT_LABEL = {
  med_supp: "Medicare Supplement",
  "medicare supplement": "Medicare Supplement",
  ma: "Medicare Advantage",
  "medicare advantage": "Medicare Advantage",
  pdp: "Prescription Drug Plan (PDP)",
  "prescription drug": "Prescription Drug Plan (PDP)",
};

function prettyProduct(p) {
  if (!p) return "Medicare";
  const key = String(p).trim().toLowerCase();
  return PRODUCT_LABEL[key] || p;
}

export default function SOAForm() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [invalid, setInvalid] = useState("");

  const [fullName, setFullName] = useState("");
  const [checked, setChecked] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await axios.get(
          `${API_BASE}/soa/public/${encodeURIComponent(token)}`,
        );
        if (!alive) return;
        setInfo(data);
        // Pre-check every product the agent listed for this SOA.
        const initial = {};
        (data.products_to_discuss || []).forEach((p) => {
          initial[p] = true;
        });
        setChecked(initial);
      } catch (err) {
        if (!alive) return;
        setInvalid(
          err?.response?.data?.detail
          || "This link has expired or already been used. Please contact your agent for a new link.",
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    if (!fullName.trim()) return;
    const productsConfirmed = Object.entries(checked)
      .filter(([, v]) => v)
      .map(([k]) => k);
    setSubmitting(true);
    try {
      await axios.post(
        `${API_BASE}/soa/public/${encodeURIComponent(token)}/sign`,
        {
          full_name: fullName.trim(),
          products_confirmed: productsConfirmed,
        },
      );
      setDone(true);
    } catch (err) {
      setInvalid(
        err?.response?.data?.detail
        || "We couldn't record your signature. Please refresh and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const todayStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen px-4 py-8 flex justify-center"
      style={{ background: "#080E1A" }}
    >
      <div className="w-full max-w-md">
        {/* GHW brand mark */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div
            className="w-10 h-10 rounded-lg grid place-items-center text-white font-bold text-lg"
            style={{
              background: "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
              fontFamily: "Outfit",
            }}
            aria-hidden="true"
          >
            G
          </div>
          <div className="text-white">
            <div className="text-sm font-semibold" style={{ fontFamily: "Outfit" }}>
              Gruening Health &amp; Wealth
            </div>
            <div className="text-[11px] text-white/55 -mt-0.5">
              Scope of Appointment
            </div>
          </div>
        </div>

        <Card className="bg-white">
          <CardContent className="p-6 space-y-5">
            {loading && (
              <div className="text-sm text-muted-foreground text-center py-6">
                Loading…
              </div>
            )}

            {!loading && invalid && (
              <div
                className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900 flex items-start gap-2"
                data-testid="soa-invalid"
              >
                <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{invalid}</span>
              </div>
            )}

            {!loading && !invalid && done && (
              <div
                className="text-center space-y-3 py-4"
                data-testid="soa-success"
              >
                <div className="w-14 h-14 rounded-full bg-emerald-100 grid place-items-center mx-auto">
                  <CheckCircle2 className="w-7 h-7 text-emerald-600" />
                </div>
                <h2 className="text-lg font-semibold tracking-tight">
                  Thank you!
                </h2>
                <p className="text-sm text-muted-foreground">
                  Your scope of appointment is on file. Your agent will be
                  in touch shortly.
                </p>
              </div>
            )}

            {!loading && !invalid && !done && info && (
              <form onSubmit={submit} className="space-y-5">
                <div>
                  <h1
                    className="text-lg font-semibold text-[#1e2d3d]"
                    style={{ fontFamily: "Outfit" }}
                  >
                    Hi {info.first_name || "there"},
                  </h1>
                  <p className="text-sm text-muted-foreground mt-2">
                    Before we discuss your Medicare options, we need your
                    authorization to discuss the following products. This
                    is a federal requirement (Scope of Appointment) — your
                    information is never shared with anyone else.
                  </p>
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
                    Products to discuss
                  </legend>
                  {(info.products_to_discuss || []).map((p) => (
                    <label
                      key={p}
                      className="flex items-start gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-[#e85d2f]"
                        checked={!!checked[p]}
                        onChange={(e) =>
                          setChecked((prev) => ({ ...prev, [p]: e.target.checked }))
                        }
                        data-testid={`soa-product-${p}`}
                      />
                      <span className="text-sm">{prettyProduct(p)}</span>
                    </label>
                  ))}
                </fieldset>

                <div className="space-y-3 pt-1 border-t border-border">
                  <div>
                    <Label className="text-xs">Your full legal name</Label>
                    <Input
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="h-11 mt-1.5"
                      data-testid="soa-fullname"
                      autoFocus
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Date</Label>
                    <Input
                      readOnly
                      value={todayStr}
                      className="h-11 mt-1.5 bg-secondary/40"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    By typing your name above you agree this is your
                    electronic signature, and you authorize{" "}
                    <strong>{info.agent_name || "your GHW agent"}</strong>{" "}
                    to discuss the products you selected with you.
                  </p>
                </div>

                <Button
                  type="submit"
                  disabled={submitting || !fullName.trim()}
                  className="w-full h-12 text-base font-semibold text-white"
                  style={{
                    background:
                      "linear-gradient(135deg, #e85d2f 0%, #c84416 100%)",
                  }}
                  data-testid="soa-submit"
                >
                  {submitting ? "Recording your signature…" : "I Agree & Sign"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-[11px] text-white/40 text-center mt-4">
          HIPAA Compliant · You are not affiliated with the federal Medicare
          program. We do not offer every plan available in your area.
        </p>
      </div>
    </div>
  );
}
