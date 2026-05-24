#!/usr/bin/env python3
"""
check_google_calendar_flag.py — diagnostic for Google Calendar sync.

Read-only. Queries the live `users` collection for one specific agent
and reports whether the Google Calendar OAuth callback successfully
stamped the connection flag + refresh token on their user document.

The refresh token value is NEVER printed — only "PRESENT" / "MISSING".
The token is encrypted at rest (PHIEncryption / PHI_FIELD_KEY) but
even ciphertext should never land in operator terminals or logs.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\
        python backend/scripts/check_google_calendar_flag.py

Output:
    FLAG: Connected ✓                      → connected=True
    FLAG: Not connected — OAuth callback   → False / missing flag
    write failed
    FLAG: User not found                   → no doc matches the email
"""
import asyncio
import os
import sys
from pathlib import Path

# Allow running both as `python backend/scripts/check_google_calendar_flag.py`
# and from inside backend/scripts/ directly (mirrors audit_users.py).
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


TARGET_EMAIL = "timarnold@grueninghealthwealth.com"


async def _run() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='gruening_medicare' \\\n"
            "        python backend/scripts/check_google_calendar_flag.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    doc = await db.users.find_one(
        {"email": TARGET_EMAIL},
        {
            "google_calendar_connected": 1,
            "google_calendar_connected_at": 1,
            "google_calendar_refresh_token": 1,
            "id": 1,
            "_id": 0,
        },
    )

    print()
    print(f"=== Google Calendar flag check for {TARGET_EMAIL} ===")
    print()

    if doc is None:
        print("(no user document matches that email)")
        print()
        print("FLAG: User not found")
        client.close()
        return

    # Mask the token — print only its presence, never its value.
    token_value = doc.get("google_calendar_refresh_token")
    token_presence = "PRESENT" if token_value else "MISSING"

    print(f"  id:                              {doc.get('id') or '(missing)'}")
    print(f"  google_calendar_connected:       {doc.get('google_calendar_connected')!r}")
    print(f"  google_calendar_connected_at:    {doc.get('google_calendar_connected_at') or '(missing)'}")
    print(f"  google_calendar_refresh_token:   {token_presence}")
    print()

    if doc.get("google_calendar_connected") is True:
        print("FLAG: Connected ✓")
    else:
        print("FLAG: Not connected — OAuth callback write failed")
    print()

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
