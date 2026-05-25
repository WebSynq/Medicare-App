"""Security utilities: password hashing, JWT, doc encryption."""
import os
import re
import base64
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, List

import bcrypt
import jwt
from cryptography.fernet import Fernet

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_MINUTES = int(os.environ.get("JWT_EXPIRES_MINUTES", "60"))
# Hardening 2: idle-timeout minutes stamped into every fresh JWT under
# the `idle_exp` claim. The SPA fires /auth/refresh on activity to
# bump it back to "now + N". 30-minute default = HIPAA-aligned for
# unattended-workstation scenarios.
JWT_IDLE_TIMEOUT_MINUTES = int(
    os.environ.get("JWT_IDLE_TIMEOUT_MINUTES", "30"),
)

# Common-password blocklist (Hardening 3). Catches the obvious 2026
# pen-test losers — agents try to game length requirements with these.
# Lowercased for the comparison.
_COMMON_PASSWORDS = {
    "password1234", "password12345", "password123!", "password1!aa",
    "qwertyuiop12", "qwerty12345!a", "letmein123456", "welcome12345!",
    "abc123456789!", "iloveyou1234!", "monkey1234!aa", "dragon12345!",
    "trustno1234!a", "admin1234567!", "superman1234!", "starwars123!",
    "medicare2026", "medicare1234", "ghw2026!aaaaa", "agentlogin1!",
}


def validate_password_strength(
    password: str,
    email: Optional[str] = None,
    full_name: Optional[str] = None,
) -> List[str]:
    """
    Returns a list of unmet requirements.
    Empty list = password is strong enough.

    HIPAA NOTE: Strong passwords are a technical safeguard requirement
    under the HIPAA Security Rule (§164.312(d)).

    Beyond character-class rules we also refuse passwords that match
    the user's own email or full name (case-insensitive) — pen-test
    finding: agents were setting "first.last" as their password.
    """
    errors: List[str] = []

    if len(password) < 12:
        errors.append("Password must be at least 12 characters long.")
    if not re.search(r"[A-Z]", password):
        errors.append("Password must contain at least one uppercase letter.")
    if not re.search(r"[a-z]", password):
        errors.append("Password must contain at least one lowercase letter.")
    if not re.search(r"\d", password):
        errors.append("Password must contain at least one number.")
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>_\-+=\[\]\\;'/`~]", password):
        errors.append("Password must contain at least one special character (!@#$%^&* etc.).")

    lowered = (password or "").strip().lower()
    if email and lowered and lowered == (email or "").strip().lower():
        errors.append("Password cannot be the same as your email.")
    if full_name and lowered and lowered == (full_name or "").strip().lower():
        errors.append("Password cannot be the same as your full name.")
    if lowered in _COMMON_PASSWORDS:
        errors.append("This password is too common — please choose a different one.")

    return errors


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(claims: Dict[str, Any], expires_minutes: Optional[int] = None) -> str:
    to_encode = claims.copy()
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=expires_minutes or JWT_EXPIRES_MINUTES)
    # Hardening 2: stamp `idle_exp` (epoch seconds) + `jti` (session id
    # for audit log correlation). Refresh endpoint reissues with a
    # fresh idle_exp; absolute `exp` is never extended past the original
    # JWT_EXPIRES_MINUTES window.
    import uuid as _uuid_jti
    idle_exp = now + timedelta(minutes=JWT_IDLE_TIMEOUT_MINUTES)
    to_encode.update({
        "exp": expire,
        "iat": now,
        "idle_exp": int(idle_exp.timestamp()),
        "jti": _uuid_jti.uuid4().hex,
    })
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Dict[str, Any]:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


# ----- Document encryption (Fernet AES-128-CBC + HMAC) -----
def _get_doc_key() -> bytes:
    key = os.environ.get("DOC_ENCRYPTION_KEY", "").strip()
    if not key:
        # Derive from JWT_SECRET for MVP — in production use AWS KMS / dedicated key
        derived = base64.urlsafe_b64encode(JWT_SECRET.encode("utf-8").ljust(32, b"0")[:32])
        return derived
    return key.encode("utf-8")


_fernet = Fernet(_get_doc_key())


def encrypt_bytes(data: bytes) -> bytes:
    return _fernet.encrypt(data)


def decrypt_bytes(token: bytes) -> bytes:
    return _fernet.decrypt(token)
