"""Idempotent admin seed + agent-identity backfill + multi-tenant
foundation seeds. Everything in this module runs on app startup, in
order, and every function is a no-op when there's nothing to do.
"""
import logging
import os
import uuid
from datetime import datetime, timezone

from security import hash_password


logger = logging.getLogger(__name__)


# ── Multi-tenant: GHW agency seed ───────────────────────────────────────
# The GHW agency is the platform's first tenant and the home for every
# super admin. It carries super_admin=True so callers from this agency
# bypass per-feature gates (they own the platform). agency_id is a
# stable string — not a UUID — because the rest of the codebase already
# stamps "ghw_001" on legacy records via deps.get_agency_id().

GHW_AGENCY_ID = "ghw_001"
GHW_SLUG = "ghw"


async def seed_ghw_agency(db) -> None:
    """Create the GHW agency record if it doesn't exist.

    Idempotent: runs on every startup, no-op after first success. Safe
    to redeploy. Never overwrites an existing row — super admins can
    tweak fields via the admin panel after seeding.

    Why a fixed agency_id="ghw_001": every existing leads/clients/
    policies/users row already carries this value (stamped by
    deps.get_agency_id() since the multi-tenant scaffolding landed).
    Migrating GHW now means seeding the agency record to match,
    NOT changing the historical agency_id on 6,666+ records.
    """
    from agency_models import build_agency_defaults
    from tiers import FEATURE_REGISTRY

    existing = await db.agencies.find_one({"agency_id": GHW_AGENCY_ID})
    if existing:
        return

    owner_email = (
        os.environ.get("SEED_ADMIN_EMAIL", "admin@grueninghw.com")
        .strip().lower()
    )
    # GHW gets every feature on — including ops_console and add-ons —
    # because it IS the platform team. Other agencies get their tier
    # defaults instead.
    features = {k: True for k in FEATURE_REGISTRY}
    agency = build_agency_defaults(
        name="Gruening Health & Wealth",
        slug=GHW_SLUG,
        owner_email=owner_email,
        tier="domination",
        super_admin=True,
        created_by="system",
        features_override=features,
    )
    # Pin the agency_id to "ghw_001" so it matches every legacy stamp.
    doc = agency.model_dump()
    doc["agency_id"] = GHW_AGENCY_ID
    await db.agencies.insert_one(doc)
    logger.info(
        "Seeded GHW agency: agency_id=%s slug=%s owner=%s tier=%s",
        GHW_AGENCY_ID, GHW_SLUG, owner_email, agency.tier,
    )


async def backfill_agency_id_on_users(db) -> int:
    """Stamp ``agency_id=ghw_001`` on every existing user row.

    Pre-multi-tenant users have no agency_id. Without this, the new
    deps.get_agency dependency would 404 on every legacy login.
    Idempotent — only touches rows missing the field.
    """
    result = await db.users.update_many(
        {"agency_id": {"$exists": False}},
        {"$set": {"agency_id": GHW_AGENCY_ID}},
    )
    if result.modified_count:
        logger.info(
            "backfill_agency_id_on_users: stamped %d user rows with %s",
            result.modified_count, GHW_AGENCY_ID,
        )
    return result.modified_count


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

    # Default admin identity. Override at seed time via env
    # (SEED_ADMIN_FULL_NAME) or after the fact via PATCH /auth/users/{id}/profile.
    # Tim Arnold is the CTO/admin of record for GHW.
    full_name = os.environ.get("SEED_ADMIN_FULL_NAME", "Tim Arnold").strip() or "Tim Arnold"

    new_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": new_id,
        # Stamp agent_id = user.id and agent_name = full_name at write time
        # so the new admin is fully scoped/resolvable from the moment they
        # log in. Admins/compliance can later impersonate any agent via
        # X-Agent-ID; agent_id stays as the user's own id by default.
        "agent_id": new_id,
        "email": email,
        "full_name": full_name,
        "agent_name": full_name,
        "role": "admin",
        "is_active": True,
        "status": "active",
        "agency_name": None,
        "hashed_password": hash_password(password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    logger.info("Seeded admin account: %s (%s)", email, full_name)


async def backfill_agent_identity(db) -> dict:
    """Backfill ``agent_id`` and ``agent_name`` on existing user rows.

    Why:
        - ``agent_id`` is the scoping key the ``agent_filter`` helper uses to
          keep one agent's data invisible to another. Pre-existing rows
          didn't have it, so without this backfill those users would either
          see nothing or accidentally match a different scope.
        - ``agent_name`` is the downstream identity (ComTrack lookups,
          leaderboard rows). Pre-existing rows often had it null, leaving
          /commissions/live and /leaderboard with blank entries.

    Defaults:
        - ``agent_id`` defaults to the user's own ``id``.
        - ``agent_name`` defaults to ``full_name``. Only applied when the
          user actually has a ``full_name`` so we never clobber the field
          with an empty string. Admins can override via PATCH afterwards.

    Idempotent: re-running on an already-backfilled DB is a no-op. Safe to
    call on every startup.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    agent_id_updated = 0
    agent_name_updated = 0

    cursor = db.users.find(
        {},
        {"_id": 0, "id": 1, "full_name": 1, "agent_id": 1, "agent_name": 1},
    )
    async for user in cursor:
        updates: dict = {}
        if not user.get("agent_id"):
            updates["agent_id"] = user.get("id")
        if not user.get("agent_name") and user.get("full_name"):
            updates["agent_name"] = user["full_name"]
        if updates:
            updates["updated_at"] = now_iso
            await db.users.update_one({"id": user["id"]}, {"$set": updates})
            if "agent_id" in updates:
                agent_id_updated += 1
            if "agent_name" in updates:
                agent_name_updated += 1

    if agent_id_updated or agent_name_updated:
        logger.info(
            "backfill_agent_identity: agent_id=%d agent_name=%d",
            agent_id_updated, agent_name_updated,
        )

    return {
        "agent_id_updated": agent_id_updated,
        "agent_name_updated": agent_name_updated,
    }
