#!/usr/bin/env python3
"""
audit_users.py — read-only print of every row in db.users.

This script makes NO writes. Use it before fix_admin_identities.py to capture
the BEFORE state, and again afterwards to verify.

Usage:
    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \
        python backend/scripts/audit_users.py

The script prints a fixed-width table and a JSON summary block so the output
is easy to paste into chat / a ticket / git.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

# Allow running both as `python backend/scripts/audit_users.py` and from
# inside backend/scripts/ directly.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


# Display widths chosen to fit a standard 120-col terminal while showing the
# fields that matter for identity work.
_FIELDS = ("id", "email", "full_name", "agent_name", "role", "is_active",
           "agent_id", "status")
_WIDTHS = (38, 38, 24, 24, 12, 9, 38, 10)


def _row_for_table(u):
    out = []
    for f, w in zip(_FIELDS, _WIDTHS):
        v = u.get(f)
        if v is None:
            s = "(null)"
        elif isinstance(v, bool):
            s = "true" if v else "false"
        else:
            s = str(v)
        if len(s) > w:
            s = s[: w - 2] + ".."
        out.append(s.ljust(w))
    return "  ".join(out)


def _header_line():
    parts = [f.ljust(w) for f, w in zip(_FIELDS, _WIDTHS)]
    rule = ["-" * w for w in _WIDTHS]
    return "  ".join(parts), "  ".join(rule)


async def _run():
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit(
            "MONGO_URL and DB_NAME env vars are required. Example:\n"
            "    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \\\n"
            "        python backend/scripts/audit_users.py"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    users = await db.users.find({}, {"_id": 0}).sort("created_at", 1).to_list(length=None)

    print()
    print(f"=== USERS in {db_name}.users ({len(users)} rows) ===")
    hdr, rule = _header_line()
    print(hdr)
    print(rule)
    for u in users:
        print(_row_for_table(u))

    # Summary buckets so it's easy to spot mislabeled rows at a glance.
    by_role = {}
    by_agent_name = {}
    missing_agent_id = []
    missing_agent_name = []
    for u in users:
        role = u.get("role") or "(null)"
        by_role[role] = by_role.get(role, 0) + 1
        an = u.get("agent_name") or "(null)"
        by_agent_name[an] = by_agent_name.get(an, 0) + 1
        if not u.get("agent_id"):
            missing_agent_id.append({"id": u.get("id"), "email": u.get("email")})
        if not u.get("agent_name"):
            missing_agent_name.append({"id": u.get("id"), "email": u.get("email")})

    print()
    print("=== SUMMARY ===")
    print(json.dumps({
        "total": len(users),
        "by_role": by_role,
        "by_agent_name": by_agent_name,
        "missing_agent_id": missing_agent_id,
        "missing_agent_name": missing_agent_name,
    }, indent=2))

    client.close()


if __name__ == "__main__":
    asyncio.run(_run())
