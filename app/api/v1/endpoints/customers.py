from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Query

from app.api.v1 import presenters
from app.db.dependencies import Auth, DbSession
from app.schemas.common import Envelope, Page, ok
from app.schemas.core import (
    CustomerCreate,
    CustomerDetailOut,
    CustomerUpdate,
    CustomerWithBalance,
    InvoiceSummaryOut,
    PaymentOut,
)
from app.services import commitment_service, customer_service, invoice_service, payment_service

router = APIRouter(prefix="/customers", tags=["customers"])


def _detail(db, ctx, customer_id) -> CustomerDetailOut:
    cs = customer_service.summary(db, ctx.business, customer_id)
    rows, _ = commitment_service.list_commitments(db, ctx.business_id, customer_id=customer_id, page_size=200)
    return CustomerDetailOut(
        **presenters.customer_with_balance(cs).model_dump(),
        commitments=[presenters.commitment(c, n, i) for c, n, i in rows],
    )


@router.get("", response_model=Envelope[Page[CustomerWithBalance]])
def list_customers(
    ctx: Auth,
    db: DbSession,
    search: str | None = Query(default=None, max_length=100),
    with_balance: bool | None = Query(default=None, description="true = owes money"),
    sort: Literal["name", "outstanding", "overdue", "recent"] = "name",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    items, total = customer_service.list_customers(
        db,
        ctx.business,
        search=search,
        with_balance=with_balance,
        sort=sort,
        page=page,
        page_size=page_size,
    )
    return ok(
        Page(
            items=[presenters.customer_with_balance(i) for i in items],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


@router.post("", response_model=Envelope[CustomerDetailOut], status_code=201)
def create_customer(body: CustomerCreate, ctx: Auth, db: DbSession):
    customer = customer_service.create(db, ctx, body.model_dump())
    db.commit()
    return ok(_detail(db, ctx, customer.id))


@router.get("/{customer_id}", response_model=Envelope[CustomerDetailOut])
def get_customer(customer_id: uuid.UUID, ctx: Auth, db: DbSession):
    return ok(_detail(db, ctx, customer_id))


@router.patch("/{customer_id}", response_model=Envelope[CustomerDetailOut])
def update_customer(customer_id: uuid.UUID, body: CustomerUpdate, ctx: Auth, db: DbSession):
    changes = body.model_dump(exclude_unset=True)
    if "name" in changes and changes["name"] is None:
        changes.pop("name")
    customer_service.update(db, ctx, customer_id, changes)
    db.commit()
    return ok(_detail(db, ctx, customer_id))


@router.get("/{customer_id}/invoices", response_model=Envelope[Page[InvoiceSummaryOut]])
def customer_invoices(
    customer_id: uuid.UUID,
    ctx: Auth,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    customer_service.get(db, ctx.business_id, customer_id)
    items, total = invoice_service.list_invoices(
        db, ctx.business, customer_id=customer_id, page=page, page_size=page_size
    )
    return ok(
        Page(
            items=[presenters.invoice_summary(b) for b in items], total=total, page=page, page_size=page_size
        )
    )


@router.get("/{customer_id}/payments", response_model=Envelope[Page[PaymentOut]])
def customer_payments(
    customer_id: uuid.UUID,
    ctx: Auth,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    customer_service.get(db, ctx.business_id, customer_id)
    rows, total = payment_service.list_payments(
        db, ctx.business_id, customer_id=customer_id, page=page, page_size=page_size
    )
    return ok(
        Page(
            items=[presenters.payment(p, i, n) for p, i, n in rows],
            total=total,
            page=page,
            page_size=page_size,
        )
    )
