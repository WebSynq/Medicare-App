"""Authentication routes: register, login, MFA enroll/verify, me, approval."""
import io
import base64
import logging
import uuid
from datetime import datetime, timezone

import pyotp
import qrcode
from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from models import (
    UserPublic, LoginRequest, LoginResponse,
    MfaEnrollResponse, MfaVerifyRequest,
    AgentRegistrationRequest,
)
from security import hash_password, verify_password, create_access_token
from deps import get_db, get_current_user, require_roles, write_audit


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_public(user: dict) -> UserPublic:
    return UserPublic(
        id=user["id"],
        email=user["email"],
        full_name=user.get("full_name"),
        role=user.get("role", "agent"),
        is_active=user.get("is_active", True),
        status=user.get("status", "active"),
        agency_name=user.get("agency_name"),
        mfa_enabled=user.get("mfa_enabled", False),
        created_at=user.get("created_at", datetime.now(timezone.utc).isoformat()),
    )


@router.post("/register", response_model=UserPublic, status_code=201)
async def register(
    payload: AgentRegistrationRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Public self-service agent registration. Creates a *pending* agent that
    cannot log in until an admin approves the request."""
    email = payload.email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "full_name": payload.full_name.strip(),
        "role": "agent",
        "is_active": False,
        "status": "pending",
        "agency_name": payload.agency_name.strip(),
        "hashed_password": hash_password(payload.password),
        "mfa_secret": None,
        "mfa_enabled": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(user_doc)
    await write_audit(db, "agent_registration_requested", actor_email=email,
                      target_type="user", target_id=user_doc["id"], request=request,
                      metadata={"agency_name": user_doc["agency_name"],
                                "full_name": user_doc["full_name"]})
    # Notification hook — replace with email/Slack later. Logging only for now.
    logger.info(
        "[notification] Agent access requested: %s (%s) — agency=%s. "
        "Approve at /api/auth/users/%s/approve",
        user_doc["full_name"], email, user_doc["agency_name"], user_doc["id"],
    )
    return _user_public(user_doc)


@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest, request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    user = await db.users.find_one({"email": payload.email.lower().strip()}, {"_id": 0})
    if not user or not verify_password(payload.password, user["hashed_password"]):
        await write_audit(db, "login_failed", actor_email=payload.email, request=request,
                          metadata={"reason": "invalid_credentials"})
        raise HTTPException(status_code=401, detail="Invalid credentials")

    status_value = user.get("status", "active")
    if status_value == "pending":
        await write_audit(db, "login_failed", actor_email=payload.email,
                          actor_id=user.get("id"), request=request,
                          metadata={"reason": "pending_approval"})
        raise HTTPException(status_code=403,
                            detail="Account pending admin approval")
    if status_value == "rejected":
        await write_audit(db, "login_failed", actor_email=payload.email,
                          actor_id=user.get("id"), request=request,
                          metadata={"reason": "rejected"})
        raise HTTPException(status_code=403,
                            detail="Account access denied")
    if not user.get("is_active", True):
        await write_audit(db, "login_failed", actor_email=payload.email,
                          actor_id=user.get("id"), request=request,
                          metadata={"reason": "inactive"})
        raise HTTPException(status_code=403, detail="Account disabled")

    mfa_verified = False
    if user.get("mfa_enabled"):
        if not payload.mfa_code:
            # Issue a short pre-auth token allowing MFA submission
            token = create_access_token(
                {"sub": user["id"], "email": user["email"], "role": user["role"],
                 "mfa_verified": False, "pre_auth": True},
                expires_minutes=5,
            )
            await write_audit(db, "login_mfa_required", actor_email=payload.email,
                              actor_id=user["id"], request=request)
            return LoginResponse(access_token=token, mfa_required=True, user=_user_public(user))
        totp = pyotp.TOTP(user["mfa_secret"])
        if not totp.verify(payload.mfa_code, valid_window=1):
            await write_audit(db, "login_failed", actor_email=payload.email,
                              actor_id=user["id"], request=request,
                              metadata={"reason": "invalid_mfa"})
            raise HTTPException(status_code=401, detail="Invalid MFA code")
        mfa_verified = True

    token = create_access_token(
        {"sub": user["id"], "email": user["email"], "role": user["role"],
         "mfa_verified": mfa_verified or not user.get("mfa_enabled", False)}
    )
    await write_audit(db, "login_success", actor_email=user["email"], actor_id=user["id"],
                      request=request, metadata={"mfa": user.get("mfa_enabled", False)})
    return LoginResponse(access_token=token, mfa_required=False, user=_user_public(user))


@router.get("/me", response_model=UserPublic)
async def me(current_user=Depends(get_current_user)):
    return _user_public(current_user)


@router.post("/mfa/enroll", response_model=MfaEnrollResponse)
async def mfa_enroll(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if current_user.get("mfa_enabled"):
        raise HTTPException(status_code=400, detail="MFA already enabled")

    secret = pyotp.random_base32()
    otpauth_uri = pyotp.TOTP(secret).provisioning_uri(
        name=current_user["email"], issuer_name="Gruening Health & Wealth"
    )

    img = qrcode.make(otpauth_uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    await db.users.update_one(
        {"id": current_user["id"]},
        {"$set": {"mfa_secret": secret}},
    )
    await write_audit(db, "mfa_enroll_started", actor_email=current_user["email"],
                      actor_id=current_user["id"], request=request)
    return MfaEnrollResponse(secret=secret, otpauth_uri=otpauth_uri, qr_png_base64=b64)


@router.post("/mfa/verify")
async def mfa_verify(
    payload: MfaVerifyRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    user = await db.users.find_one({"id": current_user["id"]}, {"_id": 0})
    if not user or not user.get("mfa_secret"):
        raise HTTPException(status_code=400, detail="MFA not started")
    if not pyotp.TOTP(user["mfa_secret"]).verify(payload.code, valid_window=1):
        raise HTTPException(status_code=400, detail="Invalid code")
    await db.users.update_one({"id": user["id"]}, {"$set": {"mfa_enabled": True}})
    await write_audit(db, "mfa_enabled", actor_email=user["email"], actor_id=user["id"], request=request)

    # Re-issue token with mfa_verified=true
    token = create_access_token(
        {"sub": user["id"], "email": user["email"], "role": user["role"], "mfa_verified": True}
    )
    return {"message": "MFA enabled", "access_token": token, "token_type": "bearer"}


# ----- Pending agent approval (admin only) -----

@router.get("/pending", response_model=list[UserPublic])
async def list_pending_agents(
    db: AsyncIOMotorDatabase = Depends(get_db),
    _admin=Depends(require_roles("admin")),
):
    cursor = db.users.find({"status": "pending"}, {"_id": 0}).sort("created_at", -1)
    return [_user_public(u) async for u in cursor]


@router.post("/users/{user_id}/approve", response_model=UserPublic)
async def approve_agent(
    user_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    admin=Depends(require_roles("admin")),
):
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.get("status") == "active":
        return _user_public(user)
    if user.get("status") == "rejected":
        raise HTTPException(status_code=400,
                            detail="Cannot approve a rejected account")

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"status": "active", "is_active": True,
                  "approved_at": now_iso, "approved_by": admin["id"]}},
    )
    await write_audit(db, "agent_approved", actor_email=admin["email"],
                      actor_id=admin["id"], target_type="user", target_id=user_id,
                      request=request, metadata={"email": user["email"]})
    fresh = await db.users.find_one({"id": user_id}, {"_id": 0})
    return _user_public(fresh)


@router.post("/users/{user_id}/reject", response_model=UserPublic)
async def reject_agent(
    user_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    admin=Depends(require_roles("admin")),
):
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"status": "rejected", "is_active": False,
                  "rejected_at": now_iso, "rejected_by": admin["id"]}},
    )
    await write_audit(db, "agent_rejected", actor_email=admin["email"],
                      actor_id=admin["id"], target_type="user", target_id=user_id,
                      request=request, metadata={"email": user["email"]})
    fresh = await db.users.find_one({"id": user_id}, {"_id": 0})
    return _user_public(fresh)
