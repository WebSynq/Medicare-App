#!/usr/bin/env python3
"""
create_team_accounts.py — seed the three GHW team admin accounts.

Idempotent: every account is keyed by email; an existing email is left
untouched and reported as "skipped". Uses the same bcrypt hashing as
auth_router (via security.hash_password) and writes the same user-doc
shape that seed.py.seed_admin produces.

Usage
-----
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        python backend/scripts/create_team_accounts.py \\
            --password 'Strong!Initial!Pass2026'

The same password is used for every account — each agent should change
it on first login via Settings → Security. Pass --dry-run to inspect
what would be written without touching the database.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Make backend/ importable so we can reuse the canonical password hasher
# instead of vendoring a copy here.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

# We import lazily after the JWT_SECRET check so importing the script
# with --help doesn't blow up on a missing env var.

TEAM_ACCOUNTS = [
    {
        "email": "cesar@grueninghealthwealth.com",
        "full_name": "Cesar GHW",
        "agent_name": "Cesar GHW",
        "role": "admin",
    },
    {
        "email": "matt@grueninghealthwealth.com",
        "full_name": "Matt Monacelli",
        "agent_name": "Matt Monacelli",
        "role": "admin",
    },
    {
        "email": "michael@grueninghealthwealth.com",
        "full_name": "Michael GHW",
        "agent_name": "Michael GHW",
        "role": "admin",
    },
]


async def _create_one(db, hash_password, spec: dict, password: str,
                       dry_run: bool) -> str:
    email = spec["email"].lower().strip()
    existing = await db.users.find_one({"email": email}, {"_id": 0, "id": 1})
    if existing:
        return "skipped"

    if dry_run:
        return "would_create"

    new_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": new_id,
        # Phase-2 scoping: agent_id == user.id, so leads/policies they
        # own are visible to them via deps.agent_filter from minute one.
        "agent_id": new_id,
        "email": email,
        "full_name": spec["full_name"],
        "agent_name": spec["agent_name"],
        "agent_npn": None,
        "role": spec["role"],
        "is_active": True,
        "status": "active",
        "agency_name": "Gruening Health & Wealth",
        "hashed_password": hash_password(password),
        # Brute-force lockout + token-invalidation mirror fields (added
        # in the post-pentest hardening sprint).
        "failed_attempts": 0,
        "last_failed_at": None,
        "locked_until": None,
        "token_version": 0,
        # GHL location id is set later via Agent Management when the
        # admin maps each user to a sub-account.
        "ghl_location_id": None,
        "tcpa_consent": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    return "created"


async def _run(args) -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit("MONGO_URL and DB_NAME env vars are required.")
    if not args.password and not args.dry_run:
        raise SystemExit("--password is required (or use --dry-run).")

    # Import here so the JWT_SECRET-dependent module load only runs when
    # we're actually about to write. (security.py reads JWT_SECRET at
    # import time and will error out otherwise.)
    from security import hash_password  # noqa: WPS433

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    print()
    print(f"=== Target DB: {db_name} "
          f"(mode: {'DRY-RUN' if args.dry_run else 'APPLY'}) ===")
    print()

    created, skipped = [], []
    for spec in TEAM_ACCOUNTS:
        result = await _create_one(
            db, hash_password, spec,
            args.password or "",
            args.dry_run,
        )
        line = f"  {spec['email']:<45} → {result}"
        print(line)
        if result == "created" or result == "would_create":
            created.append(spec["email"])
        elif result == "skipped":
            skipped.append(spec["email"])

    print()
    print(f"Created : {len(created)}")
    print(f"Skipped : {len(skipped)}")
    if args.dry_run:
        print()
        print("DRY-RUN — no writes performed. Re-run without --dry-run to "
              "create the accounts.")
    client.close()


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--password", default=None,
        help=("Initial password for all newly-created accounts. Each user "
              "should change theirs on first login. Required unless --dry-run."),
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Print what would happen without touching the DB.",
    )
    args = p.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
