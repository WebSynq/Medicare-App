#!/usr/bin/env python3
"""
cleanup_duplicate_user.py — DELETE a single user document by id.

Use to remove a duplicate / orphaned / test user record. Destructive
and irreversible — there is no soft-delete here; the document is
permanently removed from db.users.

Safety rails (beyond the y/n confirm):
    - Refuses to delete the LAST active admin/owner — would lock the
      portal. Even an explicit "y" can't override.
    - Surfaces the orphan blast radius before asking:
      counts of leads.agent_id, appointments.agent_id, and
      audit_logs.actor_id that reference this user. Those records
      stay in the DB after the delete (we don't cascade) but become
      orphaned — operator sees the count and decides.
    - Redacts hashed_password and google_calendar_refresh_token
      from the printout; shows PRESENT / MISSING markers instead.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        TARGET_ID='5cc9c4ac-fdde-47f3-ac9c-c597a556cd67' \\
        python backend/scripts/cleanup_duplicate_user.py
"""
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


# Field names whose VALUES never get printed — we substitute a presence
# marker instead. Add to this set if other secret-shaped fields appear.
_REDACTED_FIELDS = frozenset({
    "hashed_password",
    "google_calendar_refresh_token",
})


def _safe_render(doc: dict) -> dict:
    """Return a shallow copy of the doc safe to print — secret-shaped
    fields are replaced with 'PRESENT' / 'MISSING' markers, never the
    value itself."""
    out = {}
    for k, v in doc.items():
        if k in _REDACTED_FIELDS:
            out[k] = "PRESENT" if v else "MISSING"
        else:
            out[k] = v
    return out


async def _run() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    target_id = (os.environ.get("TARGET_ID") or "").strip()

    if not mongo_url or not db_name:
        raise SystemExit("MONGO_URL and DB_NAME env vars are required.")
    if not target_id:
        raise SystemExit(
            "TARGET_ID env var is required. Example:\n"
            "    TARGET_ID='5cc9c4ac-fdde-47f3-ac9c-c597a556cd67' \\\n"
            "        python backend/scripts/cleanup_duplicate_user.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    # Pull the whole doc minus _id so all custom fields are visible
    # before we redact the secret-shaped ones for printing.
    doc = await db.users.find_one({"id": target_id}, {"_id": 0})

    print()
    if doc is None:
        print(f"✗ No user document with id='{target_id}'. Nothing to delete.")
        client.close()
        return

    safe = _safe_render(doc)

    print(f"=== User document at id={target_id} ===")
    print(json.dumps(safe, indent=2, default=str, sort_keys=True))
    print()

    # ── Orphan blast radius ──────────────────────────────────────────────
    related_leads = await db.leads.count_documents({"agent_id": target_id})
    related_appts = await db.appointments.count_documents({"agent_id": target_id})
    related_audit = await db.audit_logs.count_documents({"actor_id": target_id})

    print("Related records that reference this user (would NOT be cascaded):")
    print(f"  leads.agent_id     = {target_id}: {related_leads}")
    print(f"  appointments.agent_id = {target_id}: {related_appts}")
    print(f"  audit_logs.actor_id   = {target_id}: {related_audit}")
    if related_leads or related_appts:
        print("  ⚠ Deleting this user will leave the records above orphaned.")
        print("    Re-assign them first (see scripts/migrate_agent_ownership.py)")
        print("    if they should remain owned by an active agent.")
    print()

    # ── Last-admin lockout protection ────────────────────────────────────
    role = (doc.get("role") or "").lower()
    if role in ("admin", "owner"):
        other_admins = await db.users.count_documents({
            "role": {"$in": ["admin", "owner"]},
            "id": {"$ne": target_id},
            "is_active": {"$ne": False},
        })
        if other_admins == 0:
            print(
                "✗ HARD-STOP — this is the LAST active admin/owner. Deleting it\n"
                "  would lock the portal. Refusing even with explicit confirm."
            )
            client.close()
            return
        print(f"  (admin/owner role — {other_admins} other admin(s) remain after delete.)")
        print()

    # ── Confirm + delete ─────────────────────────────────────────────────
    confirm = input("Delete this user document? (y/n): ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        client.close()
        return

    result = await db.users.delete_one({"id": target_id})

    print()
    print(f"deleted_count: {result.deleted_count}")
    if result.deleted_count == 1:
        print(f"✓ User document {target_id} deleted.")
    else:
        print("⚠ Delete reported 0 — the document may have been removed between")
        print("  the find and the delete. Re-run to confirm absence.")
    print()

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
