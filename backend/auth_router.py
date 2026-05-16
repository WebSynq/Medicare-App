"""Authentication routes: register, login, MFA enroll/verify, me."""
import io
import base64
import uuid
from datetime import datetime, timezone

import pyotp
import qrcode
from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from models import (
    UserCreate, UserPublic, LoginRequest, LoginResponse,
    MfaEnrollResponse, MfaVerifyRequest,
)
from security import hash_password, verify_password, create_access_token
from deps import get_db, get_current_user, require_roles, write_audit


router = APIRouter(prefix="/auth", tags=["auth"])


def _user_public(user: dict) -> UserPublic:
    return UserPublic(
        id=user["id"],
        email=user["email"],
        full_name=user.get("full_name"),
        role=user.get("role", "agent"),
        is_active=user.get("is_active", True),
        mfa_enabled=user.get("mfa_enabled", False),
        created_at=user.get("created_at", datetime.now(timezone.utc).isoformat()),
    )


@router.post("/register", response_model=UserPublic)
async def register(
    payload: UserCreate,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    _admin=Depends(require_roles("admin")),
):
    existing = await db.users.find_one({"email": payload.email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_doc = {
        "id": str(uuid.uuid4()),
        "email": payload.email,
        "full_name": payload.full_name,
        "role": payload.role,
        "is_active": True,
        "hashed_password": hash_password(payload.password),
        "mfa_secret": None,
        "mfa_enabled": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(user_doc)
    await write_audit(db, "user_created", actor_email=_admin["email"], actor_id=_admin["id"],
                      target_type="user", target_id=user_doc["id"], request=request,
                      metadata={"email": payload.email, "role": payload.role})
    return _user_public(user_doc)


@router.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest, request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    user = await db.users.find_one({"email": payload.email}, {"_id": 0})
    if not user or not verify_password(payload.password, user["hashed_password"]):
        await write_audit(db, "login_failed", actor_email=payload.email, request=request,
                          metadata={"reason": "invalid_credentials"})
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not user.get("is_active", True):
        await write_audit(db, "login_failed", actor_email=payload.email, request=request,
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
