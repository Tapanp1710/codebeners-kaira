"""Convert service results into API response models."""

from __future__ import annotations

from app.schemas import core as s
from app.schemas import finance as f
from app.services import forecast_service, ledger, receivables_service
from app.services.customer_service import CustomerSummary
from app.utils.money import ZERO, money_str


def invoice_summary(b: ledger.InvoiceBalance) -> s.InvoiceSummaryOut:
    inv = b.invoice
    return s.InvoiceSummaryOut(
        id=inv.id,
        invoice_number=inv.invoice_number,
        customer_id=inv.customer_id,
        customer_name=b.customer_name,
        invoice_date=inv.invoice_date,
        due_date=inv.due_date,
        lifecycle_status=inv.lifecycle_status,
        payment_status=b.payment_status,
        is_overdue=b.is_overdue,
        days_overdue=b.days_overdue,
        total=b.total,
        paid=b.paid,
        outstanding=b.outstanding,
        notes=inv.notes,
        created_at=inv.created_at,
    )


def invoice_full(b: ledger.InvoiceBalance) -> s.InvoiceOut:
    return s.InvoiceOut(
        **invoice_summary(b).model_dump(),
        items=[s.InvoiceItemOut.model_validate(i) for i in b.invoice.items],
    )


def payment(p, invoice, customer_name: str) -> s.PaymentOut:
    return s.PaymentOut(
        id=p.id,
        invoice_id=invoice.id,
        invoice_number=invoice.invoice_number,
        customer_id=invoice.customer_id,
        customer_name=customer_name,
        amount=p.amount,
        payment_date=p.payment_date,
        payment_method=p.payment_method,
        reference=p.reference,
        notes=p.notes,
        source_action_id=p.source_action_id,
        created_at=p.created_at,
    )


def customer_with_balance(cs: CustomerSummary) -> s.CustomerWithBalance:
    return s.CustomerWithBalance(
        **s.CustomerOut.model_validate(cs.customer).model_dump(),
        total_invoiced=cs.total_invoiced,
        total_paid=cs.total_paid,
        outstanding=cs.outstanding,
        overdue=cs.overdue,
        open_invoice_count=cs.open_invoice_count,
        overdue_invoice_count=cs.overdue_invoice_count,
        pending_commitments=cs.pending_commitments,
    )


def bill(bb: ledger.BillBalance) -> s.BillOut:
    b = bb.bill
    return s.BillOut(
        id=b.id,
        vendor_name=b.vendor_name,
        description=b.description,
        category=b.category,
        amount=b.amount,
        paid=bb.paid,
        outstanding=bb.outstanding,
        payment_status=bb.payment_status,
        is_overdue=bb.is_overdue,
        days_overdue=bb.days_overdue,
        bill_date=b.bill_date,
        due_date=b.due_date,
        notes=b.notes,
        created_at=b.created_at,
        updated_at=b.updated_at,
    )


def commitment(c, customer_name: str, invoice_number: str | None) -> s.CommitmentOut:
    return s.CommitmentOut(
        id=c.id,
        customer_id=c.customer_id,
        customer_name=customer_name,
        invoice_id=c.invoice_id,
        invoice_number=invoice_number,
        amount=c.amount,
        expected_payment_date=c.expected_payment_date,
        status=c.status,
        notes=c.notes,
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


def receivable(r: receivables_service.ReceivableRow) -> f.ReceivableOut:
    b = r.balance
    return f.ReceivableOut(
        **invoice_summary(b).model_dump(),
        ageing_bucket=r.ageing_bucket,
        committed_amount=r.committed_amount,
        commitments=[commitment(c, b.customer_name, b.invoice.invoice_number) for c in r.pending_commitments],
    )


def receivables_summary(rs: receivables_service.ReceivablesSummary) -> f.ReceivablesSummaryOut:
    return f.ReceivablesSummaryOut(
        total_outstanding=rs.total_outstanding,
        total_overdue=rs.total_overdue,
        total_current=rs.total_current,
        open_invoice_count=rs.open_invoice_count,
        overdue_invoice_count=rs.overdue_invoice_count,
        unpaid_invoice_count=rs.unpaid_invoice_count,
        partially_paid_invoice_count=rs.partially_paid_invoice_count,
        ageing=rs.ageing,
        pending_commitments_total=rs.pending_commitments_total,
        commitments_due_next_7_days=rs.commitments_due_next_7_days,
        customers=[f.CustomerBalanceOut.model_validate(c) for c in rs.customers],
    )


def shortfall(sf: forecast_service.ShortfallPeriod) -> f.ShortfallOut:
    return f.ShortfallOut(
        start=sf.start, end=sf.end, lowest_balance=sf.lowest_balance, lowest_date=sf.lowest_date
    )


def _weekly(points: list[forecast_service.DayPoint]) -> list[forecast_service.DayPoint]:
    out = []
    for i in range(0, len(points), 7):
        chunk = points[i : i + 7]
        out.append(
            forecast_service.DayPoint(
                date=chunk[-1].date,
                inflow=sum((p.inflow for p in chunk), ZERO),
                outflow=sum((p.outflow for p in chunk), ZERO),
                balance=chunk[-1].balance,
            )
        )
    return out


def forecast(p: forecast_service.Projection, currency: str, granularity: str = "daily") -> f.ForecastOut:
    from datetime import timedelta

    points = _weekly(p.points) if granularity == "weekly" else p.points
    warnings = [
        f"Projected cash falls below {money_str(p.threshold)} {currency} from "
        f"{sf.start.isoformat()} to {sf.end.isoformat()}, lowest {money_str(sf.lowest_balance)} "
        f"{currency} on {sf.lowest_date.isoformat()}."
        for sf in p.shortfalls
    ]
    return f.ForecastOut(
        as_of=p.today,
        horizon_days=p.horizon_days,
        granularity=granularity,
        currency=currency,
        opening_cash=p.opening_cash,
        current_cash=p.current_cash,
        expected_inflows=p.expected_inflows,
        expected_outflows=p.expected_outflows,
        end_balance=p.end_balance,
        balance_30_days=p.milestones.get(30),
        balance_60_days=p.milestones.get(60),
        balance_90_days=p.milestones.get(90),
        milestones=[
            f.MilestoneOut(days=d, date=p.today + timedelta(days=d), balance=bal)
            for d, bal in sorted(p.milestones.items())
        ],
        lowest_balance=p.lowest_balance,
        lowest_balance_date=p.lowest_balance_date,
        shortfall_threshold=p.threshold,
        shortfalls=[shortfall(sf) for sf in p.shortfalls],
        warnings=warnings,
        points=[f.ForecastPointOut.model_validate(pt) for pt in points],
        events=[f.ForecastEventOut.model_validate(e) for e in p.events],
        beyond_horizon_inflows=p.beyond_horizon_inflows,
        beyond_horizon_outflows=p.beyond_horizon_outflows,
        assumptions=p.assumptions,
    )


def simulation(r: forecast_service.SimulationResult, currency: str) -> f.SimulationOut:
    from datetime import timedelta

    b, sim = r.baseline, r.simulated
    milestones = sorted(set(b.milestones) | {b.horizon_days})
    return f.SimulationOut(
        target_type=r.target_type,
        target_id=r.target_id,
        target_label=r.target_label,
        delay_days=r.delay_days,
        horizon_days=b.horizon_days,
        currency=currency,
        current_cash=b.current_cash,
        shifted_inflows=[
            f.SimulationShiftOut(
                label=a.label,
                amount=a.amount,
                baseline_date=a.date,
                simulated_date=m.date,
                source_type=a.source_type,
                source_id=a.source_id,
            )
            for a, m in r.affected_events
        ],
        comparison=[
            f.SimulationComparisonOut(
                days=d,
                date=b.today + timedelta(days=d),
                baseline_balance=b.points[d].balance,
                simulated_balance=sim.points[d].balance,
                difference=sim.points[d].balance - b.points[d].balance,
            )
            for d in milestones
        ],
        baseline_lowest_balance=b.lowest_balance,
        baseline_lowest_balance_date=b.lowest_balance_date,
        simulated_lowest_balance=sim.lowest_balance,
        simulated_lowest_balance_date=sim.lowest_balance_date,
        lowest_balance_difference=sim.lowest_balance - b.lowest_balance,
        baseline_end_balance=b.end_balance,
        simulated_end_balance=sim.end_balance,
        baseline_shortfalls=[shortfall(x) for x in b.shortfalls],
        simulated_shortfalls=[shortfall(x) for x in sim.shortfalls],
        new_shortfall_dates=r.new_shortfall_dates,
        points=[
            f.SimulationPointOut(date=bp.date, baseline_balance=bp.balance, simulated_balance=sp.balance)
            for bp, sp in zip(b.points, sim.points, strict=True)
        ],
        explanation=r.explanation,
        assumptions=b.assumptions,
    )
