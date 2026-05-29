#!/usr/bin/env python3
"""
migrate_calendars.py — promote users.booking_settings → calendars rows.

Backstory
---------
Feature C sub-phase C1 makes ``calendars`` a first-class collection so a
single agent can own multiple calendars (personal + team round-robin)
and round-robin calendars can have no single owner. The existing per-
agent booking page lives on the user document — this script seeds one
``Individual`` calendar per user that currently has a slug, preserving
the slug verbatim so /book/:slug URLs keep working.

Behavior
--------
For each user with a configured booking slug:

  - Compute a candidate slug (the user's existing slug, lowercased +
    trimmed).
  - If the slug is already taken in ``calendars`` (globally — slugs
    are globally unique per design Q1), append ``-2``, ``-3``, etc.
    to the loser. Earliest ``created_at`` wins (design Q4).
  - Skip the user entirely if a calendar with the same ``owner_id``
    already exists — idempotency (re-runs are no-ops).
  - Insert one ``individual`` calendar with the user's
    ``booking_settings`` copied verbatim into the calendar's
    ``booking_settings`` field. Defaults filled in for any missing
    keys via the shared default helper in ``models``.

Safety properties
-----------------
  - Dry-run by default. ``--apply`` writes.
  - Idempotent on owner_id — already-migrated users are skipped.
  - Per-user independent: a failure on one user leaves the others
    intact; safe to re-run.

Run order
---------
1. Deploy C1 backend so ``calendars`` collection + indexes exist.
2. ``python backend/scripts/migrate_calendars.py``           (dry-run)
3. Inspect counts.
4. ``python backend/scripts/migrate_calendars.py --apply``   (commit)
5. Re-run dry-run — created/collisions must be 0; skipped equals the
   user count with booking slugs.
"""
import argparse
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_calendar_booking_settings() -> dict:
    """Default booking_settings shape for any keys the source user
    document doesn't carry. Lives in this script (not imported from
    models) so the migration runs even when the broader app refuses
    to import — e.g. against a paused Render service where the env
    is partial.
    """
    return {
        "duration_minutes": 30,
        "buffer_minutes": 15,
        "advance_notice_hours": 24,
        "max_bookings_per_day": 10,
        "working_hours": {
            "monday":    {"enabled": True,  "start": "09:00", "end": "17:00"},
            "tuesday":   {"enabled": True,  "start": "09:00", "end": "17:00"},
            "wednesday": {"enabled": True,  "start": "09:00", "end": "17:00"},
            "thursday":  {"enabled": True,  "start": "09:00", "end": "17:00"},
            "friday":    {"enabled": True,  "start": "09:00", "end": "17:00"},
            "saturday":  {"enabled": False, "start": "09:00", "end": "12:00"},
            "sunday":    {"enabled": False, "start": "09:00", "end": "12:00"},
        },
        "meeting_types": ["phone", "video"],
        "timezone": "America/Chicago",
    }


def _coerce_booking_settings(user_bs: dict) -> dict:
    """Copy the user's booking_settings into the calendar shape.

    Translates the two field renames between the legacy
    ``BookingSettings`` shape and the new ``Calendar.booking_settings``
    shape:

      - ``appointment_duration`` → ``duration_minutes``
      - ``max_per_day``          → ``max_bookings_per_day``

    Defaults fill in anything the source row didn't carry so the new
    calendar row is fully populated regardless of the legacy gap.
    """
    out = _default_calendar_booking_settings()
    if not isinstance(user_bs, dict):
        return out
    if "appointment_duration" in user_bs:
        out["duration_minutes"] = int(user_bs["appointment_duration"])
    if "duration_minutes" in user_bs:
        out["duration_minutes"] = int(user_bs["duration_minutes"])
    if "buffer_minutes" in user_bs:
        out["buffer_minutes"] = int(user_bs["buffer_minutes"])
    if "advance_notice_hours" in user_bs:
        out["advance_notice_hours"] = int(user_bs["advance_notice_hours"])
    if "max_per_day" in user_bs:
        out["max_bookings_per_day"] = int(user_bs["max_per_day"])
    if "max_bookings_per_day" in user_bs:
        out["max_bookings_per_day"] = int(user_bs["max_bookings_per_day"])
    if isinstance(user_bs.get("working_hours"), dict):
        out["working_hours"] = user_bs["working_hours"]
    if isinstance(user_bs.get("meeting_types"), list):
        out["meeting_types"] = user_bs["meeting_types"]
    if isinstance(user_bs.get("timezone"), str):
        out["timezone"] = user_bs["timezone"]
    return out


async def _slug_taken(db, slug: str) -> bool:
    return bool(await db.calendars.find_one({"slug": slug}, {"_id": 0, "id": 1}))


async def _resolve_unique_slug(db, base_slug: str) -> tuple[str, bool]:
    """Find a free slug. Returns (slug, collided).

    Tries the base slug first; if taken, appends -2 / -3 / … until an
    unclaimed slug lands. ``collided`` is True when we had to suffix.
    """
    candidate = base_slug
    if not await _slug_taken(db, candidate):
        return candidate, False
    n = 2
    while await _slug_taken(db, f"{base_slug}-{n}"):
        n += 1
    return f"{base_slug}-{n}", True


async def _users_with_slug(db) -> list[dict]:
    """Users that currently own a slug. Sort earliest first so the
    collision-loser rule (design Q4) matches "first one keeps the
    original slug".
    """
    cursor = db.users.find(
        {
            "booking_settings.slug": {"$nin": [None, ""]},
        },
        {
            "_id": 0,
            "id": 1,
            "agency_id": 1,
            "full_name": 1,
            "agent_name": 1,
            "email": 1,
            "created_at": 1,
            "booking_settings": 1,
        },
    ).sort("created_at", 1)
    return [row async for row in cursor]


async def migrate(db, apply_writes: bool = False, quiet: bool = False) -> dict:
    """Core migration entry point — callable from tests with a
    mongomock db. Returns a summary dict so tests can assert on
    created / skipped / collision counts without scraping stdout.
    """
    def _say(msg: str) -> None:
        if not quiet:
            print(msg)

    candidates = await _users_with_slug(db)
    _say(f"Found {len(candidates)} user(s) with a booking slug.")
    _say("")

    created = 0
    skipped_existing = 0
    collisions = 0

    for user in candidates:
        # Idempotency: skip if a calendar with this owner_id exists.
        already = await db.calendars.find_one(
            {"owner_id": user["id"]}, {"_id": 0, "id": 1, "slug": 1},
        )
        if already:
            skipped_existing += 1
            _say(f"  SKIP existing → user={user.get('email')} "
                 f"already owns calendar id={already.get('id')} "
                 f"slug={already.get('slug')!r}")
            continue

        user_bs = user.get("booking_settings") or {}
        raw_slug = (user_bs.get("slug") or "").strip().lower()
        if not raw_slug:
            # Defensive — the projection above already filters this.
            continue

        slug, collided = await _resolve_unique_slug(db, raw_slug)
        if collided:
            collisions += 1
            _say(f"  COLLISION → user={user.get('email')} "
                 f"original={raw_slug!r} → resolved={slug!r}")

        agency_id = user.get("agency_id") or "ghw_001"
        name = (
            user.get("agent_name")
            or user.get("full_name")
            or user.get("email")
            or "Calendar"
        )
        doc = {
            "id": str(uuid.uuid4()),
            "agency_id": agency_id,
            "name": f"{name}'s Calendar",
            "type": "individual",
            "slug": slug,
            "color": "#6366f1",
            "source_label": "manual",
            "owner_id": user["id"],
            "member_ids": [],
            "distribution": None,
            "booking_settings": _coerce_booking_settings(user_bs),
            "is_active": True,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }

        if apply_writes:
            await db.calendars.insert_one(doc)
        created += 1
        _say(f"  CREATE → user={user.get('email')} slug={slug!r} "
             f"owner_id={user['id']}")

    _say("")
    _say("=== Summary ===")
    _say(f"  created           : {created}")
    _say(f"  skipped (existing): {skipped_existing}")
    _say(f"  slug collisions   : {collisions}")
    _say("")
    if not apply_writes:
        _say("DRY-RUN — no writes performed. Re-run with --apply to commit.")
    elif created == 0 and skipped_existing == len(candidates):
        _say("OK — migration is idempotent; nothing to do.")
    else:
        _say(f"OK — created {created} calendar row(s).")

    return {
        "created": created,
        "skipped_existing": skipped_existing,
        "collisions": collisions,
        "total_candidates": len(candidates),
    }


async def _run(apply_writes: bool) -> None:
    """CLI wrapper — opens a real Motor connection from env vars and
    delegates to ``migrate``.
    """
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\\n"
            "        python backend/scripts/migrate_calendars.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    print()
    mode = "APPLY" if apply_writes else "DRY-RUN"
    print(f"=== Target DB: {db_name} (mode: {mode}) ===")
    await migrate(db, apply_writes=apply_writes, quiet=False)
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
