"""
cfo_chat_router.py
==================
GHW CFO Assistant — a separate Bedrock-streamed chat surface
specialised for Medicare-agency accounting.

Why a second chat router?
-------------------------
The general /api/chat widget is tuned for *agent* questions (Med Supp
rules, AEP windows, product trivia). The CFO chat is admin/compliance-
only and gets a different system prompt + a dynamically-built agency
financial snapshot. Sharing the model is fine; sharing the system
prompt would confuse both surfaces.

PHI:
- The system prompt receives ONLY aggregate financial numbers.
- Specific client names are never seeded into context. If the user
  asks about a specific client, that's their typed query — they made
  the choice.
"""
from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import boto3
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter

from deps import (
    ACCESS_TOKEN_COOKIE,
    COMPLIANCE_ROLES,
    get_db,
    require_roles,
    write_audit,
)
from security import decode_token


logger = logging.getLogger("gruening.cfo_chat")
router = APIRouter(prefix="/cfo-chat", tags=["cfo-chat"])

BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
MAX_HISTORY_TURNS = 10
MAX_MESSAGE_LEN = 4000
MAX_TURN_CONTENT_LEN = 4000
MAX_TOKENS = 1200
CONTEXT_CACHE_SECONDS = 300  # 5 minutes


# ── Rate limiting (20/min per authenticated user) ────────────────────────
def _per_user_key(request: Request) -> str:
    try:
        token = request.cookies.get(ACCESS_TOKEN_COOKIE) or ""
        if token:
            payload = decode_token(token)
            sub = payload.get("sub")
            if sub:
                return f"user:{sub}"
    except Exception:
        pass
    return request.client.host if request.client else "anon"


limiter = Limiter(key_func=_per_user_key)


def _get_bedrock_client():
    return boto3.client(
        service_name="bedrock-runtime",
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


# ── Wire payloads ────────────────────────────────────────────────────────
class CFOChatTurn(BaseModel):
    role: str
    content: str


class CFOChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_LEN)
    conversation_history: List[CFOChatTurn] = Field(default_factory=list)


# ── Context builder ──────────────────────────────────────────────────────
# Cached at module scope so we don't hammer Mongo for every chat turn.
_ctx_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def _safe_float(v: Any) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


async def _get_accounting_context(db) -> Dict[str, Any]:
    """Aggregate the agency financial snapshot injected into the system
    prompt. Cached for ``CONTEXT_CACHE_SECONDS`` to avoid a full table
    scan on every user turn.

    All numbers are agency-wide aggregates — no client identifiers."""
    now = datetime.now(timezone.utc)
    cached = _ctx_cache.get("global")
    if cached and (time.monotonic() - cached[0]) < CONTEXT_CACHE_SECONDS:
        return cached[1]

    mtd_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    ytd_start = datetime(now.year, 1, 1, tzinfo=timezone.utc)

    rev_mtd = rec_mtd = 0.0
    rev_ytd = rec_ytd = 0.0
    total_expected = total_received = 0.0
    by_carrier: Dict[str, float] = defaultdict(float)
    by_agent_gap: Dict[str, float] = defaultdict(float)
    largest_outstanding = 0.0
    pending_total = 0.0

    async for r in db.production_records.find(
        {},
        {"_id": 0, "agent_name": 1, "carrier": 1,
         "revenue_expected": 1, "revenue_received": 1,
         "effective_date": 1, "app_date": 1},
    ):
        exp = _safe_float(r.get("revenue_expected"))
        rec_raw = r.get("revenue_received")
        rec = _safe_float(rec_raw) if rec_raw is not None else 0.0
        try:
            eff = datetime.fromisoformat(
                (r.get("effective_date") or r.get("app_date") or "")
                .replace("Z", "+00:00")
            )
            if eff.tzinfo is None:
                eff = eff.replace(tzinfo=timezone.utc)
        except Exception:
            eff = None
        if eff and eff >= mtd_start:
            rev_mtd += exp
            rec_mtd += rec
        if eff and eff >= ytd_start:
            rev_ytd += exp
            rec_ytd += rec
            total_expected += exp
            total_received += rec
            gap = max(0.0, exp - rec)
            by_carrier[(r.get("carrier") or "Unknown")] += gap
            if r.get("agent_name"):
                by_agent_gap[r["agent_name"]] += gap
            if rec_raw is None:
                pending_total += exp
                if exp > largest_outstanding:
                    largest_outstanding = exp

    total_gaps = max(0.0, total_expected - total_received)
    coll_rate = (total_received / total_expected * 100) if total_expected > 0 else 0.0

    top_carrier_by_gap = (
        max(by_carrier.items(), key=lambda kv: kv[1])[0] if by_carrier else None
    )
    agents_with_most_gaps = [
        {"agent_name": a, "gap": round(g, 2)}
        for a, g in sorted(by_agent_gap.items(), key=lambda kv: -kv[1])[:3]
    ]

    disputes_count = await db.commission_disputes.count_documents(
        {"status": {"$in": ["open", "in_progress"]}}
    )

    ctx = {
        "revenue_mtd": round(rev_mtd, 2),
        "received_mtd": round(rec_mtd, 2),
        "revenue_ytd": round(rev_ytd, 2),
        "received_ytd": round(rec_ytd, 2),
        "total_gaps": round(total_gaps, 2),
        "collection_rate": round(coll_rate, 1),
        "top_carrier_by_gap": top_carrier_by_gap,
        "agents_with_most_gaps": agents_with_most_gaps,
        "open_disputes_count": disputes_count,
        "largest_outstanding_amount": round(largest_outstanding, 2),
        "pending_total": round(pending_total, 2),
        "as_of": now.isoformat(),
    }
    _ctx_cache["global"] = (time.monotonic(), ctx)
    return ctx


# ── System prompt builder ────────────────────────────────────────────────
def _build_system_prompt(ctx: Dict[str, Any]) -> str:
    """Compose the CFO system prompt with the live financial snapshot.

    ``ctx`` is whatever ``_get_accounting_context`` returned — purely
    aggregates, no client PII."""
    agents_line = "; ".join(
        f"{a['agent_name']} (${a['gap']:,.0f} gap)"
        for a in (ctx.get("agents_with_most_gaps") or [])
    ) or "(none)"

    return (
        "You are the GHW CFO Assistant — a specialized financial AI for "
        "Gruening Health & Wealth, a Medicare insurance agency.\n\n"
        "YOUR EXPERTISE:\n"
        "- Medicare insurance commission structures\n"
        "- Carrier payment schedules and patterns\n"
        "- Advance vs earned commission accounting\n"
        "- Chargeback and recapture scenarios\n"
        "- NMO override calculations\n"
        "- AEP/OEP revenue patterns\n"
        "- Carrier reconciliation best practices\n"
        "- Medicare compliance financial requirements\n\n"
        "GHW COMMISSION STRUCTURE:\n"
        "- Agent split: 30% of agency revenue\n"
        "- Agency revenue: annual premium × carrier rate\n"
        "- Carrier rates vary by product/state/carrier\n"
        "- UHC pays flat $ per policy (not percentage)\n"
        "- MA: $313 new / $626 with scope\n"
        "- PDP: $100 flat\n\n"
        "CURRENT AGENCY FINANCIAL SNAPSHOT:\n"
        f"Revenue MTD:           ${ctx.get('revenue_mtd', 0):,.2f}\n"
        f"Received MTD:          ${ctx.get('received_mtd', 0):,.2f}\n"
        f"Revenue YTD:           ${ctx.get('revenue_ytd', 0):,.2f}\n"
        f"Received YTD:          ${ctx.get('received_ytd', 0):,.2f}\n"
        f"Outstanding gaps:      ${ctx.get('total_gaps', 0):,.2f}\n"
        f"Collection rate:       {ctx.get('collection_rate', 0)}%\n"
        f"Top carrier by gap:    {ctx.get('top_carrier_by_gap') or '(none)'}\n"
        f"Largest outstanding:   ${ctx.get('largest_outstanding_amount', 0):,.2f}\n"
        f"Open disputes:         {ctx.get('open_disputes_count', 0)}\n"
        f"Agents with most gaps: {agents_line}\n"
        f"Snapshot as of:        {ctx.get('as_of')}\n\n"
        "WHAT YOU CAN HELP WITH:\n"
        "- Finding and analyzing transactions\n"
        "- Explaining commission calculations\n"
        "- Identifying payment patterns and anomalies\n"
        "- Generating financial summaries\n"
        "- Advising on dispute strategies\n"
        "- Forecasting revenue\n"
        "- Explaining carrier payment behaviors\n\n"
        "RULES:\n"
        "- Always be specific and data-driven\n"
        "- Reference actual numbers when available\n"
        "- If you need data you don't have, say so clearly and suggest "
        "what the user should look for\n"
        "- NEVER make up financial figures\n"
        "- Keep responses concise — accounting teams are busy\n"
        "- Format money as $X,XXX.XX\n"
        "- Use markdown tables when a comparison would help"
    )


def _normalize_history(turns: List[CFOChatTurn]) -> List[dict]:
    out: List[dict] = []
    for t in turns[-MAX_HISTORY_TURNS:]:
        role = t.role if t.role in ("user", "assistant") else "user"
        content = (t.content or "").strip()
        if not content:
            continue
        out.append({"role": role, "content": content[:MAX_TURN_CONTENT_LEN]})
    return out


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


# ── Routes ───────────────────────────────────────────────────────────────
@router.post("")
@limiter.limit("20/minute")
async def cfo_chat(
    payload: CFOChatRequest,
    request: Request,
    current_user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Stream a Bedrock-backed CFO chat response over SSE."""
    user_msg = (payload.message or "").strip()
    if not user_msg:
        raise HTTPException(400, "Empty message")

    ctx = await _get_accounting_context(db)
    system_prompt = _build_system_prompt(ctx)

    messages = _normalize_history(payload.conversation_history)
    messages.append({"role": "user", "content": user_msg[:MAX_MESSAGE_LEN]})

    body_json = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": messages,
    })

    # HIPAA: only metadata logged.
    await write_audit(
        db, "cfo_chat_message",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="cfo_chat", request=request,
        metadata={
            "message_length": len(user_msg),
            "history_turns": len(messages) - 1,
        },
    )

    def event_stream():
        logger.info(
            "Bedrock CFO chat invoke: model=%s region=%s msgs=%d",
            BEDROCK_MODEL_ID, AWS_REGION, len(messages),
        )
        try:
            client = _get_bedrock_client()
        except Exception as e:
            logger.exception("Bedrock client init failed: %s", e)
            yield _sse({"type": "error",
                        "content": "CFO assistant unavailable. Try again."})
            yield "data: [DONE]\n\n"
            return
        # Streaming path.
        try:
            resp = client.invoke_model_with_response_stream(
                modelId=BEDROCK_MODEL_ID, body=body_json,
                contentType="application/json", accept="application/json",
            )
            for event in resp["body"]:
                chunk = event.get("chunk")
                if not chunk:
                    continue
                try:
                    data = json.loads(chunk["bytes"])
                except Exception:
                    continue
                if data.get("type") == "content_block_delta":
                    text = (data.get("delta") or {}).get("text") or ""
                    if text:
                        yield _sse({"type": "text", "content": text})
                elif data.get("type") == "message_stop":
                    break
            yield "data: [DONE]\n\n"
            return
        except Exception as stream_err:
            logger.warning(
                "CFO chat streaming failed, falling back to non-streaming: %s",
                stream_err,
            )
        # Non-streaming fallback.
        try:
            resp = client.invoke_model(
                modelId=BEDROCK_MODEL_ID, body=body_json,
                contentType="application/json", accept="application/json",
            )
            raw = resp["body"].read()
            data = json.loads(raw) if raw else {}
            text_parts = [
                b.get("text") or "" for b in data.get("content") or []
                if b.get("type") == "text"
            ]
            full = "".join(text_parts).strip()
            if full:
                yield _sse({"type": "text", "content": full})
            else:
                yield _sse({"type": "error",
                            "content": "Assistant returned no content."})
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.exception("CFO chat non-streaming fallback failed: %s", e)
            yield _sse({"type": "error",
                        "content": "CFO assistant unavailable. Try again."})
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/context")
async def cfo_context(
    _user: dict = Depends(require_roles(*COMPLIANCE_ROLES)),
    db=Depends(get_db),
):
    """Return the same snapshot the chat will see — useful for the UI
    badge ("As of 2:14pm — $42k outstanding") and for tests."""
    return await _get_accounting_context(db)
