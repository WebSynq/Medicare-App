#!/usr/bin/env python3
"""
backfill_state_normalization.py — one-shot normalization of leads.state.

Pre-rollout writes accepted `state` in arbitrary case ("IL", "il", "Il",
"Illinois", "illinois"). The Pydantic validator on LeadBase now
normalizes on every new write, but legacy rows are still dirty. This
script rewrites them so downstream filters (birthday rule, dashboard,
multi-state segmentation) can compare against a single canonical value.

Rules (mirror models.normalize_state_field exactly):
    - None / blank → leave unchanged (don't overwrite None with None)
    - len == 2 → uppercase
    - full state name (case-insensitive) → 2-letter code
    - anything else → strip().upper()

`state` is NOT a PHI field (see encryption.LEAD_PHI_FIELDS) so we read /
write the raw value directly — no PHI_FIELD_KEY needed.

Idempotent: rows where normalized == stored are skipped.

Usage:
    # Dry-run — prints what WOULD change, writes nothing.
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        python backend/scripts/backfill_state_normalization.py --dry-run

    # Live run:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        python backend/scripts/backfill_state_normalization.py

Exit code: 0 on success, non-zero on any unexpected failure.
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

# Allow `import models` when invoked from the repo root.
ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from pymongo import UpdateOne  # noqa: E402

from models import normalize_state_field  # noqa: E402


BATCH_SIZE = 500


async def run(dry_run: bool) -> int:
    mongo_url = os.environ.get("MONGO_URL")
    if not mongo_url:
        print("ERROR: MONGO_URL env var is not set", file=sys.stderr)
        return 2
    db_name = os.environ.get("DB_NAME", "gruening_medicare")

    client = AsyncIOMotorClient(mongo_url)
    try:
        db = client[db_name]
        # Projection: id + state only — we never read PHI here.
        cursor = db.leads.find({}, {"_id": 0, "id": 1, "state": 1})

        scanned = 0
        updated = 0
        skipped = 0
        pending: list[UpdateOne] = []
        sample_changes: list[tuple[str, str, str]] = []

        async def flush() -> int:
            nonlocal pending
            if not pending:
                return 0
            if dry_run:
                count = len(pending)
                pending = []
                return count
            result = await db.leads.bulk_write(pending, ordered=False)
            pending = []
            # modified_count is what we actually changed in Mongo.
            return result.modified_count or 0

        mode = "DRY RUN" if dry_run else "LIVE"
        print(f"[{mode}] Scanning leads in {db_name}.leads "
              f"(batch={BATCH_SIZE})…")

        async for doc in cursor:
            scanned += 1
            lead_id = doc.get("id")
            stored = doc.get("state")
            normalized = normalize_state_field(stored)

            if stored == normalized:
                skipped += 1
            else:
                if len(sample_changes) < 10:
                    sample_changes.append(
                        (lead_id or "<no-id>", repr(stored), repr(normalized)),
                    )
                if lead_id is not None:
                    # Match on portal id (the canonical key) rather than
                    # _id so this is safe across mongomock + Atlas. The
                    # raw collection write is fine because `state` is
                    # not PHI — no safe_lead_set needed.
                    pending.append(UpdateOne(
                        {"id": lead_id},
                        {"$set": {"state": normalized}},
                    ))
                updated += 1

            if len(pending) >= BATCH_SIZE:
                await flush()

            if scanned % BATCH_SIZE == 0:
                print(
                    f"  …scanned={scanned} "
                    f"updated={updated} skipped={skipped}",
                )

        await flush()

        if sample_changes:
            print("\nSample changes (first 10):")
            for lid, before, after in sample_changes:
                print(f"  {lid}: {before} → {after}")

        verb = "Would update" if dry_run else "Updated"
        print(
            f"\n[{mode}] Scanned {scanned} | "
            f"{verb} {updated} | Skipped {skipped}",
        )
        return 0
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change but do not write to MongoDB.",
    )
    args = parser.parse_args()
    rc = asyncio.run(run(dry_run=args.dry_run))
    sys.exit(rc)


if __name__ == "__main__":
    main()
