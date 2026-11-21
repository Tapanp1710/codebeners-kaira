"""Schemas for the server-side payment-attempt registry (cross-device payment recovery)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import ApiModel, MoneyIn, MoneyOut
from app.schemas.core import BillPaymentRecordedOut, PaymentMethod, PaymentRecordedOut

ResourceType = Literal["invoice", "bill"]
AttemptStatus = Literal["pending", "succeeded", "rejected", "cancelled"]


class PaymentAttemptCreate(ApiModel):
    resource_type: ResourceType
    resource_id: uuid.UUID
    idempotency_key: str | None = Field(
        default=None,
        min_length=8,
        max_length=200,
        description=(
            "Optional client key. Omit it to let the server generate one. Supply it to register a payment "
            "the client may already have sent with this key (it is then linked to the recorded payment)."
        ),
    )
    amount: MoneyIn
    payment_date: date | None = Field(
        default=None, description="Defaults to the business's today when executed."
    )
    payment_method: PaymentMethod = "cash"
    reference: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=2000, description="Invoice payments only.")


class PaymentAttemptRequest(ApiModel):
    """The frozen request, exactly as it will be (re)sent."""

    amount: MoneyOut
    payment_date: date | None
    payment_method: str
    reference: str | None
    notes: str | None


class PaymentAttemptOut(ApiModel):
    id: uuid.UUID
    resource_type: ResourceType
    resource_id: uuid.UUID
    resource_label: str = Field(description="Invoice number or bill vendor, for lists.")
    status: AttemptStatus
    request: PaymentAttemptRequest
    payment_id: uuid.UUID | None
    failure_code: str | None
    failure_message: str | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None


class PaymentAttemptResult(ApiModel):
    """The confirmed outcome; exactly one of the two payment shapes is set."""

    replayed: bool = Field(
        description="True when the payment had already been recorded under this attempt's key."
    )
    invoice_payment: PaymentRecordedOut | None = None
    bill_payment: BillPaymentRecordedOut | None = None


class PaymentAttemptDetailOut(PaymentAttemptOut):
    result: PaymentAttemptResult | None = Field(default=None, description="Present when status is succeeded.")
