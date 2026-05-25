/**
 * Public client-facing booking page.
 *
 * Route: /book/:slug  (registered OUTSIDE the auth wrapper in App.js)
 *
 * No portal navigation, no shadcn AppLayout, no AgentContext.
 * Three steps: Date → Time + Meeting Type → Details → Confirmation.
 *
 * Security
 * ========
 *   - All API calls are RELATIVE (REACT_APP_BACKEND_URL via axios).
 *     No hardcoded production domain in this file.
 *   - HMAC booking token fetched on mount from
 *     `/api/book/:slug/token`, included in POST body.
 *   - Hidden honeypot `website` input — real users never see it.
 *   - Submit button disables after the first click — defeats
 *     double-submit.
 *   - No `dangerouslySetInnerHTML`. Backend errors surface as
 *     generic messages — never raw response detail.
 *   - All input is plain text (no Markdown / no rich text), so the
 *     React JSX escaping is the XSS defense.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";

// Brand
const FOREST = "#1B4332";
const COPPER = "#B5451B";
const CREAM = "#FAFAF5";
const CHARCOAL = "#1F2937";
const MUTED = "#6B7280";

const BOOKING_REASONS = [
  "New to Medicare",
  "Plan Review",
  "Turning 65 Soon",
  "Employer to Medicare",
  "Cost & Coverage Questions",
  "Other",
];

// Module-local axios — does NOT carry session cookies, does NOT touch
// the AgentContext header interceptor. Public booking traffic must look
// the same as any anonymous client.
const BACKEND = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
const bookingApi = axios.create({
  baseURL: `${BACKEND}/api`,
  withCredentials: false,
  timeout: 15000,
});

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function genCalendarDays(weeksAhead = 9) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  // Walk back to the previous Sunday so each week row starts aligned.
  start.setDate(today.getDate() - today.getDay());
  for (let i = 0; i < weeksAhead * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(d);
  }
  return out;
}

function prettyDate(d) {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function prettyTime(hhmm) {
  if (!hhmm) return "";
  const [hh, mm] = hhmm.split(":").map((p) => parseInt(p, 10));
  const h12 = hh % 12 || 12;
  const suf = hh < 12 ? "AM" : "PM";
  return `${h12}:${String(mm).padStart(2, "0")} ${suf}`;
}

function gcalUrl({ summary, details, startIso, endIso }) {
  // Google Calendar deep-link. Uses UTC stamps so the recipient's
  // local browser shows it in their tz on the destination page.
  const fmt = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: summary,
    details,
    dates: `${fmt(startIso)}/${fmt(endIso)}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export default function BookingPage() {
  const { slug } = useParams();

  // Server data
  const [info, setInfo] = useState(null);
  const [infoError, setInfoError] = useState(null);
  const [token, setToken] = useState("");
  const [tokenAt, setTokenAt] = useState(0);

  // Wizard state
  const [step, setStep] = useState(1);
  const [selectedDate, setSelectedDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsReason, setSlotsReason] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [meetingType, setMeetingType] = useState("");
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    phone: "",
    email: "",
    booking_reason: "",
    notes: "",
    website: "", // honeypot — must stay empty
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirmation, setConfirmation] = useState(null);

  // ── Initial load: agent profile + booking token ───────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [infoRes, tokRes] = await Promise.all([
          bookingApi.get(`/book/${encodeURIComponent(slug)}/info`),
          bookingApi.get(`/book/${encodeURIComponent(slug)}/token`),
        ]);
        if (!alive) return;
        setInfo(infoRes.data);
        setToken(tokRes.data?.token || "");
        setTokenAt(Date.now());
        // If the agent only offers one meeting type, auto-select.
        const types = infoRes.data?.meeting_types || [];
        if (types.length === 1) setMeetingType(types[0]);
      } catch (err) {
        if (!alive) return;
        setInfoError(
          err?.response?.status === 404
            ? "This booking page isn't available."
            : "We're having trouble loading this page. Please try again."
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  // Refresh the token if the user has lingered past its lifetime.
  const refreshTokenIfStale = useCallback(async () => {
    if (Date.now() - tokenAt < 8 * 60 * 1000) return;
    try {
      const r = await bookingApi.get(`/book/${encodeURIComponent(slug)}/token`);
      setToken(r.data?.token || "");
      setTokenAt(Date.now());
    } catch {
      // ignore — submit will return 403 and prompt a retry
    }
  }, [slug, tokenAt]);

  // ── Step 1 → 2: load slots for the picked date ────────────────────
  useEffect(() => {
    if (!selectedDate) return;
    let alive = true;
    setSlotsLoading(true);
    setSlots([]);
    setSlotsReason("");
    (async () => {
      try {
        const r = await bookingApi.get(
          `/book/${encodeURIComponent(slug)}/slots`,
          { params: { date: isoDate(selectedDate) } }
        );
        if (!alive) return;
        setSlots(r.data?.slots || []);
        setSlotsReason(r.data?.reason || "");
      } catch {
        if (alive) setSlotsReason("Could not load times for this date.");
      } finally {
        if (alive) setSlotsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedDate, slug]);

  // Working-day predicate for the calendar grid.
  const isWorkingDay = useCallback(
    (d) => {
      const wh = info?.working_hours || {};
      const keys = [
        "sunday", "monday", "tuesday", "wednesday",
        "thursday", "friday", "saturday",
      ];
      const k = keys[d.getDay()];
      return !!wh?.[k]?.enabled;
    },
    [info]
  );

  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const windowEnd = useMemo(() => {
    if (!info) return null;
    const d = new Date(today);
    d.setDate(d.getDate() + (info.booking_window_days || 60));
    return d;
  }, [info, today]);

  const days = useMemo(() => genCalendarDays(9), []);

  const meetingTypes = info?.meeting_types || ["phone", "video"];

  async function submitBooking() {
    if (submitting) return;
    setSubmitError("");
    // Frontend gates — backend re-validates everything.
    if (!form.first_name.trim() || !form.last_name.trim() || !form.phone.trim()) {
      setSubmitError("Please fill in your name and phone number.");
      return;
    }
    if (!form.booking_reason) {
      setSubmitError("Please pick a reason for your visit.");
      return;
    }
    if (!selectedDate || !selectedTime || !meetingType) {
      setSubmitError("Please pick a date, time, and meeting type.");
      return;
    }

    setSubmitting(true);
    await refreshTokenIfStale();
    try {
      const payload = {
        client_name: `${form.first_name.trim()} ${form.last_name.trim()}`.trim(),
        client_phone: form.phone.trim(),
        client_email: form.email.trim() || undefined,
        date: isoDate(selectedDate),
        time: selectedTime,
        meeting_type: meetingType,
        booking_reason: form.booking_reason,
        notes: form.notes.trim() || undefined,
        token,
        website: form.website, // honeypot, must be empty
      };
      const r = await bookingApi.post(
        `/book/${encodeURIComponent(slug)}`,
        payload
      );
      // Build confirmation payload (backend response is intentionally minimal)
      const start = new Date(selectedDate);
      const [hh, mm] = selectedTime.split(":").map((p) => parseInt(p, 10));
      start.setHours(hh, mm, 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + (info?.appointment_duration || 30));
      setConfirmation({
        status: r.data?.status,
        message: r.data?.message,
        date: r.data?.date || isoDate(selectedDate),
        time: r.data?.time || selectedTime,
        meeting_type: r.data?.meeting_type || meetingType,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        client_first_name: form.first_name,
        has_email: !!form.email.trim(),
      });
      setStep(4);
    } catch (err) {
      const status = err?.response?.status;
      // Generic messages — never expose backend detail.
      let msg = "Something went wrong. Please try again.";
      if (status === 409) msg = "That time was just taken. Please pick another.";
      else if (status === 403) {
        msg = "Your session expired. Please reload the page and try again.";
        // Drop the stale token so a retry forces a fresh fetch.
        setToken("");
      } else if (status === 422) {
        msg = "Some of your information looks off — please check and try again.";
      } else if (status === 429) {
        msg = "Too many attempts — please wait a few minutes and try again.";
      }
      setSubmitError(msg);
      setSubmitting(false);
    }
  }

  // ── Render: error state ───────────────────────────────────────────
  if (infoError) {
    return (
      <PageShell>
        <div style={{
          background: "#fff", padding: 32, borderRadius: 10,
          border: `1px solid #eee`, textAlign: "center",
        }}>
          <h1 style={{ color: FOREST, fontSize: 22, margin: "0 0 8px 0" }}>
            Booking page unavailable
          </h1>
          <p style={{ color: MUTED, margin: 0 }}>{infoError}</p>
        </div>
      </PageShell>
    );
  }

  // ── Render: loading ───────────────────────────────────────────────
  if (!info) {
    return (
      <PageShell>
        <div style={{ textAlign: "center", padding: 40, color: MUTED }}>
          Loading…
        </div>
      </PageShell>
    );
  }

  // ── Render: confirmation ──────────────────────────────────────────
  if (step === 4 && confirmation) {
    return (
      <PageShell>
        <ConfirmationCard
          info={info}
          confirmation={confirmation}
        />
      </PageShell>
    );
  }

  // ── Render: 3-step wizard ─────────────────────────────────────────
  return (
    <PageShell>
      <header style={{ marginBottom: 20 }}>
        <div style={{ color: COPPER, fontSize: 11, letterSpacing: 1.2,
                       textTransform: "uppercase", marginBottom: 6 }}>
          Schedule a Medicare conversation
        </div>
        <h1 style={{ margin: 0, color: FOREST, fontSize: 26, lineHeight: 1.2 }}
            data-testid="booking-agent-name">
          Book time with {info.agent_name}
        </h1>
        {info.bio && (
          <p style={{ color: CHARCOAL, marginTop: 8, fontSize: 15,
                       lineHeight: 1.55 }}>
            {info.bio}
          </p>
        )}
        <p style={{ color: MUTED, marginTop: 10, fontSize: 13 }}>
          Appointments are {info.appointment_duration} minutes.
        </p>
      </header>

      <Stepper step={step} />

      <div style={{ background: "#fff", borderRadius: 10,
                     border: `1px solid #e5e7eb`, padding: 20,
                     boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        {step === 1 && (
          <Step1Calendar
            days={days}
            today={today}
            windowEnd={windowEnd}
            isWorkingDay={isWorkingDay}
            selectedDate={selectedDate}
            onPick={(d) => { setSelectedDate(d); setStep(2); }}
          />
        )}

        {step === 2 && (
          <Step2TimeAndType
            selectedDate={selectedDate}
            slots={slots}
            slotsReason={slotsReason}
            slotsLoading={slotsLoading}
            meetingTypes={meetingTypes}
            meetingType={meetingType}
            setMeetingType={setMeetingType}
            selectedTime={selectedTime}
            setSelectedTime={setSelectedTime}
            onBack={() => { setStep(1); setSelectedTime(""); }}
            onNext={() => setStep(3)}
          />
        )}

        {step === 3 && (
          <Step3Details
            form={form}
            setForm={setForm}
            onBack={() => setStep(2)}
            onSubmit={submitBooking}
            submitting={submitting}
            submitError={submitError}
          />
        )}
      </div>
    </PageShell>
  );
}

/* ── Page shell ─────────────────────────────────────────────────── */
function PageShell({ children }) {
  return (
    <div style={{
      minHeight: "100vh", background: CREAM, color: CHARCOAL,
      fontFamily: `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`,
      padding: "32px 16px",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{
          color: FOREST, fontWeight: 700, fontSize: 18, marginBottom: 22,
        }}>
          Gruening Health &amp; Wealth
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Stepper ───────────────────────────────────────────────────── */
function Stepper({ step }) {
  const items = ["Date", "Time", "Details"];
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
      {items.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <div key={label}
               style={{
                 flex: 1, padding: "10px 12px", borderRadius: 8,
                 fontSize: 12, fontWeight: 600, textAlign: "center",
                 background: active ? FOREST : done ? "#dcecdf" : "#f3f4f6",
                 color: active ? "#fff" : done ? FOREST : MUTED,
                 border: active ? "none" : "1px solid #e5e7eb",
               }}>
            Step {n}: {label}
          </div>
        );
      })}
    </div>
  );
}

/* ── Step 1: calendar ──────────────────────────────────────────── */
function Step1Calendar({ days, today, windowEnd, isWorkingDay,
                         selectedDate, onPick }) {
  return (
    <div data-testid="booking-step-1">
      <h2 style={{ margin: 0, color: FOREST, fontSize: 18 }}>
        Pick a date
      </h2>
      <p style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
        Greyed-out days aren't available for booking.
      </p>
      <div style={{
        marginTop: 14, display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)", gap: 4,
      }}>
        {["S","M","T","W","T","F","S"].map((d, i) => (
          <div key={`${d}-${i}`} style={{
            textAlign: "center", color: MUTED, fontSize: 11,
            fontWeight: 700, padding: "4px 0",
          }}>{d}</div>
        ))}
        {days.map((d) => {
          const before = d < today;
          const afterWindow = windowEnd && d > windowEnd;
          const offDay = !isWorkingDay(d);
          const disabled = before || afterWindow || offDay;
          const sel = selectedDate &&
                       d.toDateString() === selectedDate.toDateString();
          return (
            <button
              key={d.toISOString()}
              disabled={disabled}
              onClick={() => onPick(d)}
              data-testid={`booking-day-${isoDateLocal(d)}`}
              style={{
                padding: "12px 0",
                border: sel ? `2px solid ${FOREST}` : "1px solid #e5e7eb",
                background: sel ? FOREST : disabled ? "#f9fafb" : "#fff",
                color: sel ? "#fff" : disabled ? "#cbd5d1" : CHARCOAL,
                borderRadius: 6,
                cursor: disabled ? "not-allowed" : "pointer",
                fontWeight: 600, fontSize: 14,
                minHeight: 44,
              }}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* ── Step 2: time + meeting type ───────────────────────────────── */
function Step2TimeAndType({
  selectedDate, slots, slotsReason, slotsLoading,
  meetingTypes, meetingType, setMeetingType,
  selectedTime, setSelectedTime,
  onBack, onNext,
}) {
  return (
    <div data-testid="booking-step-2">
      <button onClick={onBack} style={backLinkStyle}>← Pick a different day</button>
      <h2 style={{ margin: "10px 0 6px 0", color: FOREST, fontSize: 18 }}>
        {prettyDate(selectedDate)}
      </h2>

      <div style={{ marginTop: 8 }}>
        <div style={labelStyle}>Available times</div>
        {slotsLoading && (
          <div style={{ color: MUTED, padding: "10px 0", fontSize: 14 }}>
            Loading…
          </div>
        )}
        {!slotsLoading && slots.length === 0 && (
          <div style={{ color: MUTED, padding: "10px 0", fontSize: 14 }}>
            {slotsReason || "No times available for this day."}
          </div>
        )}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px,1fr))",
          gap: 8, marginTop: 6,
        }}>
          {slots.map((s) => {
            const sel = s === selectedTime;
            return (
              <button
                key={s}
                onClick={() => setSelectedTime(s)}
                data-testid={`booking-time-${s}`}
                style={{
                  padding: "12px 0", borderRadius: 6, fontWeight: 600,
                  border: sel ? `2px solid ${FOREST}` : "1px solid #e5e7eb",
                  background: sel ? FOREST : "#fff",
                  color: sel ? "#fff" : CHARCOAL,
                  cursor: "pointer", fontSize: 14, minHeight: 44,
                }}>
                {prettyTime(s)}
              </button>
            );
          })}
        </div>
      </div>

      {meetingTypes.length > 1 && (
        <div style={{ marginTop: 18 }}>
          <div style={labelStyle}>Meeting type</div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            {meetingTypes.includes("phone") && (
              <MeetingTypeBtn
                label="Phone Call" value="phone"
                selected={meetingType === "phone"}
                onClick={() => setMeetingType("phone")}
                testId="booking-meeting-phone" />
            )}
            {meetingTypes.includes("video") && (
              <MeetingTypeBtn
                label="Video Call" value="video"
                selected={meetingType === "video"}
                onClick={() => setMeetingType("video")}
                testId="booking-meeting-video" />
            )}
          </div>
        </div>
      )}

      <button
        onClick={onNext}
        disabled={!selectedTime || !meetingType}
        data-testid="booking-step-2-next"
        style={{
          ...primaryBtnStyle, marginTop: 22,
          opacity: (!selectedTime || !meetingType) ? 0.4 : 1,
          cursor: (!selectedTime || !meetingType) ? "not-allowed" : "pointer",
        }}>
        Continue
      </button>
    </div>
  );
}

function MeetingTypeBtn({ label, selected, onClick, testId }) {
  return (
    <button onClick={onClick} data-testid={testId}
            style={{
              flex: 1, padding: "14px 12px", borderRadius: 6,
              fontWeight: 600, fontSize: 14, minHeight: 48,
              border: selected ? `2px solid ${FOREST}` : "1px solid #e5e7eb",
              background: selected ? FOREST : "#fff",
              color: selected ? "#fff" : CHARCOAL, cursor: "pointer",
            }}>
      {label}
    </button>
  );
}

/* ── Step 3: details ───────────────────────────────────────────── */
function Step3Details({ form, setForm, onBack, onSubmit,
                         submitting, submitError }) {
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div data-testid="booking-step-3">
      <button onClick={onBack} style={backLinkStyle}>← Back to times</button>
      <h2 style={{ margin: "10px 0 14px 0", color: FOREST, fontSize: 18 }}>
        Your details
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="First name *">
          <input style={inputStyle} value={form.first_name}
                 onChange={set("first_name")}
                 data-testid="booking-first-name"
                 autoComplete="given-name" />
        </Field>
        <Field label="Last name *">
          <input style={inputStyle} value={form.last_name}
                 onChange={set("last_name")}
                 data-testid="booking-last-name"
                 autoComplete="family-name" />
        </Field>
        <Field label="Phone *">
          <input style={inputStyle} value={form.phone}
                 onChange={set("phone")} type="tel"
                 data-testid="booking-phone"
                 autoComplete="tel" />
        </Field>
        <Field label="Email (optional)">
          <input style={inputStyle} value={form.email}
                 onChange={set("email")} type="email"
                 data-testid="booking-email"
                 autoComplete="email" />
        </Field>
        <Field label="Reason for booking *" span={2}>
          <select style={{ ...inputStyle, appearance: "auto" }}
                  value={form.booking_reason}
                  onChange={set("booking_reason")}
                  data-testid="booking-reason">
            <option value="">Pick one…</option>
            {BOOKING_REASONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label="Notes (optional)" span={2}>
          <textarea
            style={{ ...inputStyle, height: 90, resize: "vertical" }}
            value={form.notes} onChange={set("notes")}
            data-testid="booking-notes"
            maxLength={500} />
        </Field>
      </div>

      {/* Honeypot — hidden via off-screen positioning AND aria-hidden,
          so screen-readers skip it. Real users never touch this. */}
      <div aria-hidden="true"
           style={{
             position: "absolute", left: "-10000px",
             width: 1, height: 1, overflow: "hidden",
           }}>
        <label>
          Website
          <input type="text" name="website" tabIndex={-1}
                 autoComplete="off"
                 value={form.website || ""}
                 onChange={set("website")} />
        </label>
      </div>

      {submitError && (
        <div style={{ marginTop: 12, color: "#991b1b", fontSize: 13 }}
             data-testid="booking-submit-error">
          {submitError}
        </div>
      )}

      <button onClick={onSubmit} disabled={submitting}
              data-testid="booking-submit"
              style={{
                ...primaryBtnStyle, marginTop: 18,
                opacity: submitting ? 0.6 : 1,
                cursor: submitting ? "not-allowed" : "pointer",
              }}>
        {submitting ? "Booking…" : "Confirm appointment"}
      </button>
    </div>
  );
}

/* ── Confirmation card ─────────────────────────────────────────── */
function ConfirmationCard({ info, confirmation }) {
  const gUrl = gcalUrl({
    summary: `Appointment with ${info.agent_name}`,
    details: "Booked via Gruening Health & Wealth.",
    startIso: confirmation.startIso,
    endIso: confirmation.endIso,
  });
  return (
    <div style={{
      background: "#fff", borderRadius: 10, padding: 28,
      border: `1px solid #e5e7eb`, textAlign: "center",
    }} data-testid="booking-confirmation">
      <div style={{
        color: COPPER, fontSize: 11, letterSpacing: 1.2,
        textTransform: "uppercase", fontWeight: 700, marginBottom: 6,
      }}>You're all set</div>
      <h1 style={{ color: FOREST, margin: 0, fontSize: 24 }}>
        Thanks, {confirmation.client_first_name || "friend"}!
      </h1>
      <p style={{ color: CHARCOAL, marginTop: 10, fontSize: 15 }}>
        {confirmation.message}
      </p>
      <div style={{
        margin: "18px auto 0 auto", maxWidth: 420,
        background: CREAM, borderRadius: 8, padding: "14px 18px",
        textAlign: "left",
      }}>
        <Row label="Date" value={prettyDate(new Date(confirmation.date))} />
        <Row label="Time" value={prettyTime(confirmation.time)} />
        <Row label="Meeting"
              value={confirmation.meeting_type === "video"
                       ? "Video Call" : "Phone Call"} />
      </div>
      <p style={{ color: MUTED, fontSize: 13, marginTop: 14 }}>
        {confirmation.meeting_type === "video"
          ? (confirmation.has_email
              ? "Check your email — we'll send the join link a few minutes before your appointment."
              : "We'll be in touch with the join link before your appointment.")
          : `${info.agent_name} will call you at the phone number you provided.`}
      </p>
      <a href={gUrl} target="_blank" rel="noopener noreferrer"
         data-testid="booking-add-to-calendar"
         style={{
           ...primaryBtnStyle, marginTop: 18,
           display: "inline-block", textDecoration: "none",
           padding: "12px 22px",
         }}>
        Add to Google Calendar
      </a>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between",
                   gap: 12, padding: "6px 0", fontSize: 14 }}>
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/* ── Small primitives ──────────────────────────────────────────── */
const labelStyle = {
  fontSize: 12, fontWeight: 700, color: MUTED,
  textTransform: "uppercase", letterSpacing: 0.6,
};
const inputStyle = {
  width: "100%", padding: "10px 12px", borderRadius: 6,
  border: "1px solid #e5e7eb", fontSize: 15, boxSizing: "border-box",
  minHeight: 42, background: "#fff", color: CHARCOAL,
};
const primaryBtnStyle = {
  background: COPPER, color: "#fff", border: "none",
  borderRadius: 6, padding: "14px 22px", fontWeight: 700,
  fontSize: 15, width: "100%", minHeight: 48,
};
const backLinkStyle = {
  background: "none", border: "none", color: COPPER,
  cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600,
};

function Field({ label, children, span }) {
  return (
    <div style={{ gridColumn: span === 2 ? "1 / span 2" : undefined }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}
