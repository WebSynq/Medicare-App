"""Per-agency email domain management.

Endpoint surface (all owner-only on the caller's own agency):
  POST   /api/email-domain/setup    — register domain, get DNS records
  POST   /api/email-domain/verify   — re-check DNS via Resend
  GET    /api/email-domain/status   — current domain + verification state
  DELETE /api/email-domain          — revert to GHW fallback

Flow
====
1. Owner enters their domain (e.g. ``mail.smithinsurance.com``) in
   Settings → Email Domain.
2. POST /setup calls Resend, stashes the returned domain_id on the
   agency row, and ships the DNS records back to the SPA.
3. Owner adds the DKIM/SPF/DMARC records at their registrar.
4. SPA polls POST /verify until ``status="verified"`` — at that point
   we flip ``email_domain_verified=True`` on the agency record.
5. From then on, ``resend_client.send_email`` resolves the agency's
   ``from_email`` instead of the platform default.

Domain validation
=================
We reject obviously-broken inputs (localhost, IP addresses, missing
TLD, common private ranges) at the router boundary — Resend would
reject them too, but a fast local 400 saves a network round-trip and
keeps the audit log clean.
"""
import logging
import re
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    get_agency,
    get_current_user,
    get_db,
    write_audit,
)
from resend_domains import (
    add_domain,
    delete_domain,
    get_domain,
    verify_domain,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/email-domain", tags=["email-domain"])
limiter = Limiter(key_func=get_remote_address)


# ── Domain validation ─────────────────────────────────────────────────
# Anchored on the IANA hostname grammar — label-level dots, no leading/
# trailing hyphens, TLD at least 2 chars. Intentionally permissive
# enough for ``mail.ghw.co.uk`` and ``send.example.app`` but strict
# enough to reject ``localhost``, ``example``, and IP literals.
_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)"
    r"(?!-)"
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z]{2,63}$"
)

# Reserved / private TLDs and labels that we never want to register as
# sender domains. .test/.example/.invalid/.localhost are RFC 2606
# reserved; .local is multicast DNS; .internal is widely used as a
# private TLD; "onion" / "i2p" are darknet protocols.
_BLOCKED_LABELS = {"localhost", "local", "internal", "test", "example",
                    "invalid", "onion", "i2p"}


def _validate_domain(domain: str) -> str:
    d = (domain or "").strip().lower()
    if not d:
        raise HTTPException(400, "Domain is required.")
    if d.startswith(".") or d.endswith("."):
        raise HTTPException(400, "Domain must not start or end with a dot.")
    # IP literal check — Resend rejects, but rejecting here is faster
    # AND gives a clearer error message.
    if all(part.isdigit() for part in d.split(".") if part):
        raise HTTPException(400, "IP addresses are not valid sender domains.")
    if not _DOMAIN_RE.match(d):
        raise HTTPException(
            400, "Domain must be a valid hostname (e.g. mail.example.com).",
        )
    labels = d.split(".")
    if labels[-1] in _BLOCKED_LABELS:
        raise HTTPException(
            400,
            f"'{labels[-1]}' is a reserved TLD — use a domain you own.",
        )
    return d


# ── Pydantic bodies ───────────────────────────────────────────────────
class SetupRequest(BaseModel):
    domain: str = Field(..., min_length=3, max_length=253)
    from_name: Optional[str] = Field(None, max_length=120)
    from_local_part: Optional[str] = Field(
        None, max_length=64,
        description="The part before the @, e.g. 'noreply'",
    )

    @field_validator("from_local_part")
    @classmethod
    def _v_lp(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = v.strip().lower()
        if not s:
            return None
        if not re.match(r"^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$", s):
            raise ValueError(
                "from_local_part may only contain a-z, 0-9, '.', '_', '-'",
            )
        return s


# ── Helpers ───────────────────────────────────────────────────────────
def _require_owner(user: dict, agency: dict) -> None:
    role = (user.get("role") or "").strip().lower()
    if role in {"owner", "admin"}:
        return
    if agency.get("super_admin"):
        return
    raise HTTPException(
        403, "Only agency owners can manage the email domain.",
    )


def _public_status(agency: dict) -> Dict[str, Any]:
    """Shape the SPA expects when reading the current status. Always
    returns the full payload — fields are null when nothing's been
    set up yet, so the SPA can drive its empty state."""
    return {
        "domain": agency.get("email_domain"),
        "verified": bool(agency.get("email_domain_verified")),
        "resend_domain_id": agency.get("resend_domain_id"),
        "from_name": agency.get("from_name"),
        "from_email": agency.get("from_email"),
    }


# ── Endpoints ─────────────────────────────────────────────────────────
@router.post("/setup")
@limiter.limit("10/hour")
async def setup_domain(
    request: Request,
    body: SetupRequest = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Register the supplied domain with Resend and stash the returned
    DNS records on the agency row. Idempotent on the agency side —
    re-running for the same domain just refreshes the DNS records.

    Returns ``{domain, status, records: [...], from_email}``. The SPA
    renders the records table and points the owner at their DNS host.
    """
    _require_owner(current_user, agency)
    domain = _validate_domain(body.domain)

    # If the agency already has a domain registered AND it's the same
    # one, refresh from Resend rather than registering again — Resend
    # otherwise 409s on duplicate domain names.
    existing_id = agency.get("resend_domain_id")
    existing_name = (agency.get("email_domain") or "").lower()
    same_domain = existing_id and existing_name == domain

    if same_domain:
        resend_result = await get_domain(existing_id)
    else:
        resend_result = await add_domain(domain)

    if not resend_result.get("ok"):
        err = resend_result.get("error")
        if err == "not_configured":
            raise HTTPException(
                503,
                "Resend is not configured on this environment. "
                "Set RESEND_API_KEY and redeploy.",
            )
        if err == "invalid_domain":
            raise HTTPException(400, "Domain is invalid.")
        logger.warning(
            "resend setup failed agency=%s domain=%s err=%s",
            agency.get("agency_id"), domain, err,
        )
        raise HTTPException(
            502, f"Could not register domain with Resend ({err}).",
        )

    local_part = body.from_local_part or "noreply"
    from_email = f"{local_part}@{domain}"
    from_name = body.from_name or agency.get("name") or "Agent Portal"

    updates: Dict[str, Any] = {
        "email_domain": domain,
        "email_domain_verified": (
            (resend_result.get("status") or "").lower() == "verified"
        ),
        "resend_domain_id": resend_result.get("domain_id"),
        "from_email": from_email,
        "from_name": from_name,
    }
    await db.agencies.update_one(
        {"agency_id": agency["agency_id"]},
        {"$set": updates},
    )

    await write_audit(
        db, "email_domain_setup",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="agency", target_id=agency["agency_id"],
        request=request,
        metadata={"domain": domain},
    )

    return {
        **_public_status({**agency, **updates}),
        "status": resend_result.get("status"),
        "records": resend_result.get("records") or [],
        "instructions": (
            "Add the records above at your DNS host. Verification "
            "usually takes 5-30 minutes. Hit Verify when DNS has "
            "propagated."
        ),
    }


@router.post("/verify")
@limiter.limit("20/hour")
async def verify_setup(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Ask Resend to re-check DNS for the agency's domain. When the
    response carries ``status="verified"`` we flip the agency row.
    Otherwise we return the current Resend status so the SPA can
    show progress."""
    _require_owner(current_user, agency)
    domain_id = agency.get("resend_domain_id")
    if not domain_id:
        raise HTTPException(400, "No email domain registered yet.")
    result = await verify_domain(domain_id)
    if not result.get("ok"):
        err = result.get("error")
        if err == "not_configured":
            raise HTTPException(503, "Resend is not configured.")
        if err == "not_found":
            # Resend forgot the domain (shouldn't happen). Clean up.
            await db.agencies.update_one(
                {"agency_id": agency["agency_id"]},
                {"$set": {
                    "email_domain": None,
                    "email_domain_verified": False,
                    "resend_domain_id": None,
                    "from_email": None,
                }},
            )
            raise HTTPException(404, "Domain no longer registered with Resend.")
        raise HTTPException(502, f"Resend verify failed ({err}).")

    status = (result.get("status") or "").lower()
    is_verified = status == "verified"
    await db.agencies.update_one(
        {"agency_id": agency["agency_id"]},
        {"$set": {"email_domain_verified": is_verified}},
    )
    if is_verified:
        await write_audit(
            db, "email_domain_verified",
            actor_email=current_user.get("email"),
            actor_id=current_user.get("id"),
            target_type="agency", target_id=agency["agency_id"],
            request=request,
            metadata={"domain": agency.get("email_domain")},
        )
    fresh = await db.agencies.find_one(
        {"agency_id": agency["agency_id"]}, {"_id": 0},
    ) or agency
    return {
        **_public_status(fresh),
        "status": status,
        "records": result.get("records") or [],
    }


@router.get("/status")
async def status(
    request: Request,
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Current per-agency domain state. Never hits Resend — reads
    the cached agency row. Safe to call from the Settings page on
    every render."""
    return _public_status(agency)


@router.delete("")
@limiter.limit("10/hour")
async def remove_domain(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(get_current_user),
    agency: dict = Depends(get_agency),
):
    """Remove the agency's domain. Reverts to the GHW fallback sender
    for all future emails. Resend-side delete is best-effort: even if
    Resend errors, we clear the local fields so the agency isn't
    stuck with a half-registered domain."""
    _require_owner(current_user, agency)
    domain_id = agency.get("resend_domain_id")
    if domain_id:
        result = await delete_domain(domain_id)
        if not result.get("ok") and result.get("error") != "not_configured":
            logger.warning(
                "resend delete failed agency=%s domain_id=%s err=%s",
                agency.get("agency_id"), domain_id, result.get("error"),
            )

    await db.agencies.update_one(
        {"agency_id": agency["agency_id"]},
        {"$set": {
            "email_domain": None,
            "email_domain_verified": False,
            "resend_domain_id": None,
            "from_email": None,
        }},
    )
    await write_audit(
        db, "email_domain_removed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="agency", target_id=agency["agency_id"],
        request=request,
        metadata={"domain": agency.get("email_domain")},
    )
    return {"ok": True, **_public_status({**agency,
                                            "email_domain": None,
                                            "email_domain_verified": False,
                                            "resend_domain_id": None,
                                            "from_email": None})}
