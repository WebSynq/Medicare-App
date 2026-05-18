"""Idempotent admin seed. Runs on app startup."""
import logging
import os
import uuid
from datetime import datetime, timezone

from security import hash_password


logger = logging.getLogger(__name__)


async def seed_admin(db) -> None:
    """Create the first admin if one doesn't exist.

    Refuses to plant the historical default password in production. If
    SEED_ADMIN_PASSWORD is unset outside of dev, we log loudly and skip — the
    operator must set the env var and restart. This prevents a fresh Render
    deploy from coming up with admin/ChangeMe!2026Admin as a valid login.
    """
    email = os.environ.get("SEED_ADMIN_EMAIL", "admin@grueninghw.com").strip().lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        return

    env = os.environ.get("ENVIRONMENT", "production").lower()
    is_dev = env in ("development", "dev", "local")

    password = os.environ.get("SEED_ADMIN_PASSWORD", "").strip()
    if not password:
        if is_dev:
            password = "DevAdmin!2026Local"
            logger.warning(
                "Seeding dev admin with placeholder password. "
                "Set SEED_ADMIN_PASSWORD before deploying."
            )
        else:
            logger.error(
                "SEED_ADMIN_PASSWORD is not set. Refusing to create the admin "
                "account with a default password. Set the env var on Render "
                "and redeploy; until then no admin will be seeded."
            )
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
    logger.info("Seeded admin account: %s", email)
