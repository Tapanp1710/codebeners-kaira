from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UUIDPrimaryKey


class PaymentAttempt(UUIDPrimaryKey, Timestamps, Base):
    """A registered intent to pay an invoice or a bill, owned by the server.

    The attempt freezes the Idempotency-Key, the canonical request and its fingerprint before any money
    moves, so any authorised device can see an unresolved payment and retry exactly the same request.

    States (see docs/PAYMENT_ATTEMPTS.md):
        pending   -> succeeded   the payment was recorded (or replayed); payment_id is set
        pending   -> rejected    the backend processed and refused it; nothing was recorded
        pending   -> cancelled   only when the server proves no payment exists under the key
    Terminal states never change. A pending attempt never expires.
    """

    __tablename__ = "payment_attempts"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    resource_type: Mapped[str] = mapped_column(String(20))
    resource_id: Mapped[uuid.UUID]
    idempotency_key: Mapped[str] = mapped_column(String(200))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    request_payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    payment_id: Mapped[uuid.UUID | None]
    failure_code: Mapped[str | None] = mapped_column(String(60))
    failure_message: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("resource_type IN ('invoice', 'bill')", name="resource_type_valid"),
        CheckConstraint("status IN ('pending', 'succeeded', 'rejected', 'cancelled')", name="status_valid"),
        CheckConstraint("(status = 'succeeded') = (payment_id IS NOT NULL)", name="payment_iff_succeeded"),
        UniqueConstraint("business_id", "idempotency_key"),
        # At most one unresolved attempt per invoice/bill: a second device must adopt it, not start another.
        Index(
            "uq_payment_attempts_one_pending",
            "business_id",
            "resource_type",
            "resource_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
        Index("ix_payment_attempts_business_status", "business_id", "status"),
    )
