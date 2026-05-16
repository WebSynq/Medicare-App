# Gruening Health & Wealth — Medicare Intake Application

## Original Problem Statement
> "I need to start mapping out a full scope medicare insurance application that will connect to GHL and transfer data. This app must be hippa regulated, and cyber security at the forfront. Lets map out how this will be built and the tools and software needed and a cost analysis for this. We are build this app for gruening health and wealth, right now they are using n8n with a simple form and upload the data into ghl."

## User Choices (Phase 1 kickoff)
- Deliverable: planning doc + working MVP
- Features: full set (intake wizard, SOA e-sign, encrypted upload, agent dashboard, GHL sync, audit log)
- GHL: API v2 with Private Integration Token (user will provide)
- Hosting: MVP on Emergent + production HIPAA plan documented
- Auth: email/password JWT + TOTP MFA

## User Personas
- **Beneficiary (65+)**: Public intake form. Needs accessibility (large inputs, generous spacing, friendly tone).
- **Agent**: Logged-in console, pipeline view, lead detail, push to GHL.
- **Admin**: User management, full GHL config, all reports.
- **Compliance Officer**: Read-only access to audit log + compliance panel.

## Architecture
- **Frontend**: React 19 + Tailwind + shadcn UI + framer-motion + react-dropzone. Outfit (headings) / IBM Plex Sans (body).
- **Backend**: FastAPI + Motor (async MongoDB) + httpx for GHL.
- **Auth**: JWT (HS256) + bcrypt + pyotp TOTP MFA.
- **Storage**: MongoDB collections (users, leads, documents, soa_records, audit_logs). PHI documents encrypted with Fernet AES-128 stored at `/app/backend/secure_storage/{lead_id}/{doc_id}.enc`.
- **GHL**: Private Integration Token auth, v2 API. Falls back to mock-mode when token absent.

## What's been implemented (2026-02-XX, Phase 1 MVP)
### Backend (`/app/backend`)
- `server.py` — app factory, startup hooks, CORS, admin seed
- `models.py` — Pydantic models (User, Lead, SOA, Document, Audit)
- `security.py` — bcrypt, JWT, Fernet doc encryption
- `deps.py` — DB, current-user, RBAC, audit helper
- `auth_router.py` — register (admin only), login (with optional MFA), /me, mfa/enroll (returns QR PNG base64), mfa/verify
- `leads_router.py` — public POST, list, get, patch status, sync-to-GHL (mock-aware)
- `documents_router.py` — public upload (encrypted), list by lead, authenticated download (decrypts on the fly)
- `soa_router.py` — public sign endpoint (canvas data URL + plan types + consent), get by lead
- `audit_router.py` — admin/compliance only list + summary aggregation
- `ghl_client.py` — upsert contact, add tags, create opportunity (mock when no token)
- `seed.py` — idempotent admin seed (`admin@grueninghw.com` / `ChangeMe!2026Admin`)

### Frontend (`/app/frontend/src`)
- `App.js` + protected routes
- `pages/Landing.jsx` — hero, how-it-works, security, full scope/cost section
- `pages/IntakeWizard.jsx` — 5 steps (Personal → Medicare → SOA canvas e-sign → Documents drag-drop → Review)
- `pages/Login.jsx` — split-screen login with OTP slot when MFA required
- `pages/MfaSetup.jsx` — QR code enrollment + 6-digit verify
- `pages/AgentDashboard.jsx` — stat cards, search, status filter, leads table with sync dot
- `pages/LeadDetail.jsx` — full lead, status select, GHL sync button, encrypted doc download, SOA preview
- `pages/AuditLog.jsx` — filter by event type/email, summary cards
- `pages/CompliancePanel.jsx` — architecture, safeguards, cost analysis, phase plan

## Test credentials
See `/app/memory/test_credentials.md`.

## Backlog (deferred, prioritized)
### P0 — required before live use
- Live GHL credentials provisioning + custom field ID mapping
- Move document storage to S3 SSE-KMS (BAA-covered)
- Move JWT secret to KMS-managed and shorten access token TTL with refresh tokens
- HSTS, strict CSP, rate limiting middleware

### P1 — Compliance / Productionization
- Email verification + branded password reset email (Postmark/Paubox under BAA)
- Session timeout warning UI + idle logout
- IP allowlist for admin/compliance
- Encrypted PDF generation of signed SOA + email to beneficiary
- SOC2-style monthly access review report

### P2 — Growth / Scale
- GHL webhooks for inbound contact updates (bidirectional)
- AEP / OEP campaign reminders to agents
- Carrier API integrations for live plan recommendations
- Agent commission tracking
- Beneficiary self-service portal to view application status
- E-fax integration for carrier submission

## Next tasks
1. User to provide GHL Private Integration Token + Location ID + Pipeline IDs → drop into `backend/.env`.
2. Run testing agent to validate full backend + critical frontend flows.
3. Phase 2: production hardening (BAA-covered infra).
