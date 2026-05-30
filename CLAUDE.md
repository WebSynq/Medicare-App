# GHW Medicare Agent Portal — Session Context

## Stack
- Frontend (current, production): React CRA + Tailwind + shadcn/ui → Vercel
- Frontend (next, on the `nextjs-app` branch — see "Next.js rebuild"
  section below): Next.js 14 App Router + TypeScript + Tailwind v3 +
  shadcn/ui new-york style. Awaiting Vercel project cutover.
- Backend: FastAPI (Python 3.11.9) → Render
- Database: MongoDB (Atlas) — DB_NAME = `gruening_medicare`
- Auth: JWT (HS256) + httpOnly cookie + CSRF middleware + magic-link sign-in
- Repo: github.com/WebSynq/Medicare-App
- Real GHW email domain: `grueninghealthwealth.com`
  (the `grueninghw.com` references in older docs/code are aliases —
  production accounts use the longer domain.)
- Multi-tenant: GHW agency_id = `ghw_001`. Every lead / SOA / appointment /
  audit row carries this stamp; Phase 1+ scheduler queries filter on it.

## Team Accounts
| Name                    | Email                            | Role   |
|-------------------------|----------------------------------|--------|
| Tim Arnold              | tim@websynqdesign.com            | admin  |
| Matt Monacelli          | matt@grueninghealthwealth.com    | admin  |
| Cesar                   | cesar@grueninghealthwealth.com   | admin  |
| Michael                 | michael@grueninghealthwealth.com | admin  |
| Matt Monacelli (legacy) | admin@grueninghw.com             | admin  |

## What's Built
### Core (single-tenant baseline)
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

### CNA + AI Client Intelligence (May 2026)
- CNA tab on client profile — COACHG-script-aligned structured assessment
  form, auto-saves on blur, pre-fills from existing lead data
- AI Client Intelligence panel on Overview tab — Claude-generated
  urgency score (0-100), recommendation (Supplement vs Advantage +
  Umbrella tier), exposures, talking points, cross-sell, objection
  handles, formal-recommendation script with copy-to-clipboard
- Lead scoring + Today-page priority widget — heuristic urgency model
  stamps `ai_score` on every lead via the daily-brief tick; sortable
  AI column on Clients list
- Daily Brief — APScheduler cron at 12:00 UTC, emails each agent their
  top-10 priority calls; widget on /today reads `agent_daily_briefs`
- 21 tests in `test_cna.py`

### Multi-Tenant SaaS — Phases 1-6 (all on staging, not yet merged to main)
**Phase 1 — Foundation**
- `tiers.py` — FEATURE_REGISTRY (29 keys), TIER_DEFAULTS, OVERAGE_RATES
- `agency_models.py` — Pydantic shapes for Agency, UsageEvent,
  AgencyUsageSummary, Invitation
- `seed.py` — GHW agency seeded at `agency_id="ghw_001"` with every
  feature ON + `super_admin=True`; `backfill_agency_id_on_users` for
  legacy rows
- New deps: `get_agency`, `require_super_admin`, `require_feature`,
  `require_billing_active`, `check_seat_available`
- JWT now carries `agency_id`, `agency_tier`, `super_admin`,
  `features` (sorted list of enabled keys)
- 28 tests in `test_phase1_foundation.py`

**Phase 2 — Metering**
- `metering.py` — `track_ai_usage` / `track_email_sent` /
  `track_storage_write` / `track_app_intake` (fire-and-forget via
  `asyncio.create_task`); `check_ai_limit` / `check_email_limit` /
  `check_app_intake_limit` (live reads, super-admin bypass)
- Monthly rollup at 06:00 UTC on day 1 → `agency_usage_summary`
- Wired into: cna_router AI call, application_router /extract,
  security_intelligence Claude triage, ghl_import_router tag mapping,
  resend_client.send_email (accepts `agency_id` kwarg)
- 15 tests in `test_phase2_metering.py`

**Phase 3 — Stripe billing**
- `stripe_service.py` — webhook signature verification, idempotent
  event dispatch, state machine (trialing → active → past_due →
  suspended → active)
- `billing_router.py` — `/api/billing/webhook` (public, HMAC),
  `/create-checkout`, `/portal`, `/subscription`, `/upcoming`
- Grace-period sweep — daily cron at 07:00 UTC: past_due > 7 days →
  suspended, day-3 warning email
- 5 templated billing emails (failed / grace warning / received /
  suspended / trial ending)
- **Mock mode when `STRIPE_SECRET_KEY` is unset** — checkout +
  portal endpoints 503 with a clear message; webhook still 400s on
  bad signatures
- Feature gates on AI endpoints: `cna` (form), `ai_client_intelligence`
  (AI on top), `ai_application_intake` (/extract), `ghl_import`
  (/map-tags). GHW super_admin bypasses all gates.
- 19 tests in `test_phase3_billing.py`

**Phase 4 — Per-agency email domains**
- `resend_domains.py` — never-raise Resend API wrapper
  (add / get / verify / delete)
- `email_domain_router.py` — owner-only setup + DNS records returned
  to the agency for their registrar; /verify polls Resend
- `resend_client.send_email` — `_resolve_from_address(agency_id)`
  picks the agency's `from_name <from_email>` when verified,
  falls back to GHW platform default otherwise
- 23 tests in `test_phase4_email_domains.py`

**Phase 5 — Super Admin Panel**
- `super_admin_router.py` — 7 endpoints under `/api/super-admin/*`:
  agencies list / get / patch + agency usage, users list / patch,
  system overview. Every endpoint `require_super_admin()` gated,
  every PATCH audit-logged. Self-modification refused.
- `SuperAdmin.jsx` — 4 tabs (Agencies / Users / Usage / System).
  Server-authoritative access gate via `/super-admin/system` ping
  on mount; non-super-admins bounced to /today. Tier patch supports
  `apply_tier_defaults=true` to rebuild features+limits from
  TIER_DEFAULTS.
- 31 tests in `test_phase5_super_admin.py`

**Phase 6 — Owner Settings**
- `agency_settings_router.py` — 5 endpoints under `/api/agency/*`:
  GET/PATCH /settings (name edit, owner/admin only — tier/billing
  are super-admin-only), GET /usage (live aggregate w/ progress-bar
  limits), GET/PATCH /users (seat list + deactivate teammates,
  owner/admin only, cross-agency surfaces as 404 not 403)
- `OwnerSettings.jsx` at `/settings/agency` — 4 tabs (Agency / Seats /
  Usage / Billing). Reuses existing `InviteAgentModal` + Phase 3
  `/api/billing/portal`. Stripe mock-mode banner on Billing tab.
- 19 tests in `test_phase6_owner_settings.py`

### Tier structure
| Tier        | Price       | Seats        | Notes                                |
|-------------|-------------|--------------|--------------------------------------|
| Beta        | $297 / mo   | 3            | Every feature ON for early-access    |
| Foundation  | $297 / mo   | 5            | CRM + leads + SOA + audit log        |
| Growth      | $497 / mo   | 15           | + booking, app intake AI, GHL import |
| Domination  | $997 / mo   | Unlimited    | + CNA, AI client intelligence, AEP   |

- **Tests: 441 passing** (mongomock-motor + TestClient).

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

## Render deployment

Service name: **`ghw-medicare-backend`** (Oregon, Python). `render.yaml`
at the repo root codifies the service plan (`standard`), region, runtime,
health-check path (`/api/health`), graceful shutdown delay (120s), and
auto-deploy trigger (`commit`). Everything else — env vars, build
command, start command, root dir — lives in the Render dashboard so
`render.yaml` stays minimal and rotating a secret never requires a
repo edit.

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

**Added during Phase 3 multi-tenant billing:**
- `STRIPE_SECRET_KEY` — Stripe API secret. Test mode key
  (`sk_test_...`) on staging, live key (`sk_live_...`) on prod.
  Never logged, never echoed in responses. When unset, the user-
  facing billing endpoints 503 with a clear message; the webhook
  endpoint still 400s on bad signatures.
- `STRIPE_WEBHOOK_SECRET` — `whsec_...` value from the Stripe
  webhook endpoint config. Required to verify inbound webhook
  signatures. Without it the webhook hard-refuses (400).
- `STRIPE_PRICE_BETA` / `STRIPE_PRICE_FOUNDATION` /
  `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_DOMINATION` — Stripe price
  IDs (`price_...`) for each tier's monthly subscription. Used by
  `/api/billing/create-checkout` to start a Checkout Session.
- `SUPER_ADMIN_EMAILS` — comma-separated list of platform admin
  emails (Tim/Matt/Chase). These users bypass every feature flag
  and billing gate even if their agency row doesn't carry
  `super_admin=True`.

## Env Vars Required (Vercel)
REACT_APP_BACKEND_URL

## Rules
- Never break the test suite — current floor is **441 passing**.
- All new endpoints: auth required, rate limited, audit logged.
- Agent never sees another agent's data (IDOR).
- ANTHROPIC_API_KEY / STRIPE_SECRET_KEY / RESEND_API_KEY in Render
  env vars only — never in code, never echoed in responses.
- Python 3.11.9 compatible syntax only (no match statements, no
  3.12+ features).
- One commit per task.
- **Update this file in every phase commit with current test count
  and phase status** — the doc drift over Phases 1-6 cost us cycles
  on the next-session ramp-up; do not repeat.
- Multi-tenant scoping: every router that reads leads / appointments /
  audit_logs / SOA records MUST filter on `agency_id`. Pull the
  agency_id from `get_agency()` (request context) or `get_agency_id()`
  (static GHW fallback for schedulers).
- Feature flag enforcement is opt-in per endpoint via
  `Depends(require_feature("key"))`. Super admins always bypass.

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

## Multi-Tenant Scoping Patterns (Phase 1+)

### `get_agency()` — `deps.py`
FastAPI dependency that resolves the caller's agency record. Cached
on `request.state.agency`. Falls back to GHW (`ghw_001`) when the
caller has no `agency_id` stamp (legacy auth path).

### `get_agency_id()` — `deps.py`
Static helper returning the env-driven default (`ghw_001`). Used by
schedulers and batch jobs that have no request context. Every
scheduler query in `automations.py` filters on this.

### `require_feature(key)` — `deps.py`
FastAPI dep factory. 403 unless `agency.features[key]` is True.
Super admins bypass. Returns the agency dict on success.

### `require_super_admin()` — `deps.py`
403 unless `agency.super_admin=True` or user email is in
`SUPER_ADMIN_EMAILS` env.

### `require_billing_active()` — `deps.py`
402 (Payment Required) when `billing_status in {suspended,
cancelled}`. Trialing/active/past_due still allow writes.
Super admins bypass.

### `check_seat_available()` — `deps.py`
402 when `seats_active >= seats_max`. `seats_max=-1` means unlimited.

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

All scheduler queries now filter on `agency_id` (Phase 1+ scoping).

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

Security events bill to the GHW super_admin agency (platform cost,
not tenant-attributable).

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
  fallback when no API key. Gated on `ghl_import` feature flag.
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
- `stripe>=15.0.0,<16` (added Phase 3)
- All 441 tests pass on the new stack.

### Infrastructure (May 2026)
`render.yaml` at the repo root codifies the production service
shape: name (`ghw-medicare-backend`), plan (`standard`), region
(`oregon`), runtime (`python`), health-check path (`/api/health`),
graceful shutdown delay (120s), and auto-deploy trigger (`commit`).
Env vars, build/start commands, and rootDir stay in the Render
dashboard so secrets never live in repo and rotating a key doesn't
require a code edit.

### Memory hardening (May 2026)
Two-file pass to bound RSS growth on the long-lived 15-min
scheduler tick:
- `backend/security_intelligence.py` — `import gc`, hard caps on
  the prompt inputs before the Claude call (failed-logins `[:50]`,
  audit anomalies `[:20]`, ip_enrichments `[:10]`) plus a payload-
  size log line; the Anthropic `client.messages.create` call lives
  in a nested try/finally that does `del response; gc.collect()`;
  after the Mongo persist, `del stats, event_doc, ai` +
  `gc.collect()` before the return.
- `backend/automations.py` — every scheduler-tick cursor replaced
  with `.to_list(length=N)` (leads 500, appointments 200, users
  100, other 200) and each consume-loop ends with `del docs;
  gc.collect()`. Event-driven `run_new_lead_notification` +
  `run_soa_signed_notification` deliberately untouched. No
  behavior changes — filter logic, flag-first idempotency, email
  sends, GHL sync all byte-identical.
- Test count remains 441 (no new tests added in this pass —
  pure memory-management hardening).

### Scheduler hardening (May 2026)
Three follow-up fixes targeting boot-time stability:

- **invite_tokens TTL index aligned** — the `_PROD_INDEXES`
  declarative table and the manual `create_index` call in
  `on_startup` used to disagree on `expireAfterSeconds=0`,
  triggering an `IndexOptionsConflict` warning on every boot and
  potentially leaving production indexes without the TTL. Both
  paths now declare the same shape. **Action required: run
  `backend/scripts/fix_invite_tokens_index.py` once on prod before
  the next deploy** to reconcile any production index that landed
  without the TTL.
- **Schedulers staggered + coalesced** — every interval-triggered
  APScheduler job now carries `coalesce=True` plus a per-job
  `start_date` offset so the boot pile doesn't ignite at t=0:
    - `automations._tick` fires at T+5min
    - `dashboard_agg` fires at T+8min
    - `notifications generator` fires at T+3min
  All cron-triggered jobs (daily brief 12:00 UTC, backup 02:00,
  comtrack 06:00, metering day=1 06:00, stripe 07:00, statements
  day=1 08:00) already deferred on startup so they were left alone.
- **`security_intelligence` skips first run after startup** —
  module-level `_first_run_skipped` flag in
  `security_intelligence.py` makes the first call to
  `run_ai_security_analysis` a no-op skip. The second 15-min tick
  is the actual first analysis, by which point the worker is warm
  and connection pools have settled. Conftest resets the flag per
  test so the manual `/api/security/run-analysis` endpoint always
  exercises the real path under pytest.
- Test count remains 441 (no new tests added; conftest gained a
  single guard reset).


## Next.js rebuild (`nextjs-app` branch — May 2026, 20 phases shipped)

Full frontend rebuild from Create React App → Next.js 14 App Router on
the `nextjs-app` branch. All 20 phases (5 weeks of work) complete and
pushed. Backend untouched — same FastAPI service at api.ghwcrm.com.

**Stack:**
- Next.js 14.2 (App Router, all pages "use client" except public booking)
- TypeScript strict (minus exactOptionalPropertyTypes — incompatible
  with Radix UI's prop forwarding)
- Tailwind v3 + shadcn/ui (new-york style; 44 components installed)
- TanStack Query v5 + Table v8 + Virtual v3
- Zustand v5 with persist middleware (auth + impersonation + UI stores)
- Axios with X-CSRF-Token + X-Agent-ID interceptors
- react-big-calendar (themed via custom CSS sheet bound to HSL vars)
- recharts (Ops Console + Agency dashboard + reports)
- Framer Motion (page transitions in (authed) layout)
- Edge middleware route gating via httpOnly cookie presence

**Phase log (all merged to `nextjs-app`):**
- 1-7 — Foundation, auth bootstrap, sidebar, all 37 placeholder routes
- 8 — /today
- 9 — /clients (TanStack Table + Virtual, 100-row pagination, filters)
- 10 — /clients/[id] (6 tabs: Overview, CNA, Documents, SOA, Policies, Notes)
- 11 — /appointments (TanStack Table + revenue stats + outcome dialogs)
- 12 — /calendar (themed react-big-calendar, color-coded by booking_type)
- 13 — /commissions (live ComTrack + history + upload + calculator + leaderboard preview)
- 14 — /settings (6 tabs: Profile, Booking, Security, Integrations, Calendars, Agency)
- 15 — /leaderboard (medal podium 2/1/3 layout + self-row highlight)
- 16 — /applications (3-step wizard: extract → supporting → submit)
- 17 — /ops (single /api/ops/health aggregate, self-degrading sections, AI security panel)
- 18 — /super-admin (4 tabs: Agencies, Users, Usage, System)
- 19 — /agency + /reports/lead-sources + /audit + public /book/[slug]
- 20 — Polish (Framer Motion page transitions, loading.tsx, padding harmonization)

**Bundle sizes (largest first):**
- /ops 12.8 kB / 264 kB (recharts)
- /calendar 65.1 kB / 253 kB (react-big-calendar)
- /agency 11.4 kB / 287 kB (recharts × 3)
- /reports/lead-sources 4.17 kB / 273 kB (recharts)
- /appointments 11.5 kB / 225 kB
- /clients/[id] 17.2 kB / 216 kB
- /commissions 10.8 kB / 211 kB
- /clients 17 kB / 204 kB
- /settings 13.2 kB / 199 kB
- /super-admin 9.79 kB / 196 kB
- /applications 10.8 kB / 195 kB
- /book/[slug] 9.33 kB / 180 kB (public, no credentials)
- /audit 6.96 kB / 171 kB
- /today 7.41 kB / 157 kB
- /leaderboard 8.4 kB / 148 kB
- Shared baseline: 87.6 kB First Load JS

**Test floor:** still 441 backend tests (no test changes needed — frontend
rebuild only). Backend untouched on `nextjs-app`.

**Vercel cutover instructions (when ready):**
1. Create a new Vercel project pointing at the `nextjs-app` branch,
   root directory `app/`.
2. Set env vars:
   - `NEXT_PUBLIC_BACKEND_URL=https://api.ghwcrm.com` (production)
   - For staging: point at the staging Render URL.
3. Build command stays default (`next build`); output stays default
   (`.next/`).
4. Smoke-test on the preview URL before merging `nextjs-app` to
   `main`. Verify login, magic-link, clients list, client profile,
   calendar, appointments, settings.
5. Update CORS_ORIGINS on Render to include the new Vercel preview +
   prod URLs.
6. Once preview is green, merge `nextjs-app` → `main` and Vercel
   auto-deploys.
7. Park or delete the old CRA Vercel project after a week of overlap.

**Pre-existing CRA frontend** is untouched on `main` and stays running
until the cutover is approved. The `nextjs-app` branch is forward-only
work; do not back-port any changes to the CRA codebase.


## Pending

### Blocking merge of multi-tenant work (Phases 1-6) to main
- [ ] **End-to-end Stripe smoke test on staging** — checkout
      session against a real Stripe test customer, walk through
      payment-failed → grace → suspended → recover. Needs
      `STRIPE_SECRET_KEY` + price IDs set on staging Render.
- [ ] **Provision a real second agency on staging** — verify cross-
      tenant isolation end-to-end (lead create, CNA, dashboards)
      against a non-GHW tenant.
- [ ] **Resend domain registration smoke test** — register a real
      domain via the Settings → Email Domain flow, verify DNS,
      send a per-agency outbound to confirm FROM resolution.
- [ ] **GHL import with a real Private Integration Token** —
      pre-existing pending item; still blocking the original
      single-tenant merge too.

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
- [ ] **Set Phase 3 Stripe env vars on Render** — `STRIPE_SECRET_KEY`,
      `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` (4 tiers). Until
      then billing endpoints stay in mock mode (503).
- [ ] **Set `SUPER_ADMIN_EMAILS` env var on Render** —
      Tim/Matt/Chase emails comma-separated, so they bypass feature
      gates even when their agency row doesn't carry super_admin.

### Follow-up work (non-blocking)
- GHL import resume-on-restart (currently dies if Render restarts
  mid-flight; job stays at `status="running"` with no auto-recovery).
- Re-enable the Settings → MFA setup UI when ready (panel removed
  2026-05-25; backend endpoints still live).
- Two-tier account lockout (currently 5-in-15-min → 15-min lock;
  spec also wanted a 10-failure → 24-hour tier).
- `agent_name` legacy-row backfill (still listed under "Known Drift").
- Per-tenant security_intelligence — currently bills to GHW; split
  by tenant once we surface per-agency security findings.
- Thread `agency_id` through remaining `send_email` callsites
  (Phase 2 wired the daily-brief; birthday-window / enrolled-welcome /
  stale-lead / post-appointment / new-lead still untenanted).
- Invite seat-cap enforcement on backend — frontend already disables
  the button at cap; backend `check_seat_available()` isn't yet
  wired on `/auth/invite`.
- Pending-invite roster on Owner Settings → Seats tab — currently
  shows accepted users only.
