# Gruening Health & Wealth — Secure Medicare Intake Portal

A HIPAA-aligned Medicare insurance intake platform that replaces fragile n8n forms with a compliant intake experience: multi-step eligibility wizard, CMS-compliant SOA e-signature, AES-encrypted document upload, agent dashboard, append-only audit log, and bi-directional sync with GoHighLevel (GHL) API v2.

> **Built on a React + FastAPI + MongoDB stack.** Designed for migration to AWS / MongoDB Atlas HIPAA-tier infrastructure with signed Business Associate Agreements before any real PHI is processed.

---

## Table of Contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Local development](#local-development)
4. [Environment variables](#environment-variables)
5. [Seeded admin & test credentials](#seeded-admin--test-credentials)
6. [API surface](#api-surface)
7. [Deployment](#deployment)
8. [HIPAA & security notes](#hipaa--security-notes)
9. [Cost analysis](#cost-analysis)
10. [Roadmap](#roadmap)

---

## Features

- **Public multi-step intake wizard** — Personal info → Medicare details → SOA e-signature (canvas) → encrypted document upload → review.
- **Scope of Appointment (SOA)** — CMS Marketing Guidelines § 422.2264 compliant. Canvas signature + plan-types-discussed + timestamp + IP captured and stored immutably.
- **Document upload, encrypted at rest** — AES-128 Fernet today, AWS S3 SSE-KMS in production. PNG/JPG/WEBP/PDF up to 15 MB.
- **Agent dashboard** — Pipeline view with status filters, GHL sync indicators, search.
- **Lead detail** — Full record with on-demand decrypted document download and SOA preview.
- **GHL sync** — Upsert contact, apply tags, create opportunity in configured pipeline. Falls back to mock-mode when token absent.
- **JWT auth + TOTP MFA** — RFC 6238 TOTP enrollment with QR code, six-digit verification.
- **Role-based access** — `admin`, `agent`, `compliance`.
- **Audit log** — Append-only record of every login, lead create/update, document upload/download, SOA signature, and GHL sync. Filterable by event type, actor, target.
- **Compliance panel** — Architecture, HIPAA safeguards, cost analysis available to admins.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Tailwind, shadcn UI, framer-motion, react-dropzone |
| Backend | FastAPI, Pydantic, Motor (async MongoDB), httpx |
| Auth | JWT (HS256), bcrypt, pyotp (TOTP) |
| Encryption | cryptography.fernet (AES-128) for documents at rest |
| Storage | MongoDB collections (users, leads, documents, soa_records, audit_logs); local disk at `/app/backend/secure_storage/` for documents (MVP) → AWS S3 SSE-KMS for production |
| Integrations | GoHighLevel API v2 (Private Integration Token) |

---

## Local development

### Prerequisites

- Python 3.10+
- Node 18+ / Yarn
- MongoDB (local install or Atlas connection string)

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then edit secrets
uvicorn server:app --reload --host 0.0.0.0 --port 8001
```

### Frontend

```bash
cd frontend
yarn install
cp .env.example .env   # then edit REACT_APP_BACKEND_URL
yarn start             # serves on :3000
```

Open `http://localhost:3000`.

---

## Environment variables

### Backend (`/backend/.env`)

| Variable | Purpose |
|---|---|
| `MONGO_URL` | MongoDB connection string |
| `DB_NAME` | Database name |
| `CORS_ORIGINS` | Comma-separated allowed origins (`*` for dev only) |
| `JWT_SECRET` | **Long random secret (≥32 bytes)** — rotate via KMS in production |
| `JWT_ALGORITHM` | `HS256` |
| `JWT_EXPIRES_MINUTES` | Default `60` |
| `DOC_ENCRYPTION_KEY` | Fernet key (base64). Leave empty in dev — derived from `JWT_SECRET`. **Set explicitly in production.** |
| `DOC_STORAGE_PATH` | Local document directory (MVP only; replace with S3 in prod) |
| `GHL_BASE_URL` | `https://services.leadconnectorhq.com` |
| `GHL_PRIVATE_TOKEN` | Private Integration Token from your GHL location |
| `GHL_LOCATION_ID` | Your GHL location ID |
| `GHL_PIPELINE_ID` | Pipeline to create opportunities in (optional) |
| `GHL_PIPELINE_STAGE_ID` | Stage within that pipeline (optional) |
| `GHL_API_VERSION` | `2021-07-28` |
| `SEED_ADMIN_EMAIL` | Email of admin account auto-created on startup |
| `SEED_ADMIN_PASSWORD` | Password of admin account — rotate immediately after first deploy |

### Frontend (`/frontend/.env`)

| Variable | Purpose |
|---|---|
| `REACT_APP_BACKEND_URL` | Public URL of the backend (e.g. `https://api.intake.grueninghw.com`) |
| `WDS_SOCKET_PORT` | Dev-server websocket port (don't change in cloud builds) |

---

## Seeded admin & test credentials

On every backend startup, an admin account is created **if it doesn't already exist**:

- **Email**: value of `SEED_ADMIN_EMAIL` (default `admin@grueninghw.com`)
- **Password**: value of `SEED_ADMIN_PASSWORD` (default `ChangeMe!2026Admin`)

> **Rotate the password immediately after your first production deploy.** The seed never overwrites an existing user, so a one-time admin reset is the way to change it.

---

## API surface

All endpoints prefixed `/api`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | — | App identity & HIPAA safeguards |
| GET | `/health` | — | Mongo ping |
| POST | `/auth/login` | — | Returns access token (optional MFA) |
| POST | `/auth/register` | admin | Creates a new agent / compliance user |
| GET | `/auth/me` | any | Current user |
| POST | `/auth/mfa/enroll` | any | Returns QR + secret + otpauth URI |
| POST | `/auth/mfa/verify` | any | Confirms TOTP code, enables MFA |
| POST | `/leads` | — (public intake) | Submit Medicare lead |
| GET | `/leads` | agent+ | List with `?status=` & `?q=` |
| GET | `/leads/{id}` | agent+ | Detail |
| PATCH | `/leads/{id}` | agent+ | Update status / notes / assigned agent |
| POST | `/leads/{id}/sync-ghl` | agent+ | Push to GoHighLevel |
| POST | `/documents/upload/{lead_id}` | — (public intake) | Encrypted upload (PNG/JPG/WEBP/PDF, 15 MB max) |
| GET | `/documents/by-lead/{lead_id}` | agent+ | List documents for a lead |
| GET | `/documents/{doc_id}/download` | agent+ | Decrypted download (audited) |
| POST | `/soa/sign` | — (public intake) | Record SOA signature |
| GET | `/soa/by-lead/{lead_id}` | agent+ | Retrieve SOA |
| GET | `/audit` | admin / compliance | Filter audit events |
| GET | `/audit/summary` | admin / compliance | Aggregate event counts |

---

## Deployment

This repo is structured for a **split deployment**: React frontend on a CDN, FastAPI backend on a BAA-signing host, MongoDB on Atlas.

### Recommended layout

| Component | Recommended host | Notes |
|---|---|---|
| Frontend (React build) | Vercel / AWS Amplify / CloudFront | No PHI stored on the CDN — pure static bundle. |
| Backend (FastAPI) | AWS App Runner / Render Team / Fly.io Machines | Must sign a BAA before real PHI. |
| Database | MongoDB Atlas M10 (HIPAA tier) | M0 free tier OK for non-PHI demo. |
| Document storage | AWS S3 with SSE-KMS | Replace `secure_storage/` local writes with S3 client in prod. |
| Secrets | AWS Secrets Manager / Doppler / Render env vars | Never commit `.env` files. |
| DNS | Cloudflare / Route 53 | Add `intake.<your-domain>` for frontend, `api.intake.<your-domain>` for backend. |

### Deploying the frontend to Vercel

1. Push this repo to GitHub.
2. In Vercel → **Add New… → Project** → import the repo.
3. **Root directory**: `frontend`. Framework auto-detects as Create React App.
4. **Environment Variables**:
   - `REACT_APP_BACKEND_URL` = your backend URL (e.g. `https://api.intake.grueninghw.com`)
5. Deploy. Custom domain optional.

### Deploying the backend to AWS App Runner

1. Push this repo to GitHub.
2. AWS Console → **App Runner** → **Create service** → **Source: GitHub** → connect your account → select repo + main branch.
3. **Deployment trigger**: Automatic.
4. **Build settings**: Runtime `Python 3.11`. Build command:
   ```
   pip install -r backend/requirements.txt
   ```
   Start command:
   ```
   cd backend && uvicorn server:app --host 0.0.0.0 --port 8080
   ```
   Port: `8080`.
5. **Environment variables**: copy every key from `backend/.env.example` and fill in real values (load from AWS Secrets Manager for production).
6. **Health check**: `/api/health`.
7. Once deployed, copy the App Runner URL and paste it into Vercel's `REACT_APP_BACKEND_URL`.

### Deploying the backend to Render (simpler alternative)

1. Push to GitHub.
2. Render → **New → Blueprint** → point at `render.yaml` in this repo.
3. Fill in environment variables when prompted.
4. Deploy. Render gives you a `*.onrender.com` URL; map a custom domain in Settings.

### Wiring MongoDB Atlas

1. Create cluster on Atlas (M0 free for demo, M10 + sign BAA for production).
2. **Database Access** → add user.
3. **Network Access** → allow your backend host's egress IP (or `0.0.0.0/0` for App Runner / Render which use dynamic IPs).
4. Connection string → paste as `MONGO_URL` env var on your backend host.

### Wiring GoHighLevel

1. In your GHL location: **Settings → Integrations → Private Integrations → Create**.
2. Grant scopes: `contacts.write`, `contacts.read`, `opportunities.write`, `locations.read`.
3. Copy the token → set `GHL_PRIVATE_TOKEN`.
4. Copy your Location ID → set `GHL_LOCATION_ID`.
5. (Optional) Open the pipeline you want opportunities to land in. Copy the pipeline ID + stage ID → `GHL_PIPELINE_ID` & `GHL_PIPELINE_STAGE_ID`.

---

## HIPAA & security notes

- **TLS 1.2+** enforced at the edge (Vercel / App Runner / Render terminate TLS by default).
- **Encryption at rest**: AES-128 Fernet on uploaded documents. **Replace with AWS S3 SSE-KMS** before processing real PHI.
- **MFA** required for any account that can read PHI. Enrol it on first login.
- **Audit log** is append-only at the application layer. For tamper-evidence in production, ship logs to an immutable store (AWS CloudTrail / S3 Object Lock).
- **Session lifetime**: 60 minutes. Tokens carry an explicit `mfa_verified` claim.
- **PHI minimisation**: PHI never appears in URLs, query strings, or log messages.
- **Before live use**: sign Business Associate Agreements with AWS, MongoDB Atlas, GoHighLevel, your transactional email vendor (Postmark / Paubox), and any monitoring service you add (Sentry on-prem PHI scrubbing, etc.).

A more detailed view of safeguards mapped to specific HIPAA citations is rendered inside the app at `/admin/compliance` (admin-only).

---

## Cost analysis

Indicative Year-1 numbers (USD, recurring infra + compliance overhead; excludes development labor and existing GHL subscription):

| Category | Item | Monthly | Year 1 |
|---|---|---|---|
| Infra | MongoDB Atlas M10 (HIPAA) | $185 | $2,220 |
| Infra | AWS App Runner + ALB + WAF | $220 | $2,640 |
| Infra | S3 + KMS + CloudTrail | $45 | $540 |
| Infra | Atlas backups (PITR 30 d) | $60 | $720 |
| Infra | Domain + SSL + Sentry + logs | $80 | $960 |
| Integrations | Postmark / Paubox (BAA email) | $35 | $420 |
| Compliance | Annual penetration test | — | $6,500 |
| Compliance | HIPAA training + policy bundle | — | $1,200 |
| Compliance | Cyber-liability insurance | $180 | $2,160 |
| **Subtotal** | | **~$805** | **~$17,360** |

One-time build (Phase 1 MVP, ~6 weeks): $28k–$42k.
Phase 2 hardening (BAA + KMS + pen-test fixes, ~4 weeks): $12k–$18k.

---

## Roadmap

- **P0** — Live GHL credentials wired; replace local doc storage with S3 SSE-KMS; rotate `JWT_SECRET` via KMS; HSTS + strict CSP + rate-limiting middleware.
- **P1** — Email verification + branded password reset under BAA; session-idle warning; IP allowlist for admin/compliance; signed-PDF SOA emailed to beneficiary; monthly access-review report.
- **P2** — Bidirectional GHL webhooks; AEP/OEP campaign reminders; carrier API integrations for live plan recommendations; agent commission tracking; beneficiary self-service status portal; e-fax to carriers.

---

## License

Proprietary — © Gruening Health & Wealth. All rights reserved.
