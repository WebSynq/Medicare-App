"""
commission_audit_router.py
==========================
Commission audit endpoints — Phase 2 commission intelligence.

Reads the production_records collection seeded by scripts/import_production.py
and surfaces discrepancies between revenue_expected (Plecto) and
revenue_received (AgencyBloc, when present).

Hard rules:
- All endpoints require auth.
- Agents see only their own records (IDOR firewall — match by
  current_user.agent_name).
- 30/hour per user IP rate limit.
- Every access writes an audit event with role + filters + result counts.
"""
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from deps import (
    forbid_roles,
    get_client_ip,
    get_db,
    require_roles,
    resolve_agent_key,
    write_audit,
)

# Roles barred from every commission-audit and chat surface. Admin-only
# endpoints below already use require_roles("admin") so they're covered.
_COMMISSION_FORBIDDEN = ("client_success",)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/commission/audit", tags=["commission-audit"])
# Second router for sibling /commission/* endpoints (chat, etc). Mounted in
# server.py alongside the audit router. Same limiter — slowapi keys on IP, so
# the bucket is shared, but the per-user budget below is enforced via Mongo.
chat_router = APIRouter(prefix="/commission", tags=["commission-chat"])
limiter = Limiter(key_func=get_remote_address)


# ── Status taxonomy ─────────────────────────────────────────────────────────
# Records start "pending" (no AgencyBloc reconciliation yet). After AB sync
# the calculator transitions them based on the revenue_expected vs
# revenue_received gap. "resolved" is a manual admin override.
ALLOWED_STATUSES = {"underpaid", "missing", "overpaid", "matched",
                     "pending", "resolved"}

# Discrepancy bands. Anything within ±5% of the expected amount counts as
# "matched" (rounding, micro-fee diffs, carrier withholdings). Outside the
# band the gap classifies as under/overpaid. Bands are symmetric and shared
# with comtrack_sync.py so the daily sync writes the same status the reads
# would compute.
MATCH_BAND_LOW = 0.95
MATCH_BAND_HIGH = 1.05


def _classify_from_amounts(expected, received) -> str:
    """Classify a (expected, received) pair into the audit taxonomy.

    Pure function — no DB, no record dict — so comtrack_sync.py can call it
    when writing back the daily sync results. Edge cases:
      - received None  → pending if expected None, else missing
      - received 0     → matched if expected 0, else missing
      - expected None  → overpaid if received > 0, else matched
      - expected 0     → overpaid (we got paid for an untracked policy)
      - else           → ratio bands (5%/5%)
    """
    if received is None:
        return "pending" if expected is None else "missing"
    if expected is None:
        return "overpaid" if received > 0 else "matched"
    if received == 0:
        return "matched" if expected == 0 else "missing"
    if expected == 0:
        return "overpaid"
    ratio = received / expected
    if ratio < MATCH_BAND_LOW:
        return "underpaid"
    if ratio > MATCH_BAND_HIGH:
        return "overpaid"
    return "matched"


def _period_filter(period: str) -> Optional[dict]:
    """Translate a period token into a Mongo filter on effective_date."""
    if period == "all":
        return None
    now = datetime.now(timezone.utc).date()
    if period == "week":
        start = now - timedelta(days=7)
    elif period == "month":
        start = now - timedelta(days=30)
    else:
        raise HTTPException(status_code=400,
                            detail=f"Unknown period: {period}")
    return {"effective_date": {"$gte": start.isoformat()}}


def _classify(record: dict) -> str:
    """Derive a live status from the expected/received numbers.

    Stored audit_status wins when it's a terminal label ("resolved"); for
    everything else we recompute on read so newly synced received amounts
    don't require a write to reflect.
    """
    if record.get("audit_status") == "resolved":
        return "resolved"
    return _classify_from_amounts(record.get("revenue_expected"),
                                   record.get("revenue_received"))


def _gap(record: dict) -> float:
    """Signed gap: positive = overpaid, negative = underpaid.
    None on either side defaults to 0 so it sorts to the bottom of the
    discrepancy ranking without taking precedence over real gaps."""
    expected = record.get("revenue_expected") or 0.0
    received = record.get("revenue_received") or 0.0
    return round(received - expected, 2)


def _scope_filter(current_user: dict) -> dict:
    """Mongo filter restricting an agent to their own records.

    Matches a production record's ``agent_name`` field against the user's
    canonical agent key (``resolve_agent_key``: agent_name → full_name),
    and additionally matches the record's ``agent_email`` against the
    user's email so legacy records keyed only by email still resolve.
    """
    role = current_user.get("role")
    if role in ("admin", "compliance"):
        return {}
    filters = []
    key = resolve_agent_key(current_user)
    if key:
        filters.append({"agent_name": key})
    if current_user.get("email"):
        filters.append({"agent_email": current_user["email"].lower()})
    if not filters:
        # Authenticated user has no matchable identity → see nothing.
        return {"_no_match": True}
    return {"$or": filters} if len(filters) > 1 else filters[0]


# ── GET /commission/audit ──────────────────────────────────────────────────
# No rate limit: read-only, no upstream cost. Auth + RBAC still apply.
@router.get("")
async def list_audit_records(
    request: Request,
    period: str = Query("month", pattern="^(week|month|all)$"),
    status: str = Query("all"),
    agent_id: Optional[str] = Query(None, max_length=64,
                                     description="Admin-only override"),
    limit: int = Query(200, ge=1, le=1000),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(forbid_roles(*_COMMISSION_FORBIDDEN)),
):
    """Ranked list of records with discrepancies for the calling agent.

    Agents always see only their own rows. The agent_id param is honoured
    only for admin/compliance — agents passing it are silently ignored
    (we still apply their scope_filter on top).
    """
    if status != "all" and status not in ALLOWED_STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"Unknown status: {status}")

    base_filter: dict = {}
    period_f = _period_filter(period)
    if period_f:
        base_filter.update(period_f)

    role = current_user.get("role")
    if role in ("admin", "compliance") and agent_id:
        target = await db.users.find_one({"id": agent_id}, {"_id": 0})
        if not target:
            raise HTTPException(status_code=404, detail="Agent not found")
        target_name = target.get("agent_name")
        target_email = (target.get("email") or "").lower()
        ors = []
        if target_name:
            ors.append({"agent_name": target_name})
        if target_email:
            ors.append({"agent_email": target_email})
        if ors:
            base_filter["$or"] = ors
        else:
            return {"records": [], "total": 0}
    else:
        # Agent scoping (or admin with no agent_id filter — see everyone)
        scope = _scope_filter(current_user)
        if scope.get("_no_match"):
            return {"records": [], "total": 0}
        base_filter.update(scope)

    cursor = db.production_records.find(base_filter, {"_id": 0}).limit(limit)
    rows = [r async for r in cursor]

    # Classify in-memory (cheap; bounded by limit). Filter by status if asked.
    enriched = []
    for r in rows:
        status_now = _classify(r)
        if status != "all" and status_now != status:
            continue
        enriched.append({**r, "status": status_now, "gap": _gap(r)})

    # Rank by absolute gap descending — biggest discrepancies first.
    enriched.sort(key=lambda r: abs(r["gap"]), reverse=True)

    await write_audit(
        db, "commission_audit_listed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={
            "period": period,
            "status_filter": status,
            "agent_id_filter": agent_id,
            "result_count": len(enriched),
            "role": role,
        },
    )

    return {"records": enriched, "total": len(enriched), "period": period}


# ── GET /commission/audit/summary ──────────────────────────────────────────
# No rate limit: read-only, no upstream cost. Auth + RBAC still apply.
@router.get("/summary")
async def audit_summary(
    request: Request,
    period: str = Query("month", pattern="^(week|month|all)$"),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(forbid_roles(*_COMMISSION_FORBIDDEN)),
):
    """Team-wide totals (admin) or own-only totals (agent).

    We compute in-memory rather than via $aggregate because _classify
    needs the same Python logic the list endpoint uses; keeping it in
    one place avoids drift between summary numbers and detail rows.
    """
    base_filter: dict = {}
    period_f = _period_filter(period)
    if period_f:
        base_filter.update(period_f)

    scope = _scope_filter(current_user)
    if scope.get("_no_match"):
        return {
            "total_expected": 0.0,
            "total_received": 0.0,
            "total_gap": 0.0,
            "count_by_status": {s: 0 for s in ALLOWED_STATUSES},
            "policies": 0,
            "period": period,
        }
    base_filter.update(scope)

    counts = {s: 0 for s in ALLOWED_STATUSES}
    total_expected = 0.0
    total_received = 0.0
    total_gap = 0.0
    policies = 0

    cursor = db.production_records.find(base_filter, {"_id": 0})
    async for r in cursor:
        policies += 1
        counts[_classify(r)] = counts.get(_classify(r), 0) + 1
        if r.get("revenue_expected") is not None:
            total_expected += r["revenue_expected"]
        if r.get("revenue_received") is not None:
            total_received += r["revenue_received"]
        total_gap += _gap(r)

    await write_audit(
        db, "commission_audit_summary_viewed",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"period": period, "role": current_user.get("role"),
                   "policies": policies},
    )

    return {
        "total_expected": round(total_expected, 2),
        "total_received": round(total_received, 2),
        "total_gap": round(total_gap, 2),
        "count_by_status": counts,
        "policies": policies,
        "period": period,
    }


# ── GET /commission/sync/status — admin-only ───────────────────────────────
# Returns the most recent ComTrack sync run summary. Admin-only because the
# stats include error categories and per-agent unmatched counts that aren't
# meant for agent self-serve.
@chat_router.get("/sync/status")
async def commission_sync_status(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin")),
):
    """Latest run of the ComTrack daily sync (admin only)."""
    latest = await db.commission_sync_runs.find_one(
        {}, {"_id": 0}, sort=[("completed_at", -1)])
    if not latest:
        return {"last_run": None,
                "mock_mode": not bool(os.environ.get("COMTRACK_API_KEY", "").strip())}
    return {"last_run": latest,
            "mock_mode": latest.get("mock_mode", False)}


# ── POST /commission/sync/run — admin-only manual trigger ──────────────────
# On-demand re-sync (without waiting for the 06:00 UTC cron). Useful for
# admins reconciling fresh statements mid-day. Same code path as the cron
# job, so behaviour is identical.
@chat_router.post("/sync/run")
@limiter.limit("6/hour")
async def commission_sync_run_now(
    request: Request,
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin")),
):
    """Trigger an immediate ComTrack sync (admin only). Audited."""
    # Lazy import to avoid a circular import (comtrack_sync imports this module).
    from comtrack_sync import run_sync
    result = await run_sync(db, triggered_by=f"manual:{current_user.get('email')}")
    await write_audit(
        db, "commission_sync_manual_run",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        request=request,
        metadata={"agents_processed": result.get("agents_processed"),
                   "records_updated": result.get("records_updated"),
                   "status": result.get("status")},
    )
    return result


# ── GET /commission/statement/{year}/{month} ───────────────────────────────
# Streams the PDF generated by statement_generator (or generates it on demand
# if the file isn't yet on disk for that month). Agents see only their own
# statement; admins may pass ?agent_name= to fetch any agent's statement.
@chat_router.get("/statement/{year}/{month}")
async def get_commission_statement(
    year: int,
    month: int,
    request: Request,
    agent_name: Optional[str] = Query(None, max_length=128),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(forbid_roles(*_COMMISSION_FORBIDDEN)),
):
    """Download the agent's monthly commission statement (PDF).

    Path params validated for sane ranges. Agents are pinned to their own
    statement; the agent_name query param is honoured only for admins.
    """
    if not (2020 <= year <= 2100) or not (1 <= month <= 12):
        raise HTTPException(status_code=400, detail="Invalid year/month")

    role = current_user.get("role")
    if role == "admin" and agent_name:
        target_name = agent_name
    elif role == "admin" and not agent_name:
        # Admins must specify an agent when fetching a statement — no
        # default "everyone" PDF (one PDF per agent by design).
        raise HTTPException(status_code=400,
                              detail="agent_name query parameter is required for admins")
    else:
        target_name = current_user.get("agent_name")
        if not target_name:
            raise HTTPException(
                status_code=404,
                detail="No agent_name on file; statement unavailable")

    # Lazy import to keep server boot cheap and avoid pulling reportlab into
    # callers that never download statements.
    from statement_generator import (
        generate_for_agent, statement_path)

    path = statement_path(target_name, year, month)
    if not path.exists():
        # Generate on the fly if the scheduler hasn't produced it yet
        # (e.g. mid-month admin pulling a snapshot).
        path = await generate_for_agent(db, target_name, year, month)

    await write_audit(
        db, "commission_statement_downloaded",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="commission_statement",
        target_id=path.name,
        request=request,
        metadata={"agent_name": target_name, "year": year, "month": month,
                   "role": role},
    )

    return FileResponse(
        path=str(path),
        media_type="application/pdf",
        filename=path.name,
    )


# ── POST /commission/audit/mark-resolved/{record_id} ───────────────────────
class MarkResolvedBody(BaseModel):
    notes: str = Field(..., min_length=1, max_length=2000)


@router.post("/mark-resolved/{record_id}")
@limiter.limit("30/hour")
async def mark_resolved(
    record_id: str,
    request: Request,
    body: MarkResolvedBody = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(require_roles("admin")),
):
    """Admin-only: flag a record as resolved + attach notes.

    We accept either the document's id field (UUID) or its natural_key
    (sha256) as record_id — the natural_key is what import_production
    surfaces in the UI when no synthetic id has been assigned.
    """
    record = await db.production_records.find_one(
        {"$or": [{"id": record_id}, {"natural_key": record_id}]},
        {"_id": 0},
    )
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")

    now_iso = datetime.now(timezone.utc).isoformat()
    update_filter = {"natural_key": record["natural_key"]}
    await db.production_records.update_one(
        update_filter,
        {"$set": {
            "audit_status": "resolved",
            "audit_notes": body.notes.strip(),
            "resolved_at": now_iso,
            "resolved_by": current_user["id"],
            "updated_at": now_iso,
        }},
    )

    await write_audit(
        db, "commission_audit_resolved",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="production_record",
        target_id=record["natural_key"],
        request=request,
        metadata={"policy_number": record.get("policy_number"),
                   "carrier": record.get("carrier"),
                   "notes_excerpt": body.notes.strip()[:120]},
    )

    fresh = await db.production_records.find_one(update_filter, {"_id": 0})
    return {**fresh, "status": _classify(fresh), "gap": _gap(fresh)}


# ── POST /commission/chat — AI commission assistant ────────────────────────
# Per-user rate limit budgets (separate bucket from /audit endpoints).
_CHAT_RATE_LIMIT = 20
_CHAT_RATE_WINDOW = timedelta(hours=1)

# Bounded context inputs so we never blow the model's context window on a
# rogue dataset. Tuned for typical agent + admin loads.
_MAX_CONTEXT_RECORDS = 200
_MAX_TOP_GAPS = 3

# Static system prompt. Kept verbatim from spec so cache hits across requests.
_SYSTEM_PROMPT = (
    "You are a commission intelligence assistant for GHW "
    "(Gruening Health & Wealth). You have access to the agent's "
    "production records including expected commissions, received "
    "amounts, and audit flags. Help agents understand their "
    "commission data, identify discrepancies, and draft carrier "
    "dispute letters when needed. Always be specific — cite policy "
    "numbers, amounts, and dates. Never reveal other agents' data "
    "to non-admin users."
)

# Structured-output schema. Constrains the response to exactly the shape we
# return to the client so the SPA never has to parse free-form text.
_CHAT_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {
            "type": "string",
            "description": "Conversational answer to the agent's question. "
                            "Cite policy numbers, dollar amounts, and dates "
                            "where possible.",
        },
        "suggested_actions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Short list of follow-up actions the agent could "
                            "take (e.g. 'Mark POL-001 as resolved', 'Draft a "
                            "dispute letter to Aetna for the Q1 underpayment').",
        },
    },
    "required": ["reply", "suggested_actions"],
    "additionalProperties": False,
}


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


async def _check_chat_rate_limit(db: AsyncIOMotorDatabase, user_id: str) -> None:
    now = datetime.now(timezone.utc)
    window_start = now - _CHAT_RATE_WINDOW
    count = await db.commission_chat_rate_limits.count_documents({
        "user_id": user_id,
        "called_at": {"$gte": window_start},
    })
    if count >= _CHAT_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded ({_CHAT_RATE_LIMIT}/hour). "
                   "Please wait before retrying.",
        )
    await db.commission_chat_rate_limits.insert_one({
        "user_id": user_id,
        "called_at": now,
        "expires_at": now + _CHAT_RATE_WINDOW,
    })


async def _build_chat_context(db: AsyncIOMotorDatabase,
                               current_user: dict) -> dict:
    """Assemble the per-request context payload injected into the prompt.

    Role-scoped (admin vs agent) using the same _scope_filter / _classify
    helpers as the list endpoint, so the AI can never see records the list
    endpoint would hide. This is the IDOR firewall for the chat surface.
    """
    base_filter: dict = {}
    scope = _scope_filter(current_user)
    if scope.get("_no_match"):
        # Authenticated user with no matchable identity. Still respond, but
        # with empty data — let the model say "no data on file".
        return {"role": current_user.get("role"),
                "totals": {"expected": 0, "received": 0, "gap": 0},
                "top_gaps": [], "carrier_breakdown": {}, "records": []}
    base_filter.update(scope)

    cursor = db.production_records.find(base_filter, {"_id": 0}).limit(
        _MAX_CONTEXT_RECORDS)
    records: list[dict] = []
    total_expected = 0.0
    total_received = 0.0
    total_gap = 0.0
    carrier_totals: dict[str, dict] = {}

    async for r in cursor:
        status = _classify(r)
        gap = _gap(r)
        slim = {
            "policy_number": r.get("policy_number"),
            "carrier": r.get("carrier"),
            "product": r.get("product"),
            "agent_name": r.get("agent_name"),
            "client_name": r.get("client_name"),
            "state": r.get("state"),
            "effective_date": r.get("effective_date"),
            "revenue_expected": r.get("revenue_expected"),
            "revenue_received": r.get("revenue_received"),
            "status": status,
            "gap": gap,
        }
        records.append(slim)
        if r.get("revenue_expected") is not None:
            total_expected += r["revenue_expected"]
        if r.get("revenue_received") is not None:
            total_received += r["revenue_received"]
        total_gap += gap
        bucket = carrier_totals.setdefault(
            r.get("carrier") or "Unknown",
            {"expected": 0.0, "received": 0.0, "policies": 0},
        )
        bucket["expected"] += r.get("revenue_expected") or 0.0
        bucket["received"] += r.get("revenue_received") or 0.0
        bucket["policies"] += 1

    # Top discrepancies by absolute gap — what the agent most cares about.
    top_gaps = sorted(records, key=lambda r: abs(r["gap"]), reverse=True)
    top_gaps = [r for r in top_gaps if abs(r["gap"]) > 0][:_MAX_TOP_GAPS]

    return {
        "role": current_user.get("role"),
        "agent_name": current_user.get("agent_name"),
        "period": "all_time",
        "totals": {
            "expected": round(total_expected, 2),
            "received": round(total_received, 2),
            "gap": round(total_gap, 2),
        },
        "top_gaps": top_gaps,
        "carrier_breakdown": {
            k: {"expected": round(v["expected"], 2),
                "received": round(v["received"], 2),
                "policies": v["policies"]}
            for k, v in carrier_totals.items()
        },
        "records": records,
    }


def _extract_text_blocks(content) -> str:
    """Join the text blocks from a Claude response, skipping thinking blocks."""
    out = []
    for block in content:
        if getattr(block, "type", None) == "text":
            out.append(block.text)
    return "".join(out)


@chat_router.post("/chat")
@limiter.limit("30/hour")  # IP-level outer guard; per-user is the real budget
async def commission_chat(
    request: Request,
    body: ChatRequest = Body(...),
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: dict = Depends(forbid_roles(*_COMMISSION_FORBIDDEN)),
):
    """AI commission assistant (Anthropic claude-sonnet-4-6).

    Hard rules:
    - Auth required.
    - Per-user 20/hour rate limit (Mongo-backed counter, separate from /audit).
    - Context is role-scoped via the SAME _scope_filter used by /audit, so
      an agent can never see another agent's records through the AI surface.
    - ANTHROPIC_API_KEY is read from env only; never hardcoded.
    - System prompt is cache-controlled so warm-cache requests are cheap.
    - Output is constrained to {reply, suggested_actions} via JSON schema.
    - Every turn is audit-logged.
    """
    user_id = current_user["id"]
    await _check_chat_rate_limit(db, user_id)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        logger.error("ANTHROPIC_API_KEY is not set; refusing to call upstream")
        # Audit the attempted access so the gap is visible in compliance logs.
        await write_audit(
            db, "commission_chat_unavailable",
            actor_email=current_user.get("email"), actor_id=user_id,
            request=request,
            metadata={"reason": "missing_api_key"},
        )
        raise HTTPException(
            status_code=503,
            detail="Commission assistant temporarily unavailable.",
        )

    context = await _build_chat_context(db, current_user)

    # Import lazily so the module loads even when the SDK isn't installed
    # in test environments that mock the call.
    from anthropic import AsyncAnthropic
    client = AsyncAnthropic(api_key=api_key)

    try:
        response = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4096,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": _SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": _CHAT_OUTPUT_SCHEMA,
                },
            },
            messages=[{
                "role": "user",
                "content": (
                    "<commission_context>\n"
                    f"{json.dumps(context, default=str)}\n"
                    "</commission_context>\n\n"
                    f"Agent question: {body.message.strip()}"
                ),
            }],
        )
    except Exception as e:
        # Don't surface upstream error detail to the client (could contain
        # request IDs, prompt fragments, internal state). Log + generic 503.
        logger.exception("Anthropic call failed for user %s: %s", user_id, e)
        await write_audit(
            db, "commission_chat_error",
            actor_email=current_user.get("email"), actor_id=user_id,
            request=request,
            metadata={"error_category": type(e).__name__},
        )
        raise HTTPException(
            status_code=503,
            detail="Commission assistant temporarily unavailable.",
        )

    # The structured-output schema guarantees the first text block is valid
    # JSON of the requested shape — but be defensive (compile-cache misses,
    # refusals, max-token truncations can break the invariant).
    text = _extract_text_blocks(response.content)
    try:
        parsed = json.loads(text)
        reply = str(parsed.get("reply", ""))
        actions = parsed.get("suggested_actions", []) or []
        if not isinstance(actions, list):
            actions = []
        actions = [str(a) for a in actions]
    except (json.JSONDecodeError, AttributeError, TypeError):
        logger.warning("commission_chat: failed to parse model response as JSON")
        reply = text.strip() or "I couldn't produce a structured response."
        actions = []

    # Audit every turn. Don't log the full reply (could echo PHI from context);
    # store the question excerpt + role + token counts only.
    usage = getattr(response, "usage", None)
    await write_audit(
        db, "commission_chat",
        actor_email=current_user.get("email"), actor_id=user_id,
        request=request,
        metadata={
            "role": current_user.get("role"),
            "question_excerpt": body.message.strip()[:200],
            "stop_reason": getattr(response, "stop_reason", None),
            "input_tokens": getattr(usage, "input_tokens", None) if usage else None,
            "output_tokens": getattr(usage, "output_tokens", None) if usage else None,
            "cache_read_input_tokens":
                getattr(usage, "cache_read_input_tokens", None) if usage else None,
            "actions_count": len(actions),
            "record_count": len(context.get("records", [])),
        },
    )

    return {"reply": reply, "suggested_actions": actions}
