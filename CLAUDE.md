# GHW Medicare Agent Portal — Session Context

## Stack
- Frontend: React CRA + Tailwind + shadcn/ui → Vercel
- Backend: FastAPI (Python 3.11.9) → Render
- Database: MongoDB (Atlas) — DB_NAME = `gruening_medicare`
- Auth: JWT (HS256) + httpOnly cookie + CSRF middleware
- Repo: github.com/WebSynq/Medicare-App
- Real GHW email domain: `grueninghealthwealth.com`
  (the `grueninghw.com` references in older docs/code are aliases —
  production accounts use the longer domain.)

## Team Accounts
| Name           | Email                                  | Role   |
|----------------|----------------------------------------|--------|
| Tim Arnold     | tim@websynqdesign.com                  | admin  |
| Matt Monacelli | matt@grueninghealthwealth.com          | admin  |
| Cesar          | cesar@grueninghealthwealth.com         | admin  |
| Michael        | michael@grueninghealthwealth.com       | admin  |

## What's Built
- Auth: login, MFA, invite-only register, lockout, profile PATCH
- Leads: CRUD, GHL sync, PDF export, regex-safe search
- SOA: digital signature capture
- Documents: encrypted upload/download
- Commissions (ComTrack): /upload, /summary, /history, /live
- Admin commissions: /api/admin/commissions
- Audit log: admin/compliance query
- Security: CORS locked, /docs disabled, headers, rate limits, CSRF cookies, PostHog locked down
- Tests: 18 passing (mongomock-motor + TestClient)

## Known Drift to Fix
- /commissions/summary keys ComTrack by current_user["full_name"]
- /commissions/live keys by users.agent_name (DB row)
- These must be unified to users.agent_name before new commission work
- agent_name is empty for existing users — needs backfill migration
- InviteAgentModal.jsx missing agent_name/agent_npn fields
- Bearer-header auth path still active (deprecate before new routes)

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
