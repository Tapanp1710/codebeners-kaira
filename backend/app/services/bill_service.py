from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError, ValidationAppError
from app.models import Bill, BillPayment
from app.services import audit_service, ledger
from app.utils.dates import business_today
from app.utils.money import money_str, q2
from app.utils.serialize import snapshot


def get_bill(db: Session, business_id: uuid.UUID, bill_id: uuid.UUID) -> Bill:
    bill = db.scalar(select(Bill).where(Bill.id == bill_id, Bill.business_id == business_id))
    if bill is None:
        raise NotFoundError("Bill not found.")
    return bill


def create_bill(db: Session, actor, data: dict[str, Any], source_action_id=None) -> Bill:
    today = business_today(actor.business.timezone)
    bill_date = data.get("bill_date") or today
    due_date = data.get("due_date") or bill_date + timedelta(days=15)
    if due_date < bill_date:
        raise ValidationAppError("Due date cannot be before the bill date.")
    bill = Bill(
        business_id=actor.business_id,
        vendor_name=data["vendor_name"],
        description=data.get("description"),
        category=data.get("category") or "general",
        amount=q2(data["amount"]),
        bill_date=bill_date,
        due_date=due_date,
        notes=data.get("notes"),
    )
    db.add(bill)
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="bill.created",
        entity_type="bill",
        entity_id=bill.id,
        after=snapshot(bill),
        source_action_id=source_action_id,
    )
    return bill


def update_bill(db: Session, actor, bill_id: uuid.UUID, changes: dict[str, Any]) -> Bill:
    bill = db.scalar(
        select(Bill).where(Bill.id == bill_id, Bill.business_id == actor.business_id).with_for_update()
    )
    if bill is None:
        raise NotFoundError("Bill not found.")
    before = snapshot(bill)
    if "amount" in changes and changes["amount"] is not None:
        paid = q2(
            db.scalar(
                select(func.coalesce(func.sum(BillPayment.amount), 0)).where(BillPayment.bill_id == bill.id)
            )
        )
        if q2(changes["amount"]) < paid:
            raise BusinessRuleError(
                "AMOUNT_BELOW_PAID",
                f"Bill amount cannot be less than the {money_str(paid)} already paid.",
            )
        bill.amount = q2(changes["amount"])
    for key in ("vendor_name", "description", "category", "bill_date", "due_date", "notes"):
        if key in changes and changes[key] is not None:
            setattr(bill, key, changes[key])
    if bill.due_date < bill.bill_date:
        raise ValidationAppError("Due date cannot be before the bill date.")
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="bill.updated",
        entity_type="bill",
        entity_id=bill.id,
        before=before,
        after=snapshot(bill),
    )
    return bill


def list_bills(
    db: Session,
    business,
    *,
    status: str | None = None,
    category: str | None = None,
    search: str | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[ledger.BillBalance], int]:
    today = business_today(business.timezone)
    q, paid = ledger.bill_balance_query(business.id)
    outstanding = Bill.amount - paid
    if status == "paid":
        q = q.where(outstanding <= 0)
    elif status == "unpaid":
        q = q.where(outstanding > 0, paid == 0)
    elif status == "partially_paid":
        q = q.where(outstanding > 0, paid > 0)
    elif status == "open":
        q = q.where(outstanding > 0)
    elif status == "overdue":
        q = q.where(outstanding > 0, Bill.due_date < today)
    if category:
        q = q.where(Bill.category == category)
    if search:
        pattern = f"%{search.strip()}%"
        q = q.where(or_(Bill.vendor_name.ilike(pattern), Bill.description.ilike(pattern)))
    if due_from:
        q = q.where(Bill.due_date >= due_from)
    if due_to:
        q = q.where(Bill.due_date <= due_to)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.execute(
        q.order_by(Bill.due_date, Bill.created_at).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return [ledger.to_bill_balance(r, today) for r in rows], total


def bill_detail(db: Session, business, bill_id: uuid.UUID) -> ledger.BillBalance:
    get_bill(db, business.id, bill_id)
    return ledger.bill_balances(db, business.id, business_today(business.timezone), bill_ids=[bill_id])[0]


def bill_payments(db: Session, business_id: uuid.UUID, bill_id: uuid.UUID) -> list[BillPayment]:
    return list(
        db.scalars(
            select(BillPayment)
            .where(BillPayment.business_id == business_id, BillPayment.bill_id == bill_id)
            .order_by(BillPayment.payment_date.desc())
        ).all()
    )
