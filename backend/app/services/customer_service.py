from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.exceptions import NotFoundError
from app.models import Customer, PaymentCommitment
from app.services import audit_service, ledger
from app.utils.dates import business_today
from app.utils.money import ZERO, q2
from app.utils.serialize import snapshot


@dataclass
class CustomerSummary:
    customer: Customer
    total_invoiced: Decimal = ZERO
    total_paid: Decimal = ZERO
    outstanding: Decimal = ZERO
    overdue: Decimal = ZERO
    open_invoice_count: int = 0
    overdue_invoice_count: int = 0
    pending_commitments: Decimal = ZERO
    extra: dict[str, Any] = field(default_factory=dict)


def get(db: Session, business_id: uuid.UUID, customer_id: uuid.UUID) -> Customer:
    customer = db.scalar(
        select(Customer).where(Customer.id == customer_id, Customer.business_id == business_id)
    )
    if customer is None:
        raise NotFoundError("Customer not found.")
    return customer


def create(db: Session, actor, data: dict[str, Any], source_action_id=None) -> Customer:
    customer = Customer(business_id=actor.business_id, **data)
    db.add(customer)
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="customer.created",
        entity_type="customer",
        entity_id=customer.id,
        after=snapshot(customer),
        source_action_id=source_action_id,
    )
    return customer


def update(db: Session, actor, customer_id: uuid.UUID, changes: dict[str, Any]) -> Customer:
    customer = get(db, actor.business_id, customer_id)
    before = snapshot(customer)
    for key, value in changes.items():
        setattr(customer, key, value)
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="customer.updated",
        entity_type="customer",
        entity_id=customer.id,
        before=before,
        after=snapshot(customer),
    )
    return customer


def summaries(db: Session, business, customers: list[Customer]) -> dict[uuid.UUID, CustomerSummary]:
    today = business_today(business.timezone)
    result = {c.id: CustomerSummary(customer=c) for c in customers}
    if not customers:
        return result
    ids = list(result)
    for bal in ledger.invoice_balances(db, business.id, today):
        if bal.invoice.customer_id not in result or bal.payment_status == "void":
            continue
        s = result[bal.invoice.customer_id]
        s.total_invoiced += bal.total
        s.total_paid += bal.paid
        s.outstanding += bal.outstanding
        if bal.outstanding > ZERO:
            s.open_invoice_count += 1
        if bal.is_overdue:
            s.overdue += bal.outstanding
            s.overdue_invoice_count += 1
    rows = db.execute(
        select(PaymentCommitment.customer_id, func.sum(PaymentCommitment.amount))
        .where(
            PaymentCommitment.business_id == business.id,
            PaymentCommitment.status == "pending",
            PaymentCommitment.customer_id.in_(ids),
        )
        .group_by(PaymentCommitment.customer_id)
    ).all()
    for customer_id, amount in rows:
        result[customer_id].pending_commitments = q2(amount)
    return result


def list_customers(
    db: Session,
    business,
    *,
    search: str | None = None,
    with_balance: bool | None = None,
    sort: str = "name",
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[CustomerSummary], int]:
    q = select(Customer).where(Customer.business_id == business.id)
    if search:
        pattern = f"%{search.strip()}%"
        q = q.where(
            or_(
                Customer.name.ilike(pattern),
                Customer.phone.ilike(pattern),
                Customer.email.ilike(pattern),
            )
        )
    customers = list(db.scalars(q.order_by(func.lower(Customer.name))).all())
    sums = summaries(db, business, customers)
    items = [sums[c.id] for c in customers]
    if with_balance is True:
        items = [s for s in items if s.outstanding > ZERO]
    elif with_balance is False:
        items = [s for s in items if s.outstanding <= ZERO]
    if sort == "outstanding":
        items.sort(key=lambda s: s.outstanding, reverse=True)
    elif sort == "overdue":
        items.sort(key=lambda s: s.overdue, reverse=True)
    elif sort == "recent":
        items.sort(key=lambda s: s.customer.created_at, reverse=True)
    total = len(items)
    start = (page - 1) * page_size
    return items[start : start + page_size], total


def summary(db: Session, business, customer_id: uuid.UUID) -> CustomerSummary:
    customer = get(db, business.id, customer_id)
    return summaries(db, business, [customer])[customer.id]


def balances_by_customer(db: Session, business) -> dict[uuid.UUID, Decimal]:
    today = business_today(business.timezone)
    totals: dict[uuid.UUID, Decimal] = defaultdict(lambda: ZERO)
    for bal in ledger.invoice_balances(db, business.id, today, open_only=True):
        totals[bal.invoice.customer_id] += bal.outstanding
    return dict(totals)
