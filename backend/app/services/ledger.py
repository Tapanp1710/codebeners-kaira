"""Derived balances. Outstanding amounts are ALWAYS computed, never stored:

invoice outstanding = sum(invoice_items.line_total) - sum(payments.amount)
bill outstanding    = bills.amount - sum(bill_payments.amount)
current cash        = opening_cash_balance + inflows - outflows
                      (cash transactions dated on/after opening_cash_as_of)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import Select, and_, func, select
from sqlalchemy.orm import Session

from app.models import (
    Bill,
    BillPayment,
    Business,
    CashTransaction,
    Customer,
    Invoice,
    InvoiceItem,
    Payment,
)
from app.utils.money import ZERO, q2


@dataclass
class InvoiceBalance:
    invoice: Invoice
    customer_name: str
    total: Decimal
    paid: Decimal
    outstanding: Decimal
    payment_status: str  # unpaid | partially_paid | paid | void
    is_overdue: bool
    days_overdue: int


@dataclass
class BillBalance:
    bill: Bill
    paid: Decimal
    outstanding: Decimal
    payment_status: str  # unpaid | partially_paid | paid
    is_overdue: bool
    days_overdue: int


def _derive_status(lifecycle: str, total: Decimal, paid: Decimal, outstanding: Decimal) -> str:
    if lifecycle == "void":
        return "void"
    if outstanding <= ZERO:
        return "paid"
    if paid > ZERO:
        return "partially_paid"
    return "unpaid"


def invoice_balance_query(business_id: uuid.UUID) -> Select:
    items_sq = (
        select(InvoiceItem.invoice_id, func.sum(InvoiceItem.line_total).label("total"))
        .group_by(InvoiceItem.invoice_id)
        .subquery()
    )
    paid_sq = (
        select(Payment.invoice_id, func.sum(Payment.amount).label("paid"))
        .where(Payment.business_id == business_id)
        .group_by(Payment.invoice_id)
        .subquery()
    )
    total = func.coalesce(items_sq.c.total, 0)
    paid = func.coalesce(paid_sq.c.paid, 0)
    return (
        (
            select(Invoice, Customer.name, total.label("total"), paid.label("paid"))
            .join(Customer, and_(Customer.id == Invoice.customer_id, Customer.business_id == business_id))
            .outerjoin(items_sq, items_sq.c.invoice_id == Invoice.id)
            .outerjoin(paid_sq, paid_sq.c.invoice_id == Invoice.id)
            .where(Invoice.business_id == business_id)
        ),
        total,
        paid,
    )


def to_invoice_balance(row, today: date) -> InvoiceBalance:
    invoice, customer_name, total, paid = row
    total, paid = q2(total), q2(paid)
    outstanding = q2(total - paid) if invoice.lifecycle_status != "void" else ZERO
    is_overdue = outstanding > ZERO and invoice.due_date < today
    return InvoiceBalance(
        invoice=invoice,
        customer_name=customer_name,
        total=total,
        paid=paid,
        outstanding=outstanding,
        payment_status=_derive_status(invoice.lifecycle_status, total, paid, outstanding),
        is_overdue=is_overdue,
        days_overdue=(today - invoice.due_date).days if is_overdue else 0,
    )


def invoice_balances(
    db: Session,
    business_id: uuid.UUID,
    today: date,
    *,
    invoice_ids: list[uuid.UUID] | None = None,
    customer_id: uuid.UUID | None = None,
    open_only: bool = False,
) -> list[InvoiceBalance]:
    q, total, paid = invoice_balance_query(business_id)
    if invoice_ids is not None:
        q = q.where(Invoice.id.in_(invoice_ids))
    if customer_id is not None:
        q = q.where(Invoice.customer_id == customer_id)
    if open_only:
        q = q.where(Invoice.lifecycle_status == "issued", total - paid > 0)
    q = q.order_by(Invoice.due_date, Invoice.invoice_number)
    return [to_invoice_balance(row, today) for row in db.execute(q).all()]


def invoice_balance(
    db: Session, business_id: uuid.UUID, invoice_id: uuid.UUID, today: date
) -> InvoiceBalance | None:
    rows = invoice_balances(db, business_id, today, invoice_ids=[invoice_id])
    return rows[0] if rows else None


def bill_balance_query(business_id: uuid.UUID) -> tuple[Select, object]:
    paid_sq = (
        select(BillPayment.bill_id, func.sum(BillPayment.amount).label("paid"))
        .where(BillPayment.business_id == business_id)
        .group_by(BillPayment.bill_id)
        .subquery()
    )
    paid = func.coalesce(paid_sq.c.paid, 0)
    q = (
        select(Bill, paid.label("paid"))
        .outerjoin(paid_sq, paid_sq.c.bill_id == Bill.id)
        .where(Bill.business_id == business_id)
    )
    return q, paid


def to_bill_balance(row, today: date) -> BillBalance:
    bill, paid = row
    paid = q2(paid)
    outstanding = q2(bill.amount - paid)
    is_overdue = outstanding > ZERO and bill.due_date < today
    status = "paid" if outstanding <= ZERO else ("partially_paid" if paid > ZERO else "unpaid")
    return BillBalance(
        bill=bill,
        paid=paid,
        outstanding=outstanding,
        payment_status=status,
        is_overdue=is_overdue,
        days_overdue=(today - bill.due_date).days if is_overdue else 0,
    )


def bill_balances(
    db: Session,
    business_id: uuid.UUID,
    today: date,
    *,
    bill_ids: list[uuid.UUID] | None = None,
    open_only: bool = False,
) -> list[BillBalance]:
    q, paid = bill_balance_query(business_id)
    if bill_ids is not None:
        q = q.where(Bill.id.in_(bill_ids))
    if open_only:
        q = q.where(Bill.amount - paid > 0)
    q = q.order_by(Bill.due_date, Bill.created_at)
    return [to_bill_balance(row, today) for row in db.execute(q).all()]


@dataclass
class CashPosition:
    opening_cash: Decimal
    opening_cash_as_of: date
    total_inflows: Decimal
    total_outflows: Decimal
    current_cash: Decimal


def cash_position(db: Session, business: Business) -> CashPosition:
    """Current cash = opening balance + actual movements dated on/after the opening date.

    Movements dated before opening_cash_as_of are treated as already reflected in the
    opening balance (historical data entry) and are excluded."""
    rows = db.execute(
        select(CashTransaction.direction, func.coalesce(func.sum(CashTransaction.amount), 0))
        .where(
            CashTransaction.business_id == business.id,
            CashTransaction.transaction_date >= business.opening_cash_as_of,
        )
        .group_by(CashTransaction.direction)
    ).all()
    sums = {direction: q2(amount) for direction, amount in rows}
    inflows = sums.get("inflow", ZERO)
    outflows = sums.get("outflow", ZERO)
    opening = q2(business.opening_cash_balance)
    return CashPosition(
        opening_cash=opening,
        opening_cash_as_of=business.opening_cash_as_of,
        total_inflows=inflows,
        total_outflows=outflows,
        current_cash=q2(opening + inflows - outflows),
    )
