from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAt, Timestamps, UUIDPrimaryKey


class Conversation(UUIDPrimaryKey, CreatedAt, Base):
    """One owner utterance (typed or transcribed). Raw audio is never stored."""

    __tablename__ = "conversations"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    transcript: Mapped[str] = mapped_column(Text)
    language: Mapped[str | None] = mapped_column(String(16))
    input_mode: Mapped[str] = mapped_column(String(10), default="text")  # text | voice
    provider: Mapped[str | None] = mapped_column(String(40))  # extraction provider used
    processing_status: Mapped[str] = mapped_column(String(20), default="received")


class ProposedAction(UUIDPrimaryKey, Timestamps, Base):
    """An AI-proposed business operation awaiting explicit owner approval."""

    __tablename__ = "proposed_actions"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), index=True
    )
    action_type: Mapped[str] = mapped_column(String(40))
    # {"operations": [...]} - each operation validated by app.schemas.actions.
    extracted_data: Mapped[dict[str, Any]] = mapped_column(JSONB)
    evidence: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    source_transcript: Mapped[str] = mapped_column(Text)
    confidence_level: Mapped[str] = mapped_column(String(10))  # high | medium | low
    warnings: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_at: Mapped[datetime | None]
    rejected_at: Mapped[datetime | None]
    executed_at: Mapped[datetime | None]
    idempotency_key: Mapped[str] = mapped_column(String(64), unique=True)

    __table_args__ = (
        CheckConstraint("status IN ('pending', 'executed', 'rejected', 'failed')", name="status_valid"),
        CheckConstraint("confidence_level IN ('high', 'medium', 'low')", name="confidence_valid"),
    )
