from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAt, Timestamps, UUIDPrimaryKey


class Bill(UUIDPrimaryKey, Timestamps, Base):
    """Money the business owes a vendor. Unpaid bills are NOT cash outflows."""

    __tablename__ = "bills"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    vendor_name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(60), default="general")
    amount: Mapped[Decimal]
    bill_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date, index=True)
    notes: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("due_date >= bill_date", name="due_after_bill"),
    )


class BillPayment(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "bill_payments"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    bill_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bills.id", ondelete="RESTRICT"), index=True)
    amount: Mapped[Decimal]
    payment_date: Mapped[date] = mapped_column(Date)
    payment_method: Mapped[str] = mapped_column(String(30), default="cash")
    reference: Mapped[str | None] = mapped_column(String(200))
    idempotency_key: Mapped[str | None] = mapped_column(String(200))
    # SHA-256 of the canonical request (app/services/idempotency.py); NULL for rows recorded before it existed.
    request_fingerprint: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        UniqueConstraint("business_id", "idempotency_key"),
    )
