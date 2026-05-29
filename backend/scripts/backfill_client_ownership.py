#!/usr/bin/env python3
"""
backfill_client_ownership.py — stamp agent_id + agency_id on legacy rows.

Backstory
---------
The 2026-05 row-level-scope tightening narrowed FULL_AGENCY_SCOPE_ROLES to
``(admin, owner)`` and folded ``agency_id`` into ``deps.agent_filter``. Every
read path that uses ``agent_filter`` now scopes results to the caller's
agency. Pre-existing rows that pre-date the multi-tenant rollout often
carry no ``agency_id`` field at all (and the ``clients`` collection in
particular has never had ``agent_id`` stamped on it). The graceful-mode
$in clause in ``agent_filter`` keeps those legacy rows visible during the
migration window — this script is what closes the window by writing the
stamps to disk.

What it does
------------
For each business-data collection:

  - Stamp ``agency_id`` on rows where it's missing/null. Default agency is
    the env-var ``AGENCY_ID`` (falls back to ``ghw_001``).
  - On the ``clients`` collection specifically, also stamp ``agent_id`` on
    rows where it's missing/null, using the agency's first admin (oldest
    by ``created_at``) as the owner. The user's spec calls for orphan
    rows to default to the first admin so nothing disappears from view.

Safety properties
-----------------
  - Dry-run by default. Use ``--apply`` to actually write.
  - Only touches rows where the field is missing/null/empty — never
    overwrites an already-stamped row.
  - Idempotent: re-running after a successful run yields zero updates.
  - Per-collection independent: a failure on one collection leaves the
    others intact; safe to re-run.

Run order
---------
1. Deploy backend so the tightened ``agent_filter`` is in production.
2. ``python backend/scripts/backfill_client_ownership.py``           (dry-run)
3. Inspect the per-collection counts.
4. ``python backend/scripts/backfill_client_ownership.py --apply``   (commit)
5. Re-run without --apply — every count must read 0.

After step 5, the ``$in: [..., None]`` clause in agent_filter is dead code
in production. Leaving it in source as a belt-and-suspenders safety net.
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


# Collections that carry per-tenant business data. Every row in each must
# end up with an ``agency_id``. Order is informational — updates are
# independent so a partial failure is safe to re-run.
AGENCY_SCOPED_COLLECTIONS = (
    "leads",
    "clients",
    "policies",
    "documents",
    "appointments",
    "notes",
    "soa_records",
    "tags",
    "import_jobs",
    "production_records",
    "commission_syncs",
)


# "Field missing or empty" filter generator. ``$in: [None]`` matches both
# explicit null AND field-absent docs per MongoDB semantics; the empty
# string case is the rare-but-real "stamped with a bad value" path.
def _missing(field: str) -> dict:
    return {"$or": [
        {field: {"$exists": False}},
        {field: None},
        {field: ""},
    ]}


def _default_agency_id() -> str:
    return os.environ.get("AGENCY_ID", "ghw_001").strip() or "ghw_001"


async def _find_first_admin(db, agency_id: str) -> dict:
    """Oldest admin in the agency (by created_at, ascending). Used as the
    fallback ``agent_id`` for orphan clients rows. Matches the convention
    in ``migrate_agent_ownership.py`` (first admin = legacy data owner).
    """
    # Try agency-scoped first. Falls back to any admin if the agency
    # row doesn't yet tag its admins with agency_id (single-tenant
    # bootstrap state).
    user = await db.users.find_one(
        {"role": "admin", "agency_id": agency_id},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1, "created_at": 1},
        sort=[("created_at", 1)],
    )
    if user:
        return user
    user = await db.users.find_one(
        {"role": "admin"},
        {"_id": 0, "id": 1, "email": 1, "full_name": 1, "created_at": 1},
        sort=[("created_at", 1)],
    )
    if not user:
        raise SystemExit(
            "No admin user found in db.users. Cannot backfill clients."
            "agent_id without a fallback owner. Create an admin first."
        )
    return user


async def _backfill_field(
    coll, missing_filter: dict, set_payload: dict, apply_writes: bool,
) -> tuple[int, int]:
    """Returns (orphans_found_before, modified). On dry-run modified=0."""
    missing = await coll.count_documents(missing_filter)
    if apply_writes and missing > 0:
        result = await coll.update_many(missing_filter, {"$set": set_payload})
        return missing, result.modified_count
    return missing, 0


async def _run(apply_writes: bool) -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\\n"
            "        python backend/scripts/backfill_client_ownership.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    agency_id = _default_agency_id()
    admin = await _find_first_admin(db, agency_id)

    print()
    mode = "APPLY" if apply_writes else "DRY-RUN"
    print(f"=== Target DB: {db_name} (mode: {mode}) ===")
    print(f"Default agency_id : {agency_id}")
    print(f"Fallback agent_id : {admin['id']} ({admin.get('email')})")
    print()

    total_agency_writes = 0
    per_collection_agency = {}

    # Phase 1: stamp agency_id on every business collection.
    for coll_name in AGENCY_SCOPED_COLLECTIONS:
        coll = db[coll_name]
        found, modified = await _backfill_field(
            coll, _missing("agency_id"),
            {"agency_id": agency_id},
            apply_writes,
        )
        per_collection_agency[coll_name] = (found, modified)
        total_agency_writes += modified

    # Phase 2: stamp agent_id on `clients` rows missing it. The clients
    # collection is the only one that historically had NO agent stamp at
    # all (the per-application owner was always tracked via the related
    # `leads` / `policies` rows). The 2026-05 application_router change
    # now stamps agent_id on new upserts; legacy rows need this backfill.
    clients_found, clients_modified = await _backfill_field(
        db["clients"], _missing("agent_id"),
        {"agent_id": admin["id"], "agent_email": (admin.get("email") or "").lower()},
        apply_writes,
    )

    # Print summary.
    name_w = max(len("Collection"),
                 max((len(c) for c in AGENCY_SCOPED_COLLECTIONS), default=10))
    print("Phase 1 — agency_id stamping")
    print(f"  {'Collection'.ljust(name_w)}    Orphans    Updated")
    print(f"  {'-' * name_w}    -------    -------")
    for name, (found, modified) in per_collection_agency.items():
        print(f"  {name.ljust(name_w)}    {found:>7d}    {modified:>7d}")
    print()
    print("Phase 2 — clients.agent_id stamping")
    print(f"  {'clients'.ljust(name_w)}    "
          f"{clients_found:>7d}    {clients_modified:>7d}")
    print()

    # Verification pass.
    print("=== Verification: rows still missing the field ===")
    grand_total_missing = 0
    for coll_name in AGENCY_SCOPED_COLLECTIONS:
        n = await db[coll_name].count_documents(_missing("agency_id"))
        marker = "" if n == 0 else "  <-- WARNING"
        print(f"  {coll_name.ljust(name_w)} agency_id missing : {n:>7d}{marker}")
        grand_total_missing += n
    n_clients_agent = await db["clients"].count_documents(_missing("agent_id"))
    marker = "" if n_clients_agent == 0 else "  <-- WARNING"
    print(f"  {'clients'.ljust(name_w)} agent_id  missing : "
          f"{n_clients_agent:>7d}{marker}")
    grand_total_missing += n_clients_agent
    print()

    if apply_writes:
        if grand_total_missing == 0:
            print("OK — backfill complete. Every row carries agency_id "
                  "(and clients.agent_id where applicable).")
        else:
            print("WARNING — some rows still unstamped. Re-run with --apply "
                  "or investigate write-concern / permission issues.")
    else:
        planned = total_agency_writes + clients_modified
        # On dry-run modified is always 0, so report orphan counts instead.
        planned_dry = sum(found for found, _ in per_collection_agency.values())
        planned_dry += clients_found
        print(f"DRY-RUN — no writes performed. Total updates planned: "
              f"{planned_dry}")
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
