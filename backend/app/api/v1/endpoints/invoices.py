from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Header, Query

from app.api.v1 import presenters
from app.db.dependencies import Auth, DbSession
from app.models import Customer
from app.schemas.common import Envelope, Page, ok
from app.schemas.core import (
    InvoiceCreate,
    InvoiceOut,
    InvoiceSummaryOut,
    InvoiceUpdate,
    PaymentCreate,
    PaymentOut,
    PaymentRecordedOut,
)
from app.services import invoice_service, payment_service

router = APIRouter(tags=["invoices", "payments"])

IdempotencyKey = Annotated[
    str | None,
    Header(
        alias="Idempotency-Key",
        max_length=200,
        description="Optional. Retrying with the same key never records a second payment.",
    ),
]


@router.get("/invoices", response_model=Envelope[Page[InvoiceSummaryOut]], tags=["invoices"])
def list_invoices(
    ctx: Auth,
    db: DbSession,
    status: Literal["unpaid", "partially_paid", "paid", "overdue", "open", "void"] | None = None,
    customer_id: uuid.UUID | None = None,
    search: str | None = Query(default=None, max_length=100),
    date_from: date | None = None,
    date_to: date | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    sort: Literal[
        "invoice_date",
        "-invoice_date",
        "due_date",
        "-due_date",
        "total",
        "-total",
        "outstanding",
        "-outstanding",
        "invoice_number",
        "-invoice_number",
        "customer",
        "-customer",
    ] = "-invoice_date",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    items, total = invoice_service.list_invoices(
        db,
        ctx.business,
        status=status,
        customer_id=customer_id,
        search=search,
        date_from=date_from,
        date_to=date_to,
        due_from=due_from,
        due_to=due_to,
        sort=sort,
        page=page,
        page_size=page_size,
    )
    return ok(
        Page(
            items=[presenters.invoice_summary(b) for b in items], total=total, page=page, page_size=page_size
        )
    )


@router.post("/invoices", response_model=Envelope[InvoiceOut], status_code=201, tags=["invoices"])
def create_invoice(body: InvoiceCreate, ctx: Auth, db: DbSession):
    invoice = invoice_service.create_invoice(
        db,
        ctx,
        customer_id=body.customer_id,
        items=[i.model_dump() for i in body.items],
        invoice_date=body.invoice_date,
        due_date=body.due_date,
        notes=body.notes,
    )
    db.commit()
    return ok(presenters.invoice_full(invoice_service.invoice_detail(db, ctx.business, invoice.id)))


@router.get("/invoices/{invoice_id}", response_model=Envelope[InvoiceOut], tags=["invoices"])
def get_invoice(invoice_id: uuid.UUID, ctx: Auth, db: DbSession):
    return ok(presenters.invoice_full(invoice_service.invoice_detail(db, ctx.business, invoice_id)))


@router.patch("/invoices/{invoice_id}", response_model=Envelope[InvoiceOut], tags=["invoices"])
def update_invoice(invoice_id: uuid.UUID, body: InvoiceUpdate, ctx: Auth, db: DbSession):
    changes = body.model_dump(exclude_unset=True)
    if changes.get("items") is not None:
        changes["items"] = [dict(i) for i in changes["items"]]
    for key in ("invoice_date", "due_date"):
        if key in changes and changes[key] is None:
            changes.pop(key)
    invoice_service.update_invoice(db, ctx, invoice_id, changes)
    db.commit()
    return ok(presenters.invoice_full(invoice_service.invoice_detail(db, ctx.business, invoice_id)))


@router.get("/invoices/{invoice_id}/payments", response_model=Envelope[Page[PaymentOut]], tags=["payments"])
def invoice_payments(
    invoice_id: uuid.UUID,
    ctx: Auth,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    invoice_service.get_invoice(db, ctx.business_id, invoice_id)
    rows, total = payment_service.list_payments(
        db, ctx.business_id, invoice_id=invoice_id, page=page, page_size=page_size
    )
    return ok(
        Page(
            items=[presenters.payment(p, i, n) for p, i, n in rows],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


@router.post(
    "/invoices/{invoice_id}/payments",
    response_model=Envelope[PaymentRecordedOut],
    status_code=201,
    tags=["payments"],
    summary="Record a partial or full payment (creates cash inflow + audit atomically)",
)
def record_payment(
    invoice_id: uuid.UUID,
    body: PaymentCreate,
    ctx: Auth,
    db: DbSession,
    idempotency_key: IdempotencyKey = None,
):
    result = payment_service.record_customer_payment(
        db,
        ctx,
        invoice_id=invoice_id,
        amount=body.amount,
        payment_date=body.payment_date,
        payment_method=body.payment_method,
        reference=body.reference,
        notes=body.notes,
        idempotency_key=idempotency_key,
    )
    db.commit()
    detail = invoice_service.invoice_detail(db, ctx.business, invoice_id)
    name = db.get(Customer, detail.invoice.customer_id).name
    return ok(
        PaymentRecordedOut(
            payment=presenters.payment(result.payment, detail.invoice, name),
            invoice=presenters.invoice_summary(detail),
            replayed=not result.created,
        )
    )


@router.get("/payments", response_model=Envelope[Page[PaymentOut]], tags=["payments"])
def list_payments(
    ctx: Auth,
    db: DbSession,
    customer_id: uuid.UUID | None = None,
    invoice_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    rows, total = payment_service.list_payments(
        db,
        ctx.business_id,
        invoice_id=invoice_id,
        customer_id=customer_id,
        date_from=date_from,
        date_to=date_to,
        page=page,
        page_size=page_size,
    )
    return ok(
        Page(
            items=[presenters.payment(p, i, n) for p, i, n in rows],
            total=total,
            page=page,
            page_size=page_size,
        )
    )
