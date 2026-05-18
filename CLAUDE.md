# GHW Medicare Agent Portal — Session Context

## Stack
- Frontend: React CRA + Tailwind + shadcn/ui → Vercel
- Backend: FastAPI (Python 3.11.9) → Render
- Database: MongoDB (Atlas)
- Auth: JWT (HS256) + httpOnly cookie + CSRF middleware
- Repo: github.com/WebSynq/Medicare-App

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
