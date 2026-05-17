"""Idempotent admin seed. Runs on app startup."""
import os
import uuid
from datetime import datetime, timezone

from security import hash_password


async def seed_admin(db) -> None:
    email = os.environ.get("SEED_ADMIN_EMAIL", "admin@grueninghw.com").strip().lower()
    password = os.environ.get("SEED_ADMIN_PASSWORD", "ChangeMe!2026Admin")
    existing = await db.users.find_one({"email": email})
    if existing:
        return
    await db.users.insert_one({
        "id": str(uuid.uuid4()),
        "email": email,
        "full_name": "Administrator",
        "role": "admin",
        "is_active": True,
        "status": "active",
        "agency_name": None,
        "hashed_password": hash_password(password),
        "mfa_secret": None,
        "mfa_enabled": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
