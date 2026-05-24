#!/usr/bin/env python3
"""
backfill_enrolled_at.py — one-shot backfill of leads.enrolled_at.

`enrolled_at` is a server-stamped, write-once timestamp set on the
first transition into status="enrolled" (see leads_router.update_lead
and leads_router.update_lead_stage). Pre-rollout rows that were
already enrolled have no enrolled_at — this script stamps them with
`updated_at` as the best available proxy for the enrollment moment.

Idempotent — rows that already have enrolled_at are skipped.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        python backend/scripts/backfill_enrolled_at.py

No PHI is read or written; PHI_FIELD_KEY is not required.
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


ERROR_LOG = Path(__file__).resolve().parent / "backfill_enrolled_at_errors.log"
BATCH_SIZE = 100


def _log_error(lead_id: str, exc: Exception) -> None:
    with ERROR_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{lead_id}\t{type(exc).__name__}\t{exc}\n")


async def _run() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\\n"
            "        python backend/scripts/backfill_enrolled_at.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    # Match enrolled leads that have no enrolled_at yet.
    # Treat both "absent" and "explicit None" as needing backfill.
    query = {
        "status": "enrolled",
        "$or": [
            {"enrolled_at": {"$exists": False}},
            {"enrolled_at": None},
        ],
    }
    projection = {"_id": 0, "id": 1, "updated_at": 1, "created_at": 1}

    needs_update = await db.leads.count_documents(query)
    total_enrolled = await db.leads.count_documents({"status": "enrolled"})

    print()
    print(f"Total enrolled leads:           {total_enrolled}")
    print(f"  Already have enrolled_at:    {total_enrolled - needs_update}")
    print(f"  Need backfill (this run):    {needs_update}")
    print()

    if needs_update == 0:
        print("Nothing to do.")
        client.close()
        return

    print(f"Backfill will set enrolled_at = updated_at for {needs_update} rows")
    print(f"in batches of {BATCH_SIZE}.")
    print(f"Errors (if any) will be appended to: {ERROR_LOG}")
    confirm = input("Proceed? (y/n): ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        client.close()
        return

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
        except Exception as exc:
            failed += len(batch)
            _log_error("BULK_WRITE", exc)
        batch.clear()

    async for doc in db.leads.find(query, projection):
        # Fall back to created_at if a row somehow lacks updated_at —
        # an enrolled lead with no timestamps at all is unusable but
        # we still want to leave SOMETHING in enrolled_at to mark it
        # backfilled. Final fallback: skip the row.
        stamp = doc.get("updated_at") or doc.get("created_at")
        if not stamp:
            failed += 1
            _log_error(doc.get("id", "<unknown>"),
                       ValueError("no updated_at or created_at to use as proxy"))
            continue
        try:
            batch.append(UpdateOne(
                {"id": doc["id"]},
                {"$set": {"enrolled_at": stamp}},
            ))
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
    print(f"Final: {succeeded} backfilled, {failed} failed.")
    if failed:
        print(f"See {ERROR_LOG} for per-row error details.")
    print()

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
