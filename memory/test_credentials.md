# Test Credentials — Gruening Health & Wealth Medicare Intake

## Seeded Admin (auto-created on backend startup)
- **Email**: `admin@grueninghw.com`
- **Password**: read from `SEED_ADMIN_PASSWORD` env var on Render. Seed refuses to create the admin without it set in production.
- **Role**: `admin`

Source: `backend/.env` `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Seed runs on FastAPI startup (idempotent — won't recreate if user exists). Local dev falls back to `DevAdmin!2026Local` when `ENVIRONMENT=development`.

## Notes for Testing Agent
- Auth has two paths — both land at a JWT session cookie:
  - **Option A (magic link)**: `POST /api/auth/magic-link {email}` → opens email → user clicks `/auth/magic?token=…` → SPA POSTs `/api/auth/magic-link/verify {token}` to redeem.
  - **Option B (password)**: `POST /api/auth/login {email, password}` → JWT cookie immediately, no second step.
- Magic-link tokens live in the `magic_link_tokens` collection (hash, 15-min TTL, single-use, opaque 200 on request).
- TOTP MFA was removed — no `mfa_required`, no `mfa_code`, no `mfa_enabled`, no `/auth/mfa/*` endpoints.
- For agents / compliance accounts, register through `POST /api/auth/register` with a valid invite token from `POST /api/auth/invite` (admin-only).
- Public intake form at `POST /api/leads` (no auth required for beneficiary submission).
