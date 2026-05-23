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
- Auth: magic-link sign-in (primary) + email/password (Option B),
  invite-only register, lockout, profile PATCH
- Leads: CRUD, GHL sync, PDF export, regex-safe search
- SOA: digital signature capture
- Documents: encrypted upload/download
- Commissions (ComTrack): /upload, /summary, /history, /live
- Admin commissions: /api/admin/commissions
- Audit log: admin/compliance query
- Security: CORS locked, /docs disabled, headers, rate limits, CSRF cookies, PostHog locked down
- Tests: 18 passing (mongomock-motor + TestClient)

## Known Drift to Fix
- agent_name is empty for existing users — needs backfill migration
- Bearer-header auth path still active (deprecate before new routes)

## Auth Architecture (Magic Link)

TOTP MFA was removed in favour of magic-link sign-in. The link IS
the second factor — possession of the registered inbox stands in
for TOTP. Two paths land in the same session:

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
MONGO_URL, DB_NAME, JWT_SECRET, CORS_ORIGINS, SEED_ADMIN_PASSWORD
ENVIRONMENT, FRONTEND_URL, COMTRACK_API_KEY, GHL_* (5 vars),
DOC_ENCRYPTION_KEY, SENTRY_DSN, JWT_ALGORITHM, JWT_EXPIRES_MINUTES
ANTHROPIC_API_KEY (add now — needed for commission AI endpoint)

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
