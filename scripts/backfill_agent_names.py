#!/usr/bin/env python3
"""
backfill_agent_names.py
=======================
One-time migration: populate users.agent_name from the canonical
EMAIL_PREFIX_TO_AGENT map for any user where the field is missing,
None, or empty.

Why this exists:
- Task 1 of the prior commission session added users.agent_name as the
  identity field that drives ComTrack lookups, the audit endpoints, the
  AI chat context injector, and the leaderboard.
- Users who registered BEFORE that change have agent_name=null on their
  document, so /commissions/live returns 400 and /leaderboard skips
  their row. This script fills in the missing values from the email
  prefix.

The mapping is imported from scripts/import_production.py (single
source of truth) — do NOT redefine it here or the two scripts will
drift the moment a new agent is onboarded.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \\
        python scripts/backfill_agent_names.py

    # Inspect only — no writes
    python scripts/backfill_agent_names.py --dry-run
"""
import argparse
import asyncio
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from import_production import EMAIL_PREFIX_TO_AGENT  # canonical map  # noqa: E402


logging.basicConfig(level=logging.INFO,
                     format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_agent_names")


def _agent_name_from_email(email):
    """Resolve agent_name from the email prefix (before @). Returns None for
    unknown prefixes so the caller can decide whether to skip or flag."""
    if not email:
        return None
    s = str(email).strip().lower()
    if "@" not in s:
        return None
    prefix = s.split("@", 1)[0]
    return EMAIL_PREFIX_TO_AGENT.get(prefix)


def _needs_backfill(user):
    """A user needs a backfill if agent_name is missing, None, or empty
    whitespace. Anything already populated is treated as authoritative —
    even if it doesn't match the email map (could be a manual admin
    correction)."""
    current = user.get("agent_name")
    if current is None:
        return True
    if isinstance(current, str) and current.strip() == "":
        return True
    return False


# Fixed-width columns the print table aligns to.
_FMT = "{:<26}  {:<32}  {:<22}  {:<24}  {:<10}"


def _print_user_table(users, label):
    print()
    print(f"=== {label} ({len(users)} users) ===")
    print(_FMT.format("_id", "email", "full_name", "agent_name", "role"))
    print(_FMT.format("-" * 26, "-" * 32, "-" * 22, "-" * 24, "-" * 10))
    for u in users:
        # _id may be ObjectId or string; coerce to a short stringified form.
        oid = str(u.get("_id", ""))
        if len(oid) > 24:
            oid = oid[:24] + ".."
        email = (u.get("email") or "")[:32]
        full_name = (u.get("full_name") or "")[:22]
        agent_name = u.get("agent_name")
        if agent_name is None:
            agent_display = "(null)"
        elif isinstance(agent_name, str) and agent_name.strip() == "":
            agent_display = "(empty)"
        else:
            agent_display = agent_name[:24]
        role = (u.get("role") or "")[:10]
        print(_FMT.format(oid, email, full_name, agent_display, role))


async def _run(dry_run: bool) -> dict:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \\\n"
            "        python scripts/backfill_agent_names.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    coll = db.users

    # Read every user — print BEFORE state so the operator has a record of
    # what they're about to mutate. Sorted by email for stable diff'ing.
    all_users = await coll.find({}).sort("email", 1).to_list(length=None)
    _print_user_table(all_users, "USERS BEFORE")

    # Classify
    updated = 0
    skipped_unknown_email = []
    skipped_already_set = 0
    skipped_no_email = []
    updates_planned = []  # (email, _id, resolved_name)
    now_iso = datetime.now(timezone.utc).isoformat()

    for u in all_users:
        if not _needs_backfill(u):
            skipped_already_set += 1
            continue
        email = u.get("email")
        if not email:
            skipped_no_email.append(str(u.get("_id")))
            continue
        resolved = _agent_name_from_email(email)
        if resolved is None:
            skipped_unknown_email.append(email)
            continue
        updates_planned.append((email, u["_id"], resolved))

    # Print the planned mutation set so the operator can sanity-check before
    # any write hits the DB.
    print()
    if updates_planned:
        print(f"=== PLANNED UPDATES ({len(updates_planned)}) ===")
        for email, _id, resolved in updates_planned:
            print(f"  {email:<32}  ->  agent_name = {resolved!r}")
    else:
        print("=== PLANNED UPDATES (0) ===")
        print("  Nothing to backfill -- every user with a known email already has agent_name set.")

    if dry_run:
        print()
        print("DRY RUN -- no writes performed. Re-run without --dry-run to apply.")
    else:
        for email, _id, resolved in updates_planned:
            result = await coll.update_one(
                {"_id": _id},
                {"$set": {"agent_name": resolved, "updated_at": now_iso}},
            )
            if result.modified_count:
                updated += 1

        # Print AFTER state so the operator can confirm in one screenful.
        post = await coll.find({}).sort("email", 1).to_list(length=None)
        _print_user_table(post, "USERS AFTER")

    # Summary block — easy to grep / diff / paste back.
    print()
    print("=== SUMMARY ===")
    print(f"  total users seen           : {len(all_users)}")
    print(f"  already had agent_name set : {skipped_already_set}")
    print(f"  updated                    : {0 if dry_run else updated}"
          f"{' (planned)' if dry_run else ''}")
    if dry_run and updates_planned:
        print(f"  would update               : {len(updates_planned)}")
    print(f"  skipped (no email)         : {len(skipped_no_email)}")
    print(f"  skipped (unknown prefix)   : {len(skipped_unknown_email)}")
    if skipped_unknown_email:
        print("    Unknown emails (add to EMAIL_PREFIX_TO_AGENT in")
        print("    scripts/import_production.py if these are real agents):")
        for e in skipped_unknown_email:
            print(f"      - {e}")
    if skipped_no_email:
        print("    Users missing an email field (data quality):")
        for oid in skipped_no_email:
            print(f"      - _id={oid}")

    client.close()
    return {
        "total": len(all_users),
        "updated": 0 if dry_run else updated,
        "planned": len(updates_planned),
        "skipped_already_set": skipped_already_set,
        "skipped_unknown_email": len(skipped_unknown_email),
        "skipped_no_email": len(skipped_no_email),
        "dry_run": dry_run,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Backfill users.agent_name from the canonical EMAIL_PREFIX_TO_AGENT "
            "map. Safe to re-run — only touches rows where agent_name is "
            "missing/null/empty."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the BEFORE table and the planned updates, but make no writes.",
    )
    args = parser.parse_args()
    stats = asyncio.run(_run(dry_run=args.dry_run))
    logger.info("Backfill done: %s", stats)


if __name__ == "__main__":
    main()
