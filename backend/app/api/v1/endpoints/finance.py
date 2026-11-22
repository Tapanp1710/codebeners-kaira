from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Query
from sqlalchemy import func, select, text

from app.api.v1 import presenters
from app.db.dependencies import Auth, DbSession
from app.models import ProposedAction
from app.schemas.common import Envelope, Page, ok
from app.schemas.finance import (
    AuditLogOut,
    CashPositionOut,
    DashboardOut,
    ForecastOut,
    ForecastSummaryOut,
    InsightOut,
    ReceivableOut,
    ReceivablesSummaryOut,
    SimulationOut,
    SimulationRequest,
    UpcomingBillOut,
)
from app.services import (
    audit_service,
    forecast_service,
    insights_service,
    ledger,
    payment_service,
    receivables_service,
)
from app.utils.dates import business_today
from app.utils.money import ZERO, q2

router = APIRouter()


# ------------------------------------------------------------------ receivables
@router.get("/receivables", response_model=Envelope[Page[ReceivableOut]], tags=["receivables"])
def list_receivables(
    ctx: Auth,
    db: DbSession,
    customer_id: uuid.UUID | None = None,
    search: str | None = Query(default=None, max_length=100),
    status: Literal["overdue", "current", "partially_paid", "unpaid"] | None = None,
    ageing: Literal["current", "1_30", "31_60", "61_90", "90_plus"] | None = None,
    min_days_overdue: int | None = Query(default=None, ge=0),
    sort: Literal[
        "days_overdue",
        "-days_overdue",
        "outstanding",
        "-outstanding",
        "due_date",
        "-due_date",
        "customer",
        "-customer",
    ] = "-days_overdue",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    rows, total = receivables_service.list_receivables(
        db,
        ctx.business,
        customer_id=customer_id,
        search=search,
        status=status,
        ageing=ageing,
        min_days_overdue=min_days_overdue,
        sort=sort,
        page=page,
        page_size=page_size,
    )
    return ok(
        Page(items=[presenters.receivable(r) for r in rows], total=total, page=page, page_size=page_size)
    )


@router.get("/receivables/summary", response_model=Envelope[ReceivablesSummaryOut], tags=["receivables"])
def receivables_summary(ctx: Auth, db: DbSession):
    return ok(presenters.receivables_summary(receivables_service.summary(db, ctx.business)))


# ------------------------------------------------------------------ cash flow
@router.get("/cashflow/position", response_model=Envelope[CashPositionOut], tags=["cashflow"])
def cash_position(ctx: Auth, db: DbSession):
    return ok(CashPositionOut.model_validate(ledger.cash_position(db, ctx.business)))


@router.get("/cashflow/forecast", response_model=Envelope[ForecastOut], tags=["cashflow"])
def cashflow_forecast(
    ctx: Auth,
    db: DbSession,
    horizon_days: int = Query(default=90, ge=1, le=365),
    granularity: Literal["daily", "weekly"] = "daily",
):
    projection = forecast_service.forecast(db, ctx.business, horizon_days)
    return ok(presenters.forecast(projection, ctx.business.currency, granularity))


@router.post(
    "/cashflow/simulate",
    response_model=Envelope[SimulationOut],
    tags=["cashflow"],
    summary="What-if: delay a customer's or invoice's expected payments (never mutates data)",
)
def cashflow_simulate(body: SimulationRequest, ctx: Auth, db: DbSession):
    business = ctx.business
    currency = business.currency
    # Defence in depth: the simulation runs in a READ ONLY transaction, so even a bug
    # could not write financial records.
    db.rollback()
    db.execute(text("SET TRANSACTION READ ONLY"))
    try:
        business = db.merge(business, load=True)
        result = forecast_service.simulate_delay(
            db,
            business,
            delay_days=body.delay_days,
            customer_id=body.customer_id,
            invoice_id=body.invoice_id,
            largest=body.largest_customer,
            horizon_days=body.horizon_days,
        )
        return ok(presenters.simulation(result, currency))
    finally:
        db.rollback()


# ------------------------------------------------------------------ insights / audit
@router.get("/insights", response_model=Envelope[list[InsightOut]], tags=["insights"])
def insights(ctx: Auth, db: DbSession):
    return ok([InsightOut.model_validate(i) for i in insights_service.generate(db, ctx.business)])


@router.get("/audit-logs", response_model=Envelope[Page[AuditLogOut]], tags=["audit"])
def audit_logs(
    ctx: Auth,
    db: DbSession,
    entity_type: str | None = Query(default=None, max_length=40),
    entity_id: uuid.UUID | None = None,
    source_action_id: uuid.UUID | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    rows, total = audit_service.list_logs(
        db,
        ctx.business_id,
        entity_type=entity_type,
        entity_id=entity_id,
        source_action_id=source_action_id,
        page=page,
        page_size=page_size,
    )
    return ok(
        Page(items=[AuditLogOut.model_validate(r) for r in rows], total=total, page=page, page_size=page_size)
    )


# ------------------------------------------------------------------ dashboard
@router.get("/dashboard", response_model=Envelope[DashboardOut], tags=["dashboard"])
def dashboard(ctx: Auth, db: DbSession):
    business = ctx.business
    today = business_today(business.timezone)
    cash = ledger.cash_position(db, business)
    rec = receivables_service.summary(db, business)
    projection = forecast_service.forecast(db, business, 90)
    horizon = today + timedelta(days=14)
    bills = [
        b for b in ledger.bill_balances(db, business.id, today, open_only=True) if b.bill.due_date <= horizon
    ]
    payments, _ = payment_service.list_payments(db, business.id, page_size=5)
    activity, _ = audit_service.list_logs(db, business.id, page_size=10)
    pending = db.scalar(
        select(func.count()).where(
            ProposedAction.business_id == business.id, ProposedAction.status == "pending"
        )
    )
    return ok(
        DashboardOut(
            as_of=today,
            currency=business.currency,
            cash=CashPositionOut.model_validate(cash),
            receivables=presenters.receivables_summary(rec),
            unpaid_invoice_count=rec.unpaid_invoice_count,
            partially_paid_invoice_count=rec.partially_paid_invoice_count,
            upcoming_bills=[
                UpcomingBillOut(
                    id=b.bill.id,
                    vendor_name=b.bill.vendor_name,
                    description=b.bill.description,
                    due_date=b.bill.due_date,
                    outstanding=b.outstanding,
                    is_overdue=b.is_overdue,
                )
                for b in bills
            ],
            upcoming_bills_total=q2(sum((b.outstanding for b in bills), ZERO)),
            recent_payments=[presenters.payment(p, i, n) for p, i, n in payments],
            forecast=ForecastSummaryOut(
                balance_30_days=projection.milestones.get(30),
                balance_60_days=projection.milestones.get(60),
                balance_90_days=projection.milestones.get(90),
                lowest_balance=projection.lowest_balance,
                lowest_balance_date=projection.lowest_balance_date,
                has_shortfall=bool(projection.shortfalls),
                first_shortfall_date=projection.shortfalls[0].start if projection.shortfalls else None,
            ),
            alerts=[
                InsightOut.model_validate(i)
                for i in insights_service.generate(db, business, projection=projection, receivables=rec)
            ],
            recent_activity=[AuditLogOut.model_validate(a) for a in activity],
            pending_action_count=pending or 0,
        )
    )
