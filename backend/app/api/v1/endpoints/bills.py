from __future__ import annotations

import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Query

from app.api.v1 import presenters
from app.api.v1.endpoints.invoices import IdempotencyKey
from app.db.dependencies import Auth, DbSession
from app.schemas.common import Envelope, Page, ok
from app.schemas.core import (
    BillCreate,
    BillDetailOut,
    BillOut,
    BillPaymentCreate,
    BillPaymentOut,
    BillPaymentRecordedOut,
    BillUpdate,
)
from app.services import bill_service, payment_service

router = APIRouter(prefix="/bills", tags=["bills"])


def _detail(db, ctx, bill_id) -> BillDetailOut:
    bb = bill_service.bill_detail(db, ctx.business, bill_id)
    return BillDetailOut(
        **presenters.bill(bb).model_dump(),
        payments=[
            BillPaymentOut.model_validate(p) for p in bill_service.bill_payments(db, ctx.business_id, bill_id)
        ],
    )


@router.get("", response_model=Envelope[Page[BillOut]])
def list_bills(
    ctx: Auth,
    db: DbSession,
    status: Literal["unpaid", "partially_paid", "paid", "overdue", "open"] | None = None,
    category: str | None = Query(default=None, max_length=60),
    search: str | None = Query(default=None, max_length=100),
    due_from: date | None = None,
    due_to: date | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    items, total = bill_service.list_bills(
        db,
        ctx.business,
        status=status,
        category=category,
        search=search,
        due_from=due_from,
        due_to=due_to,
        page=page,
        page_size=page_size,
    )
    return ok(Page(items=[presenters.bill(b) for b in items], total=total, page=page, page_size=page_size))


@router.post("", response_model=Envelope[BillDetailOut], status_code=201)
def create_bill(body: BillCreate, ctx: Auth, db: DbSession):
    bill = bill_service.create_bill(db, ctx, body.model_dump())
    db.commit()
    return ok(_detail(db, ctx, bill.id))


@router.get("/{bill_id}", response_model=Envelope[BillDetailOut])
def get_bill(bill_id: uuid.UUID, ctx: Auth, db: DbSession):
    return ok(_detail(db, ctx, bill_id))


@router.patch("/{bill_id}", response_model=Envelope[BillDetailOut])
def update_bill(bill_id: uuid.UUID, body: BillUpdate, ctx: Auth, db: DbSession):
    bill_service.update_bill(db, ctx, bill_id, body.model_dump(exclude_unset=True))
    db.commit()
    return ok(_detail(db, ctx, bill_id))


@router.post(
    "/{bill_id}/payments",
    response_model=Envelope[BillPaymentRecordedOut],
    status_code=201,
    summary="Pay a bill fully or partially (creates cash outflow + audit atomically)",
)
def pay_bill(
    bill_id: uuid.UUID,
    body: BillPaymentCreate,
    ctx: Auth,
    db: DbSession,
    idempotency_key: IdempotencyKey = None,
):
    bp, created = payment_service.record_bill_payment(
        db,
        ctx,
        bill_id=bill_id,
        amount=body.amount,
        payment_date=body.payment_date,
        payment_method=body.payment_method,
        reference=body.reference,
        idempotency_key=idempotency_key,
    )
    db.commit()
    return ok(
        BillPaymentRecordedOut(
            payment=BillPaymentOut.model_validate(bp),
            bill=presenters.bill(bill_service.bill_detail(db, ctx.business, bill_id)),
            replayed=not created,
        )
    )
