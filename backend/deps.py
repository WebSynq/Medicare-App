"""FastAPI dependencies: DB, current user, RBAC."""
import os
from typing import Optional, List
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from datetime import datetime, timezone

from security import decode_token  # noqa: F401 — used by get_current_user + get_optional_user


_mongo_client: Optional[AsyncIOMotorClient] = None


def get_mongo_client() -> AsyncIOMotorClient:
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return _mongo_client


def get_db() -> AsyncIOMotorDatabase:
    return get_mongo_client()[os.environ["DB_NAME"]]


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


async def get_optional_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> Optional[dict]:
    """Returns the current user if authenticated, None if not.

    Used by endpoints that accept both anonymous (public intake) and
    authenticated (agent-on-behalf-of-client) traffic.
    """
    if not token:
        return None
    try:
        payload = decode_token(token)
        user = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0})
        if not user:
            return None
        if not user.get("is_active", True):
            return None
        return user
    except Exception:
        return None


async def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user or not user.get("is_active", True):
        raise HTTPException(status_code=401, detail="User not found or inactive")

    if not payload.get("mfa_verified", False) and user.get("mfa_enabled"):
        raise HTTPException(status_code=401, detail="MFA verification required")

    return user


def require_roles(*roles: str):
    async def _checker(current_user=Depends(get_current_user)):
        if current_user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user
    return _checker


def get_client_ip(request: Request) -> Optional[str]:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else None


async def write_audit(
    db: AsyncIOMotorDatabase,
    event_type: str,
    actor_email: Optional[str] = None,
    actor_id: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    request: Optional[Request] = None,
    metadata: Optional[dict] = None,
):
    import uuid
    doc = {
        "id": str(uuid.uuid4()),
        "event_type": event_type,
        "actor_email": actor_email,
        "actor_id": actor_id,
        "target_type": target_type,
        "target_id": target_id,
        "ip_address": get_client_ip(request) if request else None,
        "user_agent": request.headers.get("user-agent") if request else None,
        "metadata": metadata or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    await db.audit_logs.insert_one(doc)


# ── Brute-force protection ────────────────────────────────────────────────────

async def is_account_locked(db, email: str) -> dict:
    """Check if account is currently locked without recording a new attempt."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    lock_record = await db.login_attempts.find_one({
        "email": email,
        "locked_until": {"$gt": now}
    })
    if lock_record:
        return {"locked": True, "unlock_at": lock_record["locked_until"]}
    return {"locked": False, "unlock_at": None}


async def check_and_record_login_attempt(
    db, email: str, success: bool
) -> dict:
    """
    Track login attempts. Returns:
    {
        "locked": bool,
        "unlock_at": datetime | None,
        "attempts": int
    }
    HIPAA NOTE: We track attempts by email only — no PII stored in this collection.
    """
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    window_start = now - timedelta(minutes=15)
    MAX_ATTEMPTS = 5
    LOCKOUT_MINUTES = 30

    coll = db.login_attempts

    # Clean up old attempts outside the window first
    await coll.delete_many({
        "email": email,
        "attempted_at": {"$lt": window_start},
        "locked_until": None  # Only clean up non-lockout records
    })

    # Check if currently locked
    lock_record = await coll.find_one({
        "email": email,
        "locked_until": {"$gt": now}
    })
    if lock_record:
        return {
            "locked": True,
            "unlock_at": lock_record["locked_until"],
            "attempts": MAX_ATTEMPTS,
        }

    if success:
        # Clear all attempts on successful login
        await coll.delete_many({"email": email})
        return {"locked": False, "unlock_at": None, "attempts": 0}

    # Record this failed attempt
    await coll.insert_one({
        "email": email,
        "attempted_at": now,
        "locked_until": None,
    })

    # Count recent failed attempts
    recent_count = await coll.count_documents({
        "email": email,
        "attempted_at": {"$gte": window_start},
        "locked_until": None,
    })

    if recent_count >= MAX_ATTEMPTS:
        unlock_at = now + timedelta(minutes=LOCKOUT_MINUTES)
        # Record the lockout
        await coll.insert_one({
            "email": email,
            "attempted_at": now,
            "locked_until": unlock_at,
        })
        return {"locked": True, "unlock_at": unlock_at, "attempts": recent_count}

    return {"locked": False, "unlock_at": None, "attempts": recent_count}
