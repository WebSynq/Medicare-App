"""TOTP MFA support — pyotp + Fernet-encrypted secret + backup codes.

Storage shape on `users`:
  mfa_enabled: bool
  mfa_secret:  str | None     # Fernet ciphertext of the TOTP shared secret
  mfa_verified_at: str | None # ISO timestamp of last successful challenge

Pending login sessions (post-password, pre-MFA) live in
``db.mfa_pending_sessions`` with TTL = 5 minutes:
  { _id: token, user_id, expires_at: Date, used: bool, used_at }

Backup codes live in ``db.mfa_backup_codes``:
  { user_id, code_hash, used: bool, used_at, created_at }

Failed MFA attempt counters live in ``db.mfa_attempts``:
  { _id: user_id, count, last_at, locked_until }

The TOTP secret is encrypted with MFA_ENCRYPTION_KEY (a Fernet key)
so a database breach can't trivially extract every shared secret —
the attacker also needs the key from the deployment environment.
"""
import logging
import os
import secrets as _secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple
from urllib.parse import quote

import bcrypt
import pyotp
from cryptography.fernet import Fernet


logger = logging.getLogger(__name__)


_BACKUP_CODE_COUNT = 8
_MFA_ATTEMPT_LIMIT = 5
_MFA_LOCKOUT_MINUTES = 15
_PENDING_SESSION_TTL_SECONDS = 300


def _mfa_key() -> bytes:
    """Return the MFA Fernet key as bytes. Read at call-time so test
    code can monkey-patch the env. Raises HTTP-style ValueError when
    unset — caller's job to map to a 500 with a generic message."""
    raw = (os.getenv("MFA_ENCRYPTION_KEY") or "").strip()
    if not raw:
        raise ValueError(
            "MFA_ENCRYPTION_KEY is not configured. MFA cannot operate.",
        )
    return raw.encode("utf-8")


def _fernet() -> Fernet:
    return Fernet(_mfa_key())


def encrypt_secret(plain_secret: str) -> str:
    return _fernet().encrypt(plain_secret.encode("utf-8")).decode("utf-8")


def decrypt_secret(encrypted: str) -> str:
    return _fernet().decrypt(encrypted.encode("utf-8")).decode("utf-8")


def generate_totp_secret() -> str:
    """Base32 secret consumed by both pyotp.TOTP and Google Authenticator."""
    return pyotp.random_base32()


def build_otpauth_uri(secret: str, account_label: str,
                       issuer: str = "Gruening Health & Wealth") -> str:
    """Return the otpauth:// URI for QR-code rendering. account_label is
    typically the user's email; appears as the "account name" in the
    authenticator app."""
    return pyotp.TOTP(secret).provisioning_uri(
        name=account_label, issuer_name=issuer,
    )


def verify_totp(secret: str, code: str, valid_window: int = 1) -> bool:
    """Constant-time TOTP verification. ``valid_window=1`` accepts the
    code from the current 30-s window OR the immediately previous one,
    covering clock skew / a code typed right as it rolls over."""
    if not secret or not code:
        return False
    cleaned = (code or "").replace(" ", "").replace("-", "")
    if not cleaned.isdigit() or len(cleaned) != 6:
        return False
    try:
        return pyotp.TOTP(secret).verify(cleaned, valid_window=valid_window)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("totp verify failure: %s", e)
        return False


# ── Backup codes ─────────────────────────────────────────────────────────
def generate_backup_codes(n: int = _BACKUP_CODE_COUNT) -> List[str]:
    """8 codes of shape XXXX-XXXX, each 8 digits with a hyphen. Shown
    to the user once at MFA setup; only hashes are kept server-side."""
    out: List[str] = []
    for _ in range(n):
        digits = "".join(
            str(_secrets.randbelow(10)) for _ in range(8)
        )
        out.append(f"{digits[:4]}-{digits[4:]}")
    return out


def hash_backup_code(code: str) -> str:
    return bcrypt.hashpw(code.encode("utf-8"),
                          bcrypt.gensalt()).decode("utf-8")


def verify_backup_code(code: str, code_hash: str) -> bool:
    try:
        return bcrypt.checkpw(code.encode("utf-8"),
                               code_hash.encode("utf-8"))
    except Exception:
        return False


async def store_backup_codes(db, user_id: str, codes: List[str]) -> None:
    """Hash and insert. Existing codes for the user are cleared first
    so a re-generation invalidates the prior set (otherwise the old
    set would still be valid until used)."""
    await db.mfa_backup_codes.delete_many({"user_id": user_id})
    now = datetime.now(timezone.utc).isoformat()
    docs = [
        {
            "user_id": user_id,
            "code_hash": hash_backup_code(c),
            "used": False,
            "created_at": now,
        }
        for c in codes
    ]
    if docs:
        await db.mfa_backup_codes.insert_many(docs)


async def consume_backup_code(db, user_id: str, code: str) -> bool:
    """True iff the code matches one of the user's unused codes.
    Atomically flips it to used so a replay attack on the same code
    can't succeed."""
    if not code:
        return False
    cleaned = code.strip().upper()
    cursor = db.mfa_backup_codes.find(
        {"user_id": user_id, "used": False}, {"_id": 1, "code_hash": 1},
    )
    async for row in cursor:
        if verify_backup_code(cleaned, row["code_hash"]):
            result = await db.mfa_backup_codes.update_one(
                {"_id": row["_id"], "used": False},
                {"$set": {"used": True,
                          "used_at": datetime.now(timezone.utc).isoformat()}},
            )
            return result.modified_count == 1
    return False


async def backup_codes_remaining(db, user_id: str) -> int:
    return await db.mfa_backup_codes.count_documents(
        {"user_id": user_id, "used": False},
    )


# ── Pending login sessions (post-password, pre-MFA) ──────────────────────
async def create_pending_session(db, user_id: str) -> Tuple[str, datetime]:
    """Mint a 5-minute single-use token a client redeems by submitting
    a valid TOTP code. Returns (token, expires_at).
    TTL index on `expires_at` evicts stale rows automatically."""
    token = _secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=_PENDING_SESSION_TTL_SECONDS,
    )
    await db.mfa_pending_sessions.insert_one({
        "_id": token,
        "user_id": user_id,
        "created_at": datetime.now(timezone.utc),
        "expires_at": expires_at,
        "used": False,
    })
    return token, expires_at


async def redeem_pending_session(db, token: str) -> Optional[str]:
    """Atomically flip used=True. Returns user_id on success, None when
    the token is unknown / expired / already used."""
    if not token:
        return None
    now = datetime.now(timezone.utc)
    row = await db.mfa_pending_sessions.find_one_and_update(
        {"_id": token, "used": False, "expires_at": {"$gt": now}},
        {"$set": {"used": True, "used_at": now}},
        return_document=False,
    )
    if not row:
        return None
    return row.get("user_id")


# ── Per-user MFA attempt throttling ──────────────────────────────────────
async def is_mfa_locked(db, user_id: str) -> bool:
    row = await db.mfa_attempts.find_one({"_id": user_id}, {"_id": 0})
    if not row:
        return False
    locked_until = row.get("locked_until")
    if not locked_until:
        return False
    if isinstance(locked_until, str):
        try:
            locked_until = datetime.fromisoformat(
                locked_until.replace("Z", "+00:00"),
            )
        except Exception:
            return False
    if locked_until.tzinfo is None:
        locked_until = locked_until.replace(tzinfo=timezone.utc)
    return locked_until > datetime.now(timezone.utc)


async def record_mfa_attempt(db, user_id: str, success: bool) -> dict:
    """Bump or reset the failure counter. Returns {count, locked, lockout_minutes_left}."""
    now = datetime.now(timezone.utc)
    if success:
        await db.mfa_attempts.update_one(
            {"_id": user_id},
            {"$set": {"count": 0, "last_at": now, "locked_until": None}},
            upsert=True,
        )
        return {"count": 0, "locked": False}

    existing = await db.mfa_attempts.find_one({"_id": user_id}, {"_id": 0})
    count = int((existing or {}).get("count", 0)) + 1
    update: dict = {"count": count, "last_at": now}
    locked = False
    if count >= _MFA_ATTEMPT_LIMIT:
        update["locked_until"] = now + timedelta(minutes=_MFA_LOCKOUT_MINUTES)
        locked = True
    await db.mfa_attempts.update_one(
        {"_id": user_id}, {"$set": update}, upsert=True,
    )
    return {
        "count": count,
        "locked": locked,
        "lockout_minutes": _MFA_LOCKOUT_MINUTES if locked else 0,
    }
