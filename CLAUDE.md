# GHW Medicare Agent Portal — Session Context

## Stack
- Frontend (legacy): React CRA + Tailwind + shadcn/ui → Vercel
- Frontend (current): Next.js App Router (`app/`) → Vercel
- Backend: FastAPI (Python 3.11.9) → Render service `ghw-medicare-backend` (Oregon, standard plan)
- Database: MongoDB Atlas, DB_NAME = `gruening_medicare`
- Auth: JWT (HS256) httpOnly cookie + CSRF + magic-link + opt-in TOTP MFA
- Repo: github.com/WebSynq/Medicare-App, main branch `main`
- Email domain: `grueninghealthwealth.com` (legacy `grueninghw.com` is alias)
- Multi-tenant: GHW agency_id = `ghw_001`; every lead/SOA/appointment/audit row is stamped

## Team Accounts
| Name                    | Email                            | Role  |
|-------------------------|----------------------------------|-------|
| Tim Arnold              | tim@websynqdesign.com            | admin |
| Matt Monacelli          | matt@grueninghealthwealth.com    | admin |
| Cesar                   | cesar@grueninghealthwealth.com   | admin |
| Michael                 | michael@grueninghealthwealth.com | admin |
| Matt Monacelli (legacy) | admin@grueninghw.com             | admin |

## Test Count
**523 passed, 1 skipped — 524 collected** (mongomock-motor + TestClient). Never let this floor drop.

## What's Built (single-tenant core)
- Auth: magic-link (primary), email/password, TOTP MFA opt-in, invite-only register, lockout, idle-timeout JWT (`idle_exp` + `/auth/refresh`)
- Leads: CRUD, GHL sync best-effort, PDF export, regex-safe search, state normalization, full-field editing, tags system
- SOA: digital signature capture + agent-notification automation
- Documents: encrypted upload/download (Fernet under `DOC_ENCRYPTION_KEY`)
- Commissions (ComTrack): `/upload`, `/summary`, `/history`, `/live`, admin `/api/admin/commissions`
- Audit log: admin/compliance query + CSV export (no TTL — HIPAA 7-year retention)
- Bookings: public per-agent page `/book/:slug` with HMAC token + honeypot + IP abuse limits
- Automations: 8 jobs on 15-min APScheduler (birthday, reminders, stale, enrolled welcome, post-appointment, new-lead, SOA-signed) + AI security analysis
- Ops Console (`/ops`): admin/owner or `user.ops_access=True`, military theme, system/security/integrity/usage/automations/compliance + AI security panel
- AI Security: Claude-triaged threat analysis, ipapi.co + AbuseIPDB enrichment, auto-ban + admin alerts
- GHL Import: per-agent token, AI tag mapping, background bulk import, dedup, polling
- New Client from Application: two-tab Step 1 (AI pre-fill OR existing search)
- CNA tab: COACHG-aligned assessment form, auto-saves on blur, pre-fills from lead
- AI Client Intelligence: Claude-generated urgency (0-100), recommendation, exposures, talking points, cross-sell, objection handles, formal-recommendation script
- Lead scoring: `ai_score` stamped via daily-brief tick; Today widget + sortable AI column
- Daily Brief: cron 12:00 UTC, emails each agent top-10 priority calls
- Password policy: 12 chars + complexity + common-password blocklist + last-5 history
- MBI encryption: Fernet under `PHI_FIELD_KEY`
- CVE patches: fastapi 0.116.2, starlette 0.47.2, pymongo 4.6.3, PyJWT 2.12.0, cryptography 46.0.6
- Memory hardening: scheduler ticks use `.to_list(length=N)` + `gc.collect()`; security_intelligence caps Claude prompt inputs + first-run skip
- Schema indexes: compound `(agency_id, status, created_at desc)` on leads, `(agency_id, status, appointment_date)` on appointments, `(event_type, timestamp desc)` on audit_logs
- Array caps: `Lead.tags=50, doctors=20, prescriptions=50, document_ids=500`
- Render `render.yaml`: name/plan/region/runtime + health-check + 120s shutdown + commit auto-deploy. Env vars stay in dashboard.

## Multi-Tenant SaaS — Phases 1-6 (on staging, NOT merged to main)
| Phase | Module | Highlights |
|-------|--------|------------|
| 1 | Foundation | `tiers.py` FEATURE_REGISTRY (29 keys) + TIER_DEFAULTS + OVERAGE_RATES; `agency_models.py`; `seed.py` GHW at `ghw_001` super_admin; new deps; JWT carries `agency_id`/`agency_tier`/`super_admin`/`features` |
| 2 | Metering | `metering.py` track + check (super-admin bypass); monthly rollup 06:00 UTC day 1 → `agency_usage_summary`; wired into CNA, app extract, security_intelligence, GHL import, resend |
| 3 | Stripe billing | `stripe_service.py` webhook sig + idempotent dispatch + state machine; `billing_router.py` 5 endpoints; grace-period sweep 07:00 UTC daily; mock-mode 503 when `STRIPE_SECRET_KEY` unset; feature gates on cna/ai_client_intelligence/ai_application_intake/ghl_import |
| 4 | Per-agency email domains | `resend_domains.py` never-raise wrapper; owner-only setup; `_resolve_from_address(agency_id)` picks verified tenant FROM, falls back to GHW |
| 5 | Super Admin Panel | `super_admin_router.py` 7 endpoints under `/api/super-admin/*`; `SuperAdmin.jsx` 4 tabs; server-authoritative gate via `/super-admin/system` ping; tier patch supports `apply_tier_defaults=true` |
| 6 | Owner Settings | `agency_settings_router.py` 5 endpoints under `/api/agency/*`; `OwnerSettings.jsx` at `/settings/agency` 4 tabs; reuses InviteAgentModal + Phase 3 portal |

### Tier structure
| Tier | Price | Seats | Notes |
|------|-------|-------|-------|
| Beta | $297/mo | 3 | Every feature ON (early-access) |
| Foundation | $297/mo | 5 | CRM + leads + SOA + audit log |
| Growth | $497/mo | 15 | + booking, app intake AI, GHL import |
| Domination | $997/mo | Unlimited | + CNA, AI client intel, AEP |

## Next.js Migration (`app/`)

### Ported
- Sidebar nav parity (14 items, role gates match CRA)
- `/dashboard` — combined: agent panel always + Agency Overview below for COMMAND_CENTER_ROLES
- `/admin/accounting` — full QuickBooks-for-Medicare port (Overview, Ledger, Carriers, Disputes, Statements, CFO chat SSE)
- `/leaderboard/tv` — wall-display TV mode + 30s diff-driven celebrations (canvas-confetti); `/commissions/leaderboard` 60s refetch + TV Mode button
- `/settings/*` — Profile, Booking, Integrations (+AgencyBloc "Coming Soon" card), Calendars, Security (+revoke-all placeholder), Notifications (NEW, localStorage), Agency
- `/calendar` — react-big-calendar + 6 outcome buttons + reschedule/create modals; dark-theme rbc overrides in `globals.css`
- `/agency-dashboard` — full Command Center port (8 KPIs, 3 charts, agent table, 3 alert cards, drilldown sheet); revenue gated per role
- `/admin/super-admin` — full 4-tab port; server-authoritative gate via `saApi.getSystem()` probe + self-mod guard

### Placeholder / 404
- `/today`, `/pipeline`, `/birthday-rule`, `/renewals`, `/reports/lead-sources`, `/notifications` (bell target), `/agency` (footer agent-switcher target)
- AgentContext + X-Agent-ID interceptor (impersonation) — not yet ported
- NotificationPanel + unread-badge polling — not yet ported
- Recharts dataKey strings on `/admin` and `/reports/revenue` use stale field names — render blank until migrated

## Auth Architecture

### Magic link (primary) + password (Option B)
- `POST /api/auth/magic-link {email}` → 15-min single-use token emailed → user clicks `/auth/magic?token=...` → SPA `POST /api/auth/magic-link/verify {token}` → JWT cookie + redirect to `/today`
- `POST /api/auth/login {email, password}` → JWT cookie immediately (or `{mfa_required, session_token}` if MFA enabled)

Collection `magic_link_tokens`: SHA-256 `token_hash` (raw only in email), `email`, `user_id`, BSON-date `created_at`/`expires_at`, `used`, `used_at`, `ip`. Unique index on `token_hash`; TTL evicts ~1hr after expiry.

Security: opaque 200 regardless of email/rate-limit/account status; per-email cap 5/hr + IP 20/hr; verify endpoint 10/hr per IP; single-use atomically via `modified_count`; refuses pending/rejected/deactivated; successful redeem clears lockout. Audit events: `magic_link_requested`, `magic_link_used`, `magic_link_verify_failed`, `login_success` (with `method`).

### MFA (TOTP) — opt-in
Endpoints under `/api/auth/mfa/*`: `setup`, `verify-setup`, `verify`, `backup-code`, `disable`, `status`. Secret Fernet-encrypted under `MFA_ENCRYPTION_KEY`. 8 single-use backup codes (bcrypt-hashed). 5-failed-codes-in-15-min per-user lockout on top of IP rate limit. **Setup UI removed from Settings 2026-05-25**; backend remains live. `MFAChallenge.jsx` for login-time challenge still wired.

### Session timeout
`idle_exp` (epoch seconds, default 30 min) + `jti` on every fresh JWT. `deps.get_current_user` 401s past `idle_exp`. SPA activity tracker (`lib/session.js`) refreshes every ~20 min via `POST /api/auth/refresh` (10/min). Idle warning 25 min, hard logout 30 min.

## Commission Endpoint Keying (Wave 1)
`agent_name` unified across `/commissions/summary`, `/commissions/live`, `/commission/audit` (`_scope_filter`), `/leaderboard` (`is_self`). All resolve via `deps.resolve_agent_key`. Rule: `agent_name` primary, `full_name` fallback for legacy only. Endpoints fail closed (400) when neither field is set.

## Env Vars Required

### Render (backend)
Core: `MONGO_URL`, `DB_NAME`, `JWT_SECRET`, `JWT_ALGORITHM`, `JWT_EXPIRES_MINUTES`, `JWT_IDLE_TIMEOUT_MINUTES` (default 30), `CORS_ORIGINS`, `FRONTEND_URL`, `ENVIRONMENT`, `SEED_ADMIN_PASSWORD`, `COMTRACK_API_KEY`, `GHL_*` (5 fallback vars, per-agent in `ghl_integrations`), `DOC_ENCRYPTION_KEY`, `SENTRY_DSN`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `PHI_FIELD_KEY`

Security: `MFA_ENCRYPTION_KEY` (Fernet), `ADMIN_EMAIL` (lockout + AI security alert fallback), `BOOKING_SECRET` (HMAC), `ABUSEIPDB_API_KEY` (optional, 1000/day free)

Phase 3 (Stripe): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_BETA`, `STRIPE_PRICE_FOUNDATION`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_DOMINATION`, `SUPER_ADMIN_EMAILS` (CSV — Tim/Matt/Chase bypass all gates)

Generate Fernet: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`

### Vercel (frontend)
`REACT_APP_BACKEND_URL` (CRA), corresponding Next.js public var on `app/`.

## Rules (non-negotiable)
1. Never break the test suite — floor is **524**.
2. All new endpoints: auth required, rate limited, audit logged.
3. Agent never sees another agent's data (IDOR enforced server-side).
4. Secrets (`ANTHROPIC_API_KEY` / `STRIPE_SECRET_KEY` / `RESEND_API_KEY`) only in Render env — never in code, never echoed.
5. Python 3.11.9 syntax only (no match statements, no 3.12+ features).
6. One commit per task.
7. Update this CLAUDE.md every phase commit with current test count + phase status.
8. Multi-tenant: every router reading leads/appointments/audit_logs/SOA MUST filter on `agency_id` from `get_agency()` or `get_agency_id()`. Feature flag enforcement opt-in per endpoint via `Depends(require_feature("key"))`. Super admins bypass.

## Agent Isolation Patterns

### `agent_filter(current_user, override_agent_id=None)` — `deps.py`
Returns MongoDB filter dict. Admin/compliance → `{}` (or override). Agent → `{"agent_id": current_user["id"]}` (override silently ignored).
```python
query = {**agent_filter(current_user), "status": "new"}
```

### `get_effective_agent(request, current_user, db)` — `deps.py`
FastAPI dep. Admin/compliance + `X-Agent-ID` header → impersonated user doc with `_impersonated_by` metadata. Agent + header → 403. No header → `current_user`.
```python
async def create_lead(..., effective: dict = Depends(get_effective_agent)):
    doc["agent_id"] = effective["id"]
    doc["agent_email"] = (effective.get("email") or "").lower() or None
    doc["agent_name"] = effective.get("agent_name") or effective.get("full_name")
```

### IDOR on single-resource GET/PATCH/DELETE
See `leads_router._idor_or_403`: fetch doc → 404 if missing → 403 if exists but caller isn't admin/compliance and doesn't own. Never trust path id alone.

### `X-Agent-ID` header
Set by AgentContext → Axios interceptor in `frontend/src/lib/api.js`. Backend `get_effective_agent()` reads it; `agent_filter()` reads it only when caller passes `override_agent_id` explicitly.

### `AgentContext` — `frontend/src/context/AgentContext.jsx`
`useAgent()` exposes `selectedAgent`, `isImpersonating`, `setSelectedAgent`, `clearAgent`. Persists to `localStorage`.

### `ImpersonationBanner` — `frontend/src/components/ImpersonationBanner.jsx`
Drop under page title. Renders null when not impersonating, orange "Viewing as: [name]" pill otherwise. Wired on AgentDashboard, ClientsList, ClientProfile, ApplicationSubmission, CommissionsDashboard, Leaderboard.

### Backfill
`backend/scripts/migrate_agent_ownership.py` — idempotent, stamps `agent_id` on legacy records, assigns to first admin. **Already executed in prod — 6,666 records stamped.**

## Multi-Tenant Scoping Patterns (Phase 1+)
- `get_agency()` — FastAPI dep; resolves caller's agency, caches on `request.state.agency`; falls back to GHW (`ghw_001`) for legacy auth.
- `get_agency_id()` — static helper returning env-driven default; used by schedulers/batch jobs. All scheduler queries in `automations.py` filter on this.
- `require_feature(key)` — 403 unless `agency.features[key]` is True. Super admins bypass.
- `require_super_admin()` — 403 unless `agency.super_admin=True` or email in `SUPER_ADMIN_EMAILS`.
- `require_billing_active()` — 402 when `billing_status in {suspended, cancelled}`. Super admins bypass.
- `check_seat_available()` — 402 when `seats_active >= seats_max`. `-1` = unlimited.

## Known Drift to Fix
- `agent_name` empty for some existing users — backfill migration needed.
- Bearer-header auth path still active — deprecate before new routes.
- GHL Import: mid-flight import dies on Render restart (`status="running"` orphan, no auto-resume). MVP-acceptable; resume-on-restart needs APScheduler integration.
- `/admin` + `/reports/revenue` Recharts charts render blank — stale dataKey field names from pre-WS2 type drift.
- AgentContext + X-Agent-ID interceptor not ported to `app/` — impersonation works only on CRA side.

## Pending

### Blocking merge of Phases 1-6 to main
- [ ] End-to-end Stripe smoke test on staging — checkout, payment-failed → grace → suspended → recover. Needs `STRIPE_SECRET_KEY` + price IDs on staging Render.
- [ ] Provision a real second agency on staging — verify cross-tenant isolation end-to-end against non-GHW tenant.
- [ ] Resend domain registration smoke test — register a real domain via Settings → Email Domain, verify DNS, send per-agency outbound to confirm FROM resolution.
- [ ] GHL import with real Private Integration Token — also blocks original single-tenant merge.

### Infra (Tim / Matt action)
- [ ] AWS env vars on Render for AI Application Intake (Bedrock).
- [ ] Render HIPAA BAA — Matt to approve $499/mo Scale plan. Blocks prod cutover.
- [ ] MongoDB Atlas HIPAA BAA — mongodb.com/hipaa (Tim).
- [ ] AWS SES migration for transactional mail + BAA.
- [ ] Sentry BAA — Matt billing approval.
- [ ] Set Phase 3 Stripe env vars on Render (4 price IDs + secret + webhook).
- [ ] Set `SUPER_ADMIN_EMAILS` on Render (Tim/Matt/Chase).

### Follow-up (non-blocking)
- GHL import resume-on-restart.
- Re-enable Settings → MFA setup UI (backend still live).
- Two-tier account lockout (currently 5-in-15-min only; spec wanted 10 → 24-hr tier).
- `agent_name` legacy-row backfill.
- Per-tenant security_intelligence (currently bills to GHW).
- Thread `agency_id` through remaining `send_email` callsites (birthday/enrolled/stale/post-appt/new-lead).
- Invite seat-cap enforcement on backend `/auth/invite`.
- Pending-invite roster on Owner Settings → Seats tab.
- Backend `notification_prefs` field (Notifications tab persists to localStorage only).
- Backend `/sessions/revoke-all` endpoint (Security tab has placeholder button).
- Port AgentContext + X-Agent-ID interceptor to Next.js `app/`.
- Port NotificationPanel + unread-badge polling to Next.js.
- Backend `appointment_time` on `AppointmentUpdate` (calendar reschedule modal limitation).
- Backend `client_search` on `/accounting/ledger` (currently page-local).
- Backend advance-vs-earned classification on `production_records` (Accounting agent breakdown gap).
