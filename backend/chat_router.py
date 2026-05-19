"""AI chat assistant — Bedrock-streamed SSE for the in-app help widget.

PHI handling: we audit-log every message but only store metadata
(page, message length, history turn count). The message content and
the streamed response stay off disk. Bedrock is covered by AWS' HIPAA
BAA so it's an acceptable processor for whatever the agent types.
"""
import json
import logging
import os
from typing import List, Optional

import boto3
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter

from deps import (
    ACCESS_TOKEN_COOKIE,
    get_current_user,
    get_db,
    write_audit,
)
from security import decode_token


logger = logging.getLogger("gruening.chat")
router = APIRouter(prefix="/chat", tags=["chat"])

BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
MAX_HISTORY_TURNS = 10
MAX_MESSAGE_LEN = 4000
MAX_TURN_CONTENT_LEN = 4000
MAX_TOKENS = 1024


# ── Rate limiting (30/min per authenticated user) ─────────────────────────
def _per_user_key(request: Request) -> str:
    """slowapi key_func — prefer the authenticated user id, fall back to IP.

    slowapi runs before FastAPI's dependency layer so we have to peek at
    the cookie directly. A malformed/expired token silently falls through
    to per-IP limiting; the route still requires get_current_user, so an
    unauth caller never reaches Bedrock.
    """
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


# ── Wire payloads ─────────────────────────────────────────────────────────
class ChatTurn(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatContext(BaseModel):
    page: Optional[str] = None
    agent_name: Optional[str] = None
    client_name: Optional[str] = None


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_LEN)
    conversation_history: List[ChatTurn] = Field(default_factory=list)
    context: ChatContext = Field(default_factory=ChatContext)


# ── System prompt builder ─────────────────────────────────────────────────
def _build_system_prompt(ctx: ChatContext, fallback_name: str) -> str:
    """Compose the agent-context-aware system prompt.

    Only non-PHI context is interpolated — page slug, agent display name,
    and the client *name* if one is being viewed. Client PHI never enters
    the prompt; the model is told to refuse if asked.
    """
    agent_name = (ctx.agent_name or fallback_name or "Agent").strip() or "Agent"
    page = (ctx.page or "unknown").strip() or "unknown"
    client_line = (
        f"Viewing client: {ctx.client_name.strip()}\n" if ctx.client_name else ""
    )
    return (
        "You are the GHW Medicare Assistant — an expert AI built for "
        "Gruening Health & Wealth insurance agents.\n\n"
        "YOUR EXPERTISE:\n"
        "- Medicare: Part A, B, C (Medicare Advantage), D (PDP), "
        "Medigap/Supplement Plans A-N\n"
        "- Products: Med Supp, Medicare Advantage, PDP, Cancer, "
        "Heart/Stroke, Hospital Indemnity, Recovery Care, "
        "Dental/Vision/Hearing, Life Insurance, Annuities (FIA)\n"
        "- Illinois Birthday Rule: clients can switch Med Supp plans "
        "without underwriting during the 63-day window after their "
        "birthday\n"
        "- AEP: Oct 15 – Dec 7 | OEP: Jan 1 – Mar 31\n"
        "- CMS compliance and TCPA requirements\n"
        "- Scope of Appointment requirements\n"
        "- GHW carriers: UHC/AARP, Aetna, Heartland, GTL, Aflac, ACE, "
        "American Benefit Life, Allstate, AIG, Mutual of Omaha\n\n"
        "AGENT CONTEXT:\n"
        f"Agent: {agent_name}\n"
        f"Current page: {page}\n"
        f"{client_line}"
        "\nRULES:\n"
        "- Be concise and direct — agents are on calls\n"
        "- Never give specific premium quotes (use quoting tools for that)\n"
        "- Never give legal or tax advice\n"
        "- If asked about a specific client's PHI, say you don't have "
        "access to client records\n"
        "- Always recommend Scope of Appointment before discussing products\n"
        "- Flag CMS compliance concerns immediately"
    )


def _normalize_history(turns: List[ChatTurn]) -> List[dict]:
    """Trim to the last MAX_HISTORY_TURNS user/assistant turns, drop empties,
    and coerce role to a safe value. Bedrock rejects unknown roles and
    refuses requests with empty content."""
    out: List[dict] = []
    for t in turns[-MAX_HISTORY_TURNS:]:
        role = t.role if t.role in ("user", "assistant") else "user"
        content = (t.content or "").strip()
        if not content:
            continue
        out.append({"role": role, "content": content[:MAX_TURN_CONTENT_LEN]})
    return out


def _sse(obj: dict) -> str:
    """Serialise a JSON-event to a Server-Sent-Events frame."""
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


# ── Route ─────────────────────────────────────────────────────────────────
@router.post("")
@limiter.limit("30/minute")
async def chat(
    payload: ChatRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """Stream a Bedrock chat response back over SSE."""
    fallback_name = (
        current_user.get("full_name") or current_user.get("email") or "Agent"
    )
    system_prompt = _build_system_prompt(payload.context, fallback_name)

    messages = _normalize_history(payload.conversation_history)
    user_msg = (payload.message or "").strip()
    if not user_msg:
        raise HTTPException(400, "Empty message")
    messages.append({"role": "user", "content": user_msg[:MAX_MESSAGE_LEN]})

    body_json = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": messages,
    })

    # Audit BEFORE the network call — we want a record even if Bedrock
    # 5xx's or the connection drops mid-stream. Metadata only (HIPAA).
    await write_audit(
        db, "ai_chat_message",
        actor_email=current_user.get("email"),
        actor_id=current_user.get("id"),
        target_type="ai_chat",
        request=request,
        metadata={
            "page": payload.context.page,
            "message_length": len(user_msg),
            "history_turns": len(messages) - 1,
            "has_client_context": bool(payload.context.client_name),
        },
    )

    def event_stream():
        try:
            client = _get_bedrock_client()
            resp = client.invoke_model_with_response_stream(
                modelId=BEDROCK_MODEL_ID,
                body=body_json,
                contentType="application/json",
                accept="application/json",
            )
            for event in resp["body"]:
                chunk = event.get("chunk")
                if not chunk:
                    continue
                try:
                    data = json.loads(chunk["bytes"])
                except Exception:
                    continue
                etype = data.get("type")
                if etype == "content_block_delta":
                    delta = data.get("delta") or {}
                    text = delta.get("text") or ""
                    if text:
                        yield _sse({"type": "text", "content": text})
                elif etype == "message_stop":
                    break
            yield "data: [DONE]\n\n"
        except Exception as e:
            # Don't leak provider error details to the browser — log
            # server-side, return a generic message to the client.
            logger.warning("Bedrock chat stream failed: %s", e)
            yield _sse({"type": "error", "content": "Assistant unavailable. Try again."})
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
