from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PaymentCommitment
from app.services import ledger
from app.utils.dates import business_today
from app.utils.money import ZERO, q2

AGEING_BUCKETS = (
    ("current", None, 0),
    ("1_30", 1, 30),
    ("31_60", 31, 60),
    ("61_90", 61, 90),
    ("90_plus", 91, None),
)


def ageing_bucket(days_overdue: int) -> str:
    for name, low, high in AGEING_BUCKETS:
        if (low is None or days_overdue >= low) and (high is None or days_overdue <= high):
            return name
    return "90_plus"


@dataclass
class ReceivableRow:
    balance: ledger.InvoiceBalance
    ageing_bucket: str
    pending_commitments: list[PaymentCommitment] = field(default_factory=list)

    @property
    def committed_amount(self) -> Decimal:
        return q2(sum((c.amount for c in self.pending_commitments), ZERO))


def _commitments_by_invoice(db: Session, business_id) -> dict[uuid.UUID, list[PaymentCommitment]]:
    out: dict[uuid.UUID, list[PaymentCommitment]] = defaultdict(list)
    for c in db.scalars(
        select(PaymentCommitment)
        .where(
            PaymentCommitment.business_id == business_id,
            PaymentCommitment.status == "pending",
            PaymentCommitment.invoice_id.is_not(None),
        )
        .order_by(PaymentCommitment.expected_payment_date)
    ):
        out[c.invoice_id].append(c)
    return out


def list_receivables(
    db: Session,
    business,
    *,
    customer_id: uuid.UUID | None = None,
    search: str | None = None,
    status: str | None = None,  # overdue | current | partially_paid | unpaid
    ageing: str | None = None,
    min_days_overdue: int | None = None,
    sort: str = "-days_overdue",
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[ReceivableRow], int]:
    today = business_today(business.timezone)
    balances = ledger.invoice_balances(db, business.id, today, customer_id=customer_id, open_only=True)
    commitments = _commitments_by_invoice(db, business.id)
    rows = [
        ReceivableRow(b, ageing_bucket(b.days_overdue), commitments.get(b.invoice.id, [])) for b in balances
    ]
    if search:
        s = search.strip().lower()
        rows = [
            r
            for r in rows
            if s in r.balance.customer_name.lower() or s in r.balance.invoice.invoice_number.lower()
        ]
    if status == "overdue":
        rows = [r for r in rows if r.balance.is_overdue]
    elif status == "current":
        rows = [r for r in rows if not r.balance.is_overdue]
    elif status in ("partially_paid", "unpaid"):
        rows = [r for r in rows if r.balance.payment_status == status]
    if ageing:
        rows = [r for r in rows if r.ageing_bucket == ageing]
    if min_days_overdue is not None:
        rows = [r for r in rows if r.balance.days_overdue >= min_days_overdue]
    keys = {
        "days_overdue": lambda r: r.balance.days_overdue,
        "outstanding": lambda r: r.balance.outstanding,
        "due_date": lambda r: r.balance.invoice.due_date,
        "customer": lambda r: r.balance.customer_name.lower(),
    }
    key = keys.get(sort.lstrip("-"), keys["days_overdue"])
    rows.sort(key=key, reverse=sort.startswith("-"))
    total = len(rows)
    start = (page - 1) * page_size
    return rows[start : start + page_size], total


@dataclass
class CustomerBalance:
    customer_id: uuid.UUID
    customer_name: str
    outstanding: Decimal
    overdue: Decimal
    open_invoices: int
    max_days_overdue: int
    pending_commitments: Decimal


@dataclass
class ReceivablesSummary:
    total_outstanding: Decimal
    total_overdue: Decimal
    total_current: Decimal
    open_invoice_count: int
    overdue_invoice_count: int
    unpaid_invoice_count: int
    partially_paid_invoice_count: int
    ageing: dict[str, Decimal]
    pending_commitments_total: Decimal
    commitments_due_next_7_days: Decimal
    customers: list[CustomerBalance]


def summary(db: Session, business) -> ReceivablesSummary:
    today = business_today(business.timezone)
    balances = ledger.invoice_balances(db, business.id, today, open_only=True)
    ageing = {name: ZERO for name, _, _ in AGEING_BUCKETS}
    per_customer: dict[uuid.UUID, CustomerBalance] = {}
    for b in balances:
        ageing[ageing_bucket(b.days_overdue)] += b.outstanding
        cb = per_customer.setdefault(
            b.invoice.customer_id,
            CustomerBalance(b.invoice.customer_id, b.customer_name, ZERO, ZERO, 0, 0, ZERO),
        )
        cb.outstanding += b.outstanding
        cb.open_invoices += 1
        if b.is_overdue:
            cb.overdue += b.outstanding
            cb.max_days_overdue = max(cb.max_days_overdue, b.days_overdue)

    pending = db.scalars(
        select(PaymentCommitment).where(
            PaymentCommitment.business_id == business.id, PaymentCommitment.status == "pending"
        )
    ).all()
    week = today + timedelta(days=7)
    for c in pending:
        if c.customer_id in per_customer:
            per_customer[c.customer_id].pending_commitments += c.amount

    total = q2(sum((b.outstanding for b in balances), ZERO))
    overdue = q2(sum((b.outstanding for b in balances if b.is_overdue), ZERO))
    return ReceivablesSummary(
        total_outstanding=total,
        total_overdue=overdue,
        total_current=q2(total - overdue),
        open_invoice_count=len(balances),
        overdue_invoice_count=sum(1 for b in balances if b.is_overdue),
        unpaid_invoice_count=sum(1 for b in balances if b.payment_status == "unpaid"),
        partially_paid_invoice_count=sum(1 for b in balances if b.payment_status == "partially_paid"),
        ageing={k: q2(v) for k, v in ageing.items()},
        pending_commitments_total=q2(sum((c.amount for c in pending), ZERO)),
        commitments_due_next_7_days=q2(
            sum((c.amount for c in pending if today <= c.expected_payment_date <= week), ZERO)
        ),
        customers=sorted(per_customer.values(), key=lambda c: c.outstanding, reverse=True),
    )
