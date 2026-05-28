# GHW Agent Portal

Proprietary Medicare CRM and agent operations platform for
Gruening Health & Wealth.

## Access

This is a private, invite-only platform.
- Production: app.ghwcrm.com
- Access is granted by system administrators only
- Contact matt@grueninghealthwealth.com for access requests

## Stack

- Frontend: React 19 + Tailwind + shadcn/ui → Vercel
- Backend: FastAPI Python 3.11 → Render
- Database: MongoDB Atlas
- Auth: JWT + magic-link + TOTP MFA

## For Developers

Internal setup documentation is maintained in CLAUDE.md.
All credentials and environment variables are managed via
Render environment variables — never committed to this repo.

Local development setup requires access to environment
variables from the team. Contact tim@websynqdesign.com.

## Security

This platform handles HIPAA-adjacent insurance and Medicare data.

- All PHI fields are encrypted at rest
- Append-only audit log on all sensitive operations
- Invite-only registration — no public sign-up
- Vulnerabilities: report privately to tim@websynqdesign.com

## License

Proprietary — © Gruening Health & Wealth. All rights reserved.
Unauthorized use, copying, or distribution is prohibited.
