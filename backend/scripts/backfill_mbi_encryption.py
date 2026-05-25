#!/usr/bin/env python3
"""
backfill_mbi_encryption.py — one-shot MBI encryption backfill.

The platform already encrypts MBI (and the other LEAD_PHI_FIELDS) on
every write via `encryption.safe_lead_set`. Legacy lead rows written
before the PHI rollout still hold plaintext MBI values though.
`safe_lead_load` tolerates plaintext on read (defense in depth), but
those rows remain readable from a raw db dump — defeating the at-rest
encryption guarantee.

This script scans every lead, identifies plaintext MBI values, and
re-writes them encrypted. Rows whose MBI already starts with the
Fernet prefix (gAAAA…) are skipped.

Run order:
    # Dry run first — never writes.
    MONGO_URL=... DB_NAME=gruening_medicare PHI_FIELD_KEY=... \\
        python backend/scripts/backfill_mbi_encryption.py --dry-run

    # Live run:
    MONGO_URL=... DB_NAME=gruening_medicare PHI_FIELD_KEY=... \\
        python backend/scripts/backfill_mbi_encryption.py

Exit code: 0 on success, non-zero on configuration failure.
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from pymongo import UpdateOne  # noqa: E402

from encryption import _looks_encrypted, phi_encryption  # noqa: E402


BATCH_SIZE = 500


async def run(dry_run: bool) -> int:
    mongo_url = os.environ.get("MONGO_URL")
    if not mongo_url:
        print("ERROR: MONGO_URL is not set", file=sys.stderr)
        return 2
    if not os.environ.get("PHI_FIELD_KEY"):
        print("ERROR: PHI_FIELD_KEY is not set — cannot encrypt", file=sys.stderr)
        return 2
    db_name = os.environ.get("DB_NAME", "gruening_medicare")

    client = AsyncIOMotorClient(mongo_url)
    try:
        db = client[db_name]
        cursor = db.leads.find(
            {"mbi_number": {"$nin": [None, ""]}},
            {"_id": 0, "id": 1, "mbi_number": 1},
        )

        scanned = 0
        encrypted_count = 0
        skipped = 0
        sample_changes: list = []
        pending: list[UpdateOne] = []

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
            return result.modified_count or 0

        mode = "DRY RUN" if dry_run else "LIVE"
        print(f"[{mode}] Scanning leads.mbi_number in {db_name} "
              f"(batch={BATCH_SIZE})…")

        async for doc in cursor:
            scanned += 1
            mbi = doc.get("mbi_number")
            if mbi is None:
                continue
            if _looks_encrypted(mbi):
                skipped += 1
                continue
            # Plaintext — encrypt it.
            ciphertext = phi_encryption.encrypt(str(mbi))
            if len(sample_changes) < 5:
                masked_before = ("*" * max(0, len(str(mbi)) - 2)
                                  + str(mbi)[-2:])
                sample_changes.append((doc.get("id", "<no-id>"), masked_before))
            if doc.get("id"):
                pending.append(UpdateOne(
                    {"id": doc["id"]},
                    {"$set": {"mbi_number": ciphertext}},
                ))
            encrypted_count += 1

            if len(pending) >= BATCH_SIZE:
                await flush()
            if scanned % BATCH_SIZE == 0:
                print(
                    f"  …scanned={scanned} "
                    f"encrypted={encrypted_count} skipped={skipped}",
                )

        await flush()

        if sample_changes:
            print("\nSample plaintext rows that were re-encrypted "
                  "(MBI masked):")
            for lid, masked in sample_changes:
                print(f"  {lid}: {masked}")

        verb = "Would encrypt" if dry_run else "Encrypted"
        print(
            f"\n[{mode}] Scanned {scanned} | "
            f"{verb} {encrypted_count} | Skipped (already encrypted) {skipped}",
        )
        return 0
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be encrypted but do not write.",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(run(dry_run=args.dry_run)))


if __name__ == "__main__":
    main()
