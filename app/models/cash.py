from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedAt, UUIDPrimaryKey


class CashTransaction(UUIDPrimaryKey, CreatedAt, Base):
    """An actual movement of cash. Exactly one per source record (no duplicates)."""

    __tablename__ = "cash_transactions"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    # customer_payment | bill_payment | direct_sale | adjustment
    transaction_type: Mapped[str] = mapped_column(String(30))
    direction: Mapped[str] = mapped_column(String(10))  # inflow | outflow
    amount: Mapped[Decimal]
    transaction_date: Mapped[date] = mapped_column(Date, index=True)
    source_type: Mapped[str] = mapped_column(String(30))
    source_id: Mapped[uuid.UUID]
    description: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("direction IN ('inflow', 'outflow')", name="direction_valid"),
        UniqueConstraint("source_type", "source_id"),
    )
