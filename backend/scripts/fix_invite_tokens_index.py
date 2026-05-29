#!/usr/bin/env python3
"""
fix_invite_tokens_index.py — align the invite_tokens.expires_at TTL.

Backstory
---------
``server.on_startup`` historically declared the invite_tokens.expires_at
index in two places with different options:

  1. Manual call in on_startup: ``create_index("expires_at",
     expireAfterSeconds=0)`` — TTL turned on.
  2. ``_PROD_INDEXES`` declarative table: ``("invite_tokens",
     "expires_at", {"background": True})`` — TTL turned off.

Whichever path ran FIRST on a given deploy seeded the on-disk index;
the second path tripped MongoDB's IndexOptionsConflict and silently
logged the noisy "Index with name: expires_at_1 already exists with
different options" warning on every boot. Production indexes that
landed before the manual TTL line was added lack the TTL and never
auto-evict expired invite rows.

This script reconciles existing prod indexes with the now-consistent
``expireAfterSeconds=0`` declaration in source.

Behavior
--------
  - Reads the live index_information() for invite_tokens.
  - Finds ``expires_at_1``.
  - If TTL is already 0, prints "already correct" and exits (idempotent).
  - Otherwise, drops the index and recreates with
    ``expireAfterSeconds=0``.
  - Dry-run mode (--dry-run) prints the planned action without writing.

Run order
---------
1. Ship the matching ``_PROD_INDEXES`` change to staging + prod.
2. ``python backend/scripts/fix_invite_tokens_index.py --dry-run``
   (verify it sees the right index + the right TTL state).
3. ``python backend/scripts/fix_invite_tokens_index.py``
   (commit the fix; the drop window is ~ms on a small TTL index).
4. Re-run dry-run — should print "already correct" and exit 0.

After step 4 the next boot's "index ensure" log is clean.
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


_COLLECTION = "invite_tokens"
_INDEX_NAME = "expires_at_1"
_TARGET_TTL_SECONDS = 0


async def _run(mongo_url: str, db_name: str, dry_run: bool) -> int:
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    coll = db[_COLLECTION]

    print()
    mode = "DRY-RUN" if dry_run else "APPLY"
    print(f"=== Target DB: {db_name} (mode: {mode}) ===")
    print(f"Collection: {_COLLECTION}")
    print(f"Index:      {_INDEX_NAME}")
    print(f"Target TTL: expireAfterSeconds={_TARGET_TTL_SECONDS}")
    print()

    try:
        info = await coll.index_information()
    except Exception as exc:                                    # noqa: BLE001
        print(f"FATAL: could not read index_information(): {exc}")
        client.close()
        return 2

    existing = info.get(_INDEX_NAME)
    if existing is None:
        print(f"INFO  Index {_INDEX_NAME!r} does not exist yet. "
              f"Creating with TTL={_TARGET_TTL_SECONDS}.")
        if dry_run:
            print("DRY-RUN — no writes. Re-run without --dry-run to apply.")
            client.close()
            return 0
        await coll.create_index(
            "expires_at",
            expireAfterSeconds=_TARGET_TTL_SECONDS,
            background=True,
        )
        print("OK — index created.")
        client.close()
        return 0

    current_ttl = existing.get("expireAfterSeconds")
    print(f"Current index options: {existing}")
    print(f"Current TTL:           {current_ttl!r}")

    if current_ttl == _TARGET_TTL_SECONDS:
        print()
        print("OK — TTL already correct. No action needed (idempotent).")
        client.close()
        return 0

    print()
    print(f"PLAN — drop {_INDEX_NAME!r} and recreate with "
          f"expireAfterSeconds={_TARGET_TTL_SECONDS}.")
    if dry_run:
        print("DRY-RUN — no writes. Re-run without --dry-run to apply.")
        client.close()
        return 0

    try:
        await coll.drop_index(_INDEX_NAME)
        print(f"  dropped {_INDEX_NAME!r}")
    except Exception as exc:                                    # noqa: BLE001
        print(f"FATAL: drop_index failed: {exc}")
        client.close()
        return 3

    try:
        await coll.create_index(
            "expires_at",
            expireAfterSeconds=_TARGET_TTL_SECONDS,
            background=True,
        )
        print(f"  recreated with TTL={_TARGET_TTL_SECONDS}")
    except Exception as exc:                                    # noqa: BLE001
        print(f"FATAL: create_index failed after drop: {exc}")
        print("       The index is missing; rerun this script ASAP.")
        client.close()
        return 4

    # Verification.
    info_after = await coll.index_information()
    fresh = info_after.get(_INDEX_NAME) or {}
    print()
    print("Verification — index after recreate:")
    print(f"  {fresh}")
    if fresh.get("expireAfterSeconds") == _TARGET_TTL_SECONDS:
        print()
        print("OK — TTL aligned to expireAfterSeconds=0.")
        client.close()
        return 0
    print("WARN — TTL mismatch after recreate. Investigate immediately.")
    client.close()
    return 5


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--mongo-url",
        default=os.environ.get("MONGO_URL"),
        help="MongoDB connection string (defaults to $MONGO_URL).",
    )
    parser.add_argument(
        "--db-name",
        default=os.environ.get("DB_NAME") or "gruening_medicare",
        help="Database name (defaults to $DB_NAME or 'gruening_medicare').",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the planned action without writing. Safe to run anywhere.",
    )
    args = parser.parse_args()

    if not args.mongo_url:
        raise SystemExit(
            "MONGO_URL is required. Pass --mongo-url or set the env var.",
        )

    exit_code = asyncio.run(_run(
        mongo_url=args.mongo_url,
        db_name=args.db_name,
        dry_run=args.dry_run,
    ))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
