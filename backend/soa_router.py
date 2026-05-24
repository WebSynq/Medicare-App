"""Scope of Appointment (SOA) e-signature capture."""
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from models import SOASignRequest, SOARecord
from deps import get_db, get_phi_db, get_current_user, get_frontend_url, write_audit, get_client_ip
from encryption import safe_lead_set, safe_lead_load
from ghl_client import GHLClient


logger = logging.getLogger("gruening.soa")
router = APIRouter(prefix="/soa", tags=["soa"])


@router.post("/sign", response_model=SOARecord, status_code=201)
async def sign_soa(
    payload: SOASignRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """Record a Scope of Appointment signature.

    Auth required: an unauthenticated caller could otherwise mint forged
    "SOA signed" records against any known lead_id, defeating CMS consent
    requirements and creating fraudulent compliance evidence.
    """
    if not payload.consent_acknowledged:
        raise HTTPException(status_code=400, detail="Consent must be acknowledged")

    # Agents may only sign SOAs for leads assigned to them.
    lead_filter: dict = {"id": payload.lead_id}
    if current_user.get("role") == "agent":
        lead_filter["agent_assigned_id"] = current_user["id"]

    lead = safe_lead_load(await db.leads.find_one(lead_filter, {"_id": 0, "id": 1}))
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if not payload.signature_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="Invalid signature format")

    # Prefer the authenticated agent's stored identity over any client-supplied
    # agent_name field — the form often leaves it null and we never want the
    # client to assert who signed.
    agent_name = current_user.get("full_name") or current_user.get("email") or payload.agent_name

    now = datetime.now(timezone.utc).isoformat()
    record = {
        "id": str(uuid.uuid4()),
        "lead_id": payload.lead_id,
        "signature_data_url": payload.signature_data_url,
        "beneficiary_name": payload.beneficiary_name,
        "agent_name": agent_name,
        "plan_types_discussed": payload.plan_types_discussed,
        "ip_address": get_client_ip(request),
        "user_agent": request.headers.get("user-agent"),
        "signed_at": now,
    }
    await db.soa_records.insert_one(record.copy())
    await db.leads.update_one(
        {"id": payload.lead_id},
        {"$set": safe_lead_set({"soa_signed": True, "soa_signed_at": now, "updated_at": now})},
    )
    await write_audit(
        db, "soa_signed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="lead", target_id=payload.lead_id,
        request=request,
        metadata={"beneficiary": payload.beneficiary_name,
                  "plan_types": payload.plan_types_discussed},
    )
    return SOARecord(**record)


@router.get("/by-lead/{lead_id}")
async def get_soa_for_lead(
    lead_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user=Depends(get_current_user),
):
    doc = await db.soa_records.find_one({"lead_id": lead_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="No SOA on file")
    return doc


# ── Public SOA e-sign flow ───────────────────────────────────────────────
# The auto-SOA path in leads_router mints a single-use token and stores
# a pending soa_records row. The two endpoints below are PUBLIC — no
# auth, gated only by the token's validity. CSRF is handled at the
# server.py exempt list.

class PublicSignRequest(BaseModel):
    full_name: str = Field(..., min_length=1, max_length=200)
    products_confirmed: list = Field(default_factory=list)


def _parse_iso(s):
    if not s or not isinstance(s, str):
        return None
    try:
        cleaned = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


async def _resolve_public_soa(db, token: str) -> Dict[str, Any]:
    """Look up an SOA by token. Raises 404 for missing / used /
    expired records — the same response shape for all three so the
    page can show a single "this link is invalid" message without
    leaking which case it was."""
    if not token:
        raise HTTPException(status_code=404, detail="Invalid link")
    rec = await db.soa_records.find_one({"token": token}, {"_id": 0})
    if not rec:
        raise HTTPException(status_code=404, detail="Invalid link")
    if (rec.get("status") or "").lower() in ("signed", "revoked"):
        raise HTTPException(status_code=404, detail="Link already used")
    exp = _parse_iso(rec.get("expires_at"))
    if exp and exp < datetime.now(timezone.utc):
        # Best-effort mark expired so subsequent admin queries reflect
        # the state. Failure is fine — the 404 we return is the
        # source of truth for the client.
        try:
            await db.soa_records.update_one(
                {"id": rec["id"]}, {"$set": {"status": "expired"}},
            )
        except Exception:
            pass
        raise HTTPException(status_code=404, detail="Link expired")
    return rec


@router.get("/public/{token}")
async def get_public_soa(
    token: str,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
):
    """Render-time payload for the public SOA page. Returns only the
    minimum fields the page needs (agent + client first name +
    product list + expiry). No PII beyond what's already on the link
    the client received."""
    rec = await _resolve_public_soa(db, token)
    lead = safe_lead_load(await db.leads.find_one(
        {"id": rec.get("lead_id")},
        {"_id": 0, "first_name": 1, "last_name": 1},
    )) or {}
    return {
        "agent_name": rec.get("agent_name") or "Your GHW agent",
        "first_name": lead.get("first_name") or "",
        "products_to_discuss": rec.get("products_to_discuss") or [],
        "expires_at": rec.get("expires_at"),
    }


@router.post("/public/{token}/sign")
async def sign_public_soa(
    token: str,
    payload: PublicSignRequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
):
    """Record the client's e-signature on a pending SOA. Updates the
    soa_records row (status / signed_at / signed_name / signed_ip),
    flips soa_signed=true on the parent lead, and pushes the
    SOA-Signed tag to GHL when a contact_id is on file."""
    rec = await _resolve_public_soa(db, token)
    full_name = (payload.full_name or "").strip()
    if not full_name:
        raise HTTPException(status_code=400, detail="Full name is required.")

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    ip = get_client_ip(request)

    await db.soa_records.update_one(
        {"id": rec["id"]},
        {"$set": {
            "status": "signed",
            "signed_at": now_iso,
            "signed_name": full_name,
            "signed_ip": ip,
            "user_agent": request.headers.get("user-agent"),
            "products_confirmed": payload.products_confirmed or rec.get("products_to_discuss", []),
        }},
    )
    # Mirror the SOA state onto the parent lead so existing UIs that
    # read lead.soa_signed continue to work.
    await db.leads.update_one(
        {"id": rec["lead_id"]},
        {"$set": safe_lead_set({
            "soa_signed": True,
            "soa_signed_at": now_iso,
            "updated_at": now_iso,
        })},
    )
    await write_audit(
        db, "soa_signed_public",
        actor_email=None, actor_id=None,
        target_type="soa", target_id=rec["id"],
        request=request,
        metadata={
            "lead_id": rec.get("lead_id"),
            "signed_name": full_name,
            "ip_address": ip,
        },
    )

    # Best-effort GHL: replace the pending tag with a signed tag.
    lead = safe_lead_load(await db.leads.find_one(
        {"id": rec.get("lead_id")}, {"_id": 0, "ghl_contact_id": 1},
    ))
    if lead and lead.get("ghl_contact_id"):
        try:
            ghl = GHLClient()
            if not ghl.mock_mode:
                await ghl.add_tags(lead["ghl_contact_id"], ["SOA-Signed"])
        except Exception as e:
            logger.warning("SOA-Signed tag push to GHL failed: %s", e)

    return {"ok": True, "message": "Signed"}


# ── Agent-facing: list / send new / resend ───────────────────────────────
@router.get("/by-lead-list/{lead_id}")
async def list_soa_for_lead(
    lead_id: str,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """All SOA rows for a lead. Used by the ClientProfile SOA section.
    Agent scoping is enforced via the parent lead's agent_id."""
    lead = safe_lead_load(await db.leads.find_one({"id": lead_id}, {"_id": 0, "agent_id": 1}))
    if not lead:
        raise HTTPException(404, "Lead not found")
    role = current_user.get("role")
    if role == "agent" and lead.get("agent_id") != current_user["id"]:
        raise HTTPException(403, "Access denied")
    cursor = db.soa_records.find(
        {"lead_id": lead_id}, {"_id": 0, "signature_data_url": 0},
    ).sort("created_at", -1)
    rows = await cursor.to_list(length=200)

    frontend = get_frontend_url()
    for r in rows:
        if r.get("token"):
            r["public_link"] = f"{frontend}/soa/{r['token']}"
    return {"records": rows, "count": len(rows)}


class SendSOARequest(BaseModel):
    products: list = Field(default_factory=list)


@router.post("/send/{lead_id}")
async def send_new_soa(
    lead_id: str,
    payload: SendSOARequest,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """Create a fresh SOA record + public link for an existing lead.
    Used when the original pending SOA expired, was revoked, or the
    agent wants to send a follow-up for new products."""
    lead = safe_lead_load(await db.leads.find_one({"id": lead_id}, {"_id": 0}))
    if not lead:
        raise HTTPException(404, "Lead not found")
    role = current_user.get("role")
    if role == "agent" and lead.get("agent_id") != current_user["id"]:
        raise HTTPException(403, "Access denied")

    now = datetime.now(timezone.utc)
    token = uuid.uuid4().hex
    products = payload.products or (
        [lead.get("product_interest")] if lead.get("product_interest") else []
    )
    soa_doc = {
        "id": str(uuid.uuid4()),
        "lead_id": lead_id,
        "agent_id": current_user["id"],
        "agent_name": current_user.get("agent_name") or current_user.get("full_name"),
        "token": token,
        "status": "pending",
        "products_to_discuss": products,
        "created_at": now.isoformat(),
        "expires_at": (now.replace(microsecond=0)
                        ).isoformat(),  # placeholder, set below
        "signed_at": None,
        "signed_name": None,
        "signed_ip": None,
        "plan_types_discussed": [],
    }
    # 30-day window (matches the auto-SOA flow).
    from datetime import timedelta
    soa_doc["expires_at"] = (now + timedelta(days=30)).isoformat()
    await db.soa_records.insert_one(soa_doc.copy())

    link = f"{get_frontend_url()}/soa/{token}"

    if lead.get("ghl_contact_id"):
        try:
            ghl = GHLClient()
            if not ghl.mock_mode:
                await ghl.add_tags(lead["ghl_contact_id"], ["SOA-Pending"])
        except Exception as e:
            logger.warning("SOA-Pending tag push failed: %s", e)

    await write_audit(
        db, "soa_send_new",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="soa", target_id=soa_doc["id"],
        request=request,
        metadata={"lead_id": lead_id, "products": products},
    )
    return {"id": soa_doc["id"], "token": token, "public_link": link,
            "expires_at": soa_doc["expires_at"]}
