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

- **Tests: 523 passed, 1 skipped — 524 collected** (mongomock-motor + TestClient).

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

### MongoDB schema hardening (May 2026)
Multi-tenant scale prep — index coverage + array growth bounds:
- **3 compound indexes added** to `_PROD_INDEXES` in `server.py`:
  - `leads (agency_id, status, created_at desc)` — collapses the
    in-memory sort tail on `list_leads`. The existing
    `(agency_id, status)` 2-key compound served the filter but the
    `created_at DESC` sort still had to materialize and sort all
    matching rows.
  - `appointments (agency_id, status, appointment_date)` — covers
    the 15-min APScheduler reminder scan
    (`{agency_id, status:"scheduled", appointment_date: range}`).
    Field order is equality predicates first, range last so the
    planner can range-scan a contiguous prefix.
  - `audit_logs (event_type, timestamp desc)` — covers
    `export_audit_events` plus `security_intelligence`'s
    high-value-event scan, both filter on event_type and order by
    timestamp DESC.
- **4 array fields capped via Pydantic `max_length`** in `models.py`:
  - `Lead.tags` → 50
  - `Lead.doctors` → 20
  - `Lead.prescriptions` → 50
  - `Lead.document_ids` → 500

  Caps apply on write only (Pydantic validation). Existing over-cap
  docs aren't rejected at read time — no migration needed.
- **Tests: 523 passed, 1 skipped — 524 collected** (4 new tests in
  `test_models_array_caps.py`, one per capped field, each covering
  both edges of the boundary: at-cap accepted, at-cap+1 rejected).

### Next.js sidebar parity — WS1 (May 2026)
First of three workstreams porting the CRA → Next.js gap to staging.
This pass touches `app/src/components/sidebar/nav-config.ts` only.
- **14 plain nav items added** to bring the Next.js sidebar to
  CRA parity: Command Center, Today, Pipeline, Calendar,
  Leaderboard, Birthday Rule, Renewals, Lead Sources, Super
  Admin, Agent Commissions, Accounting, Team, Data Import, Ops
  Console. Order, section grouping (Main / Reports / Platform /
  Admin), and per-item role gates mirror `frontend/src/components/
  Layout.jsx` exactly.
- **Role-gate constants ported verbatim**: `ADMIN_ROLES`,
  `ADMIN_OR_COMPLIANCE_ROLES` (includes cyber_security +
  sales_manager), `COMMAND_CENTER_ROLES`, `IMPERSONATION_ROLES`.
  Super Admin still uses the existing `superAdminOnly: true` hard
  gate on `User.super_admin === true`.
- **URL drift handled**: CRA links Super Admin → `/super-admin`
  and Ops Console → `/ops` (top-level). The Next.js pages live
  at `/admin/super-admin` and `/admin/ops`. The nav items link to
  the Next.js paths so the links work; top-level redirects can
  follow if URL parity becomes desirable.
- **Bell + Agent Switcher shipped as visible placeholders** in
  `NAV_FOOTER` — Bell → `/notifications` (page TBD), Switch
  Agent → `/agents` (Team roster — closest sensible landing
  surface until the AgentContext + `X-Agent-ID` interceptor are
  ported on their own branch). These are tracked follow-ups; the
  real bell wiring (poll-driven unread badge + NotificationPanel)
  and the real impersonation popover are NOT in this branch.
- **Routes that still 404 on click** (deferred to later
  workstreams or own branches): `/today`, `/pipeline`, `/calendar`,
  `/leaderboard`, `/birthday-rule`, `/renewals`, `/reports/lead-
  sources`, `/notifications`, `/agency`. The 404 is intentional
  feedback about what still needs porting; WS2 closes `/today`
  via the combined dashboard.
- **Verification**: `npm run typecheck` clean (exit 0), `npm run
  lint` clean. No backend changes, no test impact.

### Combined dashboard — WS2 (May 2026)
Second of three workstreams. Collapses CRA's two pages
(`TodayPage.jsx` agent view + `AgencyCommandCenter.jsx` leadership
view) into a single role-aware page at `/dashboard` in the Next.js
app. Agent always sees their day at the top; leadership roles
(COMMAND_CENTER_ROLES = owner/admin/coach/sales_manager/compliance/
accounting) see the same agent panel above plus an "Agency Overview"
section below.

Files touched (`app/` only, no backend changes):
- `app/src/app/(authed)/dashboard/page.tsx` — extended with role
  check (useAuthStore), period state, header period selector, and
  conditional `<AgencySection>` render below the existing agent
  blocks. Existing agent KPI row + AI priority list + bucket cards
  preserved as-is.
- `app/src/app/(authed)/dashboard/_agency-section.tsx` — NEW. 8-card
  KPI grid + 2 charts (Enrollments by Week, Revenue by Carrier) +
  sortable Agent Performance table + 3 alert cards (Stale Leads,
  Birthday Windows, Renewals Due). Ports
  `frontend/src/pages/AgencyCommandCenter.jsx` panel-for-panel,
  swapping CRA's hardcoded brand colors for theme-aware
  `hsl(var(--primary))` so the section matches the existing
  Next.js dark navy theme.
- `app/src/app/(authed)/dashboard/_period.ts` — NEW. Shared `Period`
  type + `PERIOD_TABS` constant so the page and the agency section
  can both reach it without a circular dep.
- `app/src/lib/api/dashboard.ts` — type drift fix. Updated three
  response shapes to match what the backend actually returns
  (verified against `backend/agency_dashboard_router.py`):
  - `enrollments_by_week`: added `label` (the chart's x-axis key)
    alongside the existing `week`/`count`.
  - `revenue_by_carrier`: added `count` (the row also carries a
    policy count, kept for forwards-compat).
  - `leads_by_source`: replaced placeholder `{source, count}` with
    real `{source, total, enrolled, conversion_rate}`.
  - `AgencyAlertsResponse`: added `stale_leads` / `birthday_windows`
    / `renewals_due` row arrays + row-level interfaces. The legacy
    `alerts: AgencyAlert[]` field stays optional and `@deprecated`
    so the existing `/admin/page.tsx` AlertsRow callsite keeps
    typechecking until it's migrated.

Patterns ported from CRA: dual-tier role gate (agent always sees
their day; leadership sees agency too), pill-style period tabs
(MTD/Last30/Last90/YTD), sortable column headers with arrow
indicators, status-dot + status-badge row prefix, click-row =
view-agent (placeholder action — fires a sonner toast pointing to
the AgentSwitcher follow-up since AgentContext + X-Agent-ID
interceptor aren't ported yet).

Existing /admin and /reports/revenue Recharts dataKey strings still
hardcode the stale field names (`week`, `count`) — typecheck passes
because Recharts dataKey is a free-form string, but those charts
keep rendering blank at runtime until they're migrated to the new
field names (`label`, `total`/`enrolled`). Tracked follow-up;
out-of-scope for WS2.

- **Verification**: `npm run typecheck` clean, `npm run lint` clean,
  `npm run build` clean (16.2 kB /dashboard bundle, prerendered
  static). No backend changes — backend test floor (524) unaffected.

### Accounting port — WS3 (May 2026)
Third and final Next.js parity workstream. Full port of the CRA
`AccountingDashboard.jsx` (1,753 lines) to the Next.js placeholder
at `/admin/accounting`. This is the QuickBooks-for-Medicare page —
the highest-value surface for agency owners and accounting staff.

Files (all under `app/src/app/(authed)/admin/accounting/`):
- `page.tsx` — page shell. Role gate (admin/owner/compliance/
  accounting, super_admin bypass) with client-side redirect to
  `/dashboard` for off-role users. Tabs are local state (not URL
  segments) so cross-tab handoffs (donut → Ledger pre-filtered,
  carrier card → Disputes create-modal pre-opened) work without
  router round-trips. CFO chat toggle in the header reserves
  right-side space when open via a Tailwind padding transition.
- `_overview-tab.tsx` — 6 KPIs + 12-month Recharts BarChart
  (Expected vs Received) + 2 donuts (Carrier / Product) + Top
  Agents progress list + Aging Report (4 buckets + drill-down)
  + Recent Disputes summary + **Agent Commission Breakdown
  (NEW)** — sortable table per agent, sourced from
  `/summary.revenue_by_agent` (period-scoped). Spec asked for
  Advance / Earned columns too but the backend doesn't classify
  advance vs earned on `production_records` yet — flagged as a
  tracked follow-up; the column set ships as it stands today
  (Agent / Policies / Expected / Received / Gap).
- `_ledger-tab.tsx` — paginated commission ledger. Filters:
  carrier, agent_id, product, status. Client-name search is
  client-side on the current page (backend `/ledger` doesn't
  accept a free-text search param yet — follow-up). CSV export
  via `downloadCsv` helper.
- `_carriers-tab.tsx` — 3-col carrier card grid. Per-card
  Expected YTD / Received YTD / Gap / Collection rate + progress
  bar coloured by collection rate (green ≥90, copper ≥75,
  destructive otherwise). View Ledger + Create Dispute CTAs
  (Create Dispute only when gap_ytd > $500, hands off to the
  Disputes tab's modal via parent state).
- `_disputes-tab.tsx` — 4 stat cards (Open / In Progress /
  Resolved / Recovered MTD) + sortable disputes table + per-row
  status updater + AI Letter button. New Dispute modal (carrier
  / policy / agent / client / amount / reason / notes). Letter
  modal (copy + download) — calls
  `POST /api/accounting/disputes/{id}/letter` via raw `fetch`
  since axios's auto-JSON parse trips on the streamed
  `text/plain` response. Parent can force the modal open via
  `forceCreateOpen` so the Carriers card CTA pre-opens it.
- `_statements-tab.tsx` — carrier statement upload (PDF/CSV,
  max 10 MB) + reconciliation results. Multipart upload via raw
  `fetch` (axios FormData works but the dedicated wrapper is
  small enough to inline next to the drop zone that owns it).
  After upload, fires `POST /api/reconciliation/{id}/match` via
  the typed wrapper, surfaces 5 KPIs (Total / Matched / Gaps /
  Unmatched / Total Gap) + the full reconciliation results
  table. Bulk-create disputes for every underpaid row.
- `_cfo-chat.tsx` — Bedrock-backed SSE chat side panel.
  Streams `text/event-stream` via `fetch + ReadableStream`
  (`@/lib/api/cfo.streamCFOChat` is the typed wrapper).
  Last-10-turn history sent per request; per-send abortable
  via AbortController; markdown rendering via `react-markdown`
  (new dep, see below).
- `_helpers.ts` — shared formatters (`fmt` / `fmtShort` /
  `fmtDate` / `fmtPct` / `fmtNum`) + CSV export helper +
  `PERIOD_OPTIONS` constant.
- `_status-badges.tsx` — `LedgerStatusBadge` +
  `DisputeStatusBadge`, theme-aware variants.

API client additions:
- `app/src/lib/api/accounting.ts` — typed wrappers for every
  `/api/accounting/*` and `/api/reconciliation/*` endpoint the
  page consumes, including full response shapes verified against
  `backend/accounting_router.py` and `backend/reconciliation_
  router.py`.
- `app/src/lib/api/cfo.ts` — `streamCFOChat` SSE wrapper with
  text/error callbacks + AbortController support.
- `app/src/lib/api/index.ts` — barrel re-export adds `accounting`
  + `cfo` namespaces.

Dep change: `react-markdown@^9` added to `app/package.json` — CRA
CFO chat uses it for AI-response formatting (tables, lists, code).
~30 KB minified. Listed under follow-ups if removing it later for
bundle reasons; bundling it now matches the CRA UX.

Backend API drift surfaced (logged in PR for follow-up — not
fixed in WS3):
- `/accounting/summary` returns the right shape, but
  `revenue_by_agent` rows don't carry an advance-vs-earned
  classification. Spec asked for those columns in the Agent
  Commission Breakdown — needs a `production_records` schema
  addition.
- `/accounting/ledger` doesn't accept a `client_search` query
  param. The page does client-side search on the current page;
  pagination won't respect search matches until backend grows
  the param.
- Period selector exposes `mtd|ytd|q1-q4|all` (what
  `accounting_router._period_window` actually supports), not
  the spec's `last30/last90` (those exist on
  `agency_dashboard_router` but not here).

- **Verification**: `npm run typecheck` clean, `npm run lint` clean
  for changed files, `npm run build` clean (51 kB
  `/admin/accounting` page bundle, 346 kB First Load JS,
  prerendered static). No backend changes — backend test floor
  (524) unaffected.

### Leaderboard TV Mode + auto-refresh (May 2026)
Standalone full-screen sales board built for wall display
(1080p / Chromecast / HDMI cast). Lives OUTSIDE the `(authed)`
route group so it gets only the root layout — no sidebar, no
nav chrome, pure full-screen render.

Files:
- `app/src/app/leaderboard/tv/page.tsx` — NEW. Standalone route
  at `/leaderboard/tv` (not under `(authed)`). Header (GHW
  wordmark + SALES LEADERBOARD title + clock + period tabs) →
  podium (2nd | 1st | 3rd, 1st card taller) → rankings table
  (4+, generous row height for 10-ft readability) → footer
  ("Live · Updates every 30s" + "Last updated Xs ago" tick).
  Diff-driven celebration banner with confetti — on each poll
  iterate previous rows, find each by `agent_name` in new rows,
  if `policies_count` went up queue a celebration. Banner
  slides down from top (600ms ease-out), shows for 8s, slides
  back up, then the next queued celebration mounts. Round-number
  milestones (10/25/50/100) get a tailored sub-line; others get
  "Keep crushing it! 🔥". Confetti fires on mount via
  `canvas-confetti` (gold/orange/white/navy palette).
- `app/src/app/(authed)/commissions/leaderboard/page.tsx` —
  added `refetchInterval: 60_000` to the existing React Query
  call (matches CRA cadence) and a TV Mode button in the
  header ("Cast to TV via Chromecast or HDMI" helper text).
- `app/src/components/sidebar/nav-config.ts` — Leaderboard nav
  item href fixed: `/leaderboard` (404) → `/commissions/
  leaderboard` (real page).

Auth flow without `(authed)` layout:
- Edge middleware (`app/src/middleware.ts`) gates `/leaderboard/
  tv` by `ghw_access_token` cookie presence and bounces to
  `/login?redirect_to=/leaderboard/tv` if missing.
- Root layout's `<AuthBootstrap />` fires `/api/auth/me` on
  mount and populates `useAuthStore`; the TV page mirrors the
  `(authed)` layout's `status === "anon"` → redirect check
  inline so a stale session client-side still bounces.
- `status === "unknown"` shows a quiet "Loading…" splash for
  the brief hydration window.

Real-time architecture (audit-confirmed):
- Backend has zero WebSocket / SSE / pub-sub for production
  events. Every "live" feel is polling. The TV page polls
  `/api/leaderboard?period=&limit=200` every 30s and diffs
  the result against the previous tick to drive celebrations
  — the closest thing to real-time push that the existing
  infrastructure supports without new backend work.

Dep change: `canvas-confetti@^1` + `@types/canvas-confetti`
added to `app/package.json`. Pure-JS canvas overlay (~5 KB
minified), no runtime config.

- **Verification**: `npm run typecheck` clean, `npm run lint`
  clean for changed files, `npm run build` clean
  (`/leaderboard/tv` 11.1 kB / 136 kB First Load JS,
  prerendered static; `/commissions/leaderboard` 9.57 kB /
  149 kB after wiring the TV button). No backend changes —
  backend test floor (524) unaffected.

### Settings page — Notifications tab + tab augmentations (May 2026)
The Settings shell was already a multi-route tabbed layout (one
page per tab) — Profile / Booking / Integrations / Calendars /
Security / Agency. Profile + Booking were full ports of CRA
Settings.jsx; Security + Integrations needed small additions
and the spec's Notifications tab was a net-new build.

Tabs vs spec status:

| Spec tab | Existing depth | This branch's work |
|---|---|---|
| Profile | Full port (363 lines): identity + password change w/ 12-char + last-5 history check + current-password gate + server-side error surfacing | Unchanged |
| Booking | Full port (440 lines): slug + bio + working hours per day + meeting types + duration + buffer + advance notice + booking window | Unchanged |
| Integrations | GHL connect/disconnect/replace token (319 lines) | Added grayed-out **AgencyBloc "Coming soon"** card per spec |
| Security | Recent sign-ins table (110 lines) — UA parsing, IP, relative time | Added **"Sign out everywhere"** placeholder card. Backend has no /sessions/revoke-all endpoint today — disabled button + helper text pointing at the password-change flow (which bumps token_version and invalidates every JWT issued before the change) |
| Notifications | **Did not exist** | NEW `app/src/components/settings/notifications-tab.tsx` + route at `/settings/notifications`. 6 toggles (new lead assigned / appointment reminders / birthday window / stale lead / daily brief / SOA signed). Persists per-user to `localStorage` (survives refresh) with a clear "Saved locally" banner — backend `notification_prefs` field is a tracked follow-up. Toggles don't yet stop the actual email sends; categories align with what the automation scheduler ships today. |

Layout: `/settings/notifications` added to the BASE_TABS list in
`app/src/app/(authed)/settings/layout.tsx` between Calendars and
Security.

Backend gaps surfaced (tracked follow-ups, none fixed here):
- `users.notification_prefs` (or `/api/profile/notification-prefs`)
  doesn't exist. Notifications tab persists to `localStorage` only.
- `/sessions/revoke-all` endpoint doesn't exist. Security tab
  placeholder button points at the password-change flow (which
  invalidates other sessions via `token_version`).

- **Verification**: `npm run typecheck` clean, `npm run lint`
  clean for changed files, `npm run build` clean
  (`/settings/notifications` 10.1 kB / 144 kB First Load JS,
  prerendered static; `/settings/integrations` 5.15 kB and
  `/settings/security` 3.92 kB after augmentations). No backend
  changes — backend test floor (524) unaffected.

### Calendar page port (May 2026)
Closes the WS1 `/calendar` 404 gap by porting the CRA
`CalendarPage.jsx` (864 lines + 177 lines of overrides) to
the Next.js app. Uses the existing `react-big-calendar@^1.19.6`
dep already pinned in `app/package.json`.

Files:
- `app/src/app/(authed)/calendar/page.tsx` — page shell.
  Self-scope on `useAuthStore().user?.id` so admin/owner roles
  see only their own appointments unless impersonating (mirrors
  CRA's `agent_id` query-param pattern). React Query keys on
  `[start, end, agent_id]` so view-change refetches dedupe with
  the sidebar stats. Modal state lives here so cross-modal
  handoffs (detail → reschedule) work without remount churn.
- `_calendar-view.tsx` — `react-big-calendar` wrapper. Stock
  CSS imported as `import "react-big-calendar/lib/css/react-big-
  calendar.css"` directly in this `'use client'` component (App
  Router allows third-party CSS imports from any client
  component — file only loads on `/calendar`). Custom toolbar
  (prev / today / next + Month/Week/Day/Agenda switcher + New
  Appointment button), color-coded by `booking_type`, eventprop
  getter dims non-scheduled rows.
- `_sidebar.tsx` — right rail. Today / This Week stats / Next
  appointment + booking-source legend. Pulls from the same
  React Query cache.
- `_modals.tsx` — three colocated modals:
  - **AppointmentDetailModal** — fields + 6 outcome buttons.
    The 4 strict outcomes (`showed` / `no_show` / `sold` /
    `not_sold`) go through `POST /api/appointments/{id}/outcome`
    (auto-flips status, fires the no-show reschedule email,
    audits). `Sold` additionally `router.push("/applications?
    client_id=…")` per spec. `Cancelled` uses
    `PATCH status="cancelled"` because the AppointmentOutcome
    enum is locked to the 4 above. `Reschedule` opens the
    Reschedule modal.
  - **RescheduleModal** — single date picker → `PATCH
    appointment_date`. Helper text spells out the backend
    limitation: the `AppointmentUpdate` model doesn't accept
    `appointment_time`, so changing the time of day requires
    cancel + rebook (tracked follow-up).
  - **CreateAppointmentModal** — full form with debounced
    `LeadTypeahead` against `/api/leads?q=`. Supports walk-ins
    (no lead → free-text `client_name`) per backend's two-flow
    create.
- `_helpers.ts` — color/label maps + `parseDateTime` + `view-
  Window`. `BOOKING_TYPE_COLOR.manual` mapped to blue per spec
  (autobook → green, va → purple, ae → orange, manual → blue).
- `app/src/app/globals.css` — added ~95 lines of `.rbc-*`
  overrides so the stock light-theme calendar reads correctly
  on the GHW dark navy palette. Hides the stock toolbar so it
  doesn't double-render with the custom one slotted via
  `components.toolbar`.
- `app/src/lib/api/calendars.ts` — added 3 wrappers:
  `getGoogleStatus` / `startGoogleConnect` / `disconnectGoogle`
  hitting `/api/calendar/google/*`. The existing file dealt
  with multi-calendar surfaces (`/api/calendars/*`); Google
  OAuth lives on the singular `/api/calendar/*` prefix on the
  backend — both live in the same TS file under clearly
  commented sections to keep API surface organized.

Backend API drift surfaced (logged for follow-up — not fixed
in this branch):
- Spec called for "PATCH /api/appointments/{id} with outcome
  field". The actual production endpoint is **POST /api/
  appointments/{id}/outcome** with a strict 4-value enum body
  (`AppointmentOutcome = Literal["showed","no_show","sold",
  "not_sold"]`). The PATCH endpoint does still accept a free-
  text `outcome` field but skips the side effects (auto-flip
  status, no-show reschedule email, dedicated audit row). The
  page uses POST for the 4 strict outcomes and PATCH only for
  `Cancelled` (sets `status="cancelled"`).
- `AppointmentUpdate` doesn't accept `appointment_time`, only
  `appointment_date` — so the Reschedule modal can change date
  only. Adding `appointment_time` to the PATCH model is a tiny
  backend change worth queuing.
- `/api/appointments/{id}/ics` is mounted on a separate
  `ics_router` (calendar_router.py:63 declares the prefix); the
  path is `/api/appointments/{id}/ics` exactly as the spec
  says — `window.open()` triggers the browser's calendar-import
  flow.

CSS handling — how CRA did it vs. how we handled it in Next.js:
- **CRA:** two side-effect imports inside `CalendarPage.jsx` —
  `import "react-big-calendar/lib/css/react-big-calendar.css"`
  + `import "./CalendarPage.css"` (local override file).
- **Next.js:** the third-party stock CSS imports the same way
  inside `_calendar-view.tsx` (App Router permits third-party
  CSS imports from any client component, scoped to that
  component's chunk). Local overrides have to be global (rbc's
  classes are not CSS-module-friendly), so they live in
  `globals.css` instead of a colocated `.css` file — Next.js
  forbids non-module global CSS imports outside the root
  layout. Slight payload trade-off (~95 lines loaded on every
  page) for theme correctness on `/calendar`.

- **Verification**: `npm run typecheck` clean, `npm run lint`
  clean for changed files, `npm run build` clean
  (`/calendar` 10.2 kB / 251 kB First Load JS, prerendered
  static). No backend changes — backend test floor (524)
  unaffected.

### Super Admin route gate — server-authoritative (May 2026)
The Super Admin console at `/admin/super-admin` was already a
full port (1,372 lines, all 4 spec tabs — Agencies / Users /
Usage / System — with EditAgencyDialog including
`apply_tier_defaults`, UsersTab with self-mod guard via
`meEmail.toLowerCase() === u.email.toLowerCase()`, UsageTab,
and SystemTab with `isSystemError` partial-degrade handling).
The only spec gap was the route guard.

Before: the guard read `selectIsSuperAdmin` off the auth store —
a client-side flag mirroring `User.super_admin` from
`/api/auth/me`. A user with a stale store could briefly see the
page chrome before any backend call started 403-ing.

After: the guard fires `saApi.getSystem()` (a
`require_super_admin()`-gated endpoint) on mount via React
Query with `retry: false`. Any error — confirmed 403 OR a
network/5xx blip — redirects to `/dashboard`. The skeleton
holds until the probe resolves, so no console chrome leaks
to a non-super-admin even for a frame. The `meEmail` from the
auth store is still read (independent purpose: self-mod guard
in UsersTab).

Self-mod guard preserved unchanged at `super-admin/page.tsx:706`
— the same row that highlights the caller's row in the table
also disables the Edit button.

- **Verification**: `npm run typecheck` clean, `npm run lint`
  clean for changed files, `npm run build` clean
  (`/admin/super-admin` 13.6 kB / 196 kB First Load JS,
  prerendered static). No backend changes — backend test
  floor (524) unaffected.


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
