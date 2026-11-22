"""Request/response schemas for auth, business settings, customers, invoices, payments,
bills and commitments."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import EmailStr, Field, field_validator

from app.schemas.common import ApiModel, MoneyIn, MoneyInNonNeg, MoneyOut

PaymentMethod = Literal["cash", "upi", "bank_transfer", "cheque", "card", "other"]
InvoicePaymentStatus = Literal["unpaid", "partially_paid", "paid", "void"]


def _strip(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return v or None


# ---------------------------------------------------------------- auth
class LoginRequest(ApiModel):
    # A plain lookup key: deliverability rules (e.g. reserved .local domains) do not apply.
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+$")
    password: str = Field(min_length=1, max_length=256)


class UserOut(ApiModel):
    id: uuid.UUID
    business_id: uuid.UUID
    name: str
    email: str
    role: Literal["owner", "staff"]
    is_active: bool


class BusinessOut(ApiModel):
    id: uuid.UUID
    name: str
    business_type: str | None
    currency: str
    timezone: str
    opening_cash_balance: MoneyOut
    opening_cash_as_of: date
    overdue_collection_delay_days: int
    low_cash_threshold: MoneyOut
    created_at: datetime
    updated_at: datetime


class SessionOut(ApiModel):
    user: UserOut
    business: BusinessOut
    csrf_token: str = Field(description="Send as X-CSRF-Token on POST/PATCH/PUT/DELETE.")
    access_token_expires_at: datetime


class BusinessSettingsUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    business_type: str | None = Field(default=None, max_length=100)
    timezone: str | None = None
    opening_cash_balance: MoneyInNonNeg | None = None
    opening_cash_as_of: date | None = None
    overdue_collection_delay_days: int | None = Field(default=None, ge=0, le=365)
    low_cash_threshold: MoneyInNonNeg | None = None

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        if v is None:
            return v
        from zoneinfo import ZoneInfo

        try:
            ZoneInfo(v)
        except Exception as exc:
            raise ValueError("Unknown IANA timezone") from exc
        return v


# ---------------------------------------------------------------- customers
class CustomerCreate(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = None
    address: str | None = Field(default=None, max_length=2000)
    notes: str | None = Field(default=None, max_length=4000)

    _clean = field_validator("name", "phone", "address", "notes", mode="before")(
        lambda v: _strip(v) if isinstance(v, str) else v
    )


class CustomerUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = None
    address: str | None = Field(default=None, max_length=2000)
    notes: str | None = Field(default=None, max_length=4000)


class CustomerOut(ApiModel):
    id: uuid.UUID
    name: str
    phone: str | None
    email: str | None
    address: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class CustomerWithBalance(CustomerOut):
    total_invoiced: MoneyOut
    total_paid: MoneyOut
    outstanding: MoneyOut
    overdue: MoneyOut
    open_invoice_count: int
    overdue_invoice_count: int
    pending_commitments: MoneyOut


# ---------------------------------------------------------------- invoices
class InvoiceItemIn(ApiModel):
    description: str = Field(min_length=1, max_length=500)
    quantity: Decimal = Field(default=Decimal("1"), gt=0, max_digits=12, decimal_places=3)
    unit_price: MoneyInNonNeg


class InvoiceItemOut(ApiModel):
    id: uuid.UUID
    description: str
    quantity: Decimal
    unit_price: MoneyOut
    line_total: MoneyOut


class InvoiceCreate(ApiModel):
    customer_id: uuid.UUID
    invoice_date: date | None = Field(default=None, description="Defaults to today.")
    due_date: date | None = Field(default=None, description="Defaults to invoice_date + 15 days.")
    items: list[InvoiceItemIn] = Field(min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=4000)


class InvoiceUpdate(ApiModel):
    invoice_date: date | None = None
    due_date: date | None = None
    notes: str | None = Field(default=None, max_length=4000)
    items: list[InvoiceItemIn] | None = Field(
        default=None, min_length=1, description="Only allowed while no payments exist."
    )
    lifecycle_status: Literal["void"] | None = Field(
        default=None, description="Void an invoice that has no payments."
    )


class InvoiceSummaryOut(ApiModel):
    id: uuid.UUID
    invoice_number: str
    customer_id: uuid.UUID
    customer_name: str
    invoice_date: date
    due_date: date
    lifecycle_status: Literal["issued", "void"]
    payment_status: InvoicePaymentStatus
    is_overdue: bool
    days_overdue: int
    total: MoneyOut
    paid: MoneyOut
    outstanding: MoneyOut
    notes: str | None
    created_at: datetime


class InvoiceOut(InvoiceSummaryOut):
    items: list[InvoiceItemOut]


# ---------------------------------------------------------------- payments
class PaymentCreate(ApiModel):
    amount: MoneyIn
    payment_date: date | None = Field(default=None, description="Defaults to today.")
    payment_method: PaymentMethod = "cash"
    reference: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=2000)


class PaymentOut(ApiModel):
    id: uuid.UUID
    invoice_id: uuid.UUID
    invoice_number: str
    customer_id: uuid.UUID
    customer_name: str
    amount: MoneyOut
    payment_date: date
    payment_method: str
    reference: str | None
    notes: str | None
    source_action_id: uuid.UUID | None
    created_at: datetime


class PaymentRecordedOut(ApiModel):
    payment: PaymentOut
    invoice: InvoiceSummaryOut
    replayed: bool = Field(description="True when an Idempotency-Key replay returned the original.")


# ---------------------------------------------------------------- bills
class BillCreate(ApiModel):
    vendor_name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    category: str = Field(default="general", min_length=1, max_length=60)
    amount: MoneyIn
    bill_date: date | None = None
    due_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)


class BillUpdate(ApiModel):
    vendor_name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = Field(default=None, min_length=1, max_length=60)
    amount: MoneyIn | None = None
    bill_date: date | None = None
    due_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)


class BillPaymentCreate(ApiModel):
    amount: MoneyIn
    payment_date: date | None = None
    payment_method: PaymentMethod = "cash"
    reference: str | None = Field(default=None, max_length=200)


class BillPaymentOut(ApiModel):
    id: uuid.UUID
    bill_id: uuid.UUID
    amount: MoneyOut
    payment_date: date
    payment_method: str
    reference: str | None
    created_at: datetime


class BillOut(ApiModel):
    id: uuid.UUID
    vendor_name: str
    description: str | None
    category: str
    amount: MoneyOut
    paid: MoneyOut
    outstanding: MoneyOut
    payment_status: Literal["unpaid", "partially_paid", "paid"]
    is_overdue: bool
    days_overdue: int
    bill_date: date
    due_date: date
    notes: str | None
    created_at: datetime
    updated_at: datetime


class BillDetailOut(BillOut):
    payments: list[BillPaymentOut]


class BillPaymentRecordedOut(ApiModel):
    payment: BillPaymentOut
    bill: BillOut
    replayed: bool


# ---------------------------------------------------------------- commitments
class CommitmentCreate(ApiModel):
    customer_id: uuid.UUID
    invoice_id: uuid.UUID | None = None
    amount: MoneyIn
    expected_payment_date: date
    notes: str | None = Field(default=None, max_length=2000)


class CommitmentUpdate(ApiModel):
    amount: MoneyIn | None = None
    expected_payment_date: date | None = None
    status: Literal["pending", "fulfilled", "cancelled", "broken"] | None = None
    notes: str | None = Field(default=None, max_length=2000)


class CommitmentOut(ApiModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    customer_name: str
    invoice_id: uuid.UUID | None
    invoice_number: str | None
    amount: MoneyOut
    expected_payment_date: date
    status: Literal["pending", "fulfilled", "cancelled", "broken"]
    notes: str | None
    created_at: datetime
    updated_at: datetime


class CustomerDetailOut(CustomerWithBalance):
    commitments: list[CommitmentOut]
