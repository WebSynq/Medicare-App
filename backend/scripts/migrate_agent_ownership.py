#!/usr/bin/env python3
"""
migrate_agent_ownership.py — claim orphaned documents for the first admin.

Backstory
---------
Workspace isolation (Phase 1) introduced ``agent_id`` as the scoping key on
every business-data collection. Documents created BEFORE that change don't
have the field — they would be invisible under the new
``agent_filter`` helper.

This script claims those orphan docs for the first admin user in the system,
unblocking the rollout. It is intentionally simple and safe:

  - Defaults to DRY-RUN. Use --apply to actually write.
  - Only touches docs where ``agent_id`` is missing or null. Already-claimed
    rows are not modified.
  - Stamps ``agent_id`` AND ``agent_email`` so legacy code that filtered by
    email keeps working through the transition.
  - Idempotent — re-running after a successful run yields zero updates and
    the "still missing" count must be 0.

Run order
---------
1. Deploy backend so ``agent_filter`` is in use (otherwise rows would still
   be invisible after the migration anyway).
2. ``python backend/scripts/migrate_agent_ownership.py``           (dry-run)
3. Inspect the per-collection counts.
4. ``python backend/scripts/migrate_agent_ownership.py --apply``   (commit)
5. Re-run without --apply — counts must all be 0.
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


# Collections that carry per-agent business data. Order is informational —
# the script runs independent updates so any failure leaves a partial state
# that's safe to re-run from.
TARGET_COLLECTIONS = (
    "leads",
    "policies",
    "clients",
    "documents",
    "commission_syncs",
    "production_records",
)


# Mongo filter for "agent_id is missing or null". `$exists: false` catches
# documents created before the field existed; `$eq: null` catches docs that
# were inserted with an explicit null.
MISSING_AGENT_ID = {"$or": [
    {"agent_id": {"$exists": False}},
    {"agent_id": None},
    {"agent_id": ""},
]}


async def _find_first_admin(db) -> dict:
    """Return the oldest admin row (by created_at, ascending). The "first"
    admin is the canonical owner of legacy data — usually the operator who
    set up the system."""
    user = await db.users.find_one(
        {"role": "admin"},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1, "created_at": 1},
        sort=[("created_at", 1)],
    )
    if not user:
        raise SystemExit(
            "No admin user found in db.users. Create one with "
            "backend/scripts/create_admin.py first, then re-run."
        )
    return user


async def _run(apply_writes: bool) -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \\\n"
            "        python backend/scripts/migrate_agent_ownership.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    admin = await _find_first_admin(db)
    admin_id = admin["id"]
    admin_email = (admin.get("email") or "").lower().strip()

    print()
    print(f"=== Target DB: {db_name} (mode: {'APPLY' if apply_writes else 'DRY-RUN'}) ===")
    print(f"Claiming orphan rows for first admin:")
    print(f"  id        : {admin_id}")
    print(f"  email     : {admin_email}")
    print(f"  full_name : {admin.get('full_name')!r}")
    print()

    set_payload = {"$set": {
        "agent_id": admin_id,
        "agent_email": admin_email,
    }}

    total_updated = 0
    per_collection = {}

    for coll_name in TARGET_COLLECTIONS:
        coll = db[coll_name]
        # Count first so the dry-run can predict the number of writes.
        missing = await coll.count_documents(MISSING_AGENT_ID)
        if apply_writes and missing > 0:
            result = await coll.update_many(MISSING_AGENT_ID, set_payload)
            modified = result.modified_count
        else:
            modified = 0
        per_collection[coll_name] = {
            "orphans_found": missing,
            "modified": modified,
        }
        total_updated += modified

    # Print the per-collection table.
    name_w = max(len("Collection"), max((len(c) for c in TARGET_COLLECTIONS), default=10))
    print(f"  {'Collection'.ljust(name_w)}    Orphans    Updated")
    print(f"  {'-' * name_w}    -------    -------")
    for name, stats in per_collection.items():
        print(
            f"  {name.ljust(name_w)}    "
            f"{stats['orphans_found']:>7d}    "
            f"{stats['modified']:>7d}"
        )
    print()

    # Final verification — every orphan must be gone after --apply.
    still_missing = {}
    grand_total_missing = 0
    for coll_name in TARGET_COLLECTIONS:
        coll = db[coll_name]
        n = await coll.count_documents(MISSING_AGENT_ID)
        still_missing[coll_name] = n
        grand_total_missing += n

    print(f"=== Verification: docs still missing agent_id ===")
    for name, n in still_missing.items():
        marker = " " if n == 0 else " <-- WARNING"
        print(f"  {name.ljust(name_w)}    {n:>7d}{marker}")
    print()
    print(f"TOTAL orphan docs remaining: {grand_total_missing}")

    if apply_writes:
        if grand_total_missing == 0:
            print("OK — migration complete. Every doc now has agent_id set.")
        else:
            print(
                "WARNING — some docs still missing agent_id. Re-run with "
                "--apply, or investigate why update_many didn't cover them "
                "(write concern? permissions?)."
            )
    else:
        print(f"DRY-RUN — no writes performed. Total updates planned: {total_updated}")
        print("Re-run with --apply to commit.")

    client.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually write changes. Default is dry-run.",
    )
    args = parser.parse_args()
    asyncio.run(_run(apply_writes=args.apply))


if __name__ == "__main__":
    main()
