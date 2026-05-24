#!/usr/bin/env python3
"""
update_agent_email.py — change the email on a single user document.

Updates ONLY the user document — denormalized references on other
collections (audit_logs.actor_email, leads.agent_email,
appointments.agent_email, etc.) are intentionally left at their
historical values so the audit trail of who-did-what-when stays
accurate.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        OLD_EMAIL='tim@example.com' \\
        NEW_EMAIL='timarnold@grueninghealthwealth.com' \\
        python backend/scripts/update_agent_email.py

Safety:
    - Refuses to run if OLD_EMAIL doesn't match exactly one user.
    - Refuses to run if NEW_EMAIL is already used on a DIFFERENT
      user document (would violate the unique email index and
      cause a DuplicateKeyError on write).
    - Treats OLD_EMAIL == NEW_EMAIL (after lowercase + strip) as
      a no-op.
    - Updates ONLY the `email` field — never touches `_id` or `id`.
    - Prompts y/n before writing.
"""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


async def _run() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    old_email = (os.environ.get("OLD_EMAIL") or "").strip().lower()
    new_email = (os.environ.get("NEW_EMAIL") or "").strip().lower()

    if not mongo_url or not db_name:
        raise SystemExit("MONGO_URL and DB_NAME env vars are required.")
    if not old_email or not new_email:
        raise SystemExit(
            "OLD_EMAIL and NEW_EMAIL env vars are required. Example:\n"
            "    OLD_EMAIL='tim@example.com' \\\n"
            "    NEW_EMAIL='timarnold@grueninghealthwealth.com' \\\n"
            "        python backend/scripts/update_agent_email.py"
        )

    if old_email == new_email:
        print(f"OLD_EMAIL and NEW_EMAIL are the same ({old_email}). No-op.")
        return

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    target = await db.users.find_one(
        {"email": old_email},
        {"_id": 0, "id": 1, "email": 1, "role": 1, "agency_id": 1,
         "full_name": 1, "status": 1, "is_active": 1},
    )

    print()
    if target is None:
        print(f"✗ No user document with email='{old_email}' — nothing to update.")
        client.close()
        return

    print(f"=== Found user matching OLD_EMAIL '{old_email}' ===")
    print(f"  id:         {target.get('id') or '(missing)'}")
    print(f"  email:      {target.get('email') or '(missing)'}")
    print(f"  full_name:  {target.get('full_name') or '(missing)'}")
    print(f"  role:       {target.get('role') or '(missing)'}")
    print(f"  agency_id:  {target.get('agency_id') or '(missing)'}")
    print(f"  status:     {target.get('status') or '(missing)'}")
    print(f"  is_active:  {target.get('is_active')!r}")
    print()

    # Safety: ensure NEW_EMAIL isn't already on a DIFFERENT document.
    # (Same id is fine — that's already handled by the old==new no-op
    # above, but defend in depth in case of unicode / case oddities.)
    conflict = await db.users.find_one(
        {"email": new_email, "id": {"$ne": target.get("id")}},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1},
    )
    if conflict is not None:
        print(
            f"✗ NEW_EMAIL '{new_email}' is already on a different user document:"
        )
        print(f"    id={conflict.get('id')}  full_name={conflict.get('full_name')!r}")
        print("  Refusing to update — would violate the unique email index.")
        print("  Resolve the duplicate manually before re-running.")
        client.close()
        return

    print(f"This will change email from '{old_email}' → '{new_email}'.")
    print("(`id`, `_id`, and all other fields stay unchanged.)")
    confirm = input("Proceed? (y/n): ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        client.close()
        return

    result = await db.users.update_one(
        {"id": target["id"]},   # filter by stable id, not the email being mutated
        {"$set": {"email": new_email}},
    )

    print()
    print(f"matched_count:  {result.matched_count}")
    print(f"modified_count: {result.modified_count}")
    if result.modified_count == 1:
        print(f"✓ Email updated: {old_email} → {new_email}")
    elif result.matched_count == 1 and result.modified_count == 0:
        print("• Document matched but no fields changed (already at NEW_EMAIL).")
    else:
        print("⚠ Unexpected result — verify by re-running check or query manually.")
    print()
    print(
        "Note: denormalized references (audit_logs.actor_email, leads.agent_email,\n"
        "appointments.agent_email, etc.) were intentionally NOT updated — they\n"
        "preserve the historical record of who acted under which email at the time."
    )
    print()

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
