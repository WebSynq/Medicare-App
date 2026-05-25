"""Pydantic models for Gruening Health & Wealth Medicare Intake."""
import re
from pydantic import BaseModel, EmailStr, Field, ConfigDict, field_validator
from typing import List, Optional, Literal
from datetime import datetime, timezone
import uuid


_NPN_RE = re.compile(r"^\d{5,10}$")


def _normalize_agent_name(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > 100:
        raise ValueError("agent_name must be 100 characters or fewer")
    return v


def _normalize_agent_npn(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if not _NPN_RE.fullmatch(v):
        raise ValueError("agent_npn must be 5-10 digits, numbers only")
    return v


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----- Users -----
UserStatus = Literal["pending", "active", "rejected"]


class UserBase(BaseModel):
    email: EmailStr
    full_name: Optional[str] = None
    # Expanded role set so non-agent team members (back-office, support,
    # security) can each carry an appropriate access profile. Layout.jsx
    # groups them client-side: va/support/crm_specialist/onboarding map
    # to the agent nav profile, cyber_security/sales_manager/compliance
    # map to the compliance nav profile. admin retains full access.
    role: Literal[
        "admin",
        "owner",
        "agent",
        "compliance",
        "va",
        "support",
        "crm_specialist",
        "cyber_security",
        "sales_manager",
        "onboarding",
        "client_success",
        "coach",
        "accounting",
    ] = "agent"
    is_active: bool = True
    status: UserStatus = "active"
    agency_name: Optional[str] = None
    phone: Optional[str] = None
    # IANA timezone string (e.g. "America/Chicago"). Used by the Google
    # Calendar sync to stamp event `timeZone` correctly per agent so a
    # 10:00 AM appointment lands at the agent's local 10:00 AM, not the
    # calendar's primary tz fallback. Defaulted to GHW's HQ tz for
    # legacy rows that never saved one through Settings → Profile.
    timezone: Optional[str] = "America/Chicago"
    # Agent identity for downstream lookups (ComTrack, carrier portals, etc.).
    # We resolve agent identity from these server-side fields only — never from
    # request body or query params — so a JWT cannot impersonate another agent.
    # agent_id is the canonical scoping key (defaults to the user's own id);
    # admins/compliance can override per-request via the X-Agent-ID header.
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    agent_npn: Optional[str] = None
    # GHL sub-account id this user owns leads inside. Inbound webhooks
    # carry locationId, and we look the agent up by this field to scope
    # the new lead correctly. None means "no GHL mapping yet" — webhook
    # leads fall back to the first admin.
    ghl_location_id: Optional[str] = None
    # Multi-user agent accounts. When set, this user works inside the
    # parent agent's scope — all their reads and writes resolve to
    # parent_agent_id (deps.agent_filter + get_effective_agent), and
    # the parent's data is what they see. Audit logs still record the
    # actual actor (their own id), so we never lose attribution of who
    # actually did a thing. Only role=va or role=agent users are
    # eligible — admin/owner/coach/compliance cannot be team members.
    parent_agent_id: Optional[str] = None
    # Brute-force lockout mirror — `db.login_attempts` is the
    # authoritative tracker, but we surface counters on the user record
    # too so admin/compliance can see "X failed attempts in the last
    # window" without joining collections. token_version is bumped on
    # password change to invalidate every JWT issued before the change.
    failed_attempts: int = 0
    last_failed_at: Optional[str] = None
    locked_until: Optional[str] = None
    token_version: int = 0

    @field_validator("agent_name")
    @classmethod
    def _v_agent_name(cls, v):
        return _normalize_agent_name(v)

    @field_validator("agent_npn")
    @classmethod
    def _v_agent_npn(cls, v):
        return _normalize_agent_npn(v)


class UserCreate(UserBase):
    password: str


class UserPublic(UserBase):
    id: str
    created_at: str


class UserInDB(UserBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    hashed_password: str
    created_at: str = Field(default_factory=utcnow_iso)


class AgentRegistrationRequest(BaseModel):
    """Invite-only agent registration. Requires a valid invite_token."""
    full_name: str
    email: EmailStr
    password: str
    agency_name: str
    invite_token: Optional[str] = None
    agent_name: Optional[str] = None
    agent_npn: Optional[str] = None

    @field_validator("agent_name")
    @classmethod
    def _v_agent_name(cls, v):
        return _normalize_agent_name(v)

    @field_validator("agent_npn")
    @classmethod
    def _v_agent_npn(cls, v):
        return _normalize_agent_npn(v)


class UserProfileUpdate(BaseModel):
    """Admin-only patch payload for an agent's identity fields."""
    agent_name: Optional[str] = None
    agent_npn: Optional[str] = None

    @field_validator("agent_name")
    @classmethod
    def _v_agent_name(cls, v):
        return _normalize_agent_name(v)

    @field_validator("agent_npn")
    @classmethod
    def _v_agent_npn(cls, v):
        return _normalize_agent_npn(v)


class InviteToken(BaseModel):
    id: str
    token: str  # UUID4 — stored hashed in DB
    email: str  # Pre-assigned email (agent must register with this email)
    created_by: str  # admin user id
    created_at: str
    expires_at: str
    used: bool = False
    used_at: Optional[str] = None


class InviteRequest(BaseModel):
    email: EmailStr
    full_name: Optional[str] = None
    agency_name: Optional[str] = None
    agent_name: Optional[str] = None
    agent_npn: Optional[str] = None
    # Invite-time role assignment. Admin cannot be granted via invite —
    # that has to be done manually in the DB / via the admin tools.
    role: Optional[Literal[
        "agent",
        "owner",
        "compliance",
        "va",
        "support",
        "crm_specialist",
        "cyber_security",
        "sales_manager",
        "onboarding",
        "client_success",
        "coach",
        "accounting",
    ]] = "agent"
    # Optional parent agent — when set, the invite stamps the new user
    # with parent_agent_id on register so they immediately operate
    # inside that agent's scope. Only meaningful when role is "va" or
    # "agent"; the agent_management_router endpoint validates role
    # eligibility (the invite step doesn't, so legacy invites that
    # carried this for the wrong role just have it silently ignored).
    parent_agent_id: Optional[str] = None

    @field_validator("agent_name")
    @classmethod
    def _v_agent_name(cls, v):
        return _normalize_agent_name(v)

    @field_validator("agent_npn")
    @classmethod
    def _v_agent_npn(cls, v):
        return _normalize_agent_npn(v)


# ----- Auth -----
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


# ----- Leads -----
# Full-name → 2-letter code map for state normalization. Used by
# `normalize_state_field` so "Illinois", "illinois", "IL", "il", "Il" all
# land on "IL" at the model boundary. Pre-Pydantic-validator writes
# (API + GHL webhook + CSV) all flow through LeadBase, so this is the
# single enforcement point. Backfill script applies the same logic to
# any pre-existing dirty rows.
_STATE_ABBR_MAP = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT",
    "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME",
    "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
    "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
    "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND",
    "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY",
}


def normalize_state_field(v):
    """Best-effort state normalizer.

    - ``None`` / empty after strip → ``None``
    - 2-character input → uppercase passthrough (e.g. "il" → "IL")
    - Recognised full state name (case-insensitive) → 2-letter code
    - Anything else → ``value.strip().upper()`` (don't reject — the field
      stays free-text-tolerant so a typo doesn't 422 the whole intake)
    """
    if v is None:
        return None
    if not isinstance(v, str):
        return v
    s = v.strip()
    if not s:
        return None
    if len(s) == 2:
        return s.upper()
    mapped = _STATE_ABBR_MAP.get(s.lower())
    if mapped:
        return mapped
    return s.upper()


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
    # ----- Application details (GHW app sale submission) -----
    sales_submitting_agent: Optional[str] = None
    agency_or_personal: Optional[Literal["Agency", "Personal"]] = None
    new_or_current_client: Optional[Literal["New", "Current"]] = None
    number_of_apps: Optional[int] = None
    replacement_app: Optional[Literal["Yes", "No"]] = None
    lead_source: Optional[str] = None
    plan_type_premium: Optional[str] = None
    underwriting_approved: Optional[Literal["Yes", "No", "Pending"]] = None
    cancel_old_plan: Optional[Literal["Yes", "No", "N/A"]] = None
    admin_requests: Optional[str] = None
    # Internal assignment: which client-success rep owns post-sale support
    # for this lead. Not synced to GHL — this is back-office routing only.
    # "Other" leaves room for future names without a code change.
    client_success_rep: Optional[Literal["Kelsey", "Ashley", "Other"]] = None
    # Free-text product the client is interested in. Drives auto-SOA
    # generation in leads_router for Medicare-flavoured products.
    product_interest: Optional[str] = None
    # TCPA consent — the boolean and the verbatim consent text the user
    # saw at checkbox-click time are accepted from the client. Timestamp
    # and IP are stamped server-side only (see Lead below) so a forged
    # POST body can't backdate or spoof the consent provenance.
    tcpa_consent: bool = False
    tcpa_consent_text: Optional[str] = None
    # Free-form normalized tags drawn from the agency tag library.
    # Stored as lowercase hyphen-cased names ("hot-lead"); the library
    # in db.tags carries the display label + color. Membership is the
    # source of truth — the library entry is just a presentation hint
    # and may be deleted after leads have been tagged without nuking
    # the tags themselves.
    tags: List[str] = []

    @field_validator("state", mode="before")
    @classmethod
    def _normalize_state(cls, v):
        return normalize_state_field(v)


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
    # Server-stamped on the first transition into status="enrolled" — see
    # leads_router.update_lead / update_lead_stage. Write-once: preserved
    # across later edits so the conversion-rate dashboards report the
    # original enrollment moment, not the latest mutation.
    enrolled_at: Optional[str] = None
    document_ids: List[str] = []
    # Workspace-isolation scoping (Phase 2). agent_id is the canonical key
    # used by deps.agent_filter; agent_email/agent_name are denormalized so
    # downstream rollups don't have to join on users for every read.
    agent_id: Optional[str] = None
    agent_email: Optional[str] = None
    agent_name: Optional[str] = None
    # Legacy field — kept while we transition reads off of it. New code
    # should use agent_id instead.
    agent_assigned_id: Optional[str] = None
    ghl_contact_id: Optional[str] = None
    ghl_sync_status: str = "pending"  # pending, synced, error, mock
    ghl_sync_error: Optional[str] = None
    ghl_synced_at: Optional[str] = None
    # Server-stamped TCPA consent provenance — never accepted from the
    # client. Set in leads_router.create_lead when payload.tcpa_consent
    # is True.
    tcpa_consent_timestamp: Optional[str] = None
    tcpa_consent_ip: Optional[str] = None
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
    # Legacy in-app signature flow stamps these. The new auto-SOA
    # workflow leaves them blank — the public e-sign page records
    # signed_name + signed_ip below instead.
    signature_data_url: Optional[str] = None
    beneficiary_name: Optional[str] = None
    agent_name: Optional[str] = None
    plan_types_discussed: List[str] = []
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    signed_at: Optional[str] = None

    # Auto-SOA fields (new workflow). ``token`` is the single-use URL
    # segment, ``status`` is one of pending/signed/expired/revoked,
    # ``products_to_discuss`` is what the client is consenting to, and
    # signed_name/signed_ip carry the public-page signature provenance.
    token: Optional[str] = None
    agent_id: Optional[str] = None
    status: str = "signed"  # back-compat: in-app signed records default to "signed"
    products_to_discuss: List[str] = []
    expires_at: Optional[str] = None
    signed_name: Optional[str] = None
    signed_ip: Optional[str] = None
    created_at: str = Field(default_factory=utcnow_iso)


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
    # Workspace-isolation scoping (Phase 2).
    agent_id: Optional[str] = None
    agent_email: Optional[str] = None


# ----- Tags -----
# Free-form tag library, scoped per agency. The library entry holds the
# display metadata (label, color, category); the actual application is a
# string in Lead.tags. Normalization rule (`normalize_tag_name`) is the
# single source of truth — both the library seed and create-tag route
# pass labels through it so "Hot Lead" and "hot lead" collapse to the
# same `hot-lead` name.
TagCategory = Literal["status", "product", "compliance", "custom", "medicare"]

_TAG_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def normalize_tag_name(label: str) -> str:
    """'Hot Lead' -> 'hot-lead'. Lowercase, strip punctuation, collapse
    whitespace to single hyphens. Trim leading/trailing hyphens so a
    label like '  -hot-' lands on 'hot'."""
    if not label:
        return ""
    s = label.strip().lower()
    # Replace any run of non-alphanumeric characters with a single hyphen.
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


class TagCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=64)
    color: str = Field(..., description="Hex color like #ef4444")
    category: TagCategory = "custom"

    @field_validator("color")
    @classmethod
    def _v_color(cls, v):
        if not isinstance(v, str) or not _TAG_HEX_RE.fullmatch(v.strip()):
            raise ValueError("color must be a hex string like #ef4444")
        return v.strip().lower()


class Tag(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agency_id: str
    name: str        # normalized: "hot-lead"
    label: str       # display: "Hot Lead"
    color: str       # hex color for badge
    category: TagCategory = "custom"
    created_by: Optional[str] = None
    created_at: str = Field(default_factory=utcnow_iso)


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
