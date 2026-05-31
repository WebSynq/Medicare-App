# GHW Portal — Development Conventions
# Place this file at: /app/.claude/conventions.md
# Read this before writing ANY code in this repo.

---

## The Non-Negotiables

1. **Test floor is 527.** Never merge below it. New backend work ships with tests.
2. **Staging first.** Branch → push → staging.ghwcrm.com → merge to main.
3. **One commit per task.** Descriptive message. No squash-and-lose-history.
4. **Never commit directly to `main`.** Always branch.
5. **Secrets in Render/Vercel env vars only.** Never in code, never echoed in responses.
6. **Python 3.11.9 only.** No `match` statements, no 3.12+ features.
7. **Production-ready output only.** No `# TODO`, no "this should work."

---

## Branch Naming

```
fix/description         — bug fixes
feat/description        — new features
perf/description        — performance
chore/description       — maintenance (CLAUDE.md, deps, config)
security/description    — security fixes
phase/N-description     — phase work
```

---

## Backend Conventions (FastAPI Python)

### Every new endpoint must have:
```python
# 1. Auth
current_user: dict = Depends(get_current_user)

# 2. Rate limit
@router.get("/path", dependencies=[Depends(RateLimiter(times=60, seconds=60))])

# 3. Agency scoping (if touches tenant data)
agency = await get_agency(request)
agency_id = agency["agency_id"]

# 4. Audit log
await write_audit(db, event_type="thing_done", actor=current_user, ...)

# 5. IDOR check on single-resource endpoints
doc = await db.collection.find_one({"_id": ObjectId(id)})
if not doc:
    raise HTTPException(404)
if doc.get("agency_id") != agency_id and current_user["role"] not in ADMIN_ROLES:
    raise HTTPException(403)
```

### agency_id scoping — CRITICAL
```python
# WRONG — reads env var, breaks multi-tenant
agency_id = get_agency_id()  # or os.getenv("AGENCY_ID", "ghw_001")

# CORRECT — reads from JWT via request context
agency = await get_agency(request)  # FastAPI dep
agency_id = agency["agency_id"]     # from JWT claim
```

### Agent isolation pattern
```python
# For reads — use agent_filter()
query = {**agent_filter(current_user), "status": "new"}

# For writes — use get_effective_agent()
effective = Depends(get_effective_agent)
doc["agent_id"] = effective["id"]
doc["agent_email"] = (effective.get("email") or "").lower() or None
doc["agent_name"] = effective.get("agent_name") or effective.get("full_name")
```

### PHI fields — encrypt/decrypt
```python
# MBI and other PHI fields use Fernet under PHI_FIELD_KEY
# Always round-trip through safe_lead_set / safe_lead_load
doc = safe_lead_set(doc)   # encrypt before write
lead = safe_lead_load(lead)  # decrypt after read
```

### Test pattern
```python
# backend/tests/test_your_feature.py
# Use mongomock-motor + TestClient
# TDD: write failing test first, then implement

def test_thing_blocks_wrong_role():
    response = client.get("/api/endpoint", headers=agent_token)
    assert response.status_code == 403

def test_thing_works_for_admin():
    response = client.get("/api/endpoint", headers=admin_token)
    assert response.status_code == 200
```

---

## Frontend Conventions (Next.js)

### API client — always use these, never raw fetch
```typescript
// app/src/lib/api/{entity}.ts
import { apiClient } from './client'

export const getLeads = (filters: LeadFilters) =>
  apiClient.get<LeadsResponse>('/leads', { params: filters })

export const createLead = (data: LeadCreate) =>
  apiClient.post<Lead>('/leads', data)
```

### Types — match backend Pydantic models exactly
```typescript
// app/src/types/api.ts or app/src/lib/api/{entity}.ts
// Field names must match backend response exactly
// Check backend models.py before naming frontend types

// WRONG — invented field names
type AiRec = { exposures: string[], formal_script: string }

// CORRECT — match backend
type CnaAiRecommendation = {
  key_exposures: Array<{title: string, description: string}>,
  formal_recommendation_script: string,
  // ...
}
```

### API response wrapper pattern
```typescript
// Many endpoints wrap in { data, total, page } or similar
// Always check the actual backend router response shape
// Never assume — read the router file

const items = response?.data ?? []          // list endpoints
const item = response?.data ?? response     // single item (sometimes unwrapped)
```

### Null safety — always guard arrays
```typescript
// WRONG — crashes on undefined
data.items.map(...)
data.length > 0

// CORRECT
(data?.items ?? []).map(...)
(data?.items ?? []).length > 0
```

### Navigation
```typescript
import { useRouter } from 'next/navigation'
const router = useRouter()

router.push('/clients/123')    // navigate
router.replace('/login')       // replace (no back)
```

### Environment variables
```typescript
// Frontend — must be NEXT_PUBLIC_ prefix
const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL

// NOT REACT_APP_ (that's CRA)
```

---

## MongoDB Conventions

### Compound indexes (defined in backend/server.py _PROD_INDEXES)
Every query that filters on multiple fields needs a compound index.
Current compound indexes:
- `leads`: (agency_id, agent_id), (agency_id, status), (agency_id, status, created_at DESC)
- `appointments`: (agent_id, appointment_date), (agency_id, agent_id), (agency_id, status, appointment_date)
- `audit_logs`: (agency_id, timestamp DESC), (event_type, timestamp DESC)

When adding a new query pattern, check if an index exists. If not, add to `_PROD_INDEXES`.

### Document ID handling
```python
# MongoDB _id is ObjectId — serialize for JSON
from bson import ObjectId
doc["id"] = str(doc.pop("_id"))  # convert for response
```

### Idempotent writes
```python
# Use upsert for idempotent operations
await db.collection.update_one(
    {"unique_key": value},
    {"$set": doc},
    upsert=True
)
```

---

## Deployment Flow

```
1. git checkout main && git pull origin main
2. git checkout -b feat/your-feature
3. Build + test locally (cd backend && python -m pytest — must be 527+)
4. git push -u origin feat/your-feature
5. Vercel auto-creates preview URL — visual check
6. gh pr create --base main --head feat/your-feature
7. ! ~/bin/gh.exe pr merge [N] --merge  (if Vercel prod check blocks)
8. Both staging.ghwcrm.com + app.ghwcrm.com update automatically
9. Verify on staging.ghwcrm.com
10. Update CLAUDE.md with test count
```

---

## Vercel Projects

| Project | Domain | Branch | Stack |
|---|---|---|---|
| medicare-app | app.ghwcrm.com | main | CRA (frontend/) |
| medicare-app-staging | staging.ghwcrm.com | main | Next.js (app/) |

Both watch `main`. Push to main → both deploy.
CRA project has Ignored Build Step: `git diff HEAD^ HEAD --quiet -- frontend/`

---

## Environment Variables

### Render (backend — both services)
```
MONGO_URL, DB_NAME, JWT_SECRET, CORS_ORIGINS
ANTHROPIC_API_KEY, RESEND_API_KEY
PHI_FIELD_KEY, MFA_ENCRYPTION_KEY, BOOKING_SECRET
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_*
SUPER_ADMIN_EMAILS, ADMIN_EMAIL, ABUSEIPDB_API_KEY
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET
ENVIRONMENT (staging | production)
```

### Vercel (Next.js)
```
NEXT_PUBLIC_BACKEND_URL=https://staging-api.ghwcrm.com  (staging)
NEXT_PUBLIC_BACKEND_URL=https://api.ghwcrm.com          (production)
```

---

## CLAUDE.md Update Rule

**After every phase commit, update CLAUDE.md with:**
1. Current test count
2. Phase status (what's done, what's pending)
3. Any new infrastructure or pattern added
4. Known drift items

Doc drift costs ramp-up cycles on every new session. Do not skip.

---

## Security Checklist (run before any new endpoint)

- [ ] Does this read leads/appointments/audit/SOA? → Filter on `agency_id` from `get_agency()`
- [ ] Does it touch per-agent data? → Use `agent_filter()` for reads, `get_effective_agent()` for writes
- [ ] Single-resource GET/PATCH/DELETE? → IDOR check: 404 if missing, 403 if wrong owner
- [ ] New endpoint? → auth required + rate limited + audit logged
- [ ] PHI field? → round-trip through `safe_lead_set`/`safe_lead_load`
- [ ] Webhook? → HMAC signature verification
- [ ] File upload? → server-side type validation, S3 private, pre-signed URLs only

---

## Current Build Status (May 30, 2026)

- **Test count:** 527 passing
- **Next.js port:** In progress on staging.ghwcrm.com
- **CRA (legacy):** frontend/ — still on app.ghwcrm.com (prod)
- **Multi-tenant Phases 1-6:** Built, staging only, merge blocked pending:
  - E2E Stripe smoke test
  - Second agency on staging
  - Resend domain smoke test
  - GHL import with real token

## Known Drift to Fix
- `agent_name` empty for legacy users — needs backfill
- Bearer-header auth path still active — deprecate
- GHL import dies on Render restart (no auto-resume)
- ~5 more handlers using `get_agency_id()` instead of `get_agency()` — appointments, notes, notifications, CNA, tags
- 7 `send_email` callsites not passing `agency_id`
