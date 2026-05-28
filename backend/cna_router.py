"""Client Needs Assessment (CNA) + AI recommendation.

CRUD on ``db.cna_assessments`` (one row per lead) plus a Claude-backed
analyser that turns the assessment into a structured agent-facing
recommendation (urgency score, plan type, talking points, etc.).

Hard rules
==========
- CNA records contain PHI (medications, chronic conditions, income
  range, current carrier). Reads + writes go through the PHI Mongo
  client (``get_phi_db``).
- The cached AI recommendation itself is non-PHI prose ("supplement
  recommended", "client has chronic conditions") — it lives on the
  CNA row alongside the form fields. We never round-trip raw PHI to
  Claude beyond what the agent already typed; the assessment is sent
  verbatim because the AI needs it to make its recommendation.
- 24-hour cache: a stored ``ai_recommendation`` is returned as-is until
  the CNA is updated or the cache expires (``ai_generated_at``
  timestamp). The "Save & Generate AI" path always forces a fresh
  analysis.
- AI call is best-effort — Anthropic outage / unset key returns a safe
  defaults dict, never raises.
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from deps import (
    FULL_AGENCY_SCOPE_ROLES,
    agent_filter,
    get_agency_id,
    get_current_user,
    get_effective_agent,
    get_phi_db,
    write_audit,
)
from encryption import safe_lead_load


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/cna", tags=["cna"])


# ── Constants ──────────────────────────────────────────────────────────────
_AI_MODEL = "claude-sonnet-4-6"
_AI_MAX_TOKENS = 2500
_AI_CACHE_HOURS = 24


# ── Pydantic models ────────────────────────────────────────────────────────
class CNAPrescription(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    condition: Optional[str] = Field(None, max_length=120)


class CNADoctor(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    specialty: Optional[str] = Field(None, max_length=120)


class CNAPayload(BaseModel):
    """Full Client Needs Assessment.

    Every field is optional so the form can autosave on blur — the
    agent shouldn't get a 422 because they haven't filled in box #7
    yet. Validation happens at the AI / display layers, not here.
    """

    # Basic Info (pre-filled from lead record on first load)
    zip_code: Optional[str] = Field(None, max_length=10)
    date_of_birth: Optional[str] = Field(None, max_length=32)

    # Employment & Income
    employment_status: Optional[Literal["working", "retired", "other"]] = None
    drawing_social_security: Optional[bool] = None
    household_income_range: Optional[Literal[
        "under_85k", "85k_107k", "107k_133k", "133k_160k", "over_160k",
    ]] = None
    has_qualified_assets_200k: Optional[bool] = None
    needs_retirement_specialist: Optional[bool] = None

    # Current Coverage
    current_coverage_type: Optional[Literal[
        "employer", "marketplace", "medicaid", "tricare", "none", "other",
    ]] = None
    current_carrier: Optional[str] = Field(None, max_length=120)
    is_employer_sponsored: Optional[bool] = None
    current_monthly_premium: Optional[float] = Field(None, ge=0, le=100_000)
    current_deductible: Optional[float] = Field(None, ge=0, le=100_000)
    current_max_oop: Optional[float] = Field(None, ge=0, le=100_000)
    hit_deductible_this_year: Optional[bool] = None

    # Health & Prescriptions
    health_history_notes: Optional[str] = Field(None, max_length=4000)
    prescription_count: Optional[int] = Field(None, ge=0, le=200)
    prescriptions: List[CNAPrescription] = Field(default_factory=list)
    critical_illness_history: Optional[Literal[
        "personal", "family", "both", "none",
    ]] = None
    critical_illness_notes: Optional[str] = Field(None, max_length=2000)
    skilled_nursing_experience: Optional[bool] = None
    skilled_nursing_notes: Optional[str] = Field(None, max_length=2000)
    home_healthcare_experience: Optional[bool] = None

    # Coverage Gaps
    dental_important: Optional[bool] = None
    has_dental_coverage: Optional[bool] = None
    preferred_doctors: List[CNADoctor] = Field(default_factory=list)
    knows_ma_vs_supp_difference: Optional[Literal[
        "yes", "no", "somewhat",
    ]] = None

    # Financial Protection
    has_life_insurance: Optional[bool] = None
    life_insurance_type: Optional[Literal[
        "permanent", "term", "none",
    ]] = None
    life_insurance_important: Optional[bool] = None
    final_expense_covered: Optional[bool] = None
    has_retirement_questions: Optional[bool] = None

    # Medicare Direction
    medicare_direction_preference: Optional[Literal[
        "supplement", "advantage", "undecided",
    ]] = None
    direction_notes: Optional[str] = Field(None, max_length=2000)

    # Appointment Goal
    appointment_goal: Optional[str] = Field(None, max_length=2000)


# ── Helpers ────────────────────────────────────────────────────────────────
def _is_privileged(user: Optional[dict]) -> bool:
    """True when this user can bypass per-lead IDOR scoping.

    Logs the exact role value seen from the DB and the resolved
    decision so prod Render logs surface the case/capitalisation that
    came back from Mongo (most common cause of "I'm admin but I'm
    403'd" reports).
    """
    if not user:
        logger.info("cna._is_privileged: user=None → False")
        return False
    raw_role = user.get("role")
    role = (raw_role or "").strip().lower()
    allowed = {r.lower() for r in FULL_AGENCY_SCOPE_ROLES}
    decision = bool(role) and role in allowed
    logger.info(
        "cna._is_privileged: user_id=%s email=%s raw_role=%r "
        "normalised=%r allowed=%s decision=%s",
        user.get("id"), user.get("email"), raw_role, role,
        sorted(allowed), decision,
    )
    return decision


async def _resolve_lead_or_403(
    db: AsyncIOMotorDatabase,
    lead_id: str,
    effective: dict,
    current_user: Optional[dict] = None,
) -> Dict[str, Any]:
    """404 missing / 403 not in caller's book.

    Bypasses the IDOR check when EITHER the JWT-authenticated user
    (``current_user``) OR the effective agent has a full-agency role.
    The two-input shape matters because, during impersonation,
    ``get_effective_agent`` returns the impersonated agent (role=agent)
    even when the actual caller is an admin — relying on ``effective``
    alone would 403 an admin who never owned the lead.
    """
    raw = await db.leads.find_one({"id": lead_id}, {"_id": 0})
    lead = safe_lead_load(raw)
    if not lead:
        logger.warning(
            "cna._resolve_lead_or_403: lead NOT FOUND lead_id=%s "
            "caller=%s effective=%s",
            lead_id,
            (current_user or {}).get("email"),
            (effective or {}).get("email"),
        )
        raise HTTPException(404, "Lead not found")

    cu_priv = _is_privileged(current_user)
    eff_priv = _is_privileged(effective)
    eff_id = (effective or {}).get("id")
    lead_agent_id = lead.get("agent_id")
    owns_lead = lead_agent_id == eff_id

    if cu_priv or eff_priv:
        logger.info(
            "cna._resolve_lead_or_403: ALLOW (privileged) lead_id=%s "
            "lead_agent_id=%s effective_id=%s current_user_role=%r "
            "effective_role=%r current_user_priv=%s effective_priv=%s",
            lead_id, lead_agent_id, eff_id,
            (current_user or {}).get("role"),
            (effective or {}).get("role"),
            cu_priv, eff_priv,
        )
        return lead

    if owns_lead:
        logger.info(
            "cna._resolve_lead_or_403: ALLOW (owner) lead_id=%s "
            "lead_agent_id=%s effective_id=%s",
            lead_id, lead_agent_id, eff_id,
        )
        return lead

    logger.warning(
        "cna._resolve_lead_or_403: DENY 403 lead_id=%s lead_agent_id=%s "
        "effective_id=%s current_user_id=%s current_user_role=%r "
        "effective_role=%r impersonated_by=%s current_user_priv=%s "
        "effective_priv=%s",
        lead_id, lead_agent_id, eff_id,
        (current_user or {}).get("id"),
        (current_user or {}).get("role"),
        (effective or {}).get("role"),
        (effective or {}).get("_impersonated_by"),
        cu_priv, eff_priv,
    )
    raise HTTPException(403, "Lead is not in your book")


def _public(doc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not doc:
        return None
    return {k: v for k, v in doc.items() if k != "_id"}


def _empty_template(lead: dict) -> Dict[str, Any]:
    """Pre-fill a blank CNA from existing lead data so the form opens
    with the agent's existing context instead of forcing them to retype
    fields the CRM already knows."""
    return {
        "lead_id": lead.get("id"),
        "zip_code": lead.get("zip_code") or None,
        "date_of_birth": lead.get("date_of_birth") or None,
        "current_carrier": lead.get("current_carrier") or None,
        "prescriptions": [
            {"name": m, "condition": None}
            for m in (lead.get("prescriptions") or [])
            if isinstance(m, str) and m.strip()
        ],
        "preferred_doctors": [
            {"name": d, "specialty": None}
            for d in (lead.get("doctors") or [])
            if isinstance(d, str) and d.strip()
        ],
        # Everything else None / [] — the form treats absent as unset.
    }


def _is_cache_fresh(generated_at: Any) -> bool:
    """True if ``generated_at`` is less than _AI_CACHE_HOURS ago."""
    if not generated_at:
        return False
    try:
        if isinstance(generated_at, str):
            ts = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
        elif isinstance(generated_at, datetime):
            ts = generated_at if generated_at.tzinfo else generated_at.replace(
                tzinfo=timezone.utc)
        else:
            return False
    except (TypeError, ValueError):
        return False
    return datetime.now(timezone.utc) - ts < timedelta(hours=_AI_CACHE_HOURS)


# ── AI analyser ───────────────────────────────────────────────────────────
_SYSTEM_PROMPT = """You are an expert Medicare insurance advisor for \
Gruening Health & Wealth. You analyze client needs assessments and \
generate specific, actionable recommendations for Medicare insurance \
agents.

GHW sells three Umbrella packages:
- Umbrella 1: Medicare plan + prescription drug coverage
- Umbrella 2: Medicare plan + prescriptions + dental/vision/hearing
- Umbrella 3 (most comprehensive): Medicare plan + prescriptions +
  dental/vision/hearing + cancer/heart/stroke coverage + skilled
  nursing and assisted living after day 100

Medicare plan types:
- Medicare Supplement (Medigap): Higher premium, no networks,
  predictable costs, works with any Medicare provider
- Medicare Advantage (MA-HMO/PPO): Often $0 premium, network-based,
  dental/vision often included, drug coverage usually included

Key rules:
- If client has chronic conditions (diabetes, heart, cancer history)
  → lean toward Medicare Supplement (predictable costs, no network)
- If client is healthy, price-sensitive, wants $0 premium
  → lean toward Medicare Advantage
- If client has critical illness family history → flag
  cancer/heart/stroke rider
- If client has skilled nursing family experience → flag skilled
  nursing gap
- If client is transitioning from employer coverage → compare costs
  carefully
- Always recommend Umbrella 3 if budget allows

Respond ONLY with valid JSON — no preamble, no markdown fences.

JSON shape:
{
  "recommended_plan_type": "supplement" | "advantage" | "either",
  "recommended_umbrella": "1" | "2" | "3",
  "confidence": "high" | "medium" | "low",
  "primary_reason": "One sentence explaining the main recommendation",
  "estimated_monthly_range": "$X-Y/mo",
  "urgency_score": 1-100,
  "urgency_reason": "Why this client needs to act (or not urgent)",
  "key_exposures": [
    {
      "type": "critical_illness" | "skilled_nursing" | "dental" |
              "drug_coverage" | "network" | "cost" | "final_expense",
      "severity": "high" | "medium" | "low",
      "description": "Plain English description",
      "talking_point": "What the agent should say about this"
    }
  ],
  "talking_points": [
    "Specific thing to say to this client based on their situation"
  ],
  "cross_sell_opportunities": [
    {
      "product": "cancer_heart_stroke" | "final_expense" | "dental" |
                 "life_insurance" | "annuity" | "retirement",
      "reason": "Why this client needs it",
      "priority": "immediate" | "secondary"
    }
  ],
  "objection_handles": [
    {
      "objection": "Likely objection from this client",
      "response": "How to handle it"
    }
  ],
  "formal_recommendation_script":
    "Based on everything we talked about today, my formal recommendation is [plan type] paired with Umbrella [X]. You'd be looking at approximately $[range] per month.",
  "next_best_action": "Specific next step for the agent"
}
"""


_SAFE_AI_DEFAULT: Dict[str, Any] = {
    "recommended_plan_type": "either",
    "recommended_umbrella": "2",
    "confidence": "low",
    "primary_reason": (
        "AI recommendation is temporarily unavailable. "
        "Use the CNA answers above to make a manual recommendation."
    ),
    "estimated_monthly_range": "",
    "urgency_score": 0,
    "urgency_reason": "Not enough data for an automated urgency score.",
    "key_exposures": [],
    "talking_points": [],
    "cross_sell_opportunities": [],
    "objection_handles": [],
    "formal_recommendation_script": "",
    "next_best_action": "",
    "_fallback": True,
}


def _safe_default() -> Dict[str, Any]:
    return dict(_SAFE_AI_DEFAULT)


def _sanitise_recommendation(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise the AI response so the UI can render without optional
    chaining everywhere. Drops unknown top-level keys."""
    out = _safe_default()
    out.pop("_fallback", None)
    if not isinstance(parsed, dict):
        return _safe_default()

    str_keys = (
        "recommended_plan_type", "recommended_umbrella", "confidence",
        "primary_reason", "estimated_monthly_range", "urgency_reason",
        "formal_recommendation_script", "next_best_action",
    )
    for k in str_keys:
        v = parsed.get(k)
        if isinstance(v, (str, int, float)):
            out[k] = str(v).strip()

    score = parsed.get("urgency_score")
    try:
        out["urgency_score"] = max(0, min(100, int(score)))
    except (TypeError, ValueError):
        out["urgency_score"] = 0

    def _list_of_dicts(key: str) -> List[Dict[str, Any]]:
        raw = parsed.get(key)
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict)][:20]

    out["key_exposures"] = _list_of_dicts("key_exposures")
    out["cross_sell_opportunities"] = _list_of_dicts("cross_sell_opportunities")
    out["objection_handles"] = _list_of_dicts("objection_handles")

    raw_tps = parsed.get("talking_points")
    if isinstance(raw_tps, list):
        out["talking_points"] = [
            str(t).strip()
            for t in raw_tps
            if isinstance(t, (str, int, float)) and str(t).strip()
        ][:20]

    return out


async def generate_ai_recommendation(
    lead: dict,
    cna: dict,
    *,
    agency_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Ask Claude to turn the lead + CNA into a structured recommendation.

    Returns the safe default dict on any failure path — never raises.

    ``agency_id`` / ``agent_id`` are optional metering context. When
    provided + the Claude call actually fires, we emit a
    ``cna_analysis`` usage event (fire-and-forget). Safe-default
    paths (no API key, parse failure, exception) intentionally skip
    metering — we only charge for calls that actually hit Anthropic.
    """
    api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not api_key:
        logger.info("cna: ANTHROPIC_API_KEY unset — returning safe default")
        return _safe_default()

    # Strip the lead down to just the demographic + clinical fields the
    # AI needs. Never send PHI fields the AI doesn't need (MBI, SSN,
    # encrypted blobs).
    lead_summary = {
        "first_name": lead.get("first_name") or "",
        "last_name": lead.get("last_name") or "",
        "date_of_birth": lead.get("date_of_birth"),
        "state": lead.get("state"),
        "zip_code": lead.get("zip_code"),
        "current_carrier": lead.get("current_carrier"),
        "current_plan": lead.get("current_plan"),
        "medicare_part_a_effective": lead.get("medicare_part_a_effective"),
        "medicare_part_b_effective": lead.get("medicare_part_b_effective"),
        "status": lead.get("status"),
        "tags": lead.get("tags") or [],
    }
    cna_summary = {k: v for k, v in cna.items()
                   if not k.startswith("_")
                   and k not in ("ai_recommendation", "ai_generated_at",
                                  "agent_id", "agency_id")}

    user_msg = json.dumps({"lead": lead_summary, "cna": cna_summary},
                          default=str, indent=2)
    if len(user_msg) > 40_000:
        user_msg = user_msg[:40_000] + "\n…[truncated]"

    try:
        from anthropic import AsyncAnthropic
        client = AsyncAnthropic(api_key=api_key)
        response = await client.messages.create(
            model=_AI_MODEL,
            max_tokens=_AI_MAX_TOKENS,
            system=[{
                "type": "text",
                "text": _SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{"role": "user", "content": user_msg}],
        )
        # Metering — fire-and-forget. Wrapped in its own try so a
        # metering bug can never propagate up to the CNA caller.
        try:
            from metering import track_ai_usage
            usage = getattr(response, "usage", None)
            track_ai_usage(
                agency_id=agency_id,
                agent_id=agent_id,
                event_type="cna_analysis",
                tokens_in=int(getattr(usage, "input_tokens", 0) or 0),
                tokens_out=int(getattr(usage, "output_tokens", 0) or 0),
                model=_AI_MODEL,
            )
        except Exception as _e:                                # noqa: BLE001
            logger.debug("cna: metering hook failed: %s", _e)
        text = "".join(getattr(b, "text", "") for b in (response.content or []))
        text = (text or "").strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        try:
            parsed = json.loads(text)
        except Exception:
            logger.warning("cna: AI returned non-JSON; raw=%r", text[:300])
            return _safe_default()
        return _sanitise_recommendation(parsed)
    except Exception as e:                                    # noqa: BLE001
        logger.warning("cna: Claude call failed: %s", e)
        return _safe_default()


# ── Endpoints ──────────────────────────────────────────────────────────────
@router.get("/{lead_id}")
async def get_cna(
    lead_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """Return the CNA for this lead, or a blank pre-filled template
    when none exists yet. The blank template is identifiable by the
    absence of ``completed_at``."""
    lead = await _resolve_lead_or_403(
        db, lead_id, current_user, current_user,
    )

    existing = await db.cna_assessments.find_one(
        {"lead_id": lead_id}, {"_id": 0},
    )
    if existing:
        return {"cna": _public(existing), "exists": True}

    return {"cna": _empty_template(lead), "exists": False}


@router.post("/{lead_id}")
async def upsert_cna(
    lead_id: str,
    request: Request,
    body: CNAPayload = Body(...),
    run_ai: bool = False,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
    current_user: dict = Depends(get_current_user),
):
    """Create or update the CNA. Returns the persisted row. When
    ``run_ai=true`` is passed we synchronously call Claude before
    returning so the SPA gets the freshest recommendation in one
    round-trip (used by the "Save & Generate AI Analysis" button)."""
    # Entry-point trace. If this line shows up in Render logs but the
    # _resolve_lead_or_403 logs don't, the request actually reached
    # the body — useful to rule out get_effective_agent as the 403
    # source. (get_effective_agent raises BEFORE the body executes,
    # so its 403s never log this line.)
    logger.info(
        "cna.upsert_cna ENTER lead_id=%s x_agent_id=%r current_user_id=%s "
        "current_user_role=%r effective_id=%s effective_role=%r "
        "impersonated_by=%s run_ai=%s",
        lead_id,
        request.headers.get("X-Agent-ID", ""),
        (current_user or {}).get("id"),
        (current_user or {}).get("role"),
        (effective or {}).get("id"),
        (effective or {}).get("role"),
        (effective or {}).get("_impersonated_by"),
        run_ai,
    )
    lead = await _resolve_lead_or_403(db, lead_id, effective, current_user)

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    incoming = body.model_dump(exclude_none=False)
    incoming["prescriptions"] = [
        p.model_dump() if hasattr(p, "model_dump") else p
        for p in (body.prescriptions or [])
    ]
    incoming["preferred_doctors"] = [
        d.model_dump() if hasattr(d, "model_dump") else d
        for d in (body.preferred_doctors or [])
    ]

    # Fetch the existing row WITHOUT `_id` — MongoDB rejects any $set
    # that touches the immutable _id field, so we keep it out of the
    # update payload entirely. The upsert filter (lead_id) is enough
    # to target the same row across saves.
    existing = await db.cna_assessments.find_one(
        {"lead_id": lead_id}, {"_id": 0},
    )
    doc: Dict[str, Any] = {
        **(existing or {}),
        **incoming,
        "lead_id": lead_id,
        "agent_id": effective["id"],
        "agency_id": get_agency_id(),
        "updated_at": now_iso,
    }
    if not existing:
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = now_iso
    doc["completed_at"] = now_iso

    # Defense in depth: a future projection slip on the find_one above
    # would otherwise drag _id back into the update payload. Strip
    # unconditionally so the $set never touches an immutable field.
    doc.pop("_id", None)

    # Updating the CNA invalidates the cached recommendation. We clear
    # the timestamp so the next read knows the cache is stale; if
    # ``run_ai`` is set we fill it back in immediately below.
    doc.pop("ai_recommendation", None)
    doc.pop("ai_generated_at", None)

    ai_payload: Optional[Dict[str, Any]] = None
    if run_ai:
        try:
            ai_payload = await generate_ai_recommendation(
                lead, doc,
                agency_id=effective.get("agency_id"),
                agent_id=effective.get("id"),
            )
            doc["ai_recommendation"] = ai_payload
            doc["ai_generated_at"] = now_iso
        except Exception as e:                                # noqa: BLE001
            # generate_ai_recommendation is documented as never-raises
            # but we wrap defensively — a Claude SDK regression should
            # never cost the agent their CNA save.
            logger.exception(
                "cna upsert: AI generation failed lead_id=%s agent_id=%s: %s",
                lead_id, effective.get("id"), e,
            )

    try:
        await db.cna_assessments.update_one(
            {"lead_id": lead_id},
            {"$set": doc},
            upsert=True,
        )
    except Exception as e:                                    # noqa: BLE001
        # Surface the underlying error to Render logs with full
        # stacktrace + context. Frontend sees a generic 500 detail so
        # we don't leak collection internals to the SPA.
        logger.exception(
            "cna upsert FAILED lead_id=%s agent_id=%s impersonator=%s "
            "incoming_keys=%s err=%s",
            lead_id,
            effective.get("id"),
            effective.get("_impersonated_by"),
            sorted(incoming.keys()),
            e,
        )
        raise HTTPException(
            status_code=500,
            detail="Couldn't save CNA — see server logs for details.",
        )

    try:
        await write_audit(
            db, "cna_saved",
            actor_email=effective.get("email"),
            actor_id=effective["id"],
            target_type="lead", target_id=lead_id,
            request=request,
            metadata={
                "ai_generated": bool(run_ai),
                "impersonated_by": effective.get("_impersonated_by"),
            },
        )
    except Exception as e:                                    # noqa: BLE001
        # Audit-write failure shouldn't roll back the user's CNA save.
        logger.warning(
            "cna upsert: audit write failed lead_id=%s: %s", lead_id, e,
        )

    saved = await db.cna_assessments.find_one(
        {"lead_id": lead_id}, {"_id": 0},
    )
    return {
        "cna": _public(saved),
        "ai_recommendation": (saved or {}).get("ai_recommendation"),
        "ai_generated_at": (saved or {}).get("ai_generated_at"),
    }


@router.post("/{lead_id}/ai-analysis")
async def trigger_ai(
    lead_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    effective: dict = Depends(get_effective_agent),
    current_user: dict = Depends(get_current_user),
):
    """Force a fresh AI analysis against the stored CNA. 404 when no
    CNA exists yet — the SPA must save one before asking for AI."""
    logger.info(
        "cna.trigger_ai ENTER lead_id=%s x_agent_id=%r current_user_id=%s "
        "current_user_role=%r effective_id=%s effective_role=%r "
        "impersonated_by=%s",
        lead_id,
        request.headers.get("X-Agent-ID", ""),
        (current_user or {}).get("id"),
        (current_user or {}).get("role"),
        (effective or {}).get("id"),
        (effective or {}).get("role"),
        (effective or {}).get("_impersonated_by"),
    )
    lead = await _resolve_lead_or_403(db, lead_id, effective, current_user)
    cna = await db.cna_assessments.find_one({"lead_id": lead_id})
    if not cna:
        raise HTTPException(404, "CNA not found — save the assessment first.")

    ai_payload = await generate_ai_recommendation(
        lead, cna,
        agency_id=effective.get("agency_id"),
        agent_id=effective.get("id"),
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        await db.cna_assessments.update_one(
            {"lead_id": lead_id},
            {"$set": {
                "ai_recommendation": ai_payload,
                "ai_generated_at": now_iso,
                "updated_at": now_iso,
            }},
        )
    except Exception as e:                                    # noqa: BLE001
        logger.exception(
            "cna trigger_ai write FAILED lead_id=%s agent_id=%s: %s",
            lead_id, effective.get("id"), e,
        )
        raise HTTPException(
            status_code=500,
            detail="Couldn't persist AI analysis — see server logs.",
        )

    try:
        await write_audit(
            db, "cna_ai_analysis",
            actor_email=effective.get("email"),
            actor_id=effective["id"],
            target_type="lead", target_id=lead_id,
            request=request,
            metadata={
                "impersonated_by": effective.get("_impersonated_by"),
                "fallback": bool(ai_payload.get("_fallback")),
            },
        )
    except Exception as e:                                    # noqa: BLE001
        logger.warning(
            "cna trigger_ai: audit write failed lead_id=%s: %s", lead_id, e,
        )
    return {
        "ai_recommendation": ai_payload,
        "ai_generated_at": now_iso,
    }


@router.get("/{lead_id}/ai-analysis")
async def get_ai(
    lead_id: str,
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_phi_db),
    current_user: dict = Depends(get_current_user),
):
    """Return just the cached AI recommendation. Used by the Overview
    panel after a save+analyse round-trip; the SPA polls this to know
    whether the recommendation is ready."""
    await _resolve_lead_or_403(
        db, lead_id, current_user, current_user,
    )
    cna = await db.cna_assessments.find_one(
        {"lead_id": lead_id}, {"_id": 0},
    )
    if not cna:
        return {
            "ai_recommendation": None,
            "ai_generated_at": None,
            "cache_fresh": False,
            "exists": False,
        }
    ai_payload = cna.get("ai_recommendation")
    generated_at = cna.get("ai_generated_at")
    return {
        "ai_recommendation": ai_payload,
        "ai_generated_at": generated_at,
        "cache_fresh": _is_cache_fresh(generated_at),
        "exists": True,
    }
