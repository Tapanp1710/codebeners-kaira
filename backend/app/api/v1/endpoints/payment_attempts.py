"""Payment attempts: server-side registry for cross-device payment recovery.

Flow for a client:
  1. POST /payment-attempts            register the intended payment (key + request frozen server-side)
  2. POST /payment-attempts/{id}/execute
       200  succeeded: `result` holds the payment (replayed=true if it had already been recorded)
       422  rejected definitively; nothing was recorded (attempt status is now `rejected`)
       network error / 5xx: outcome unknown -> GET the attempt, or execute again (always safe)
  3. GET  /payment-attempts?status=pending   any device can find unresolved payments and resume them
See docs/PAYMENT_ATTEMPTS.md.
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1 import presenters
from app.db.dependencies import Auth, DbSession, SettingsDep
from app.models import Bill, BillPayment, Customer, Invoice, Payment, PaymentAttempt
from app.schemas.common import Envelope, Page, ok
from app.schemas.core import BillPaymentOut, BillPaymentRecordedOut, PaymentRecordedOut
from app.schemas.payment_attempts import (
    PaymentAttemptCreate,
    PaymentAttemptDetailOut,
    PaymentAttemptOut,
    PaymentAttemptRequest,
    PaymentAttemptResult,
)
from app.services import bill_service, invoice_service, payment_attempt_service

router = APIRouter(prefix="/payment-attempts", tags=["payment-attempts"])


def _limit(request: Request, ctx, settings) -> None:
    # Shared across workers (app/core/rate_limit.py); same per-user budget as action approval.
    request.app.state.rate_limiter.check(f"pay:{ctx.user_id}", settings.RATE_LIMIT_PAYMENT_PER_MINUTE)


def _labels(db: Session, attempts: list[PaymentAttempt]) -> dict[uuid.UUID, str]:
    inv_ids = [a.resource_id for a in attempts if a.resource_type == "invoice"]
    bill_ids = [a.resource_id for a in attempts if a.resource_type == "bill"]
    labels: dict[uuid.UUID, str] = {}
    if inv_ids:
        labels.update(
            {
                i: n
                for i, n in db.execute(
                    select(Invoice.id, Invoice.invoice_number).where(Invoice.id.in_(inv_ids))
                ).all()
            }
        )
    if bill_ids:
        labels.update(
            {
                i: n
                for i, n in db.execute(select(Bill.id, Bill.vendor_name).where(Bill.id.in_(bill_ids))).all()
            }
        )
    return labels


def _out(a: PaymentAttempt, label: str) -> PaymentAttemptOut:
    p = a.request_payload
    return PaymentAttemptOut(
        id=a.id,
        resource_type=a.resource_type,  # type: ignore[arg-type]
        resource_id=a.resource_id,
        resource_label=label,
        status=a.status,  # type: ignore[arg-type]
        request=PaymentAttemptRequest(
            amount=p["amount"],
            payment_date=p["payment_date"],
            payment_method=p["payment_method"],
            reference=p["reference"],
            notes=p["notes"],
        ),
        payment_id=a.payment_id,
        failure_code=a.failure_code,
        failure_message=a.failure_message,
        created_by=a.created_by,
        created_at=a.created_at,
        updated_at=a.updated_at,
        completed_at=a.completed_at,
    )


def _result(db: Session, ctx, a: PaymentAttempt, replayed: bool) -> PaymentAttemptResult | None:
    if a.status != "succeeded" or a.payment_id is None:
        return None
    if a.resource_type == "invoice":
        payment = db.get(Payment, a.payment_id)
        detail = invoice_service.invoice_detail(db, ctx.business, a.resource_id)
        name = db.get(Customer, detail.invoice.customer_id).name
        return PaymentAttemptResult(
            replayed=replayed,
            invoice_payment=PaymentRecordedOut(
                payment=presenters.payment(payment, detail.invoice, name),
                invoice=presenters.invoice_summary(detail),
                replayed=replayed,
            ),
        )
    bp = db.get(BillPayment, a.payment_id)
    return PaymentAttemptResult(
        replayed=replayed,
        bill_payment=BillPaymentRecordedOut(
            payment=BillPaymentOut.model_validate(bp),
            bill=presenters.bill(bill_service.bill_detail(db, ctx.business, a.resource_id)),
            replayed=replayed,
        ),
    )


def _detail(db: Session, ctx, a: PaymentAttempt, replayed: bool = True) -> PaymentAttemptDetailOut:
    label = _labels(db, [a]).get(a.resource_id, "")
    return PaymentAttemptDetailOut(**_out(a, label).model_dump(), result=_result(db, ctx, a, replayed))


@router.post(
    "",
    response_model=Envelope[PaymentAttemptDetailOut],
    status_code=201,
    summary="Register an intended invoice or bill payment (200 when an existing attempt is returned)",
)
def register_attempt(
    body: PaymentAttemptCreate,
    ctx: Auth,
    db: DbSession,
    response: Response,
    request: Request,
    settings: SettingsDep,
):
    _limit(request, ctx, settings)
    reg = payment_attempt_service.register(db, ctx, body)
    db.commit()
    if not reg.created:
        response.status_code = 200
    return ok(_detail(db, ctx, reg.attempt))


@router.get("", response_model=Envelope[Page[PaymentAttemptOut]])
def list_attempts(
    ctx: Auth,
    db: DbSession,
    status: Literal["pending", "succeeded", "rejected", "cancelled"] | None = None,
    resource_type: Literal["invoice", "bill"] | None = None,
    resource_id: uuid.UUID | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    rows, total = payment_attempt_service.list_attempts(
        db,
        ctx.business_id,
        status=status,
        resource_type=resource_type,
        resource_id=resource_id,
        page=page,
        page_size=page_size,
    )
    labels = _labels(db, rows)
    return ok(
        Page(
            items=[_out(a, labels.get(a.resource_id, "")) for a in rows],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


@router.get("/{attempt_id}", response_model=Envelope[PaymentAttemptDetailOut])
def get_attempt(attempt_id: uuid.UUID, ctx: Auth, db: DbSession):
    return ok(_detail(db, ctx, payment_attempt_service.get(db, ctx.business_id, attempt_id)))


@router.post(
    "/{attempt_id}/execute",
    response_model=Envelope[PaymentAttemptDetailOut],
    summary="Execute or safely retry the frozen payment (same key, same request)",
)
def execute_attempt(attempt_id: uuid.UUID, ctx: Auth, db: DbSession, request: Request, settings: SettingsDep):
    _limit(request, ctx, settings)
    outcome = payment_attempt_service.execute(db, ctx, attempt_id)
    # Commit the attempt's new state (with the payment, atomically) before reporting a rejection.
    db.commit()
    if outcome.error is not None:
        raise outcome.error
    return ok(_detail(db, ctx, outcome.attempt, replayed=outcome.replayed))


@router.post(
    "/{attempt_id}/cancel",
    response_model=Envelope[PaymentAttemptDetailOut],
    summary="Cancel a pending attempt; refused (409) if any payment exists under its key",
)
def cancel_attempt(attempt_id: uuid.UUID, ctx: Auth, db: DbSession, request: Request, settings: SettingsDep):
    _limit(request, ctx, settings)
    outcome = payment_attempt_service.cancel(db, ctx, attempt_id)
    db.commit()
    if outcome.error is not None:
        raise outcome.error
    return ok(_detail(db, ctx, outcome.attempt))
