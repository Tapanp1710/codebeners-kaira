from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.exceptions import BusinessRuleError, NotFoundError, ValidationAppError
from app.models import Business, Customer, Invoice, InvoiceItem, Payment
from app.services import audit_service, customer_service, ledger
from app.utils.dates import business_today
from app.utils.money import ZERO, q2
from app.utils.serialize import snapshot

DEFAULT_PAYMENT_TERMS_DAYS = 15


def _invoice_snapshot(invoice: Invoice) -> dict[str, Any]:
    data = snapshot(invoice)
    data["items"] = [snapshot(i) for i in invoice.items]
    return data


def get_invoice(db: Session, business_id: uuid.UUID, invoice_id: uuid.UUID, lock=False) -> Invoice:
    q = select(Invoice).where(Invoice.id == invoice_id, Invoice.business_id == business_id)
    if lock:
        q = q.with_for_update()
    invoice = db.scalar(q.options(selectinload(Invoice.items)))
    if invoice is None:
        raise NotFoundError("Invoice not found.")
    return invoice


def _build_items(items: list[dict[str, Any]]) -> list[InvoiceItem]:
    if not items:
        raise ValidationAppError("An invoice needs at least one item.")
    built = []
    for position, item in enumerate(items):
        quantity = Decimal(item.get("quantity", 1))
        unit_price = q2(item["unit_price"])
        if quantity <= 0 or unit_price < 0:
            raise ValidationAppError("Item quantity must be positive and price non-negative.")
        built.append(
            InvoiceItem(
                position=position,
                description=item["description"],
                quantity=quantity,
                unit_price=unit_price,
                line_total=q2(quantity * unit_price),
            )
        )
    if sum((i.line_total for i in built), ZERO) <= ZERO:
        raise ValidationAppError("Invoice total must be greater than zero.")
    return built


def create_invoice(
    db: Session,
    actor,
    *,
    customer_id: uuid.UUID,
    items: list[dict[str, Any]],
    invoice_date: date | None = None,
    due_date: date | None = None,
    notes: str | None = None,
    source_action_id: uuid.UUID | None = None,
) -> Invoice:
    customer_service.get(db, actor.business_id, customer_id)
    # Lock the business row to allocate a gap-free, unique invoice number.
    business = db.scalar(select(Business).where(Business.id == actor.business_id).with_for_update())
    today = business_today(business.timezone)
    invoice_date = invoice_date or today
    due_date = due_date or invoice_date + timedelta(days=DEFAULT_PAYMENT_TERMS_DAYS)
    if due_date < invoice_date:
        raise ValidationAppError("Due date cannot be before the invoice date.")
    number = f"INV-{business.next_invoice_seq:04d}"
    business.next_invoice_seq += 1
    invoice = Invoice(
        business_id=actor.business_id,
        customer_id=customer_id,
        invoice_number=number,
        invoice_date=invoice_date,
        due_date=due_date,
        notes=notes,
        items=_build_items(items),
    )
    db.add(invoice)
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="invoice.created",
        entity_type="invoice",
        entity_id=invoice.id,
        after=_invoice_snapshot(invoice),
        source_action_id=source_action_id,
    )
    return invoice


def update_invoice(db: Session, actor, invoice_id: uuid.UUID, changes: dict[str, Any]) -> Invoice:
    invoice = get_invoice(db, actor.business_id, invoice_id, lock=True)
    before = _invoice_snapshot(invoice)
    paid = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.invoice_id == invoice.id)
    )
    has_payments = q2(paid) > ZERO
    if invoice.lifecycle_status == "void":
        raise BusinessRuleError("INVOICE_VOID", "A void invoice cannot be changed.")

    if "items" in changes and changes["items"] is not None:
        if has_payments:
            raise BusinessRuleError(
                "INVOICE_HAS_PAYMENTS", "Items cannot be changed after payments are recorded."
            )
        invoice.items.clear()
        db.flush()
        invoice.items.extend(_build_items(changes["items"]))
    for key in ("invoice_date", "due_date", "notes"):
        if key in changes:
            setattr(invoice, key, changes[key])
    if changes.get("lifecycle_status") == "void":
        if has_payments:
            raise BusinessRuleError("INVOICE_HAS_PAYMENTS", "An invoice with payments cannot be voided.")
        invoice.lifecycle_status = "void"
    if invoice.due_date < invoice.invoice_date:
        raise ValidationAppError("Due date cannot be before the invoice date.")
    db.flush()
    audit_service.record(
        db,
        business_id=actor.business_id,
        user_id=actor.user_id,
        action_type="invoice.voided" if invoice.lifecycle_status == "void" else "invoice.updated",
        entity_type="invoice",
        entity_id=invoice.id,
        before=before,
        after=_invoice_snapshot(invoice),
    )
    return invoice


def list_invoices(
    db: Session,
    business,
    *,
    status: str | None = None,
    customer_id: uuid.UUID | None = None,
    search: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    sort: str = "-invoice_date",
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[ledger.InvoiceBalance], int]:
    today = business_today(business.timezone)
    q, total, paid = ledger.invoice_balance_query(business.id)
    if customer_id:
        q = q.where(Invoice.customer_id == customer_id)
    if search:
        pattern = f"%{search.strip()}%"
        q = q.where(or_(Invoice.invoice_number.ilike(pattern), Customer.name.ilike(pattern)))
    if date_from:
        q = q.where(Invoice.invoice_date >= date_from)
    if date_to:
        q = q.where(Invoice.invoice_date <= date_to)
    if due_from:
        q = q.where(Invoice.due_date >= due_from)
    if due_to:
        q = q.where(Invoice.due_date <= due_to)
    issued = Invoice.lifecycle_status == "issued"
    outstanding = total - paid
    if status == "void":
        q = q.where(Invoice.lifecycle_status == "void")
    elif status == "paid":
        q = q.where(issued, outstanding <= 0)
    elif status == "unpaid":
        q = q.where(issued, outstanding > 0, paid == 0)
    elif status == "partially_paid":
        q = q.where(issued, outstanding > 0, paid > 0)
    elif status == "open":
        q = q.where(issued, outstanding > 0)
    elif status == "overdue":
        q = q.where(issued, outstanding > 0, Invoice.due_date < today)

    sort_map = {
        "invoice_date": Invoice.invoice_date,
        "due_date": Invoice.due_date,
        "invoice_number": Invoice.invoice_number,
        "total": total,
        "outstanding": outstanding,
        "customer": Customer.name,
    }
    key = sort.lstrip("-")
    column = sort_map.get(key, Invoice.invoice_date)
    q = q.order_by(column.desc() if sort.startswith("-") else column.asc(), Invoice.id)
    count = db.scalar(select(func.count()).select_from(q.order_by(None).subquery())) or 0
    rows = db.execute(q.offset((page - 1) * page_size).limit(page_size)).all()
    return [ledger.to_invoice_balance(r, today) for r in rows], count


def invoice_detail(db: Session, business, invoice_id: uuid.UUID) -> ledger.InvoiceBalance:
    get_invoice(db, business.id, invoice_id)
    bal = ledger.invoice_balance(db, business.id, invoice_id, business_today(business.timezone))
    assert bal is not None
    return bal
