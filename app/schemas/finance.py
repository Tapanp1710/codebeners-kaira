"""Schemas for receivables, dashboard, forecast, simulation, insights and audit."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import Field, model_validator

from app.schemas.common import ApiModel, MoneyOut
from app.schemas.core import CommitmentOut, InvoiceSummaryOut, PaymentOut

AgeingBucket = Literal["current", "1_30", "31_60", "61_90", "90_plus"]


class ReceivableOut(InvoiceSummaryOut):
    ageing_bucket: AgeingBucket
    committed_amount: MoneyOut
    commitments: list[CommitmentOut]


class CustomerBalanceOut(ApiModel):
    customer_id: uuid.UUID
    customer_name: str
    outstanding: MoneyOut
    overdue: MoneyOut
    open_invoices: int
    max_days_overdue: int
    pending_commitments: MoneyOut


class ReceivablesSummaryOut(ApiModel):
    total_outstanding: MoneyOut
    total_overdue: MoneyOut
    total_current: MoneyOut
    open_invoice_count: int
    overdue_invoice_count: int
    unpaid_invoice_count: int
    partially_paid_invoice_count: int
    ageing: dict[AgeingBucket, MoneyOut]
    pending_commitments_total: MoneyOut
    commitments_due_next_7_days: MoneyOut
    customers: list[CustomerBalanceOut]


class CashPositionOut(ApiModel):
    opening_cash: MoneyOut
    opening_cash_as_of: date
    total_inflows: MoneyOut
    total_outflows: MoneyOut
    current_cash: MoneyOut


class ForecastPointOut(ApiModel):
    date: date
    inflow: MoneyOut
    outflow: MoneyOut
    balance: MoneyOut


class ForecastEventOut(ApiModel):
    date: date
    original_date: date | None
    direction: Literal["inflow", "outflow"]
    amount: MoneyOut
    kind: Literal[
        "invoice_due", "overdue_assumption", "commitment", "missed_commitment", "bill_due", "overdue_bill"
    ]
    label: str
    source_type: Literal["invoice", "payment_commitment", "bill"]
    source_id: uuid.UUID
    customer_id: uuid.UUID | None
    customer_name: str | None
    invoice_id: uuid.UUID | None
    invoice_number: str | None
    bill_id: uuid.UUID | None


class ShortfallOut(ApiModel):
    start: date
    end: date
    lowest_balance: MoneyOut
    lowest_date: date


class MilestoneOut(ApiModel):
    days: int
    date: date
    balance: MoneyOut


class ForecastOut(ApiModel):
    value_type: Literal["projected"] = "projected"
    as_of: date
    horizon_days: int
    granularity: Literal["daily", "weekly"]
    currency: str
    opening_cash: MoneyOut
    current_cash: MoneyOut
    expected_inflows: MoneyOut
    expected_outflows: MoneyOut
    end_balance: MoneyOut
    balance_30_days: MoneyOut | None
    balance_60_days: MoneyOut | None
    balance_90_days: MoneyOut | None
    milestones: list[MilestoneOut]
    lowest_balance: MoneyOut
    lowest_balance_date: date
    shortfall_threshold: MoneyOut
    shortfalls: list[ShortfallOut]
    warnings: list[str]
    points: list[ForecastPointOut]
    events: list[ForecastEventOut]
    beyond_horizon_inflows: MoneyOut
    beyond_horizon_outflows: MoneyOut
    assumptions: list[str]


class SimulationRequest(ApiModel):
    customer_id: uuid.UUID | None = None
    invoice_id: uuid.UUID | None = None
    largest_customer: bool = Field(
        default=False, description="Delay the customer with the largest outstanding balance."
    )
    delay_days: int = Field(ge=1, le=365)
    horizon_days: int = Field(default=90, ge=1, le=365)

    @model_validator(mode="after")
    def _one_target(self) -> SimulationRequest:
        chosen = sum([self.customer_id is not None, self.invoice_id is not None, self.largest_customer])
        if chosen != 1:
            raise ValueError("Provide exactly one of customer_id, invoice_id or largest_customer=true.")
        return self


class SimulationShiftOut(ApiModel):
    label: str
    amount: MoneyOut
    baseline_date: date
    simulated_date: date
    source_type: str
    source_id: uuid.UUID


class SimulationComparisonOut(ApiModel):
    days: int
    date: date
    baseline_balance: MoneyOut
    simulated_balance: MoneyOut
    difference: MoneyOut


class SimulationPointOut(ApiModel):
    date: date
    baseline_balance: MoneyOut
    simulated_balance: MoneyOut


class SimulationOut(ApiModel):
    value_type: Literal["simulated"] = "simulated"
    is_simulation: Literal[True] = True
    target_type: Literal["customer", "invoice"]
    target_id: uuid.UUID
    target_label: str
    delay_days: int
    horizon_days: int
    currency: str
    current_cash: MoneyOut
    shifted_inflows: list[SimulationShiftOut]
    comparison: list[SimulationComparisonOut]
    baseline_lowest_balance: MoneyOut
    baseline_lowest_balance_date: date
    simulated_lowest_balance: MoneyOut
    simulated_lowest_balance_date: date
    lowest_balance_difference: MoneyOut
    baseline_end_balance: MoneyOut
    simulated_end_balance: MoneyOut
    baseline_shortfalls: list[ShortfallOut]
    simulated_shortfalls: list[ShortfallOut]
    new_shortfall_dates: list[date]
    points: list[SimulationPointOut]
    explanation: str
    assumptions: list[str]


class InsightOut(ApiModel):
    type: str
    severity: Literal["critical", "warning", "info"]
    title: str
    message: str
    related: dict[str, Any]


class AuditLogOut(ApiModel):
    id: uuid.UUID
    user_id: uuid.UUID | None
    action_type: str
    entity_type: str
    entity_id: uuid.UUID | None
    before_data: dict[str, Any] | None
    after_data: dict[str, Any] | None
    source_action_id: uuid.UUID | None
    created_at: datetime


class UpcomingBillOut(ApiModel):
    id: uuid.UUID
    vendor_name: str
    description: str | None
    due_date: date
    outstanding: MoneyOut
    is_overdue: bool


class ForecastSummaryOut(ApiModel):
    balance_30_days: MoneyOut | None
    balance_60_days: MoneyOut | None
    balance_90_days: MoneyOut | None
    lowest_balance: MoneyOut
    lowest_balance_date: date
    has_shortfall: bool
    first_shortfall_date: date | None


class DashboardOut(ApiModel):
    as_of: date
    currency: str
    cash: CashPositionOut
    receivables: ReceivablesSummaryOut
    unpaid_invoice_count: int
    partially_paid_invoice_count: int
    upcoming_bills: list[UpcomingBillOut]
    upcoming_bills_total: MoneyOut
    recent_payments: list[PaymentOut]
    forecast: ForecastSummaryOut
    alerts: list[InsightOut]
    recent_activity: list[AuditLogOut]
    pending_action_count: int
