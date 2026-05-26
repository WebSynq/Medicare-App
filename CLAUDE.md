# GHW Medicare Agent Portal — Session Context

## Stack
- Frontend: React CRA + Tailwind + shadcn/ui → Vercel
- Backend: FastAPI (Python 3.11.9) → Render
- Database: MongoDB (Atlas) — DB_NAME = `gruening_medicare`
- Auth: JWT (HS256) + httpOnly cookie + CSRF middleware + magic-link sign-in
- Repo: github.com/WebSynq/Medicare-App
- Real GHW email domain: `grueninghealthwealth.com`
  (the `grueninghw.com` references in older docs/code are aliases —
  production accounts use the longer domain.)

## Team Accounts
| Name                    | Email                            | Role   |
|-------------------------|----------------------------------|--------|
| Tim Arnold              | tim@websynqdesign.com            | admin  |
| Matt Monacelli          | matt@grueninghealthwealth.com    | admin  |
| Cesar                   | cesar@grueninghealthwealth.com   | admin  |
| Michael                 | michael@grueninghealthwealth.com | admin  |
| Matt Monacelli (legacy) | admin@grueninghw.com             | admin  |

## What's Built
- Auth: magic-link sign-in (primary) + email/password (Option B) + TOTP MFA
  (opt-in per agent, see "MFA (TOTP)" below), invite-only register, lockout,
  profile PATCH, idle-timeout JWT (idle_exp + /auth/refresh)
- Leads: CRUD, GHL sync (best-effort), PDF export, regex-safe search,
  state normalization, full-field editing, tags system
- SOA: digital signature capture + agent-notification automation
- Documents: encrypted upload/download
- Commissions (ComTrack): /upload, /summary, /history, /live
- Admin commissions: /api/admin/commissions
- Audit log: admin/compliance query + CSV export endpoint
- Bookings: public per-agent booking page (`/book/:slug`) with HMAC token +
  honeypot + IP abuse limits
- Automations: 8 jobs on 15-min APScheduler (birthday, reminders, stale,
  enrolled welcome, post-appointment, new-lead, SOA-signed) +
  AI security analysis on the same tick
- Ops Console (`/ops`): military-themed admin dashboard (admin/owner or
  user.ops_access=True) — system/security/integrity/usage/automations/
  compliance + AI security panel with kill switch
- AI Security Intelligence (May 2026): Claude-triaged threat analysis,
  ipapi.co + AbuseIPDB enrichment, auto-ban + admin email alerts
- GHL Import System (May 2026): per-agent token, AI tag mapping,
  background bulk import, dedup, progress polling
- New Client from Application (May 2026): two-tab Step 1 in the
  application wizard (New Client AI-pre-fill OR Existing Client search)
- Security: CORS locked, /docs disabled, headers (CORP cross-origin),
  rate limits, CSRF cookies, PostHog locked down, MBI Fernet-encrypted,
  password history (last 5), per-IP booking blocks
- **Tests: 285 passing** (mongomock-motor + TestClient)

## Known Drift to Fix
- agent_name is empty for existing users — needs backfill migration
- Bearer-header auth path still active (deprecate before new routes)
- GHL Import: a mid-flight import dies if Render restarts (job stays at
  `status="running"` with no auto-resume). Acceptable MVP; resume-on-
  restart is a follow-up that needs APScheduler integration.

## Auth Architecture (Magic Link + TOTP MFA)

Two factor types share the same session machinery:

- **Magic link** — the primary path. The signed URL in the email IS
  the second factor; possession of the registered inbox stands in for
  TOTP for users who never enable an authenticator app.
- **TOTP MFA** (re-added 2026-05 as part of the HIPAA hardening pass) —
  opt-in per agent in Settings → Security. When enabled, password
  login returns a 5-minute `session_token` instead of a JWT, and the
  SPA redirects to `/mfa` for the challenge. See "MFA (TOTP)" section
  below.

Two paths land in the same session:

- **Option A (default)**: `POST /api/auth/magic-link {email}` →
  15-min single-use token emailed → user clicks
  `/auth/magic?token=...` → SPA POSTs to
  `/api/auth/magic-link/verify {token}` → JWT cookie planted,
  redirect to `/today`.
- **Option B**: `POST /api/auth/login {email, password}` →
  JWT cookie immediately. No second step.

Collection: `magic_link_tokens` — stores SHA-256 `token_hash`
(raw token only ever exists in the email link), `email`, `user_id`,
BSON-Date `created_at` / `expires_at`, `used` flag, `used_at`, `ip`.
Unique index on `token_hash`; TTL index on `expires_at` evicts
rows ~1 hour after expiry.

Security properties:
- Opaque 200 response on `/magic-link` regardless of email
  existence, rate-limit hit, or account status — never leaks
  account enumeration.
- Per-email cap 5/hour (silent) on top of slowapi IP cap 20/hour.
- Verify endpoint: 10/hour per IP. Single-use enforced atomically
  via `update_one(..., {"$set": {"used": true}})` with race-safe
  modified_count check.
- Magic link refuses pending/rejected/deactivated accounts (same
  gates as password login).
- Successful redeem clears any failed-login lockout for the email
  (proof of inbox control == fresh password reset equivalent).

Audit events: `magic_link_requested` (with sent / reason),
`magic_link_used`, `magic_link_verify_failed`, `login_success`
(with `method: "password" | "magic_link"`).

Email template: `send_magic_link_email` in `email_service.py`.
PHI-safe — first name + signed URL only. Both HTML (branded shell)
and plain-text alternative sent via Resend.

Frontend:
- `pages/Login.jsx` + `pages/HomePortal.jsx` — magic-link form
  default, "Sign in with password instead" toggle. After send,
  shows "Check your email" card with 60s resend cooldown.
- `pages/MagicLinkVerify.jsx` — route `/auth/magic`. `useRef`
  gate prevents StrictMode double-redeem.
- `pages/Settings.jsx` Security tab — sessions table only, no
  per-account MFA toggle.

## Commission Endpoint Keying (Wave 1)
agent_name unified across all commission endpoints — /commissions/summary,
/commissions/live, /commission/audit (`_scope_filter`), and /leaderboard
(`is_self`) all resolve the lookup key through `deps.resolve_agent_key`.
Rule: `agent_name` primary, `full_name` fallback for legacy records only.
Endpoints fail closed (400) when neither field is set.

## Env Vars Required (Render)

**Core (already set):**
MONGO_URL, DB_NAME, JWT_SECRET, CORS_ORIGINS, SEED_ADMIN_PASSWORD,
ENVIRONMENT, FRONTEND_URL, COMTRACK_API_KEY, GHL_* (5 vars — agency-
wide fallback only; per-agent GHL now uses ghl_integrations),
DOC_ENCRYPTION_KEY, SENTRY_DSN, JWT_ALGORITHM, JWT_EXPIRES_MINUTES,
ANTHROPIC_API_KEY, RESEND_API_KEY, PHI_FIELD_KEY

**Added during May 2026 hardening pass:**
- `MFA_ENCRYPTION_KEY` — Fernet key for TOTP secret at rest. Generate:
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
- `ADMIN_EMAIL` — recipient for account-lockout + AI security alerts
  when `system_config.alert_emails` is empty.
- `BOOKING_SECRET` — HMAC secret for the public booking-page anti-
  replay token. Same generation command as above. Without it the
  router falls back to a per-process random secret (tokens don't
  survive restart, fine for dev but bad for prod).
- `JWT_IDLE_TIMEOUT_MINUTES` — optional, default 30. Stamped into
  every JWT's `idle_exp` claim.
- `ABUSEIPDB_API_KEY` — optional. Free tier at abuseipdb.com
  (1000 lookups/day). Enriches the AI security loop's IP intel with
  crowdsourced abuse reports. Without it, ipapi.co only.

## Env Vars Required (Vercel)
REACT_APP_BACKEND_URL

## Commission Module — Phase 2 (Next Build)
New collections to add alongside existing ComTrack system:
- production_records (Plecto tracker data — seed from CSV)
- carrier_rates (commission schedule — hardcoded seed)
New endpoints to add:
- GET /api/commission/audit
- GET /api/commission/audit/summary
- POST /api/commission/audit/mark-resolved/{record_id}
- POST /api/commission/chat (Anthropic AI)
- GET /api/leaderboard (update with real data)
Import scripts:
- scripts/import_production.py
- scripts/import_rates.py

## Rules
- Never break existing 18 passing tests
- All new endpoints: auth required, rate limited, audit logged
- Agent never sees another agent's data (IDOR)
- ANTHROPIC_API_KEY in Render env vars only — never in code
- Python 3.11.9 compatible syntax only (no match statements, no 3.12+ features)
- One commit per task

## Agent Isolation Patterns

Workspace isolation is enforced server-side. Every new endpoint that
touches per-agent data MUST use the helpers below — do not roll your
own scoping or stamp `agent_id` off the request body.

### `agent_filter(current_user, override_agent_id=None)` — `deps.py`
Returns a MongoDB filter dict to scope a read.
- Admin / compliance → `{}` (full visibility), or
  `{"agent_id": override_agent_id}` when impersonating.
- Agent → `{"agent_id": current_user["id"]}` (override is silently
  ignored so a leaked header can't widen scope).

Use on every list endpoint:
```python
query = {**agent_filter(current_user), "status": "new"}
cursor = db.leads.find(query, {"_id": 0})
```

### `get_effective_agent(request, current_user, db)` — `deps.py`
FastAPI dependency that returns the user whose data should be stamped
on a write.
- Admin / compliance + `X-Agent-ID` header → returns that agent's user
  doc, with `_impersonated_by` + `_impersonated_by_id` metadata for
  audit logging.
- Agent + `X-Agent-ID` header → 403 (only privileged roles may
  impersonate).
- No header → returns `current_user` unchanged.

Use on every create / write endpoint that needs ownership stamping:
```python
async def create_lead(..., effective: dict = Depends(get_effective_agent)):
    doc["agent_id"]    = effective["id"]
    doc["agent_email"] = (effective.get("email") or "").lower() or None
    doc["agent_name"]  = effective.get("agent_name") or effective.get("full_name")
```

### IDOR check on single-resource GET/PATCH/DELETE
Pattern (see `leads_router._idor_or_403`): fetch the doc, then 404 if
missing, 403 if it exists but the caller isn't admin / compliance and
doesn't own it. Never trust the path id alone.

### `X-Agent-ID` header
Set automatically by the AgentContext → Axios interceptor pair in
`frontend/src/lib/api.js`. Admin impersonating an agent → every
request carries the header. Backend `get_effective_agent()` reads it;
`agent_filter()` reads it only when the caller passes
`override_agent_id` explicitly.

### `AgentContext` — `frontend/src/context/AgentContext.jsx`
React context provider wrapping `<App>`. `useAgent()` exposes:
- `selectedAgent`
- `isImpersonating`
- `setSelectedAgent(agent)`
- `clearAgent()`

Persists the selected agent to `localStorage` so the X-Agent-ID
header (a module-level var in `api.js` that resets on reload) and
the impersonation banner stay in sync after a page refresh.

### `ImpersonationBanner` — `frontend/src/components/ImpersonationBanner.jsx`
Drop directly under the page title on every data page. Renders
`null` when not impersonating, otherwise shows the orange-bordered
"Viewing as: [name]" pill. Already wired on AgentDashboard,
ClientsList, ClientProfile, ApplicationSubmission, CommissionsDashboard,
Leaderboard.

### Backfill / migration
`backend/scripts/migrate_agent_ownership.py` — one-shot backfill that
stamps `agent_id` on legacy records that pre-date the isolation
work, assigning them to the first admin user. Safe to re-run
(idempotent on records that already have `agent_id`). Already
executed in prod — **6,666 records stamped**.


## Built May 2026

### MFA (TOTP)
Per-agent opt-in TOTP. Endpoints under `/api/auth/mfa/*`:
`setup`, `verify-setup`, `verify`, `backup-code`, `disable`, `status`.
Secret is Fernet-encrypted at rest under `MFA_ENCRYPTION_KEY`. 8
single-use backup codes (bcrypt-hashed). Login flow returns
`{mfa_required: true, session_token}` instead of a JWT when the user
has MFA enabled — SPA redirects to `/mfa`. 5-failed-codes-in-15-min
per-user lockout in addition to the IP rate limit.

UI: Settings → Security used to include the setup/verify/disable
panel; **removed 2026-05-25 per Tim's call** — backend remains
fully functional, only the user-facing setup UI is hidden.
`MFAChallenge.jsx` (the login-time challenge page) is still wired.

### Session timeout
`idle_exp` claim (epoch seconds, default 30 min) + `jti` stamped on
every fresh JWT. `deps.get_current_user` 401s past `idle_exp`. SPA
activity tracker (`frontend/src/lib/session.js`) refreshes every
~20 min of detected activity via `POST /api/auth/refresh`
(10/min rate limit). Idle warning modal at 25 min, hard logout at
30 min.

### Password policy + history
`security.validate_password_strength` enforces 12 chars + complexity
+ common-password blocklist (20 entries). Last-5-passwords history
on `users.password_history` — `/profile/me` change endpoint rejects
re-use via bcrypt check against current + 4 most-recent hashes.

### Account lockout admin alert
Existing 5-in-15-min → 15-min lockout now triggers a best-effort
Resend email to `ADMIN_EMAIL` with IP / attempt count / unlock time.
Wrapped — Resend outage cannot convert auth failure to 5xx.

### MBI encryption
`mbi_number` is already in `LEAD_PHI_FIELDS` and round-trips via
`safe_lead_set`/`safe_lead_load` under existing `PHI_FIELD_KEY`.
Backfill for legacy plaintext rows: `backend/scripts/backfill_mbi_encryption.py`
(dry-run safe, batch 500, idempotent on Fernet prefix).

### Audit log improvements
`write_audit` now stamps `session_id` from the JWT `jti` via
`request.state.session_id` (plumbed in `deps.get_current_user`).
HIPAA 7-year retention comment in `server.py` + `audit_router.py`
forbidding TTL on `audit_logs`. New `GET /api/audit/export?format=csv|json`
(admin/compliance only, max 50k rows, audits its own invocation).

### Bookings system
`backend/booking_router.py` mounts `/api/book/*`:
- `GET /book/{slug}/info` — first-name agent profile (no email/
  phone/video link in payload)
- `GET /book/{slug}/token` — HMAC anti-replay token (10 min)
- `GET /book/{slug}/slots?date=YYYY-MM-DD`
- `POST /book/{slug}` — `PublicBookingPayload` with EmailStr +
  Literal booking_reason + hidden `website` honeypot field

Security: slug regex `^[a-z0-9-]{3,60}$`, rate limits per spec,
`booking_attempts` collection (TTL 30 days), `booking_blocks` per-IP
24-hour ban after 10 failures/hour. Response sanitization — POST
returns only `status/message/date/time/meeting_type`, no internal
IDs.

Frontend: `/book/:slug` page (`pages/BookingPage.jsx`) — public,
no auth wrapper, GHW-branded 3-step wizard with HMAC token fetch,
hidden honeypot input, submit double-click guard.

Per-agent config lives on `users.booking_settings` (slug, bio,
meeting_types, duration, working_hours, etc.); managed via Settings
→ Booking tab.

### Automations engine
`backend/automations.py` — APScheduler 15-min `_tick` runs:
1. `run_appointment_reminders` (48 / 24 / 1 hr)
2. `run_birthday_window_automation` (IL, 45 days pre-DOB)
3. `run_enrolled_welcome_automation`
4. `run_stale_lead_alerts` (30 days)
5. `run_post_appointment_followup` (24-25 hr post)
6. **AI security analysis** (added May 2026 — see below)

Plus event-driven: `run_new_lead_notification` (called from
leads_router create), `run_soa_signed_notification`. All flag-first
idempotent — same record cannot fire twice.

### Tags system
`Lead.tags: List[str]` on every lead. Agency tag library in
`db.tags` (per-agency, seeded with 21 Medicare tags on first boot).
Routes: `GET /api/tags`, `POST /api/tags` (admin/owner), `POST/DELETE
/api/leads/{id}/tags`, `GET /api/leads/tags/summary` (leadership).
`GET /api/leads?tags=a,b` filters with `$all`. UI: `TagBadgeRow` on
list, `AddTagPopover` + removable badges on detail.

### State field normalization
`models.normalize_state_field()` — `LeadBase` validator + matching
`backfill_state_normalization.py` script normalises `state` to a
2-letter uppercase code on every write. Backfill executed in prod.
Birthday-rule + dashboard band-aid `$or`/`.upper()` queries
collapsed to single `"state": "IL"` predicates.

### Full lead field editing
`LeadUpdate` model expanded from 3 fields → 18 (identity, address,
coverage, Medicare effective dates, status/notes). `ClientProfile.jsx`
edit mode renders a real form across all of them; field names match
`LeadBase` (`medicare_part_a_effective`, not `part_a_effective` — the
spec's shorter name would have created ghost fields).

### Ops Console (`/ops`)
Admin/owner OR `user.ops_access=True` only — gated on both backend
(`require_ops_access()` dep in `ops_router.py`) and frontend
(useEffect-based redirect in `OpsConsole.jsx`). Single
`GET /api/ops/health` aggregates: system, security, data integrity,
usage, automations, compliance, 7-day activity, threat log, AI
security. All sections degrade independently to `{"error":"unavailable"}`
on failure.

Military-theme UI: dark navy + amber/cyan, scanline overlay,
blinking classified banner, live clock, posture radar (6 dims),
line + bar charts, compliance command, BAA status board, AI
security panel (kill switch, last analysis, events feed, banned-IPs
table, IP lookup widget).

### AI Security Intelligence
`backend/security_intelligence.py` — runs every 15 min on the same
scheduler tick as the automations. Collects: failed logins, lockouts,
booking attacks, IP bans, audit anomalies (bulk/high-value events),
abandoned MFA. Enriches unique IPs (max 20/cycle) through ipapi.co
(+ optional AbuseIPDB if `ABUSEIPDB_API_KEY` set) — 24-hour
`ip_intelligence` cache. Detects impossible-travel (same actor,
different countries within 30 min). Asks Claude (`claude-sonnet-4-6`)
to triage with strict JSON output schema. If `system_config.security_config.ai_auto_ban_enabled`
AND threat_level ∈ {high, critical} → auto-bans IPs in `booking_blocks`
+ `ip_permanent_bans`. Emails alert recipients via
`email_templates.security_alert_email`. Persists every cycle to
`security_events`.

`backend/security_router.py` — 9 endpoints under `/api/security`:
events list/detail, IP lookup, ban/unban, banned-IPs, config
get/patch (the kill switch), run-analysis on demand, impossible-travel
history. All admin/owner-only. Token never returned in any response.
Never raises — `ANTHROPIC_API_KEY` unset (test env) returns safe
defaults but still persists the event row.

Frontend: `AISecurityPanel` lives inside the Ops Console below the
compliance section. Kill-switch toggle, last-analysis card with
RUN NOW button, expandable events feed, banned-IPs table with Unban
buttons, IP lookup widget.

### GHL sync — best-effort
Historically, `/api/applications/submit` raised a 502 if the GHL
`update_contact` call failed, killing the whole submission. Now
wrapped best-effort: response carries `ghl_synced: bool` +
`ghl_sync_error: str|None`, and the lead row gets
`ghl_sync_status: "synced"|"error"` stamped. Two existing
non-fatal GHL calls (PDF field push, canonical-fields push) were
already wrapped — verified.

### GHL Import System
**Per-agent** GHL connect + bulk contact import. Each agent pastes
their own Private Integration Token in Settings → GoHighLevel.

`backend/ghl_import_router.py` — 10 endpoints under `/api/ghl-import`:
- `POST /connect` — validates token (calls GHL `/locations/search`),
  stores Fernet-encrypted under `PHI_FIELD_KEY` in `ghl_integrations`
  (one row per agent, unique on `agent_id`).
- `DELETE /connect` — removes integration, leaves imported contacts.
- `GET /status` — connection info (never returns the token).
- `POST /preview` — first-page analysis: total, unique tags,
  missing-email %, missing-DOB %, duplicate estimate.
- `POST /map-tags` — Claude AI mapping (`claude-sonnet-4-6`) against
  23 portal tags. Returns full keyset (null for unmatched). Safe
  fallback when no API key.
- `POST /start` — creates `import_jobs` row + fires
  `BackgroundTasks`. 409 if a job already running for this agent.
- `GET /jobs` — last 10 per agent.
- `GET /jobs/{id}` — full progress (polled every 3s by SPA).
- `POST /jobs/{id}/cancel` — honored at next page boundary.
- `GET /jobs/{id}/report` — downloadable JSON report.

Import engine: 100 contacts/page, 0.1s rate-limit sleep, dedup on
`(ghl_contact_id OR email OR phone)` scoped to current agent_id.
Field mapping: standard + custom-field hints (`medicare_id`/`mbi`/
`current carrier`/etc. lowercased name match). Sends
`ghl_import_complete_email` on done via Resend.

Frontend: `GHLImportPanel` in Settings → Integrations → "GoHighLevel"
section. Connect card with token paste/show-hide, 4-step inline
wizard (Preview → Tag Mapping → Running with progress bar → Done),
import history table with per-job report download.

### New Client from Application
`ApplicationSubmission.jsx` Step 1 now offers a two-card mode pick:
- **New Client** — agent uploads main application PDF/image, AI
  pre-extracts via existing `/api/applications/extract`, agent
  reviews 9 fields in a confirmation form (with per-field
  `ConfidenceBadge` + amber-ring on warn-confidence), confirm
  creates a fresh lead via `POST /api/leads` and advances to
  Step 2 (Upload Files) with `selectedContact` set to the new
  lead.
- **Existing Client** — legacy search flow, unchanged.

Both paths converge on the same Step 2+ pipeline. `StepBar`
unchanged (the split is internal to Step 1).

### CORS / CORP fix
`SecurityHeadersMiddleware` was sending `Cross-Origin-Resource-Policy: same-site`,
which made the browser block cross-origin reads even when CORS
allowed the request — staging vercel.app ↔ staging onrender.com
was broken. Changed to `cross-origin`.

### CVE patches (May 2026)
`backend/requirements.txt` security upgrade pass:
- `fastapi==0.110.1` → **`0.116.2`** (needed for starlette 0.47.x
  upper bound — 0.110.1 capped at `<0.38.0`)
- `starlette` → **`0.47.2`** (explicit pin, was 0.37.2 transitive)
- `pymongo==4.5.0` → **`4.6.3`**
- `PyJWT>=2.10.1` → **`PyJWT==2.12.0`** (explicit pin)
- `cryptography>=42.0.8` → **`cryptography==46.0.6`** (explicit pin)
- All 285 tests still pass on the new stack.


## Pending

### Blocking merge to main
- [ ] **Test GHL import with a real Private Integration Token**
      — staging deploy, paste token in Settings, run a full import
      against a real GHL sub-account. Look at job completion email,
      Clients list, dedup behavior. This is the last gate before
      merging staging → main.

### Infra (Tim / Matt to action)
- [ ] **AWS env vars on Render** for the AI Application Intake
      (extracted-data Bedrock calls). Already used by
      `application_router.py` extraction path.
- [ ] **Render HIPAA BAA** — Matt to approve the $499/mo Scale plan.
      Blocks production cutover; currently surfaced on Ops Console
      Compliance section in red ("NOT SIGNED — Action Required").
- [ ] **MongoDB Atlas HIPAA BAA** — contact mongodb.com/hipaa
      (Tim's action). Also surfaced red on Ops Console.
- [ ] **AWS SES** — migration target for transactional mail. BAA
      after setup. Currently shown as "Migration Pending" on Ops
      Console.
- [ ] **Sentry BAA** — Matt to approve billing.

### Follow-up work (non-blocking)
- GHL import resume-on-restart (currently dies if Render restarts
  mid-flight; job stays at `status="running"` with no auto-recovery).
- Re-enable the Settings → MFA setup UI when ready (panel removed
  2026-05-25; backend endpoints still live).
- Two-tier account lockout (currently 5-in-15-min → 15-min lock;
  spec also wanted a 10-failure → 24-hour tier).
- `agent_name` legacy-row backfill (still listed under "Known Drift").
