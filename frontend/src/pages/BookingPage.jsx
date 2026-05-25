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
const FOREST_DEEP = "#163829";
const COPPER = "#B5451B";
const CREAM = "#FAFAF5";
const CHARCOAL = "#1F2937";
const MUTED = "#6B7280";
const LIGHT_GREEN = "#D8F3DC";
const BORDER = "#E5E7EB";
const WHITE = "#FFFFFF";
const SOFT_GRAY = "#F3F4F6";
const DISABLED_TEXT = "#D1D5DB";

const SERIF = `Georgia, "Times New Roman", "Iowan Old Style", serif`;
const SANS = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;

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

// Inject a tiny stylesheet for things inline styles can't reach:
// keyframes, hover/focus/active pseudo-classes, and a couple of
// mobile media queries. Idempotent — guards against StrictMode
// double-mount duplicating the <style> node.
function useInjectedStyles() {
  useEffect(() => {
    const ID = "ghw-booking-styles";
    if (document.getElementById(ID)) return;
    const style = document.createElement("style");
    style.id = ID;
    style.textContent = `
      @keyframes ghw-shimmer {
        0%   { background-position: -240px 0; }
        100% { background-position: 240px 0; }
      }
      .ghw-shimmer {
        background: linear-gradient(90deg,
          ${SOFT_GRAY} 0%, #E9EBEE 50%, ${SOFT_GRAY} 100%);
        background-size: 480px 100%;
        animation: ghw-shimmer 1.2s infinite linear;
        border-radius: 8px;
      }
      .ghw-input:focus, .ghw-select:focus, .ghw-textarea:focus {
        outline: none;
        border-color: ${FOREST};
        box-shadow: 0 0 0 3px rgba(27,67,50,0.15);
      }
      .ghw-day:not(:disabled):hover {
        background: ${LIGHT_GREEN} !important;
        color: ${FOREST} !important;
        border-color: ${FOREST} !important;
      }
      .ghw-time:not(:disabled):hover {
        background: ${LIGHT_GREEN};
        border-color: ${FOREST};
      }
      .ghw-mtype:not([data-sel="1"]):hover {
        border-color: ${FOREST};
        box-shadow: 0 6px 18px rgba(27,67,50,0.10);
        transform: translateY(-1px);
      }
      .ghw-primary:not(:disabled):hover {
        background: ${FOREST_DEEP} !important;
      }
      .ghw-cta-outline:hover {
        background: ${COPPER};
        color: ${WHITE} !important;
      }
      .ghw-month-nav:hover {
        color: ${COPPER};
      }
      .ghw-back:hover {
        text-decoration: underline;
      }
      .ghw-spinner {
        display: inline-block;
        width: 14px; height: 14px;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: ${WHITE};
        border-radius: 50%;
        animation: ghw-shimmer-spin 0.7s linear infinite;
        vertical-align: -2px;
        margin-right: 8px;
      }
      @keyframes ghw-shimmer-spin {
        to { transform: rotate(360deg); }
      }
      @media (max-width: 480px) {
        .ghw-mtype-row { flex-direction: column !important; }
        .ghw-times-grid {
          grid-template-columns: repeat(2, 1fr) !important;
        }
        .ghw-form-row { grid-template-columns: 1fr !important; }
        .ghw-h1 { font-size: 26px !important; }
        .ghw-day { min-height: 38px !important; min-width: 38px !important; }
      }
    `;
    document.head.appendChild(style);
  }, []);
}

export default function BookingPage() {
  const { slug } = useParams();
  useInjectedStyles();

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
        <div style={styles.errorCard}>
          <div style={styles.errorIcon} aria-hidden="true">!</div>
          <h1 style={styles.errorTitle}>Booking page unavailable</h1>
          <p style={styles.errorMessage}>{infoError}</p>
        </div>
      </PageShell>
    );
  }

  // ── Render: loading ───────────────────────────────────────────────
  if (!info) {
    return (
      <PageShell>
        <div style={styles.loadingWrap}>
          <div style={{ ...styles.shimmerLine, width: "60%", height: 24, marginBottom: 14 }} className="ghw-shimmer" />
          <div style={{ ...styles.shimmerLine, width: "90%", height: 14, marginBottom: 8 }} className="ghw-shimmer" />
          <div style={{ ...styles.shimmerLine, width: "80%", height: 14 }} className="ghw-shimmer" />
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
      <header style={{ marginBottom: 28 }}>
        <div style={styles.tinyEyebrowForest}>
          Gruening Health &amp; Wealth
        </div>
        <div style={styles.tinyEyebrowCopper}>
          Schedule a Medicare conversation
        </div>
        <h1
          className="ghw-h1"
          style={styles.h1}
          data-testid="booking-agent-name"
        >
          Book time with {info.agent_name}
        </h1>
        {info.bio && <p style={styles.bio}>{info.bio}</p>}
        <div style={{ marginTop: 14 }}>
          <span style={styles.durationPill}>
            {info.appointment_duration}-minute appointment
          </span>
        </div>
        <div style={styles.copperDivider} />
      </header>

      <Stepper step={step} />

      <div style={{ marginTop: 4 }}>
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
            selectedDate={selectedDate}
            selectedTime={selectedTime}
            meetingType={meetingType}
            duration={info.appointment_duration}
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
    <div style={styles.pageBg}>
      <div style={styles.pageColumn}>{children}</div>
    </div>
  );
}

/* ── Stepper ───────────────────────────────────────────────────── */
function Stepper({ step }) {
  const items = [
    { n: 1, label: "Date" },
    { n: 2, label: "Time & Meeting" },
    { n: 3, label: "Your Details" },
  ];
  return (
    <div style={styles.stepperRow} role="progressbar"
         aria-valuemin={1} aria-valuemax={3} aria-valuenow={step}>
      {items.map((it, i) => {
        const active = it.n === step;
        const done = it.n < step;
        const bg = done ? COPPER : active ? FOREST : SOFT_GRAY;
        const fg = done || active ? WHITE : MUTED;
        const labelColor = active ? FOREST : MUTED;
        return (
          <div key={it.n} style={styles.stepperCol}>
            <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
              <div style={{
                ...styles.stepCircle,
                background: bg, color: fg,
                border: active ? `2px solid ${FOREST}` : "none",
              }}>
                {done ? "✓" : it.n}
              </div>
              {i < items.length - 1 && (
                <div style={{
                  flex: 1, height: 2,
                  background: done ? COPPER : BORDER,
                  margin: "0 8px",
                }} />
              )}
            </div>
            <div style={{
              ...styles.stepLabel, color: labelColor,
              fontWeight: active ? 700 : 600,
            }}>
              {it.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Step 1: calendar ──────────────────────────────────────────── */
function Step1Calendar({ days, today, windowEnd, isWorkingDay,
                         selectedDate, onPick }) {
  // Header label spans the first → last visible month in the strip.
  const headerLabel = useMemo(() => {
    if (!days.length) return "";
    const first = days[0];
    const last = days[days.length - 1];
    const sameYear = first.getFullYear() === last.getFullYear();
    const fmt = (d, withYear = true) =>
      d.toLocaleDateString(undefined, {
        month: "long", ...(withYear ? { year: "numeric" } : {}),
      });
    if (first.getMonth() === last.getMonth() && sameYear) return fmt(first);
    if (sameYear) {
      return `${fmt(first, false)} – ${fmt(last)}`;
    }
    return `${fmt(first)} – ${fmt(last)}`;
  }, [days]);

  return (
    <div data-testid="booking-step-1" style={styles.cardSurface}>
      <div style={styles.calendarHeader}>
        <h2 style={styles.monthTitle}>{headerLabel}</h2>
      </div>

      <div style={styles.weekdayHeader}>
        {["S","M","T","W","T","F","S"].map((d, i) => (
          <div key={`${d}-${i}`} style={styles.weekdayCell}>{d}</div>
        ))}
      </div>

      <div style={styles.dayGrid}>
        {days.map((d) => {
          const before = d < today;
          const afterWindow = windowEnd && d > windowEnd;
          const offDay = !isWorkingDay(d);
          const disabled = before || afterWindow || offDay;
          const sel = selectedDate &&
                       d.toDateString() === selectedDate.toDateString();
          const isToday = d.toDateString() === today.toDateString();
          return (
            <button
              key={d.toISOString()}
              disabled={disabled}
              onClick={() => onPick(d)}
              data-testid={`booking-day-${isoDateLocal(d)}`}
              aria-label={prettyDate(d)}
              className="ghw-day"
              style={{
                ...styles.dayCell,
                ...(disabled
                  ? styles.dayCellDisabled
                  : sel
                    ? styles.dayCellSelected
                    : styles.dayCellAvailable),
              }}>
              <span style={{
                fontSize: 15, fontWeight: 600,
                color: sel ? WHITE : disabled ? DISABLED_TEXT : CHARCOAL,
              }}>
                {d.getDate()}
              </span>
              {isToday && !sel && (
                <span style={{
                  position: "absolute", bottom: 6,
                  left: "50%", transform: "translateX(-50%)",
                  width: 4, height: 4, borderRadius: 4,
                  background: COPPER,
                }} aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>

      <p style={styles.helperText}>
        Greyed-out days aren't available for booking.
      </p>
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
  // Short date — weekday + month + day only, year-less for snappier read.
  const shortDate = selectedDate
    ? selectedDate.toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric",
      })
    : "";
  return (
    <div data-testid="booking-step-2" style={styles.cardSurface}>
      <button onClick={onBack} className="ghw-back" style={styles.backLink}
              aria-label="Go back to date picker">
        ← Pick a different day
      </button>

      <h2 style={styles.dateHeading}>{shortDate}</h2>

      <div style={{ marginTop: 16 }}>
        <div style={styles.sectionLabel}>Available times</div>

        {slotsLoading ? (
          <div className="ghw-times-grid" style={styles.timesGrid}>
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="ghw-shimmer"
                   style={{ height: 48, borderRadius: 8 }} />
            ))}
          </div>
        ) : slots.length === 0 ? (
          <div style={styles.emptyTimes}>
            {slotsReason || "No times available for this day."}
          </div>
        ) : (
          <div className="ghw-times-grid" style={styles.timesGrid}>
            {slots.map((s) => {
              const sel = s === selectedTime;
              return (
                <button
                  key={s}
                  onClick={() => setSelectedTime(s)}
                  data-testid={`booking-time-${s}`}
                  className="ghw-time"
                  style={{
                    ...styles.timeBtn,
                    ...(sel ? styles.timeBtnSelected : null),
                  }}>
                  {prettyTime(s)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {meetingTypes.length > 1 && selectedTime && (
        <div style={{ marginTop: 24 }}>
          <div style={styles.sectionLabel}>How would you like to meet?</div>
          <div className="ghw-mtype-row" style={styles.mtypeRow}>
            {meetingTypes.includes("phone") && (
              <MeetingTypeCard
                emoji="📞"
                title="Phone Call"
                helper="We'll call you at the number you provide"
                selected={meetingType === "phone"}
                onClick={() => setMeetingType("phone")}
                testId="booking-meeting-phone" />
            )}
            {meetingTypes.includes("video") && (
              <MeetingTypeCard
                emoji="💻"
                title="Video Call"
                helper="Join via the link in your confirmation email"
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
        className="ghw-primary"
        style={{
          ...styles.primaryBtn, marginTop: 28,
          opacity: (!selectedTime || !meetingType) ? 0.45 : 1,
          cursor: (!selectedTime || !meetingType) ? "not-allowed" : "pointer",
        }}>
        Continue
      </button>
    </div>
  );
}

function MeetingTypeCard({ emoji, title, helper, selected, onClick, testId }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      data-sel={selected ? "1" : "0"}
      className="ghw-mtype"
      style={{
        ...styles.mtypeCard,
        ...(selected ? styles.mtypeCardSelected : null),
      }}>
      <div style={{
        fontSize: 28, lineHeight: 1, marginBottom: 8,
        color: selected ? COPPER : CHARCOAL,
      }} aria-hidden="true">
        {emoji}
      </div>
      <div style={{
        fontWeight: 700, fontSize: 16,
        color: selected ? FOREST : CHARCOAL,
      }}>
        {title}
      </div>
      <div style={{
        fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.45,
      }}>
        {helper}
      </div>
    </button>
  );
}

/* ── Step 3: details ───────────────────────────────────────────── */
function Step3Details({ form, setForm, selectedDate, selectedTime,
                         meetingType, duration,
                         onBack, onSubmit, submitting, submitError }) {
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const summaryDate = selectedDate
    ? selectedDate.toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric",
      })
    : "";

  return (
    <div data-testid="booking-step-3" style={styles.cardSurface}>
      <button onClick={onBack} className="ghw-back" style={styles.backLink}
              aria-label="Go back to time picker">
        ← Back to times
      </button>

      <h2 style={styles.dateHeading}>Your details</h2>

      <div className="ghw-form-row" style={styles.formGrid2col}>
        <Field label="First name" required>
          <input className="ghw-input" style={styles.input}
                 value={form.first_name}
                 onChange={set("first_name")}
                 data-testid="booking-first-name"
                 autoComplete="given-name" />
        </Field>
        <Field label="Last name" required>
          <input className="ghw-input" style={styles.input}
                 value={form.last_name}
                 onChange={set("last_name")}
                 data-testid="booking-last-name"
                 autoComplete="family-name" />
        </Field>
      </div>

      <Field label="Phone number" required>
        <input className="ghw-input" style={styles.input}
               value={form.phone}
               onChange={set("phone")} type="tel"
               data-testid="booking-phone"
               autoComplete="tel" />
      </Field>

      <Field label="Email address" hint="optional">
        <input className="ghw-input" style={styles.input}
               value={form.email}
               onChange={set("email")} type="email"
               data-testid="booking-email"
               autoComplete="email" />
      </Field>

      <Field label="Reason for appointment" required>
        <div style={{ position: "relative" }}>
          <select className="ghw-select"
                  style={{
                    ...styles.input,
                    paddingRight: 40,
                    appearance: "none",
                    WebkitAppearance: "none",
                    MozAppearance: "none",
                  }}
                  value={form.booking_reason}
                  onChange={set("booking_reason")}
                  data-testid="booking-reason">
            <option value="">Choose one…</option>
            {BOOKING_REASONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <span aria-hidden="true" style={styles.selectArrow}>▾</span>
        </div>
      </Field>

      <Field label="Notes" hint="optional">
        <textarea className="ghw-textarea"
                  style={{ ...styles.input, height: 96, resize: "vertical" }}
                  value={form.notes} onChange={set("notes")}
                  placeholder="Anything else we should know?"
                  data-testid="booking-notes"
                  maxLength={500} />
      </Field>

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

      {/* Appointment summary */}
      {selectedDate && selectedTime && (
        <div style={styles.summaryBox} aria-live="polite">
          <div style={styles.summaryLabel}>Your appointment</div>
          <div style={styles.summaryRow}>
            <span style={styles.summaryIcon} aria-hidden="true">📅</span>
            <span>{summaryDate} at {prettyTime(selectedTime)}</span>
          </div>
          <div style={styles.summaryRow}>
            <span style={styles.summaryIcon} aria-hidden="true">
              {meetingType === "video" ? "💻" : "📞"}
            </span>
            <span>
              {meetingType === "video" ? "Video Call" : "Phone Call"}
              {duration ? ` · ${duration} minutes` : ""}
            </span>
          </div>
        </div>
      )}

      {submitError && (
        <div style={styles.errorBanner} data-testid="booking-submit-error">
          {submitError}
        </div>
      )}

      <button onClick={onSubmit} disabled={submitting}
              data-testid="booking-submit"
              className="ghw-primary"
              style={{
                ...styles.primaryBtn, marginTop: 18,
                opacity: submitting ? 0.7 : 1,
                cursor: submitting ? "not-allowed" : "pointer",
              }}>
        {submitting ? (
          <>
            <span className="ghw-spinner" aria-hidden="true" />
            Booking…
          </>
        ) : (
          "Confirm appointment"
        )}
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

  const dateLabel = prettyDate(new Date(confirmation.date));
  const timeLabel = prettyTime(confirmation.time);

  return (
    <div data-testid="booking-confirmation" style={styles.confirmCard}>
      <div style={styles.confirmCheck} aria-hidden="true">✓</div>
      <h1 style={styles.confirmTitle}>
        You're all set, {confirmation.client_first_name || "friend"}!
      </h1>
      <p style={styles.confirmSubtitle}>
        Your appointment is confirmed.
      </p>

      <div style={styles.confirmInfoCard}>
        <ConfirmRow icon="📅" label="When"
                     value={`${dateLabel} · ${timeLabel}`} />
        <ConfirmRow
          icon={confirmation.meeting_type === "video" ? "💻" : "📞"}
          label={confirmation.meeting_type === "video" ? "Meeting" : "How"}
          value={
            confirmation.meeting_type === "video"
              ? (confirmation.has_email
                  ? "Video link arrives by email before your appointment"
                  : "Video link sent to you before your appointment")
              : `${info.agent_name} will call you`
          } />
        <ConfirmRow icon="👤" label="With" value={info.agent_name} last />
      </div>

      <a href={gUrl} target="_blank" rel="noopener noreferrer"
         data-testid="booking-add-to-calendar"
         className="ghw-cta-outline"
         style={styles.outlineCta}>
        Add to Google Calendar
      </a>

      <p style={styles.confirmFooter}>
        Questions? Contact {info.agent_name} for help with your appointment.
      </p>
    </div>
  );
}

function ConfirmRow({ icon, label, value, last }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12,
      padding: "12px 0",
      borderBottom: last ? "none" : `1px solid ${BORDER}`,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: LIGHT_GREEN, color: FOREST,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, fontSize: 16,
      }} aria-hidden="true">{icon}</div>
      <div style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
        <div style={{
          fontSize: 11, color: MUTED, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: 0.6,
        }}>{label}</div>
        <div style={{ fontSize: 15, color: CHARCOAL, marginTop: 2 }}>
          {value}
        </div>
      </div>
    </div>
  );
}

/* ── Form field primitive ──────────────────────────────────────── */
function Field({ label, hint, required, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={styles.fieldLabel}>
        {label}
        {required && (
          <span style={{ color: COPPER, marginLeft: 4 }} aria-hidden="true">
            *
          </span>
        )}
        {hint && (
          <span style={{ color: MUTED, fontWeight: 500, marginLeft: 6 }}>
            ({hint})
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

/* ── Style table ───────────────────────────────────────────────── */
const styles = {
  /* shell */
  pageBg: {
    minHeight: "100vh", background: CREAM, color: CHARCOAL,
    fontFamily: SANS,
    padding: "32px 16px",
  },
  pageColumn: { maxWidth: 680, margin: "0 auto" },

  /* header */
  tinyEyebrowForest: {
    color: FOREST, fontSize: 12, letterSpacing: 1.4,
    textTransform: "uppercase", fontWeight: 600,
  },
  tinyEyebrowCopper: {
    color: COPPER, fontSize: 11, letterSpacing: 1.2,
    textTransform: "uppercase", fontWeight: 700, marginTop: 4,
  },
  h1: {
    margin: "12px 0 0 0", color: FOREST, fontSize: 32,
    lineHeight: 1.2, fontWeight: 700, fontFamily: SERIF,
    letterSpacing: -0.2,
  },
  bio: {
    color: MUTED, marginTop: 12, fontSize: 15,
    lineHeight: 1.55, marginBottom: 0,
  },
  durationPill: {
    display: "inline-block", background: FOREST, color: WHITE,
    fontSize: 12, fontWeight: 600, padding: "5px 12px",
    borderRadius: 999, letterSpacing: 0.2,
  },
  copperDivider: {
    height: 2, background: COPPER, width: 48,
    marginTop: 22, borderRadius: 2,
  },

  /* stepper */
  stepperRow: {
    display: "flex", gap: 0, marginBottom: 20,
    alignItems: "stretch",
  },
  stepperCol: {
    flex: 1, display: "flex", flexDirection: "column",
    alignItems: "stretch",
  },
  stepCircle: {
    width: 30, height: 30, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 13, fontWeight: 700, flexShrink: 0,
  },
  stepLabel: {
    fontSize: 12, marginTop: 8, paddingLeft: 0,
  },

  /* card surface used by each step */
  cardSurface: {
    background: WHITE, borderRadius: 12, padding: 24,
    border: `1px solid ${BORDER}`,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },

  /* calendar */
  calendarHeader: {
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: 14,
  },
  monthTitle: {
    margin: 0, color: FOREST, fontSize: 18, fontWeight: 700,
    fontFamily: SERIF,
  },
  weekdayHeader: {
    display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
    gap: 4, marginBottom: 4,
  },
  weekdayCell: {
    textAlign: "center", color: MUTED, fontSize: 11,
    fontWeight: 700, padding: "6px 0",
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  dayGrid: {
    display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4,
  },
  dayCell: {
    position: "relative",
    minHeight: 44, minWidth: 44,
    display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 8, padding: 0,
    transition: "background-color 120ms ease, border-color 120ms ease, transform 120ms ease",
  },
  dayCellAvailable: {
    background: WHITE, border: `1px solid ${BORDER}`,
    color: CHARCOAL, cursor: "pointer",
  },
  dayCellSelected: {
    background: FOREST, border: `2px solid ${FOREST}`,
    color: WHITE, cursor: "pointer",
    boxShadow: `0 0 0 3px rgba(181, 69, 27, 0.20)`,
  },
  dayCellDisabled: {
    background: SOFT_GRAY, border: `1px solid ${SOFT_GRAY}`,
    color: DISABLED_TEXT, cursor: "not-allowed",
  },
  helperText: {
    color: MUTED, fontSize: 13, marginTop: 14, marginBottom: 0,
  },

  /* navigation between steps */
  backLink: {
    background: "none", border: "none", color: COPPER,
    cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600,
  },

  dateHeading: {
    margin: "12px 0 0 0", color: FOREST, fontSize: 20,
    fontWeight: 700, fontFamily: SERIF,
  },

  sectionLabel: {
    fontSize: 12, fontWeight: 700, color: MUTED,
    textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 10,
  },

  /* time grid */
  timesGrid: {
    display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10,
  },
  timeBtn: {
    background: WHITE, border: `1px solid ${BORDER}`,
    color: CHARCOAL, padding: "14px 10px", borderRadius: 8,
    fontWeight: 600, fontSize: 15, cursor: "pointer",
    minHeight: 48,
    transition: "background-color 120ms ease, border-color 120ms ease, color 120ms ease",
  },
  timeBtnSelected: {
    background: FOREST, color: WHITE,
    border: `1px solid ${FOREST}`,
    borderLeft: `3px solid ${COPPER}`,
  },
  emptyTimes: {
    color: MUTED, padding: "20px 0", fontSize: 14, textAlign: "center",
  },

  /* meeting type */
  mtypeRow: {
    display: "flex", gap: 12,
  },
  mtypeCard: {
    flex: 1, padding: 20, borderRadius: 12,
    border: `1.5px solid ${BORDER}`,
    background: WHITE, textAlign: "left", cursor: "pointer",
    minHeight: 100,
    transition: "border-color 120ms ease, box-shadow 160ms ease, transform 160ms ease, background-color 120ms ease",
  },
  mtypeCardSelected: {
    border: `2px solid ${FOREST}`, background: LIGHT_GREEN,
  },

  /* form */
  formGrid2col: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
  },
  fieldLabel: {
    display: "block", fontSize: 13, fontWeight: 600,
    color: CHARCOAL, marginBottom: 6,
  },
  input: {
    width: "100%", padding: "12px 14px", borderRadius: 8,
    border: `1.5px solid ${BORDER}`,
    fontSize: 16, boxSizing: "border-box",
    minHeight: 46, background: WHITE, color: CHARCOAL,
    fontFamily: SANS,
    transition: "border-color 120ms ease, box-shadow 120ms ease",
  },
  selectArrow: {
    position: "absolute", right: 14, top: "50%",
    transform: "translateY(-50%)", color: COPPER,
    fontSize: 14, pointerEvents: "none", fontWeight: 700,
  },

  /* summary */
  summaryBox: {
    background: LIGHT_GREEN, borderRadius: 10, padding: 16,
    marginTop: 18,
  },
  summaryLabel: {
    color: FOREST, fontWeight: 700, fontSize: 13,
    textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10,
  },
  summaryRow: {
    display: "flex", alignItems: "center", gap: 10,
    color: CHARCOAL, fontSize: 14, marginTop: 4,
  },
  summaryIcon: {
    fontSize: 16, width: 22, textAlign: "center",
  },

  /* primary button */
  primaryBtn: {
    background: FOREST, color: WHITE, border: "none",
    borderRadius: 10, padding: 16, fontWeight: 700,
    fontSize: 16, width: "100%", minHeight: 52,
    fontFamily: SANS,
    transition: "background-color 120ms ease, opacity 120ms ease",
  },

  /* errors */
  errorBanner: {
    marginTop: 14, padding: "12px 14px",
    background: "#FEE2E2", color: "#991B1B",
    borderLeft: "4px solid #DC2626", borderRadius: 6,
    fontSize: 14, fontWeight: 500,
  },
  errorCard: {
    background: WHITE, padding: 36, borderRadius: 12,
    border: `1px solid ${BORDER}`, textAlign: "center",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  errorIcon: {
    width: 48, height: 48, borderRadius: "50%",
    background: LIGHT_GREEN, color: FOREST,
    fontSize: 24, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 16px auto",
  },
  errorTitle: {
    color: FOREST, fontSize: 22, margin: "0 0 8px 0",
    fontFamily: SERIF, fontWeight: 700,
  },
  errorMessage: { color: MUTED, margin: 0, fontSize: 15 },

  /* loading */
  loadingWrap: {
    background: WHITE, padding: 24, borderRadius: 12,
    border: `1px solid ${BORDER}`,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  shimmerLine: {
    height: 14, borderRadius: 6,
  },

  /* confirmation */
  confirmCard: {
    background: WHITE, borderRadius: 14, padding: "36px 28px",
    border: `1px solid ${BORDER}`, textAlign: "center",
    boxShadow: "0 4px 18px rgba(27, 67, 50, 0.08)",
  },
  confirmCheck: {
    width: 64, height: 64, borderRadius: "50%",
    background: FOREST, color: WHITE,
    fontSize: 32, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 16px auto",
    boxShadow: `0 6px 18px rgba(27, 67, 50, 0.22)`,
  },
  confirmTitle: {
    color: FOREST, margin: 0, fontSize: 28, fontWeight: 700,
    fontFamily: SERIF, letterSpacing: -0.2,
  },
  confirmSubtitle: {
    color: MUTED, marginTop: 8, marginBottom: 0, fontSize: 16,
  },
  confirmInfoCard: {
    background: CREAM, borderRadius: 10, padding: "4px 18px",
    margin: "20px auto 0 auto", maxWidth: 440, textAlign: "left",
    border: `1px solid ${BORDER}`,
  },
  outlineCta: {
    display: "inline-block", marginTop: 22,
    color: COPPER, background: WHITE,
    border: `1.5px solid ${COPPER}`,
    padding: "12px 24px", borderRadius: 10,
    fontWeight: 700, fontSize: 15, textDecoration: "none",
    fontFamily: SANS,
    transition: "background-color 120ms ease, color 120ms ease",
  },
  confirmFooter: {
    color: MUTED, fontSize: 13, marginTop: 18, marginBottom: 0,
  },
};
