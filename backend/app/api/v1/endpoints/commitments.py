from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.api.v1 import presenters
from app.db.dependencies import Auth, DbSession
from app.models import Customer, Invoice
from app.schemas.common import Envelope, Page, ok
from app.schemas.core import CommitmentCreate, CommitmentOut, CommitmentUpdate
from app.services import commitment_service

router = APIRouter(prefix="/payment-commitments", tags=["payment-commitments"])


def _out(db, c) -> CommitmentOut:
    name = db.scalar(select(Customer.name).where(Customer.id == c.customer_id))
    number = (
        db.scalar(select(Invoice.invoice_number).where(Invoice.id == c.invoice_id)) if c.invoice_id else None
    )
    return presenters.commitment(c, name, number)


@router.get("", response_model=Envelope[Page[CommitmentOut]])
def list_commitments(
    ctx: Auth,
    db: DbSession,
    status: Literal["pending", "fulfilled", "cancelled", "broken"] | None = None,
    customer_id: uuid.UUID | None = None,
    invoice_id: uuid.UUID | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    rows, total = commitment_service.list_commitments(
        db,
        ctx.business_id,
        status=status,
        customer_id=customer_id,
        invoice_id=invoice_id,
        page=page,
        page_size=page_size,
    )
    return ok(
        Page(
            items=[presenters.commitment(c, n, i) for c, n, i in rows],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


@router.post("", response_model=Envelope[CommitmentOut], status_code=201)
def create_commitment(body: CommitmentCreate, ctx: Auth, db: DbSession):
    c = commitment_service.create_commitment(
        db,
        ctx,
        customer_id=body.customer_id,
        invoice_id=body.invoice_id,
        amount=body.amount,
        expected_payment_date=body.expected_payment_date,
        notes=body.notes,
    )
    db.commit()
    return ok(_out(db, c))


@router.patch("/{commitment_id}", response_model=Envelope[CommitmentOut])
def update_commitment(commitment_id: uuid.UUID, body: CommitmentUpdate, ctx: Auth, db: DbSession):
    c = commitment_service.update_commitment(db, ctx, commitment_id, body.model_dump(exclude_unset=True))
    db.commit()
    return ok(_out(db, c))
