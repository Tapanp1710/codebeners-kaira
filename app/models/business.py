from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, Date, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAt, Timestamps, UUIDPrimaryKey


class Business(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "businesses"

    name: Mapped[str] = mapped_column(String(200))
    business_type: Mapped[str | None] = mapped_column(String(100))
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata")
    opening_cash_balance: Mapped[Decimal] = mapped_column(default=Decimal("0.00"))
    opening_cash_as_of: Mapped[date] = mapped_column(Date)
    # Forecast assumption: overdue invoices with no commitment are expected this many
    # days after today.
    overdue_collection_delay_days: Mapped[int] = mapped_column(Integer, default=30)
    # Projected balances below this threshold raise a shortfall warning.
    low_cash_threshold: Mapped[Decimal] = mapped_column(default=Decimal("0.00"))
    # Sequence used to generate per-business invoice numbers (INV-0001 ...).
    next_invoice_seq: Mapped[int] = mapped_column(Integer, default=1)

    __table_args__ = (
        CheckConstraint("overdue_collection_delay_days >= 0", name="overdue_delay_nonneg"),
        CheckConstraint("next_invoice_seq >= 1", name="invoice_seq_positive"),
    )


class User(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "users"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(20), default="owner")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (CheckConstraint("role IN ('owner', 'staff')", name="role_valid"),)


class RefreshToken(UUIDPrimaryKey, CreatedAt, Base):
    """Server-side record of issued refresh tokens so they can be rotated and revoked."""

    __tablename__ = "refresh_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
