"""Schemas for AI extraction, proposed actions, assistant queries, reminders and voice."""

from __future__ import annotations

import datetime as dt
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import ApiModel, MoneyOut

Intent = Literal[
    "record_payment",
    "record_sale",
    "create_invoice",
    "create_expense",
    "create_customer",
    "create_payment_commitment",
    "query_receivables",
    "query_customer_balance",
    "query_cash_position",
    "request_payment_reminder",
    "unknown",
]
WRITE_INTENTS = {
    "record_payment",
    "record_sale",
    "create_invoice",
    "create_expense",
    "create_customer",
    "create_payment_commitment",
}
QUERY_INTENTS = {"query_receivables", "query_customer_balance", "query_cash_position"}
LanguageCode = Literal["te-IN", "hi-IN", "en-IN"]
PaymentMethodLit = Literal["cash", "upi", "bank_transfer", "cheque", "card", "other"]


class ExtractedItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    description: str = Field(min_length=1, max_length=500)
    quantity: Decimal = Field(default=Decimal("1"), gt=0, max_digits=12, decimal_places=3)
    unit_price: Decimal = Field(ge=0, max_digits=14, decimal_places=2)


class Operation(BaseModel):
    """One structured business operation. Values are null unless stated in the transcript."""

    model_config = ConfigDict(extra="ignore")

    type: Intent
    customer_name: str | None = Field(default=None, max_length=200)
    customer_id: uuid.UUID | None = None
    invoice_reference: str | None = Field(default=None, max_length=40)
    invoice_id: uuid.UUID | None = None
    vendor_name: str | None = Field(default=None, max_length=200)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    amount_is_remaining: bool = Field(
        default=False, description="True when the speaker says 'the remaining/rest/balance'."
    )
    date: dt.date | None = Field(default=None, description="Payment / sale / invoice / bill date.")
    due_date: dt.date | None = None
    expected_payment_date: dt.date | None = None
    payment_method: PaymentMethodLit | None = None
    description: str | None = Field(default=None, max_length=500)
    category: str | None = Field(default=None, max_length=60)
    items: list[ExtractedItem] | None = None
    paid_now: bool = Field(default=False, description="Expense already paid (cash out now).")
    phone: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=320)
    notes: str | None = Field(default=None, max_length=1000)
    horizon_days: int | None = Field(default=None, ge=1, le=365)
    delay_days: int | None = Field(default=None, ge=1, le=365)
    target: Literal["largest_customer"] | None = None
    evidence: dict[str, str] = Field(
        default_factory=dict, description="field name -> verbatim transcript fragment"
    )

    @field_validator("customer_name", "vendor_name", "invoice_reference", "description", mode="before")
    @classmethod
    def _blank(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v


class ExtractionOutput(BaseModel):
    """Exactly what an extractor (LLM or rules) must return."""

    model_config = ConfigDict(extra="ignore")
    language: str | None = None
    operations: list[Operation] = Field(min_length=1, max_length=5)


# ----------------------------------------------------------------- API models
class ExtractRequest(ApiModel):
    transcript: str = Field(min_length=1, max_length=2000)
    language: LanguageCode | None = None
    input_mode: Literal["text", "voice"] = "text"


class Candidate(ApiModel):
    id: uuid.UUID
    label: str
    score: float
    outstanding: MoneyOut | None = None


class ResolutionOut(ApiModel):
    status: Literal["resolved", "ambiguous", "not_found", "not_applicable", "new"]
    id: uuid.UUID | None = None
    label: str | None = None
    candidates: list[Candidate] = []


class WarningOut(ApiModel):
    code: str
    message: str
    operation_index: int | None = None
    blocking: bool = Field(default=False, description="True when this warning prevents approval.")


class EvidenceOut(ApiModel):
    field: str
    fragment: str
    verified: bool
    operation_index: int


class OperationOut(ApiModel):
    index: int
    type: Intent
    fields: dict[str, Any]
    customer: ResolutionOut
    invoice: ResolutionOut
    missing_fields: list[str]
    computed: dict[str, Any]


class ProposedActionOut(ApiModel):
    id: uuid.UUID
    conversation_id: uuid.UUID | None
    action_type: str
    status: Literal["pending", "executed", "rejected", "failed"]
    source_transcript: str
    language: str | None
    provider: str | None
    confidence_level: Literal["high", "medium", "low"]
    operations: list[OperationOut]
    evidence: list[EvidenceOut]
    warnings: list[WarningOut]
    can_approve: bool
    result: dict[str, Any] | None
    approved_by: uuid.UUID | None
    approved_at: datetime | None
    rejected_at: datetime | None
    executed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ActionUpdate(ApiModel):
    operations: list[Operation] = Field(min_length=1, max_length=5)


class ApprovalOut(ApiModel):
    action: ProposedActionOut
    replayed: bool


class AnswerOut(ApiModel):
    intent: Intent
    language: str
    answer: str
    answer_language: str
    data: dict[str, Any]


class ExtractResponse(ApiModel):
    conversation_id: uuid.UUID
    transcript: str
    language: str | None
    provider: str
    kind: Literal["proposal", "answer", "reminder", "unknown"]
    proposal: ProposedActionOut | None = None
    answer: AnswerOut | None = None
    reminder: ReminderOut | None = None
    message: str | None = None


class QueryRequest(ApiModel):
    question: str = Field(min_length=1, max_length=1000)
    language: LanguageCode | None = None


class ReminderRequest(ApiModel):
    customer_id: uuid.UUID
    invoice_id: uuid.UUID | None = None
    language: LanguageCode = "en-IN"
    tone: Literal["friendly", "firm"] = "friendly"


class ReminderOut(ApiModel):
    customer_id: uuid.UUID
    customer_name: str
    invoice_ids: list[uuid.UUID]
    total_outstanding: MoneyOut
    overdue_amount: MoneyOut
    language: str
    tone: str
    message: str
    generated_by: Literal["template", "template+sarvam_translation"]
    note: str = "Draft only. KAIRA never sends reminders automatically."


ExtractResponse.model_rebuild()


class TranscriptionOut(ApiModel):
    transcript: str
    language_code: str | None
    language_probability: float | None
    provider: Literal["sarvam"] = "sarvam"
    model: str
    request_id: str | None


class SpeakRequest(ApiModel):
    text: str = Field(min_length=1, max_length=2500)
    language_code: LanguageCode = "en-IN"
    speaker: str | None = Field(default=None, max_length=60)
    pace: Decimal | None = Field(default=None, ge=Decimal("0.5"), le=Decimal("2.0"))


class SpeechOut(ApiModel):
    audio_base64: str
    mime_type: str
    codec: str
    sample_rate: int
    model: str
    speaker: str
    language_code: str
    request_id: str | None
