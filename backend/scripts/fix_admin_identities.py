#!/usr/bin/env python3
"""
fix_admin_identities.py — restore Tim Arnold and Matt Monacelli's user records
before the agent_id ownership migration runs.

What it does
------------
- Tim (CTO/admin): forces full_name="Tim Arnold", agent_name="Tim Arnold",
  role="admin", is_active=True, status="active".
- Matt (Director): forces full_name="Matt Monacelli",
  agent_name="Matt Monacelli", role=<--matt-role>, is_active=True,
  status="active".

Lookup
------
- Tim is matched by --tim-email (exact, lowercased).
- Matt is matched by --matt-email (exact, lowercased) when supplied;
  otherwise by a case-insensitive substring scan of full_name OR
  agent_name OR email containing the literal text "monacelli".

Safety
------
- Default mode is DRY-RUN. Pass --apply to actually write.
- Prints BEFORE and AFTER row content for every targeted user, plus a
  one-line audit log entry per write.
- Idempotent: re-running on already-correct rows is a no-op.

Usage
-----
    # Inspect-only — no writes
    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \\
        python backend/scripts/fix_admin_identities.py \\
            --tim-email tim@websynqdesign.com \\
            --matt-email matt@grueninghw.com

    # Apply
    MONGO_URL='mongodb+srv://...' DB_NAME='ghw_medicare' \\
        python backend/scripts/fix_admin_identities.py \\
            --tim-email tim@websynqdesign.com \\
            --matt-email matt@grueninghw.com \\
            --apply
"""
import argparse
import asyncio
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(ROOT / "backend"))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402


PROJECTION = {
    "_id": 0, "id": 1, "email": 1, "full_name": 1, "agent_name": 1,
    "agent_id": 1, "role": 1, "is_active": 1, "status": 1,
}


def _coerce_role(s):
    if s not in ("admin", "compliance"):
        raise argparse.ArgumentTypeError(
            f"--matt-role must be 'admin' or 'compliance', not {s!r}")
    return s


async def _find_tim(db, tim_email):
    return await db.users.find_one(
        {"email": tim_email.lower().strip()}, PROJECTION)


async def _find_matt(db, matt_email):
    if matt_email:
        u = await db.users.find_one(
            {"email": matt_email.lower().strip()}, PROJECTION)
        if u:
            return u, "email"
    # Substring fallback — looks at the three identity fields. We avoid a
    # naive {"$or": [...regex...]} because the regex pattern needs anchored
    # case-insensitivity and substring escape; Mongo's $regex is enough but
    # being explicit makes the intent obvious.
    pat = re.compile(r"monacelli", re.IGNORECASE)
    cursor = db.users.find({}, PROJECTION)
    async for u in cursor:
        for field in ("full_name", "agent_name", "email"):
            v = u.get(field) or ""
            if pat.search(str(v)):
                return u, f"substring:{field}"
    return None, None


def _desired_for(label, target_role):
    return {
        "full_name": label,
        "agent_name": label,
        "role": target_role,
        "is_active": True,
        "status": "active",
    }


async def _apply_audit(db, actor, target, before, after):
    """Write an audit_logs entry so the change is traceable. Best-effort —
    a missing audit_logs collection / index won't block the data fix."""
    try:
        await db.audit_logs.insert_one({
            "id": str(uuid.uuid4()),
            "event_type": "admin_identity_corrected",
            "actor_email": actor,
            "actor_id": None,
            "target_type": "user",
            "target_id": target.get("id"),
            "ip_address": None,
            "user_agent": "fix_admin_identities.py",
            "metadata": {"before": before, "after": after},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        print(f"  (audit log write failed: {e})")


async def _apply_fix(db, user, label, role, dry_run, actor):
    desired = _desired_for(label, role)
    # Compute the actual diff so dry-run output matches what we'd write
    actual_changes = {k: v for k, v in desired.items() if user.get(k) != v}
    if not actual_changes:
        print(f"  No-op — {label}'s record already matches.")
        return False
    actual_changes["updated_at"] = datetime.now(timezone.utc).isoformat()
    print(f"  CHANGES: {json.dumps(actual_changes, default=str)}")
    if dry_run:
        return True
    await db.users.update_one({"id": user["id"]}, {"$set": actual_changes})
    await _apply_audit(db, actor, user, user, actual_changes)
    return True


def _short(u):
    if not u:
        return "(not found)"
    return json.dumps({k: u.get(k) for k in (
        "id", "email", "full_name", "agent_name", "agent_id",
        "role", "is_active", "status")}, default=str)


async def _run(args):
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        raise SystemExit("MONGO_URL and DB_NAME env vars are required.")

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    print()
    print(f"=== Target DB: {db_name} (mode: {'APPLY' if args.apply else 'DRY-RUN'}) ===")

    # ── Tim ─────────────────────────────────────────────────────────────────
    print()
    print("--- Tim Arnold ---")
    tim = await _find_tim(db, args.tim_email)
    print(f"  BEFORE: {_short(tim)}")
    if not tim:
        print(f"  ERROR: no user with email={args.tim_email!r} — check the address "
              f"and re-run. No write attempted.")
    else:
        wrote = await _apply_fix(
            db, tim, "Tim Arnold", "admin",
            dry_run=not args.apply,
            actor="fix_admin_identities.py",
        )
        if wrote and args.apply:
            fresh = await db.users.find_one({"id": tim["id"]}, PROJECTION)
            print(f"  AFTER:  {_short(fresh)}")

    # ── Matt ────────────────────────────────────────────────────────────────
    print()
    print(f"--- Matt Monacelli (target role={args.matt_role}) ---")
    matt, matched_by = await _find_matt(db, args.matt_email)
    print(f"  Matched by: {matched_by or '(none)'}")
    print(f"  BEFORE: {_short(matt)}")
    if not matt:
        print("  ERROR: no user matched. Supply --matt-email or ensure a row "
              "exists with 'Monacelli' in full_name/agent_name/email. No "
              "write attempted.")
    else:
        if tim and matt and matt.get("id") == tim.get("id"):
            print("  REFUSING TO WRITE: Tim's and Matt's lookups resolved to the "
                  "SAME user document. That would overwrite Tim's identity. "
                  "Provide --matt-email explicitly to disambiguate, or fix the "
                  "DB so Matt has his own row first.")
        else:
            wrote = await _apply_fix(
                db, matt, "Matt Monacelli", args.matt_role,
                dry_run=not args.apply,
                actor="fix_admin_identities.py",
            )
            if wrote and args.apply:
                fresh = await db.users.find_one({"id": matt["id"]}, PROJECTION)
                print(f"  AFTER:  {_short(fresh)}")

    print()
    if not args.apply:
        print("DRY-RUN — no writes performed. Re-run with --apply to mutate.")
    else:
        print("Done. Re-run backend/scripts/audit_users.py to confirm.")

    client.close()


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tim-email", required=True,
                   help="Tim's admin email (case-insensitive exact match)")
    p.add_argument("--matt-email", default=None,
                   help="Matt's email if known; otherwise substring scan on Monacelli")
    p.add_argument("--matt-role", type=_coerce_role, default="admin",
                   help="Role for Matt's record: 'admin' or 'compliance' (default: admin)")
    p.add_argument("--apply", action="store_true",
                   help="Actually write changes. Default is dry-run.")
    args = p.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
