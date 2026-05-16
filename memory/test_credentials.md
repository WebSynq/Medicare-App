# Test Credentials — Gruening Health & Wealth Medicare Intake

## Seeded Admin (auto-created on backend startup)
- **Email**: `admin@grueninghw.com`
- **Password**: `ChangeMe!2026Admin`
- **Role**: `admin`
- **MFA**: Not enabled by default (can be enrolled from UI)

Source: backend/.env `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Seed runs on FastAPI startup (idempotent — won't recreate if user exists).

## Notes for Testing Agent
- Login endpoint: `POST /api/auth/login` with `{email, password, mfa_code?}`
- If MFA is enabled, login first returns `mfa_required:true` + pre-auth token, then submit `mfa_code` on a second call to get full token.
- For agents/compliance accounts, register through `POST /api/auth/register` with admin JWT.
- Public intake form at `POST /api/leads` (no auth required for beneficiary submission).
