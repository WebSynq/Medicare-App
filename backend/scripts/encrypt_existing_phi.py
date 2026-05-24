#!/usr/bin/env python3
"""
encrypt_existing_phi.py — one-shot backfill of leads PHI.

Encrypts plaintext values in the three PHI fields on `leads` and stamps
dob_year/dob_month derived from date_of_birth. Idempotent — values that
already look like Fernet ciphertext are skipped, and the dob components
are recomputed each time so re-running is harmless.

Detection: a field "needs encryption" when its value is a non-empty
string that does NOT begin with the Fernet prefix 'gAAAA'.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        PHI_FIELD_KEY='...' \\
        python backend/scripts/encrypt_existing_phi.py

The script prints counts, asks for explicit `y` confirmation, processes
in batches of 100 via bulk_write(UpdateOne) so a multi-thousand-row
backfill is one network round-trip per batch. Errors are appended to
backend/scripts/encrypt_errors.log; the run continues so one bad row
doesn't block the rest.
"""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from pymongo import UpdateOne  # noqa: E402

from encryption import (  # noqa: E402
    LEAD_PHI_FIELDS,
    _FERNET_PREFIX,
    _derive_dob_components,
    phi_encryption,
)

ERROR_LOG = Path(__file__).resolve().parent / "encrypt_errors.log"
BATCH_SIZE = 100


def _needs_encryption(value) -> bool:
    """True iff value is a non-empty plaintext string."""
    if value is None:
        return False
    if not isinstance(value, str):
        return False
    if not value:
        return False
    if value.startswith(_FERNET_PREFIX):
        return False
    return True


def _log_error(lead_id: str, exc: Exception) -> None:
    with ERROR_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{lead_id}\t{type(exc).__name__}\t{exc}\n")


def _build_update(doc: dict) -> dict | None:
    """Return a $set dict for this doc, or None if nothing to do.

    Encrypts plaintext PHI fields and stamps dob_year/dob_month from
    date_of_birth. Never touches values that are already ciphertext.
    """
    update: dict = {}

    for field in LEAD_PHI_FIELDS:
        v = doc.get(field)
        if _needs_encryption(v):
            update[field] = phi_encryption.encrypt(v)

    # Derive dob_year / dob_month from the PLAINTEXT source DOB only.
    # On a partial-state row (DOB already ciphertext from a prior run),
    # skip derivation — parsing ciphertext would yield (None, None)
    # and wipe correct existing components.
    dob = doc.get("date_of_birth")
    if dob is not None and not (isinstance(dob, str) and dob.startswith(_FERNET_PREFIX)):
        year, month = _derive_dob_components(dob)
        if doc.get("dob_year") != year:
            update["dob_year"] = year
        if doc.get("dob_month") != month:
            update["dob_month"] = month

    return update or None


async def _run() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\\n"
            "        PHI_FIELD_KEY='...' \\\n"
            "        python backend/scripts/encrypt_existing_phi.py"
        )
    if not os.environ.get("PHI_FIELD_KEY"):
        raise SystemExit("PHI_FIELD_KEY env var is required.")

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    # Pre-scan: how many leads need any update?
    projection = {"_id": 0, "id": 1, "date_of_birth": 1, "dob_year": 1,
                  "dob_month": 1}
    for f in LEAD_PHI_FIELDS:
        projection[f] = 1

    needs_update = 0
    total = 0
    async for doc in db.leads.find({}, projection):
        total += 1
        if _build_update(doc):
            needs_update += 1

    print()
    print(f"Scanned {total} lead documents.")
    print(f"  {needs_update} need an update "
          "(plaintext PHI to encrypt, or dob components to stamp).")
    print(f"  {total - needs_update} are already up-to-date.")
    print()

    if needs_update == 0:
        print("Nothing to do.")
        client.close()
        return

    print(f"Encrypting will write to {needs_update} documents in batches of "
          f"{BATCH_SIZE}.")
    print(f"Errors (if any) will be appended to: {ERROR_LOG}")
    confirm = input("Proceed? (y/n): ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        client.close()
        return

    # Truncate error log so this run's failures stand on their own.
    if ERROR_LOG.exists():
        ERROR_LOG.unlink()

    processed = 0
    succeeded = 0
    failed = 0
    batch: list[UpdateOne] = []

    async def _flush_batch() -> None:
        nonlocal succeeded, failed
        if not batch:
            return
        try:
            result = await db.leads.bulk_write(batch, ordered=False)
            succeeded += result.modified_count
            # bulk_write doesn't tell us which ops failed in unordered
            # mode unless an exception is raised; partial failures
            # surface via BulkWriteError below.
        except Exception as exc:
            failed += len(batch)
            _log_error("BULK_WRITE", exc)
        batch.clear()

    async for doc in db.leads.find({}, projection):
        update = _build_update(doc)
        if not update:
            continue
        try:
            batch.append(UpdateOne({"id": doc["id"]}, {"$set": update}))
        except Exception as exc:
            failed += 1
            _log_error(doc.get("id", "<unknown>"), exc)
            continue

        if len(batch) >= BATCH_SIZE:
            await _flush_batch()
            processed += BATCH_SIZE
            print(f"  processed {processed} / {needs_update} "
                  f"(succeeded={succeeded}, failed={failed})")

    if batch:
        leftover = len(batch)
        await _flush_batch()
        processed += leftover

    print()
    print("====================")
    print(f"Final: scanned {total}, updated {succeeded}, failed {failed}.")
    if failed:
        print(f"See {ERROR_LOG} for per-row error details.")
    print()

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
