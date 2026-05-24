#!/usr/bin/env python3
"""
fix_google_calendar_token.py — one-off repair for a single user's
Google Calendar connection flag.

Use when an OAuth callback succeeded in the browser (the user saw
"Connected ✓") but didn't actually persist on the user document
(typically: state JWT carried a stale user_id, or the user has a
duplicate account). This script DIRECTLY sets
`google_calendar_connected: True` on the user document identified by
the provided AGENT_ID, after sanity-checking that the document exists
and that its email matches AGENT_EMAIL.

It does NOT set the refresh token. After this runs, the user must
re-do the OAuth flow once — the callback (now with observability)
will persist the refresh token correctly.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        AGENT_EMAIL='timarnold@grueninghealthwealth.com' \\
        AGENT_ID='5cc9c4ac-fdde-47f3-ac9c-c597a556cd67' \\
        python backend/scripts/fix_google_calendar_token.py

Safety checks:
    - Refuses to run if AGENT_ID isn't a non-empty string.
    - Refuses to update if the document at AGENT_ID has a different
      email than AGENT_EMAIL (prevents writing to the wrong account
      when both env vars were copy-pasted incorrectly).
    - Prompts y/n before writing.
"""
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


async def _run() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    agent_email = os.environ.get("AGENT_EMAIL", "").strip()
    agent_id = os.environ.get("AGENT_ID", "").strip()

    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required."
        )
    if not agent_email or not agent_id:
        raise SystemExit(
            "AGENT_EMAIL and AGENT_ID env vars are required. Example:\n"
            "    AGENT_EMAIL='timarnold@grueninghealthwealth.com' \\\n"
            "    AGENT_ID='5cc9c4ac-fdde-47f3-ac9c-c597a556cd67' \\\n"
            "        python backend/scripts/fix_google_calendar_token.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    doc = await db.users.find_one(
        {"id": agent_id},
        {"_id": 0, "id": 1, "email": 1,
         "google_calendar_connected": 1,
         "google_calendar_connected_at": 1},
    )

    print()
    print(f"Target id:    {agent_id}")
    print(f"Target email: {agent_email}")
    print()

    if doc is None:
        print(f"✗ No user document found with id={agent_id}.")
        print("  Nothing to do — verify the id and re-run.")
        client.close()
        return

    actual_email = (doc.get("email") or "").strip().lower()
    if actual_email != agent_email.lower():
        print(f"✗ Safety check failed: document id matches but email does not.")
        print(f"  AGENT_EMAIL says: {agent_email}")
        print(f"  Document email:   {actual_email or '(missing)'}")
        print("  Refusing to write to the wrong account.")
        client.close()
        return

    print("Current state on document:")
    print(f"  google_calendar_connected:    {doc.get('google_calendar_connected')!r}")
    print(f"  google_calendar_connected_at: {doc.get('google_calendar_connected_at') or '(missing)'}")
    print()

    if doc.get("google_calendar_connected") is True:
        print("✓ Already True — no change needed.")
        client.close()
        return

    confirm = input(
        "Set google_calendar_connected=True on this document? (y/n): "
    ).strip().lower()
    if confirm != "y":
        print("Aborted.")
        client.close()
        return

    now_iso = datetime.now(timezone.utc).isoformat()
    result = await db.users.update_one(
        {"id": agent_id},
        {"$set": {
            "google_calendar_connected": True,
            "google_calendar_connected_at": now_iso,
        }},
    )

    print()
    print(f"matched_count:  {result.matched_count}")
    print(f"modified_count: {result.modified_count}")
    print(f"  set google_calendar_connected:    True")
    print(f"  set google_calendar_connected_at: {now_iso}")
    print()
    print("Note: refresh_token was NOT set by this script. The user must")
    print("redo the Google OAuth flow once for sync to actually fire.")
    print("(After the callback observability fix is deployed, a zero-match")
    print("write will now log a WARNING instead of silently succeeding.)")
    print()

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
