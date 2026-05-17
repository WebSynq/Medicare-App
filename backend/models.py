"""Pydantic models for Gruening Health & Wealth Medicare Intake."""
from pydantic import BaseModel, EmailStr, Field, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime, timezone
import uuid


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----- Users -----
UserStatus = Literal["pending", "active", "rejected"]


class UserBase(BaseModel):
    email: EmailStr
    full_name: Optional[str] = None
    role: Literal["admin", "agent", "compliance"] = "agent"
    is_active: bool = True
    status: UserStatus = "active"
    agency_name: Optional[str] = None


class UserCreate(UserBase):
    password: str


class UserPublic(UserBase):
    id: str
    mfa_enabled: bool = False
    created_at: str


class UserInDB(UserBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    hashed_password: str
    mfa_secret: Optional[str] = None
    mfa_enabled: bool = False
    created_at: str = Field(default_factory=utcnow_iso)


class AgentRegistrationRequest(BaseModel):
    """Public self-service registration. Always creates a pending agent."""
    full_name: str
    email: EmailStr
    password: str
    agency_name: str


# ----- Auth -----
class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    mfa_code: Optional[str] = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    mfa_required: bool = False
    user: UserPublic


class MfaEnrollResponse(BaseModel):
    secret: str
    otpauth_uri: str
    qr_png_base64: str


class MfaVerifyRequest(BaseModel):
    code: str


# ----- Leads -----
class LeadBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    first_name: str
    last_name: str
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    date_of_birth: Optional[str] = None  # ISO date string
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip_code: Optional[str] = None
    mbi_number: Optional[str] = None
    medicare_part_a_effective: Optional[str] = None
    medicare_part_b_effective: Optional[str] = None
    current_carrier: Optional[str] = None
    current_plan: Optional[str] = None
    doctors: List[str] = []
    prescriptions: List[str] = []
    preferred_contact_time: Optional[str] = None
    notes: Optional[str] = None


class LeadCreate(LeadBase):
    pass


class LeadUpdate(BaseModel):
    status: Optional[str] = None
    agent_assigned_id: Optional[str] = None
    notes: Optional[str] = None


class Lead(LeadBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "new"  # new, contacted, qualified, enrolled, lost
    soa_signed: bool = False
    soa_signed_at: Optional[str] = None
    document_ids: List[str] = []
    agent_assigned_id: Optional[str] = None
    ghl_contact_id: Optional[str] = None
    ghl_sync_status: str = "pending"  # pending, synced, error, mock
    ghl_sync_error: Optional[str] = None
    ghl_synced_at: Optional[str] = None
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)


# ----- SOA (Scope of Appointment) -----
class SOASignRequest(BaseModel):
    lead_id: str
    signature_data_url: str  # base64 PNG of drawn signature
    beneficiary_name: str
    agent_name: Optional[str] = None
    plan_types_discussed: List[str] = []  # e.g., ["MA", "MAPD", "PDP", "MedSupp"]
    consent_acknowledged: bool


class SOARecord(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    lead_id: str
    signature_data_url: str
    beneficiary_name: str
    agent_name: Optional[str] = None
    plan_types_discussed: List[str] = []
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    signed_at: str = Field(default_factory=utcnow_iso)


# ----- Documents -----
class DocumentMeta(BaseModel):
    id: str
    lead_id: str
    filename: str
    content_type: str
    size_bytes: int
    doc_type: str  # "medicare_card", "id", "voided_check", "other"
    encrypted: bool = True
    uploaded_by: Optional[str] = None
    uploaded_at: str


# ----- Audit Log -----
class AuditEvent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    event_type: str  # login_success, login_failed, lead_created, doc_uploaded, doc_downloaded, ghl_sync, soa_signed, etc.
    actor_email: Optional[str] = None
    actor_id: Optional[str] = None
    target_type: Optional[str] = None  # lead, document, user
    target_id: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    metadata: dict = {}
    timestamp: str = Field(default_factory=utcnow_iso)
