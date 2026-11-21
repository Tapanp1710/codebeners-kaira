"""Server-side payment attempts: register, inspect, execute (retry) and safely cancel.

Why: a payment whose response was lost must be recoverable from any authorised device, not only from the
browser that sent it. An attempt freezes the Idempotency-Key and the canonical request *before* money
moves; executing it runs the normal payment path with that key, so a retry either records the payment once
or replays it (app/services/payment_service.py, app/services/idempotency.py).

Guarantees (PostgreSQL-enforced where possible):
- One attempt per (business, Idempotency-Key): unique constraint.
- At most one pending attempt per invoice/bill: partial unique index; a second registration with a
  different request gets 409 PAYMENT_ATTEMPT_PENDING with the existing attempt's id.
- Execution and the pending -> succeeded transition commit in one transaction with the payment, the cash
  transaction and the audit entry. A crash before commit leaves the attempt pending with nothing recorded.
- Concurrent executions of one attempt serialise on its row lock (SELECT ... FOR UPDATE); the second sees
  `succeeded` and returns the original result.
- Cancellation is allowed only for a pending attempt while holding its row lock and the invoice/bill row
  lock, and only when no payment exists under its key. Otherwise the attempt stays recoverable.
- Pending attempts never expire.

Lock order everywhere is attempt row, then invoice/bill row (registration takes only the invoice/bill row).
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.exceptions import AppError, ConflictError, NotFoundError, ValidationAppError
from app.db.base import utcnow
from app.models import Bill, Invoice, PaymentAttempt
from app.schemas.payment_attempts import PaymentAttemptCreate
from app.services import audit_service, idempotency, payment_service
from app.utils.money import ZERO, q2

# Errors from the payment path that mean "processed and refused; nothing was recorded".
DEFINITIVE_STATUS_CODES = (404, 422)


@dataclass
class Registration:
    attempt: PaymentAttempt
    created: bool


@dataclass
class Outcome:
    attempt: PaymentAttempt
    replayed: bool = False
    error: AppError | None = None


def _model(resource_type: str):
    return Invoice if resource_type == "invoice" else Bill


def _lock_resource(db: Session, business_id: uuid.UUID, resource_type: str, resource_id: uuid.UUID):
    model = _model(resource_type)
    row = db.scalar(
        select(model).where(model.id == resource_id, model.business_id == business_id).with_for_update()
    )
    if row is None:
        raise NotFoundError(f"{resource_type.capitalize()} not found.")
    return row


def _canonical(actor, data: PaymentAttemptCreate) -> tuple[dict, str]:
    amount = q2(data.amount)
    if amount <= ZERO:
        raise ValidationAppError("Payment amount must be greater than zero.")
    payment_service.check_method(data.payment_method)
    if data.resource_type == "bill" and idempotency.clean_text(data.notes) is not None:
        raise ValidationAppError("Bill payments do not take notes.")
    canonical = idempotency.canonical_payment(
        business_id=actor.business_id,
        operation="invoice_payment" if data.resource_type == "invoice" else "bill_payment",
        target_id=data.resource_id,
        amount=amount,
        payment_date=data.payment_date,
        payment_method=data.payment_method,
        reference=data.reference,
        notes=data.notes,
    )
    return canonical, idempotency.fingerprint(canonical)


def _recorded_under_key(db: Session, attempt: PaymentAttempt):
    if attempt.resource_type == "invoice":
        return payment_service.payment_by_key(db, attempt.business_id, attempt.idempotency_key)
    return payment_service.bill_payment_by_key(db, attempt.business_id, attempt.idempotency_key)


def _matches(recorded, attempt: PaymentAttempt) -> bool:
    """Does a payment recorded under the attempt's key correspond to the attempt's exact request?"""
    p = attempt.request_payload
    if recorded.request_fingerprint is not None:
        return recorded.request_fingerprint == attempt.request_fingerprint
    target = recorded.invoice_id if attempt.resource_type == "invoice" else recorded.bill_id
    return not idempotency.legacy_mismatch(
        recorded,
        target_matches=target == attempt.resource_id,
        amount=Decimal(p["amount"]),
        payment_date=date.fromisoformat(p["payment_date"]) if p["payment_date"] else None,
        payment_method=p["payment_method"],
        reference=p["reference"],
        notes=p["notes"],
    )


def _audit(db: Session, actor, attempt: PaymentAttempt, action: str, extra: dict | None = None) -> None:
    after = {
        "status": attempt.status,
        "resource_type": attempt.resource_type,
        "resource_id": str(attempt.resource_id),
        "payment_id": str(attempt.payment_id) if attempt.payment_id else None,
        "failure_code": attempt.failure_code,
    }
    after.update(extra or {})
    audit_service.record(
        db,
        business_id=attempt.business_id,
        user_id=actor.user_id,
        action_type=f"payment_attempt.{action}",
        entity_type="payment_attempt",
        entity_id=attempt.id,
        after=after,
    )


def _succeed(attempt: PaymentAttempt, payment_id: uuid.UUID) -> None:
    attempt.status = "succeeded"
    attempt.payment_id = payment_id
    attempt.completed_at = utcnow()


def register(db: Session, actor, data: PaymentAttemptCreate) -> Registration:
    canonical, fp = _canonical(actor, data)
    # Serialises registrations, executions and direct payments for this invoice/bill.
    _lock_resource(db, actor.business_id, data.resource_type, data.resource_id)

    if data.idempotency_key:
        existing = db.scalar(
            select(PaymentAttempt).where(
                PaymentAttempt.business_id == actor.business_id,
                PaymentAttempt.idempotency_key == data.idempotency_key,
            )
        )
        if existing is not None:
            if existing.request_fingerprint != fp:
                raise payment_service.key_reused_error()
            return Registration(existing, created=False)

    pending = db.scalar(
        select(PaymentAttempt).where(
            PaymentAttempt.business_id == actor.business_id,
            PaymentAttempt.resource_type == data.resource_type,
            PaymentAttempt.resource_id == data.resource_id,
            PaymentAttempt.status == "pending",
        )
    )
    if pending is not None:
        # The same intended payment registered again without a key (another device, or a lost
        # registration response): hand back the existing attempt.
        if data.idempotency_key is None and pending.request_fingerprint == fp:
            return Registration(pending, created=False)
        raise ConflictError(
            f"Another payment for this {data.resource_type} is awaiting confirmation. Resolve it first.",
            {"attempt_id": str(pending.id)},
            code="PAYMENT_ATTEMPT_PENDING",
        )

    attempt = PaymentAttempt(
        business_id=actor.business_id,
        resource_type=data.resource_type,
        resource_id=data.resource_id,
        idempotency_key=data.idempotency_key or f"pa_{secrets.token_hex(16)}",
        request_fingerprint=fp,
        request_payload=canonical,
        status="pending",
        created_by=actor.user_id,
    )
    # A client may register a payment it already sent with its own key (for example one saved in the
    # browser before this registry existed). Link it to what was recorded, or refuse a mismatch.
    linked = False
    if data.idempotency_key:
        recorded = _recorded_under_key(db, attempt)
        if recorded is not None:
            if not _matches(recorded, attempt):
                raise payment_service.key_reused_error()
            _succeed(attempt, recorded.id)
            linked = True
    try:
        with db.begin_nested():
            db.add(attempt)
            db.flush()
    except IntegrityError:
        # Same client key registered concurrently for another invoice/bill (different row lock).
        existing = db.scalar(
            select(PaymentAttempt).where(
                PaymentAttempt.business_id == actor.business_id,
                PaymentAttempt.idempotency_key == attempt.idempotency_key,
            )
        )
        if existing is None:
            raise
        if existing.request_fingerprint != fp:
            raise payment_service.key_reused_error() from None
        return Registration(existing, created=False)
    _audit(db, actor, attempt, "registered", {"linked_existing_payment": linked})
    return Registration(attempt, created=True)


def get(db: Session, business_id: uuid.UUID, attempt_id: uuid.UUID, *, lock: bool = False) -> PaymentAttempt:
    q = select(PaymentAttempt).where(
        PaymentAttempt.id == attempt_id, PaymentAttempt.business_id == business_id
    )
    attempt = db.scalar(q.with_for_update() if lock else q)
    if attempt is None:
        raise NotFoundError("Payment attempt not found.")
    return attempt


def list_attempts(
    db: Session,
    business_id: uuid.UUID,
    *,
    status: str | None = None,
    resource_type: str | None = None,
    resource_id: uuid.UUID | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[PaymentAttempt], int]:
    q = select(PaymentAttempt).where(PaymentAttempt.business_id == business_id)
    if status:
        q = q.where(PaymentAttempt.status == status)
    if resource_type:
        q = q.where(PaymentAttempt.resource_type == resource_type)
    if resource_id:
        q = q.where(PaymentAttempt.resource_id == resource_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(
        q.order_by(PaymentAttempt.created_at.desc(), PaymentAttempt.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return list(rows), total


def execute(db: Session, actor, attempt_id: uuid.UUID) -> Outcome:
    """Runs (or re-runs) the frozen request with the attempt's key. Caller commits, then raises `error`."""
    attempt = get(db, actor.business_id, attempt_id, lock=True)
    if attempt.status == "succeeded":
        return Outcome(attempt, replayed=True)
    if attempt.status == "rejected":
        return Outcome(
            attempt,
            error=AppError(attempt.failure_code or "PAYMENT_REJECTED", attempt.failure_message or "", 422),
        )
    if attempt.status == "cancelled":
        raise ConflictError("This payment attempt was cancelled.", code="PAYMENT_ATTEMPT_CANCELLED")

    p = attempt.request_payload
    kwargs = dict(
        amount=Decimal(p["amount"]),
        payment_date=date.fromisoformat(p["payment_date"]) if p["payment_date"] else None,
        payment_method=p["payment_method"],
        reference=p["reference"],
        idempotency_key=attempt.idempotency_key,
    )
    try:
        with db.begin_nested():
            if attempt.resource_type == "invoice":
                res = payment_service.record_customer_payment(
                    db, actor, invoice_id=attempt.resource_id, notes=p["notes"], **kwargs
                )
                payment_id, created = res.payment.id, res.created
            else:
                bp, created = payment_service.record_bill_payment(
                    db, actor, bill_id=attempt.resource_id, **kwargs
                )
                payment_id = bp.id
    except AppError as e:
        if e.status_code not in DEFINITIVE_STATUS_CODES:
            raise
        attempt.status = "rejected"
        attempt.failure_code = e.code
        attempt.failure_message = e.message
        attempt.completed_at = utcnow()
        _audit(db, actor, attempt, "rejected")
        return Outcome(attempt, error=e)
    _succeed(attempt, payment_id)
    _audit(db, actor, attempt, "succeeded", {"replayed": not created})
    return Outcome(attempt, replayed=not created)


def cancel(db: Session, actor, attempt_id: uuid.UUID) -> Outcome:
    """Cancels a pending attempt only when no payment can exist under its key. Caller commits."""
    attempt = get(db, actor.business_id, attempt_id, lock=True)
    if attempt.status == "cancelled":
        return Outcome(attempt)
    if attempt.status != "pending":
        raise ConflictError(
            f"This payment attempt is already {attempt.status}.",
            {"status": attempt.status},
            code="PAYMENT_ATTEMPT_NOT_PENDING",
        )
    # Holding the attempt lock excludes a concurrent execution; the invoice/bill lock waits out any direct
    # payment with the same key that is still in flight.
    _lock_resource(db, actor.business_id, attempt.resource_type, attempt.resource_id)
    recorded = _recorded_under_key(db, attempt)
    if recorded is not None:
        if _matches(recorded, attempt):
            _succeed(attempt, recorded.id)
            _audit(db, actor, attempt, "succeeded", {"reconciled_on_cancel": True})
        return Outcome(
            attempt,
            error=ConflictError(
                "A payment was already recorded for this attempt, so it cannot be cancelled.",
                {"attempt_id": str(attempt.id)},
                code="PAYMENT_ALREADY_RECORDED",
            ),
        )
    attempt.status = "cancelled"
    attempt.completed_at = utcnow()
    _audit(db, actor, attempt, "cancelled")
    return Outcome(attempt)
