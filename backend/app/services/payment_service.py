"""Customer payments and bill payments. Each payment atomically creates the payment,
its cash transaction and an audit entry. Callers own the transaction (commit)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError, ValidationAppError
from app.models import Bill, BillPayment, CashTransaction, Customer, Invoice, Payment, PaymentCommitment
from app.services import audit_service, idempotency, ledger
from app.utils.dates import business_today
from app.utils.money import ZERO, money_str, q2
from app.utils.serialize import snapshot

PAYMENT_METHODS = ("cash", "upi", "bank_transfer", "cheque", "card", "other")


@dataclass
class PaymentResult:
    payment: Payment
    created: bool  # False when an idempotent replay returned the original payment


def key_reused_error() -> BusinessRuleError:
    return BusinessRuleError(
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used for a payment with different details.",
    )


def payment_by_key(db: Session, business_id: uuid.UUID, key: str) -> Payment | None:
    return db.scalar(
        select(Payment).where(Payment.business_id == business_id, Payment.idempotency_key == key)
    )


def bill_payment_by_key(db: Session, business_id: uuid.UUID, key: str) -> BillPayment | None:
    return db.scalar(
        select(BillPayment).where(BillPayment.business_id == business_id, BillPayment.idempotency_key == key)
    )


def _attempts():
    # payment_attempt_service builds on this module; imported lazily to avoid an import cycle.
    from app.services import payment_attempt_service

    return payment_attempt_service


def check_method(method: str) -> str:
    if method not in PAYMENT_METHODS:
        raise ValidationAppError(
            f"Unsupported payment method '{method}'.", {"allowed": list(PAYMENT_METHODS)}
        )
    return method


def record_customer_payment(
    db: Session,
    actor,
    *,
    invoice_id: uuid.UUID,
    amount: Decimal,
    payment_date: date | None = None,
    payment_method: str = "cash",
    reference: str | None = None,
    notes: str | None = None,
    idempotency_key: str | None = None,
    source_action_id: uuid.UUID | None = None,
    expected_customer_id: uuid.UUID | None = None,
    attempt_guard: bool = True,
) -> PaymentResult:
    """attempt_guard=False only for payment_attempt_service.execute, which already holds the attempt and
    drives its transition. Every other caller is checked against payment attempts (see guard_direct_payment)."""
    amount = q2(amount)
    if amount <= ZERO:
        raise ValidationAppError("Payment amount must be greater than zero.")
    check_method(payment_method)

    # The attempt registered under this key (if any) is locked before the invoice: lock order attempt -> invoice.
    own_attempt = (
        _attempts().lock_for_direct_payment(db, actor.business_id, idempotency_key) if attempt_guard else None
    )
    # Serialise concurrent payments against the same invoice.
    invoice = db.scalar(
        select(Invoice)
        .where(Invoice.id == invoice_id, Invoice.business_id == actor.business_id)
        .with_for_update()
    )
    if invoice is None:
        raise NotFoundError("Invoice not found.")
    if expected_customer_id is not None and invoice.customer_id != expected_customer_id:
        raise BusinessRuleError(
            "INVOICE_CUSTOMER_MISMATCH", "This invoice does not belong to the selected customer."
        )

    # The fingerprint covers every field that affects the operation (app/services/idempotency.py).
    fp = idempotency.fingerprint(
        idempotency.canonical_payment(
            business_id=actor.business_id,
            operation="invoice_payment",
            target_id=invoice.id,
            amount=amount,
            payment_date=payment_date,
            payment_method=payment_method,
            reference=reference,
            notes=notes,
        )
    )

    def replay_or_conflict(existing: Payment) -> PaymentResult:
        if existing.request_fingerprint is not None:
            mismatch = existing.request_fingerprint != fp
        else:
            mismatch = idempotency.legacy_mismatch(
                existing,
                target_matches=existing.invoice_id == invoice.id,
                amount=amount,
                payment_date=payment_date,
                payment_method=payment_method,
                reference=reference,
                notes=notes,
            )
        if mismatch:
            raise key_reused_error()
        return PaymentResult(existing, created=False)

    # The key is looked up before the void / already-paid / overpayment checks, so an exact retry
    # replays even after the original payment cleared the invoice.
    if idempotency_key:
        existing = payment_by_key(db, actor.business_id, idempotency_key)
        if existing is not None:
            result = replay_or_conflict(existing)
            if attempt_guard:
                _attempts().link_direct_payment(db, actor, own_attempt, existing)
            return result

    # Under the invoice lock, so no attempt can be registered, executed or cancelled for it meanwhile.
    if attempt_guard:
        _attempts().guard_direct_payment(
            db,
            business_id=actor.business_id,
            resource_type="invoice",
            resource_id=invoice.id,
            attempt=own_attempt,
            fingerprint=fp,
        )

    if invoice.lifecycle_status == "void":
        raise BusinessRuleError("INVOICE_VOID", "Payments cannot be recorded on a void invoice.")
    business = actor.business
    today = business_today(business.timezone)
    bal = ledger.invoice_balance(db, actor.business_id, invoice.id, today)
    assert bal is not None
    if bal.outstanding <= ZERO:
        raise BusinessRuleError("INVOICE_ALREADY_PAID", "This invoice is already fully paid.")
    if amount > bal.outstanding:
        raise BusinessRuleError(
            "OVERPAYMENT",
            f"Payment of {money_str(amount)} exceeds the outstanding balance of "
            f"{money_str(bal.outstanding)}.",
            {"outstanding": money_str(bal.outstanding), "attempted": money_str(amount)},
        )

    payment = Payment(
        business_id=actor.business_id,
        invoice_id=invoice.id,
        amount=amount,
        payment_date=payment_date or today,
        payment_method=payment_method,
        reference=reference,
        notes=notes,
        idempotency_key=idempotency_key,
        request_fingerprint=fp,
        source_action_id=source_action_id,
    )
    # Savepoint: a concurrent request with the same key on another invoice (different row lock) can win
    # the unique index first. Resolve that as a replay or a conflict instead of a generic 409.
    try:
        with db.begin_nested():
            db.add(payment)
            db.flush()
    except IntegrityError:
        existing = payment_by_key(db, actor.business_id, idempotency_key) if idempotency_key else None
        if existing is None:
            raise
        return replay_or_conflict(existing)
    db.flush()
    customer_name = db.scalar(select(Customer.name).where(Customer.id == invoice.customer_id))
    db.add(
        CashTransaction(
            business_id=actor.business_id,
            transaction_type="customer_payment",
            direction="inflow",
            amount=amount,
            transaction_date=payment.payment_date,
            source_type="payment",
            source_id=payment.id,
            description=f"Payment from {customer_name} for {invoice.invoice_number}",
        )
    )
    new_outstanding = q2(bal.outstanding - amount)
    if new_outstanding == ZERO:
        _close_commitments(db, actor, invoice)
    db.flush()
    after = snapshot(payment)
    after["invoice_outstanding_after"] = money_str(new_outstanding)
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="payment.recorded",
        entity_type="payment",
        entity_id=payment.id,
        before={"invoice_outstanding": money_str(bal.outstanding)},
        after=after,
        source_action_id=source_action_id,
    )
    if attempt_guard:
        _attempts().link_direct_payment(db, actor, own_attempt, payment)
    return PaymentResult(payment, created=True)


def _close_commitments(db: Session, actor, invoice: Invoice) -> None:
    """When an invoice is fully paid its pending commitments are fulfilled."""
    db.execute(
        update(PaymentCommitment)
        .where(
            PaymentCommitment.business_id == actor.business_id,
            PaymentCommitment.invoice_id == invoice.id,
            PaymentCommitment.status == "pending",
        )
        .values(status="fulfilled")
    )


def list_payments(
    db: Session,
    business_id: uuid.UUID,
    *,
    invoice_id: uuid.UUID | None = None,
    customer_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[tuple[Payment, Invoice, str]], int]:
    q = (
        select(Payment, Invoice, Customer.name)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(Customer, Customer.id == Invoice.customer_id)
        .where(Payment.business_id == business_id)
    )
    if invoice_id:
        q = q.where(Payment.invoice_id == invoice_id)
    if customer_id:
        q = q.where(Invoice.customer_id == customer_id)
    if date_from:
        q = q.where(Payment.payment_date >= date_from)
    if date_to:
        q = q.where(Payment.payment_date <= date_to)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.execute(
        q.order_by(Payment.payment_date.desc(), Payment.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return [tuple(r) for r in rows], total


def record_bill_payment(
    db: Session,
    actor,
    *,
    bill_id: uuid.UUID,
    amount: Decimal,
    payment_date: date | None = None,
    payment_method: str = "cash",
    reference: str | None = None,
    idempotency_key: str | None = None,
    source_action_id: uuid.UUID | None = None,
    attempt_guard: bool = True,
) -> tuple[BillPayment, bool]:
    """attempt_guard: see record_customer_payment."""
    amount = q2(amount)
    if amount <= ZERO:
        raise ValidationAppError("Payment amount must be greater than zero.")
    check_method(payment_method)
    own_attempt = (
        _attempts().lock_for_direct_payment(db, actor.business_id, idempotency_key) if attempt_guard else None
    )
    bill = db.scalar(
        select(Bill).where(Bill.id == bill_id, Bill.business_id == actor.business_id).with_for_update()
    )
    if bill is None:
        raise NotFoundError("Bill not found.")
    fp = idempotency.fingerprint(
        idempotency.canonical_payment(
            business_id=actor.business_id,
            operation="bill_payment",
            target_id=bill.id,
            amount=amount,
            payment_date=payment_date,
            payment_method=payment_method,
            reference=reference,
            notes=None,  # bill payments have no notes field
        )
    )

    def replay_or_conflict(existing: BillPayment) -> tuple[BillPayment, bool]:
        if existing.request_fingerprint is not None:
            mismatch = existing.request_fingerprint != fp
        else:
            mismatch = idempotency.legacy_mismatch(
                existing,
                target_matches=existing.bill_id == bill.id,
                amount=amount,
                payment_date=payment_date,
                payment_method=payment_method,
                reference=reference,
                notes=None,
            )
        if mismatch:
            raise key_reused_error()
        return existing, False

    # Key lookup precedes the already-paid / overpayment checks so an exact retry always replays.
    if idempotency_key:
        existing = bill_payment_by_key(db, actor.business_id, idempotency_key)
        if existing is not None:
            result = replay_or_conflict(existing)
            if attempt_guard:
                _attempts().link_direct_payment(db, actor, own_attempt, existing)
            return result
    if attempt_guard:
        _attempts().guard_direct_payment(
            db,
            business_id=actor.business_id,
            resource_type="bill",
            resource_id=bill.id,
            attempt=own_attempt,
            fingerprint=fp,
        )
    today = business_today(actor.business.timezone)
    bal = ledger.bill_balances(db, actor.business_id, today, bill_ids=[bill.id])[0]
    if bal.outstanding <= ZERO:
        raise BusinessRuleError("BILL_ALREADY_PAID", "This bill is already fully paid.")
    if amount > bal.outstanding:
        raise BusinessRuleError(
            "OVERPAYMENT",
            f"Payment of {money_str(amount)} exceeds the remaining payable amount of "
            f"{money_str(bal.outstanding)}.",
            {"outstanding": money_str(bal.outstanding), "attempted": money_str(amount)},
        )
    bp = BillPayment(
        business_id=actor.business_id,
        bill_id=bill.id,
        amount=amount,
        payment_date=payment_date or today,
        payment_method=payment_method,
        reference=reference,
        idempotency_key=idempotency_key,
        request_fingerprint=fp,
    )
    # Savepoint: see record_customer_payment.
    try:
        with db.begin_nested():
            db.add(bp)
            db.flush()
    except IntegrityError:
        existing = bill_payment_by_key(db, actor.business_id, idempotency_key) if idempotency_key else None
        if existing is None:
            raise
        return replay_or_conflict(existing)
    db.add(
        CashTransaction(
            business_id=actor.business_id,
            transaction_type="bill_payment",
            direction="outflow",
            amount=amount,
            transaction_date=bp.payment_date,
            source_type="bill_payment",
            source_id=bp.id,
            description=f"Payment to {bill.vendor_name}",
        )
    )
    db.flush()
    after = snapshot(bp)
    after["bill_outstanding_after"] = money_str(bal.outstanding - amount)
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="bill_payment.recorded",
        entity_type="bill_payment",
        entity_id=bp.id,
        before={"bill_outstanding": money_str(bal.outstanding)},
        after=after,
        source_action_id=source_action_id,
    )
    if attempt_guard:
        _attempts().link_direct_payment(db, actor, own_attempt, bp)
    return bp, True


def record_direct_sale(
    db: Session,
    actor,
    *,
    amount: Decimal,
    sale_date: date | None,
    description: str,
    source_action_id: uuid.UUID,
) -> CashTransaction:
    """A cash sale not tied to an invoice (e.g. a walk-in sale): an actual cash inflow."""
    amount = q2(amount)
    if amount <= ZERO:
        raise ValidationAppError("Sale amount must be greater than zero.")
    txn = CashTransaction(
        business_id=actor.business_id,
        transaction_type="direct_sale",
        direction="inflow",
        amount=amount,
        transaction_date=sale_date or business_today(actor.business.timezone),
        source_type="direct_sale",
        source_id=uuid.uuid4(),
        description=description,
    )
    db.add(txn)
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="sale.recorded",
        entity_type="cash_transaction",
        entity_id=txn.id,
        after=snapshot(txn),
        source_action_id=source_action_id,
    )
    return txn
