from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, CreatedAt, Timestamps, UUIDPrimaryKey


class Invoice(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "invoices"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("customers.id", ondelete="RESTRICT"), index=True
    )
    invoice_number: Mapped[str] = mapped_column(String(40))
    invoice_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date, index=True)
    # issued | void. Payment status (unpaid/partially_paid/paid/overdue) is derived.
    lifecycle_status: Mapped[str] = mapped_column(String(20), default="issued")
    notes: Mapped[str | None] = mapped_column(Text)

    items: Mapped[list[InvoiceItem]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan", order_by="InvoiceItem.position"
    )

    __table_args__ = (
        UniqueConstraint("business_id", "invoice_number"),
        CheckConstraint("lifecycle_status IN ('issued', 'void')", name="lifecycle_valid"),
        CheckConstraint("due_date >= invoice_date", name="due_after_invoice"),
    )


class InvoiceItem(UUIDPrimaryKey, Base):
    __tablename__ = "invoice_items"

    invoice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(default=0)
    description: Mapped[str] = mapped_column(String(500))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    unit_price: Mapped[Decimal]
    line_total: Mapped[Decimal]

    invoice: Mapped[Invoice] = relationship(back_populates="items")

    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price >= 0", name="unit_price_nonneg"),
        CheckConstraint("line_total >= 0", name="line_total_nonneg"),
    )


class Payment(UUIDPrimaryKey, CreatedAt, Base):
    __tablename__ = "payments"

    business_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), index=True
    )
    invoice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("invoices.id", ondelete="RESTRICT"), index=True)
    amount: Mapped[Decimal]
    payment_date: Mapped[date] = mapped_column(Date, index=True)
    payment_method: Mapped[str] = mapped_column(String(30), default="cash")
    reference: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str | None] = mapped_column(String(200))
    source_action_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("proposed_actions.id", ondelete="SET NULL")
    )

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        UniqueConstraint("business_id", "idempotency_key"),
    )
