"""Deterministic, data-driven business insights. Every figure comes from the ledger."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Customer, PaymentCommitment
from app.services import forecast_service, ledger, receivables_service
from app.utils.dates import business_today
from app.utils.money import ZERO, money_str, q2

SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}


@dataclass
class Insight:
    type: str
    severity: str  # critical | warning | info
    title: str
    message: str
    related: dict[str, Any] = field(default_factory=dict)


def generate(
    db: Session,
    business,
    *,
    projection: forecast_service.Projection | None = None,
    receivables: receivables_service.ReceivablesSummary | None = None,
) -> list[Insight]:
    cur = business.currency
    today = business_today(business.timezone)
    projection = projection or forecast_service.forecast(db, business, 90)
    receivables = receivables or receivables_service.summary(db, business)
    out: list[Insight] = []

    if projection.shortfalls:
        first = projection.shortfalls[0]
        out.append(
            Insight(
                "cash_shortfall",
                "critical",
                "Projected cash shortfall",
                f"Cash is projected to drop below {money_str(projection.threshold)} {cur} on "
                f"{first.start.isoformat()}, reaching {money_str(first.lowest_balance)} {cur} on "
                f"{first.lowest_date.isoformat()}.",
                {"start": first.start.isoformat(), "lowest_balance": money_str(first.lowest_balance)},
            )
        )

    if receivables.total_overdue > ZERO:
        worst = max(receivables.customers, key=lambda c: c.overdue)
        out.append(
            Insight(
                "overdue_receivables",
                "warning",
                "Overdue payments",
                f"{receivables.overdue_invoice_count} invoice(s) totalling "
                f"{money_str(receivables.total_overdue)} {cur} are overdue. {worst.customer_name} "
                f"owes the most overdue: {money_str(worst.overdue)} {cur} "
                f"(up to {worst.max_days_overdue} days late).",
                {"customer_id": str(worst.customer_id), "overdue": money_str(receivables.total_overdue)},
            )
        )

    if receivables.total_outstanding > ZERO and receivables.customers:
        top = receivables.customers[0]
        share = (top.outstanding / receivables.total_outstanding * 100).quantize(Decimal("1"))
        if share >= 40 and len(receivables.customers) > 1:
            out.append(
                Insight(
                    "customer_concentration",
                    "info",
                    "Receivables concentrated in one customer",
                    f"{top.customer_name} accounts for {share}% of money owed to you "
                    f"({money_str(top.outstanding)} {cur}). A delay from them has an outsized "
                    "effect on cash - try the What-If analysis.",
                    {"customer_id": str(top.customer_id), "share_percent": str(share)},
                )
            )

    missed = db.execute(
        select(PaymentCommitment, Customer.name)
        .join(Customer, Customer.id == PaymentCommitment.customer_id)
        .where(
            PaymentCommitment.business_id == business.id,
            PaymentCommitment.status == "pending",
            PaymentCommitment.expected_payment_date < today,
        )
    ).all()
    for c, name in missed:
        out.append(
            Insight(
                "missed_commitment",
                "warning",
                "Missed payment promise",
                f"{name} promised {money_str(c.amount)} {cur} by "
                f"{c.expected_payment_date.isoformat()} and it has not been recorded.",
                {"commitment_id": str(c.id), "customer_id": str(c.customer_id)},
            )
        )

    if receivables.commitments_due_next_7_days > ZERO:
        out.append(
            Insight(
                "commitments_due",
                "info",
                "Payments promised this week",
                f"Customers have promised {money_str(receivables.commitments_due_next_7_days)} {cur} "
                "within the next 7 days.",
            )
        )

    week = today + timedelta(days=7)
    bills_due = [
        b for b in ledger.bill_balances(db, business.id, today, open_only=True) if b.bill.due_date <= week
    ]
    if bills_due:
        total = q2(sum((b.outstanding for b in bills_due), ZERO))
        cash = projection.current_cash
        severity = "warning" if total > cash else "info"
        out.append(
            Insight(
                "bills_due",
                severity,
                "Bills due soon",
                f"{len(bills_due)} bill(s) totalling {money_str(total)} {cur} are due by "
                f"{week.isoformat()} (current cash {money_str(cash)} {cur}).",
                {"total": money_str(total)},
            )
        )

    if not out:
        out.append(
            Insight(
                "all_clear",
                "info",
                "No urgent issues",
                "No overdue payments, missed promises or projected shortfalls right now.",
            )
        )
    out.sort(key=lambda i: SEVERITY_ORDER[i.severity])
    return out
