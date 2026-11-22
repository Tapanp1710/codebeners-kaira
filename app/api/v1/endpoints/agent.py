"""Live voice agent API.

POST /agent/session        start (or resume) a live session -> short-lived WebSocket ticket (cookie + CSRF auth)
WS   /agent/live?ticket=   the live audio/agent socket (ticket auth, Origin checked against CORS_ORIGINS)
POST /agent/turn           one typed turn through the same agent (typed fallback; also used by tests)
GET  /agent/conversation   persisted conversation history for this user
GET  /agent/sessions/{id}  usage of one session (billed STT seconds, TTS characters, LLM calls)
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from fastapi import APIRouter, Request, WebSocket
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.exceptions import NotFoundError
from app.db.dependencies import Auth, DbSession, SettingsDep
from app.models import AgentSession
from app.schemas.common import Envelope, ok
from app.services.agent import orchestrator
from app.services.agent.live import LiveSession

router = APIRouter(prefix="/agent", tags=["agent"])
TICKET_TYPE = "agent_ws"


class AgentSessionStart(BaseModel):
    resume_session_id: uuid.UUID | None = None


class AgentSessionOut(BaseModel):
    session_id: uuid.UUID
    ticket: str
    ws_url: str
    expires_in: int
    voice_configured: bool
    stt_model: str
    tts_model: str


class AgentTurnIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    turn_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    language: str | None = Field(default=None, max_length=8)


class AgentTurnOut(BaseModel):
    turn_id: str
    reply: str
    language: str
    ignored: bool
    replayed: bool
    duration_ms: int
    events: list[dict[str, Any]]


@router.post("/session", response_model=Envelope[AgentSessionOut], summary="Start or resume a live voice session")
def start_session(body: AgentSessionStart, request: Request, ctx: Auth, db: DbSession, settings: SettingsDep):
    request.app.state.rate_limiter.check(f"ai:{ctx.user_id}", settings.RATE_LIMIT_AI_PER_MINUTE)
    session = None
    if body.resume_session_id:
        session = db.scalar(
            select(AgentSession).where(
                AgentSession.id == body.resume_session_id,
                AgentSession.business_id == ctx.business_id,
                AgentSession.user_id == ctx.user_id,
            )
        )
    if session is None:
        session = AgentSession(business_id=ctx.business_id, user_id=ctx.user_id, status="active")
        db.add(session)
    session.status = "active"
    db.commit()
    exp = datetime.now(UTC) + timedelta(seconds=settings.AGENT_TICKET_TTL_SECONDS)
    ticket = jwt.encode(
        {
            "typ": TICKET_TYPE,
            "sub": str(ctx.user_id),
            "bid": str(ctx.business_id),
            "sid": str(session.id),
            "jti": secrets.token_hex(8),
            "exp": exp,
        },
        settings.JWT_SECRET_KEY,
        algorithm="HS256",
    )
    return ok(
        AgentSessionOut(
            session_id=session.id,
            ticket=ticket,
            ws_url=settings.AGENT_PUBLIC_WS_URL,
            expires_in=settings.AGENT_TICKET_TTL_SECONDS,
            voice_configured=settings.sarvam_configured,
            stt_model=settings.SARVAM_STT_MODEL,
            tts_model=settings.SARVAM_TTS_MODEL,
        )
    )


@router.websocket("/live")
async def live(ws: WebSocket):
    settings = ws.app.state.settings
    origin = ws.headers.get("origin")
    if origin is not None and origin.rstrip("/") not in settings.CORS_ORIGINS:
        await ws.close(code=1008, reason="origin not allowed")
        return
    try:
        claims = jwt.decode(ws.query_params.get("ticket", ""), settings.JWT_SECRET_KEY, algorithms=["HS256"])
        if claims.get("typ") != TICKET_TYPE:
            raise jwt.InvalidTokenError("wrong ticket type")
        user_id, business_id, session_id = (
            uuid.UUID(claims["sub"]),
            uuid.UUID(claims["bid"]),
            uuid.UUID(claims["sid"]),
        )
    except (jwt.PyJWTError, KeyError, ValueError):
        await ws.close(code=1008, reason="invalid or expired ticket")
        return
    await ws.accept()
    if not settings.sarvam_configured:
        await ws.send_json(
            {
                "type": "error",
                "source": "config",
                "code": "PROVIDER_NOT_CONFIGURED",
                "fatal": True,
                "message": "Live voice needs SARVAM_API_KEY in the backend .env. Typed input still works.",
            }
        )
        await ws.close(code=1000)
        return
    await LiveSession(ws, ws.app.state, user_id=user_id, business_id=business_id, session_id=session_id).run()


@router.post("/turn", response_model=Envelope[AgentTurnOut], summary="One typed conversational turn")
def turn(body: AgentTurnIn, request: Request, ctx: Auth, settings: SettingsDep):
    request.app.state.rate_limiter.check(f"ai:{ctx.user_id}", settings.RATE_LIMIT_AI_PER_MINUTE)
    events: list[dict[str, Any]] = []
    result = orchestrator.run_turn(
        request.app.state.session_factory,
        settings,
        request.app.state.sarvam,
        user_id=ctx.user_id,
        business_id=ctx.business_id,
        session_id=None,
        turn_id=body.turn_id or uuid.uuid4().hex,
        text=body.text,
        language_hint=body.language,
        input_mode="text",
        emit=events.append,
    )
    return ok(
        AgentTurnOut(
            turn_id=result.turn_id,
            reply=result.reply,
            language=result.language,
            ignored=result.ignored,
            replayed=result.replayed,
            duration_ms=result.duration_ms,
            events=events,
        )
    )


@router.get("/conversation", response_model=Envelope[list[dict[str, Any]]], summary="Conversation history")
def get_conversation(ctx: Auth, db: DbSession):
    return ok(orchestrator.conversation(db, ctx.business_id, ctx.user_id))


@router.get(
    "/sessions/{session_id}", response_model=Envelope[dict[str, Any]], summary="Usage of one live session"
)
def session_usage(session_id: uuid.UUID, ctx: Auth, db: DbSession):
    s = db.scalar(
        select(AgentSession).where(AgentSession.id == session_id, AgentSession.business_id == ctx.business_id)
    )
    if s is None:
        raise NotFoundError("Session not found.")
    return ok(
        {
            "session_id": str(s.id),
            "status": s.status,
            "stt_audio_seconds_billed": str(s.stt_audio_seconds),
            "stt_audio_seconds_sent": str(s.stt_audio_sent_seconds),
            "tts_characters": s.tts_characters,
            "llm_calls": s.llm_calls,
            "provider_errors": s.provider_errors,
            "started_at": s.created_at.isoformat(),
            "ended_at": s.ended_at.isoformat() if s.ended_at else None,
        }
    )
