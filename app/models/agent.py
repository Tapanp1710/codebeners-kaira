"""Live voice agent: sessions, conversation messages and tool executions. Raw audio is never stored."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAt, Timestamps, UUIDPrimaryKey


class AgentSession(UUIDPrimaryKey, Timestamps, Base):
    """One enabled live listening session (one WebSocket). Usage is what Sarvam reports, not an estimate."""

    __tablename__ = "agent_sessions"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | ended | failed
    ended_at: Mapped[datetime | None]
    # Billed audio seconds from Sarvam's session.end event (server-authoritative), summed over reconnects.
    stt_audio_seconds: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0"))
    # Audio seconds the browser sent (client-side count, for comparison with the billed figure).
    stt_audio_sent_seconds: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0"))
    tts_characters: Mapped[int] = mapped_column(Integer, default=0)
    llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    provider_errors: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (CheckConstraint("status IN ('active', 'ended', 'failed')", name="status_valid"),)


class AgentMessage(UUIDPrimaryKey, CreatedAt, Base):
    """Conversation history shown in the UI and replayed (trimmed) to the LLM as context."""

    __tablename__ = "agent_messages"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agent_sessions.id", ondelete="SET NULL"))
    turn_id: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str] = mapped_column(String(12))  # user | assistant | tool
    content: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str | None] = mapped_column(String(16))
    input_mode: Mapped[str | None] = mapped_column(String(10))  # voice | text
    # role=tool: {"name", "arguments", "result"}; role=assistant: {"tool_calls": [...]} when it called tools.
    data: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    __table_args__ = (
        CheckConstraint("role IN ('user', 'assistant', 'tool')", name="role_valid"),
        # One user message and one reply per turn: concurrent duplicates of a turn cannot both run.
        UniqueConstraint("business_id", "user_id", "turn_id", "role"),
    )


class AgentToolExecution(UUIDPrimaryKey, Timestamps, Base):
    """One tool call. The idempotency key makes a repeated turn (duplicate final transcript, reconnect,
    lost response) return the stored result instead of executing the operation again."""

    __tablename__ = "agent_tool_executions"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    turn_id: Mapped[str] = mapped_column(String(64), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    tool_name: Mapped[str] = mapped_column(String(60))
    kind: Mapped[str] = mapped_column(String(10))  # read | write
    arguments: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="running")
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    proposed_action_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("proposed_actions.id", ondelete="SET NULL"), index=True
    )
    duration_ms: Mapped[int | None]

    __table_args__ = (
        UniqueConstraint("business_id", "idempotency_key"),
        CheckConstraint(
            "status IN ('running', 'completed', 'failed', 'needs_clarification', 'needs_confirmation')",
            name="status_valid",
        ),
        CheckConstraint("kind IN ('read', 'write')", name="kind_valid"),
    )
