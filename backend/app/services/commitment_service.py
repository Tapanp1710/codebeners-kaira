"""Payment commitments: expected customer payments.

A commitment never creates a receivable; it only changes WHEN part of an existing
outstanding balance is expected. Active (pending) commitments may not exceed the
related outstanding balance - per invoice, and per customer in total."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError
from app.models import Customer, Invoice, PaymentCommitment
from app.services import audit_service, customer_service, ledger
from app.utils.dates import business_today
from app.utils.money import ZERO, money_str, q2
from app.utils.serialize import snapshot

STATUSES = ("pending", "fulfilled", "cancelled", "broken")


def _pending_sum(db: Session, business_id, *, invoice_id=None, customer_id=None, exclude_id=None):
    q = select(func.coalesce(func.sum(PaymentCommitment.amount), 0)).where(
        PaymentCommitment.business_id == business_id, PaymentCommitment.status == "pending"
    )
    if invoice_id is not None:
        q = q.where(PaymentCommitment.invoice_id == invoice_id)
    if customer_id is not None:
        q = q.where(PaymentCommitment.customer_id == customer_id)
    if exclude_id is not None:
        q = q.where(PaymentCommitment.id != exclude_id)
    return q2(db.scalar(q))


def _validate_capacity(
    db: Session,
    actor,
    *,
    customer_id: uuid.UUID,
    invoice_id: uuid.UUID | None,
    amount: Decimal,
    exclude_id: uuid.UUID | None = None,
    pending_outstanding_reduction: Decimal = ZERO,
) -> None:
    today = business_today(actor.business.timezone)
    if invoice_id is not None:
        bal = ledger.invoice_balance(db, actor.business_id, invoice_id, today)
        if bal is None or bal.invoice.customer_id != customer_id:
            raise BusinessRuleError(
                "INVOICE_CUSTOMER_MISMATCH", "This invoice does not belong to the selected customer."
            )
        available = bal.outstanding - pending_outstanding_reduction
        committed = _pending_sum(db, actor.business_id, invoice_id=invoice_id, exclude_id=exclude_id)
        if committed + amount > available:
            raise BusinessRuleError(
                "COMMITMENT_EXCEEDS_OUTSTANDING",
                f"Commitments of {money_str(committed + amount)} would exceed the invoice's "
                f"outstanding balance of {money_str(available)}.",
                {"outstanding": money_str(available), "already_committed": money_str(committed)},
            )
    customer_outstanding = (
        sum(
            (
                b.outstanding
                for b in ledger.invoice_balances(
                    db, actor.business_id, today, customer_id=customer_id, open_only=True
                )
            ),
            ZERO,
        )
        - pending_outstanding_reduction
    )
    committed_all = _pending_sum(db, actor.business_id, customer_id=customer_id, exclude_id=exclude_id)
    if committed_all + amount > customer_outstanding:
        raise BusinessRuleError(
            "COMMITMENT_EXCEEDS_OUTSTANDING",
            f"Commitments of {money_str(committed_all + amount)} would exceed the customer's "
            f"outstanding balance of {money_str(customer_outstanding)}.",
            {
                "outstanding": money_str(customer_outstanding),
                "already_committed": money_str(committed_all),
            },
        )


def create_commitment(
    db: Session,
    actor,
    *,
    customer_id: uuid.UUID,
    invoice_id: uuid.UUID | None,
    amount: Decimal,
    expected_payment_date: date,
    notes: str | None = None,
    source_action_id: uuid.UUID | None = None,
    supersede_existing: bool = False,
) -> PaymentCommitment:
    customer_service.get(db, actor.business_id, customer_id)
    if invoice_id is not None:
        # Lock the invoice so concurrent commitments cannot oversubscribe it.
        locked = db.scalar(
            select(Invoice.id)
            .where(Invoice.id == invoice_id, Invoice.business_id == actor.business_id)
            .with_for_update()
        )
        if locked is None:
            raise NotFoundError("Invoice not found.")
    db.scalar(select(Customer.id).where(Customer.id == customer_id).with_for_update())
    amount = q2(amount)
    if amount <= ZERO:
        raise BusinessRuleError("INVALID_AMOUNT", "Commitment amount must be greater than zero.")
    if supersede_existing:
        _cancel_pending(db, actor, customer_id, invoice_id, source_action_id)
    _validate_capacity(db, actor, customer_id=customer_id, invoice_id=invoice_id, amount=amount)
    commitment = PaymentCommitment(
        business_id=actor.business_id,
        customer_id=customer_id,
        invoice_id=invoice_id,
        amount=amount,
        expected_payment_date=expected_payment_date,
        notes=notes,
        status="pending",
    )
    db.add(commitment)
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="commitment.created",
        entity_type="payment_commitment",
        entity_id=commitment.id,
        after=snapshot(commitment),
        source_action_id=source_action_id,
    )
    return commitment


def _cancel_pending(db: Session, actor, customer_id, invoice_id, source_action_id) -> None:
    """A new promise for the same balance replaces earlier pending promises."""
    q = select(PaymentCommitment).where(
        PaymentCommitment.business_id == actor.business_id,
        PaymentCommitment.customer_id == customer_id,
        PaymentCommitment.status == "pending",
    )
    if invoice_id is not None:
        q = q.where(PaymentCommitment.invoice_id == invoice_id)
    else:
        q = q.where(PaymentCommitment.invoice_id.is_(None))
    for old in db.scalars(q).all():
        before = snapshot(old)
        old.status = "cancelled"
        db.flush()
        audit_service.record(
            db,
            business_id=actor.business_id,
            user_id=actor.user_id,
            action_type="commitment.superseded",
            entity_type="payment_commitment",
            entity_id=old.id,
            before=before,
            after=snapshot(old),
            source_action_id=source_action_id,
        )


def get_commitment(db: Session, business_id, commitment_id) -> PaymentCommitment:
    c = db.scalar(
        select(PaymentCommitment).where(
            PaymentCommitment.id == commitment_id, PaymentCommitment.business_id == business_id
        )
    )
    if c is None:
        raise NotFoundError("Payment commitment not found.")
    return c


def update_commitment(db: Session, actor, commitment_id, changes: dict[str, Any]) -> PaymentCommitment:
    c = get_commitment(db, actor.business_id, commitment_id)
    before = snapshot(c)
    if "status" in changes and changes["status"] is not None:
        if changes["status"] not in STATUSES:
            raise BusinessRuleError("INVALID_STATUS", "Unknown commitment status.")
        c.status = changes["status"]
    if changes.get("amount") is not None:
        c.amount = q2(changes["amount"])
    if changes.get("expected_payment_date") is not None:
        c.expected_payment_date = changes["expected_payment_date"]
    if "notes" in changes:
        c.notes = changes["notes"]
    if c.status == "pending":
        _validate_capacity(
            db,
            actor,
            customer_id=c.customer_id,
            invoice_id=c.invoice_id,
            amount=c.amount,
            exclude_id=c.id,
        )
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="commitment.updated",
        entity_type="payment_commitment",
        entity_id=c.id,
        before=before,
        after=snapshot(c),
    )
    return c


def list_commitments(
    db: Session,
    business_id,
    *,
    status: str | None = None,
    customer_id=None,
    invoice_id=None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[tuple[PaymentCommitment, str, str | None]], int]:
    q = (
        select(PaymentCommitment, Customer.name, Invoice.invoice_number)
        .join(Customer, Customer.id == PaymentCommitment.customer_id)
        .outerjoin(Invoice, Invoice.id == PaymentCommitment.invoice_id)
        .where(PaymentCommitment.business_id == business_id)
    )
    if status:
        q = q.where(PaymentCommitment.status == status)
    if customer_id:
        q = q.where(PaymentCommitment.customer_id == customer_id)
    if invoice_id:
        q = q.where(PaymentCommitment.invoice_id == invoice_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.execute(
        q.order_by(PaymentCommitment.expected_payment_date).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return [tuple(r) for r in rows], total
