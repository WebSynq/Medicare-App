"""
backend/encryption.py — application-level PHI encryption.

Single enforcement point for `leads` PHI. Use `safe_lead_set` on every
write (insert doc and update $set dict) and `safe_lead_load` on every
read result. Pydantic validators are NOT used because `update_one`
with a raw `$set` dict bypasses them.

Fields encrypted on `leads`:
  - mbi_number                       (Phase 1)
  - medicare_part_a_effective        (Phase 1)
  - medicare_part_b_effective        (Phase 1)
  - date_of_birth                    (Phase 2)

Phase 2 added DOB encryption after a discovery pass confirmed every
filter on date_of_birth is `{"$ne": None}` (an exists check that
works identically on plaintext and ciphertext). All age / birthday
math runs in Python AFTER `safe_lead_load` decrypts. `safe_lead_set`
additionally stamps `dob_year` and `dob_month` as plaintext integers
(derived BEFORE encryption) so future range-query work has a queryable
surface without breaking the encryption invariant.

Env vars:
  PHI_FIELD_KEY — URL-safe base64 Fernet key. Generate with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""
import logging
import os
from datetime import date
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


logger = logging.getLogger("gruening.encryption")


# Fields on the `leads` collection that hold PHI and must be encrypted
# at rest. Order is stable; do not depend on it elsewhere.
#
# Phase 2 added `date_of_birth`. Two facts that made this safe:
#   1. Every filter on date_of_birth in the codebase is `{"$ne": None}`
#      (exists check) — works identically on plaintext and ciphertext.
#   2. All age/birthday math runs in Python AFTER safe_lead_load
#      decrypts. dob_year / dob_month plaintext integers are also
#      stamped by safe_lead_set for future range-query use.
LEAD_PHI_FIELDS = [
    "mbi_number",
    "medicare_part_a_effective",
    "medicare_part_b_effective",
    "date_of_birth",
]

# Live PHI discovery (2026-05) found no banking fields in `policies` or
# `application_extracted_data` yet. Populate when extracted EFT data
# starts landing — paths will be nested (e.g. "all_fields.routing_number",
# "by_doc.eft_form.account_number") and need a different helper than the
# flat lead helpers below.
POLICY_PHI_FIELDS: list[str] = []
EXTRACTED_DATA_PHI_PATHS: list[str] = []


# Fernet v1 tokens always begin with 'gAAAA' — that's the base64url
# encoding of version byte 0x80 plus payload padding. Used both as an
# idempotency guard (don't double-encrypt) and as a read-side
# detection heuristic (don't try to decrypt a legacy plaintext row).
_FERNET_PREFIX = "gAAAA"


class PHIEncryption:
    """Fernet-backed encryptor.

    The key is loaded lazily on first encrypt/decrypt so that:
      - importing this module never crashes (tests that don't touch
        PHI don't need PHI_FIELD_KEY configured),
      - a misconfigured production deployment fails loudly on the
        first PHI write/read rather than masking the error.
    """

    def __init__(self) -> None:
        self._fernet: Optional[Fernet] = None

    def _get_fernet(self) -> Fernet:
        if self._fernet is None:
            key = os.environ.get("PHI_FIELD_KEY")
            if not key:
                raise ValueError(
                    "PHI_FIELD_KEY environment variable is not set. "
                    "Generate with: python -c \"from cryptography.fernet "
                    "import Fernet; print(Fernet.generate_key().decode())\""
                )
            self._fernet = Fernet(key.encode())
        return self._fernet

    def encrypt(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return self._get_fernet().encrypt(value.encode()).decode()

    def decrypt(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return self._get_fernet().decrypt(value.encode()).decode()


# Module-level singleton — import this, don't instantiate elsewhere.
phi_encryption = PHIEncryption()


def _looks_encrypted(v) -> bool:
    """True iff v is a string shaped like a Fernet token."""
    return isinstance(v, str) and v.startswith(_FERNET_PREFIX)


def _derive_dob_components(dob_value) -> tuple[Optional[int], Optional[int]]:
    """Parse an ISO date string → (year, month).

    Returns (None, None) on any failure. Never raises — a malformed DOB
    must not block a lead write. Accepts the canonical "YYYY-MM-DD"
    form plus longer strings ("YYYY-MM-DDTHH:..." get truncated to 10).
    """
    if dob_value is None or not isinstance(dob_value, str):
        return (None, None)
    try:
        d = date.fromisoformat(dob_value.strip()[:10])
    except ValueError:
        return (None, None)
    return (d.year, d.month)


def safe_lead_set(updates: Optional[dict]) -> Optional[dict]:
    """Return a shallow copy of `updates` with PHI encrypted in place
    and dob_year/dob_month stamped if date_of_birth is being set.

    Use on EVERY db.leads write:
        await db.leads.insert_one(safe_lead_set(doc))
        await db.leads.update_one(filter, {"$set": safe_lead_set(updates)})

    Behavior:
      - PHI keys (LEAD_PHI_FIELDS, including date_of_birth) with
        non-None values are encrypted.
      - Values that already look like Fernet ciphertext are left alone
        (idempotency / defense against double-encryption during
        partial rollouts).
      - When date_of_birth is present in the dict, dob_year and
        dob_month are derived from the PLAINTEXT DOB BEFORE the
        encryption loop runs (or cleared to None on parse failure /
        explicit None). This is the single source of truth for the
        derived components — never derived from ciphertext.
      - Empty / None inputs pass through unchanged.
    """
    if not updates:
        return updates

    out = dict(updates)

    # Derive dob_year / dob_month FIRST — must read the plaintext DOB
    # before the encryption loop below replaces it with ciphertext.
    # When the caller explicitly clears date_of_birth (None), wipe the
    # components too so they don't go stale. When the caller passes
    # already-encrypted ciphertext (defensive — e.g. a re-save path),
    # leave existing components alone — we can't parse ciphertext.
    if "date_of_birth" in out:
        dob_value = out["date_of_birth"]
        if dob_value is None:
            out["dob_year"] = None
            out["dob_month"] = None
        elif not _looks_encrypted(dob_value):
            year, month = _derive_dob_components(dob_value)
            out["dob_year"] = year
            out["dob_month"] = month
        # else: already encrypted — preserve existing components.

    for field in LEAD_PHI_FIELDS:
        if field not in out:
            continue
        v = out[field]
        if v is None or _looks_encrypted(v):
            continue
        out[field] = phi_encryption.encrypt(str(v))

    return out


def safe_lead_load(doc: Optional[dict]) -> Optional[dict]:
    """Return a shallow copy of `doc` with PHI keys decrypted in place.

    Use on EVERY db.leads read:
        lead = safe_lead_load(await db.leads.find_one(...))
        leads = [safe_lead_load(d) for d in await cursor.to_list(None)]

    Behavior:
      - None passes through.
      - PHI keys whose values look like ciphertext are decrypted.
      - PHI keys whose values are None or plaintext are left untouched
        (handles legacy rows mid-rollout — the encrypt_existing_phi.py
        backfill will close this window).
      - If a value looks like ciphertext but decryption fails
        (key mismatch / corruption), the field is set to None and a
        WARNING is logged. Returning ciphertext to the SPA would leak
        a base64 blob into the UI; returning None is recoverable and
        surfaces in monitoring.
    """
    if doc is None:
        return None

    out = dict(doc)

    for field in LEAD_PHI_FIELDS:
        if field not in out:
            continue
        v = out[field]
        if v is None or not _looks_encrypted(v):
            continue
        try:
            out[field] = phi_encryption.decrypt(v)
        except InvalidToken:
            logger.warning(
                "InvalidToken decrypting leads.%s — wrong key or "
                "corrupted ciphertext. Returning None to caller.",
                field,
            )
            out[field] = None

    return out
