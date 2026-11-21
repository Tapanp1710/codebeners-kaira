"""Cash-flow forecast and what-if simulation (see docs/FINANCIAL_ENGINE.md).

Projected cash(d) = current cash + expected inflows up to d - expected outflows up to d

Expected inflows (open receivables only, never more than the outstanding balance):
  1. Pending commitments linked to an invoice, in date order, capped at that invoice's
     remaining outstanding balance.
  2. Pending customer-level commitments (no invoice), allocated against the customer's
     remaining uncommitted balances (oldest due date first), capped likewise.
  3. Any remaining uncommitted balance is expected on the invoice due date; if the
     invoice is already overdue it is expected ``overdue_collection_delay_days`` after
     today (configurable per business) - overdue customers are NOT assumed to pay today.
  A commitment whose date has passed is treated like an overdue balance.
Expected outflows: the remaining (unpaid) balance of each open bill on its due date;
overdue bills are assumed payable today (conservative).
All arithmetic is Decimal. The forecast never writes to the database.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError
from app.models import Business, Customer, PaymentCommitment
from app.services import ledger
from app.utils.dates import business_today
from app.utils.money import ZERO, money_str, q2

MILESTONES = (30, 60, 90)


@dataclass(frozen=True)
class CashEvent:
    date: date
    direction: str  # inflow | outflow
    amount: Decimal
    kind: str  # invoice_due | overdue_assumption | commitment | missed_commitment | bill_due | overdue_bill
    label: str
    source_type: str  # invoice | payment_commitment | bill
    source_id: uuid.UUID
    customer_id: uuid.UUID | None = None
    customer_name: str | None = None
    invoice_id: uuid.UUID | None = None
    invoice_number: str | None = None
    bill_id: uuid.UUID | None = None
    original_date: date | None = None


@dataclass
class DayPoint:
    date: date
    inflow: Decimal
    outflow: Decimal
    balance: Decimal


@dataclass
class ShortfallPeriod:
    start: date
    end: date
    lowest_balance: Decimal
    lowest_date: date


@dataclass
class Projection:
    today: date
    horizon_days: int
    opening_cash: Decimal
    current_cash: Decimal
    threshold: Decimal
    expected_inflows: Decimal
    expected_outflows: Decimal
    end_balance: Decimal
    milestones: dict[int, Decimal]
    lowest_balance: Decimal
    lowest_balance_date: date
    points: list[DayPoint]
    shortfalls: list[ShortfallPeriod]
    events: list[CashEvent]
    beyond_horizon_inflows: Decimal
    beyond_horizon_outflows: Decimal
    assumptions: list[str] = field(default_factory=list)


def build_events(db: Session, business: Business, today: date) -> list[CashEvent]:
    delay = business.overdue_collection_delay_days
    overdue_date = today + timedelta(days=delay)
    events: list[CashEvent] = []

    open_invoices = ledger.invoice_balances(db, business.id, today, open_only=True)
    remaining: dict[uuid.UUID, Decimal] = {b.invoice.id: b.outstanding for b in open_invoices}
    by_invoice = {b.invoice.id: b for b in open_invoices}
    by_customer: dict[uuid.UUID, list[ledger.InvoiceBalance]] = defaultdict(list)
    for b in open_invoices:
        by_customer[b.invoice.customer_id].append(b)

    commitments = db.execute(
        select(PaymentCommitment, Customer.name)
        .join(Customer, Customer.id == PaymentCommitment.customer_id)
        .where(PaymentCommitment.business_id == business.id, PaymentCommitment.status == "pending")
        .order_by(PaymentCommitment.expected_payment_date, PaymentCommitment.created_at)
    ).all()

    def commitment_event(c: PaymentCommitment, name: str, amount: Decimal, inv) -> CashEvent:
        missed = c.expected_payment_date < today
        return CashEvent(
            date=overdue_date if missed else c.expected_payment_date,
            direction="inflow",
            amount=amount,
            kind="missed_commitment" if missed else "commitment",
            label=f"{name} promised payment"
            + (f" ({inv.invoice.invoice_number})" if inv is not None else ""),
            source_type="payment_commitment",
            source_id=c.id,
            customer_id=c.customer_id,
            customer_name=name,
            invoice_id=inv.invoice.id if inv is not None else None,
            invoice_number=inv.invoice.invoice_number if inv is not None else None,
            original_date=c.expected_payment_date,
        )

    # 1. invoice-linked commitments
    for c, name in commitments:
        if c.invoice_id is None or c.invoice_id not in remaining:
            continue
        alloc = min(q2(c.amount), remaining[c.invoice_id])
        if alloc > ZERO:
            remaining[c.invoice_id] -= alloc
            events.append(commitment_event(c, name, alloc, by_invoice[c.invoice_id]))

    # 2. customer-level commitments against remaining balances (oldest due first)
    for c, name in commitments:
        if c.invoice_id is not None:
            continue
        need = q2(c.amount)
        allocated = ZERO
        for b in sorted(by_customer.get(c.customer_id, []), key=lambda x: x.invoice.due_date):
            take = min(need - allocated, remaining[b.invoice.id])
            if take > ZERO:
                remaining[b.invoice.id] -= take
                allocated += take
            if allocated >= need:
                break
        if allocated > ZERO:
            events.append(commitment_event(c, name, allocated, None))

    # 3. uncommitted remainder at due date (or overdue assumption)
    for b in open_invoices:
        amount = remaining[b.invoice.id]
        if amount <= ZERO:
            continue
        overdue = b.invoice.due_date < today
        events.append(
            CashEvent(
                date=overdue_date if overdue else b.invoice.due_date,
                direction="inflow",
                amount=amount,
                kind="overdue_assumption" if overdue else "invoice_due",
                label=f"{b.customer_name} - {b.invoice.invoice_number}",
                source_type="invoice",
                source_id=b.invoice.id,
                customer_id=b.invoice.customer_id,
                customer_name=b.customer_name,
                invoice_id=b.invoice.id,
                invoice_number=b.invoice.invoice_number,
                original_date=b.invoice.due_date,
            )
        )

    # outflows: remaining bill balances
    for bb in ledger.bill_balances(db, business.id, today, open_only=True):
        overdue = bb.bill.due_date < today
        events.append(
            CashEvent(
                date=today if overdue else bb.bill.due_date,
                direction="outflow",
                amount=bb.outstanding,
                kind="overdue_bill" if overdue else "bill_due",
                label=f"{bb.bill.vendor_name}" + (f" - {bb.bill.description}" if bb.bill.description else ""),
                source_type="bill",
                source_id=bb.bill.id,
                bill_id=bb.bill.id,
                original_date=bb.bill.due_date,
            )
        )
    events.sort(key=lambda e: (e.date, e.direction != "outflow", e.label))
    return events


def project(
    business: Business,
    current_cash: Decimal,
    events: list[CashEvent],
    today: date,
    horizon_days: int,
) -> Projection:
    end = today + timedelta(days=horizon_days)
    in_range = [e for e in events if e.date <= end]
    beyond_in = sum((e.amount for e in events if e.date > end and e.direction == "inflow"), ZERO)
    beyond_out = sum((e.amount for e in events if e.date > end and e.direction == "outflow"), ZERO)
    daily_in: dict[date, Decimal] = defaultdict(lambda: ZERO)
    daily_out: dict[date, Decimal] = defaultdict(lambda: ZERO)
    for e in in_range:
        (daily_in if e.direction == "inflow" else daily_out)[e.date] += e.amount

    threshold = q2(business.low_cash_threshold)
    balance = current_cash
    points: list[DayPoint] = []
    for offset in range(horizon_days + 1):
        d = today + timedelta(days=offset)
        balance = q2(balance + daily_in[d] - daily_out[d])
        points.append(DayPoint(d, q2(daily_in[d]), q2(daily_out[d]), balance))

    lowest = min(points, key=lambda p: (p.balance, p.date))
    shortfalls: list[ShortfallPeriod] = []
    current: ShortfallPeriod | None = None
    for p in points:
        if p.balance < threshold:
            if current is None:
                current = ShortfallPeriod(p.date, p.date, p.balance, p.date)
            current.end = p.date
            if p.balance < current.lowest_balance:
                current.lowest_balance, current.lowest_date = p.balance, p.date
        elif current is not None:
            shortfalls.append(current)
            current = None
    if current is not None:
        shortfalls.append(current)

    milestones = {m: points[m].balance for m in MILESTONES if m <= horizon_days}
    return Projection(
        today=today,
        horizon_days=horizon_days,
        opening_cash=q2(business.opening_cash_balance),
        current_cash=current_cash,
        threshold=threshold,
        expected_inflows=q2(sum((e.amount for e in in_range if e.direction == "inflow"), ZERO)),
        expected_outflows=q2(sum((e.amount for e in in_range if e.direction == "outflow"), ZERO)),
        end_balance=points[-1].balance,
        milestones=milestones,
        lowest_balance=lowest.balance,
        lowest_balance_date=lowest.date,
        points=points,
        shortfalls=shortfalls,
        events=in_range,
        beyond_horizon_inflows=q2(beyond_in),
        beyond_horizon_outflows=q2(beyond_out),
        assumptions=assumptions(business),
    )


def assumptions(business: Business) -> list[str]:
    return [
        "Projection starts from current cash: opening balance plus actual cash movements "
        f"recorded on or after {business.opening_cash_as_of.isoformat()}.",
        "Unpaid and partially paid invoices are expected on their due date for their remaining balance only.",
        "Pending payment commitments replace the due date for the committed portion; they "
        "never add to what a customer owes.",
        f"Overdue balances without a commitment are expected {business.overdue_collection_delay_days} "
        "days from today; missed commitments are treated the same way.",
        "Unpaid bills are expected to be paid on their due date (overdue bills today) for "
        "their remaining balance. Unpaid bills are not actual cash outflows until paid.",
        f"A shortfall is any day the projected balance is below "
        f"{money_str(business.low_cash_threshold)} {business.currency}.",
    ]


def forecast(db: Session, business: Business, horizon_days: int = 90) -> Projection:
    if not 1 <= horizon_days <= 365:
        raise BusinessRuleError("INVALID_HORIZON", "horizon_days must be between 1 and 365.")
    today = business_today(business.timezone)
    cash = ledger.cash_position(db, business)
    return project(business, cash.current_cash, build_events(db, business, today), today, horizon_days)


@dataclass
class SimulationResult:
    target_type: str
    target_id: uuid.UUID
    target_label: str
    delay_days: int
    affected_events: list[tuple[CashEvent, CashEvent]]
    baseline: Projection
    simulated: Projection
    new_shortfall_dates: list[date]
    explanation: str


def largest_customer(db: Session, business: Business, today: date) -> uuid.UUID | None:
    totals: dict[uuid.UUID, Decimal] = defaultdict(lambda: ZERO)
    for b in ledger.invoice_balances(db, business.id, today, open_only=True):
        totals[b.invoice.customer_id] += b.outstanding
    if not totals:
        return None
    return max(totals.items(), key=lambda kv: kv[1])[0]


def simulate_delay(
    db: Session,
    business: Business,
    *,
    delay_days: int,
    customer_id: uuid.UUID | None = None,
    invoice_id: uuid.UUID | None = None,
    largest: bool = False,
    horizon_days: int = 90,
) -> SimulationResult:
    """Pure computation: shifts matching expected inflows by ``delay_days``. No writes."""
    if not 1 <= delay_days <= 365:
        raise BusinessRuleError("INVALID_DELAY", "delay_days must be between 1 and 365.")
    if not 1 <= horizon_days <= 365:
        raise BusinessRuleError("INVALID_HORIZON", "horizon_days must be between 1 and 365.")
    today = business_today(business.timezone)
    if largest and customer_id is None and invoice_id is None:
        customer_id = largest_customer(db, business, today)
        if customer_id is None:
            raise BusinessRuleError("NO_RECEIVABLES", "There are no outstanding receivables to delay.")
    if customer_id is None and invoice_id is None:
        raise BusinessRuleError("TARGET_REQUIRED", "Provide customer_id, invoice_id or largest_customer.")

    if invoice_id is not None:
        bal = ledger.invoice_balance(db, business.id, invoice_id, today)
        if bal is None:
            raise NotFoundError("Invoice not found.")
        target_type, target_id = "invoice", invoice_id
        target_label = f"{bal.invoice.invoice_number} ({bal.customer_name})"
    else:
        customer = db.scalar(
            select(Customer).where(Customer.id == customer_id, Customer.business_id == business.id)
        )
        if customer is None:
            raise NotFoundError("Customer not found.")
        target_type, target_id, target_label = "customer", customer.id, customer.name

    cash = ledger.cash_position(db, business)
    events = build_events(db, business, today)

    def matches(e: CashEvent) -> bool:
        if e.direction != "inflow":
            return False
        if target_type == "invoice":
            return e.invoice_id == target_id
        return e.customer_id == target_id

    affected: list[tuple[CashEvent, CashEvent]] = []
    simulated_events: list[CashEvent] = []
    for e in events:
        if matches(e):
            moved = replace(e, date=e.date + timedelta(days=delay_days))
            affected.append((e, moved))
            simulated_events.append(moved)
        else:
            simulated_events.append(e)
    if not affected:
        raise BusinessRuleError("NOTHING_TO_DELAY", f"{target_label} has no expected payments to delay.")

    baseline = project(business, cash.current_cash, events, today, horizon_days)
    simulated = project(business, cash.current_cash, simulated_events, today, horizon_days)
    base_by_date = {p.date: p.balance for p in baseline.points}
    new_short = [
        p.date
        for p in simulated.points
        if p.balance < simulated.threshold and base_by_date[p.date] >= baseline.threshold
    ]
    return SimulationResult(
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        delay_days=delay_days,
        affected_events=affected,
        baseline=baseline,
        simulated=simulated,
        new_shortfall_dates=new_short,
        explanation=_explain(business, target_label, delay_days, affected, baseline, simulated, new_short),
    )


def _explain(business, label, delay, affected, baseline, simulated, new_short) -> str:
    cur = business.currency
    moved = q2(sum((a.amount for a, _ in affected), ZERO))
    parts = [
        f"If {label} pays {delay} days later than expected, {money_str(moved)} {cur} of "
        f"expected collections moves later."
    ]
    diff = q2(simulated.lowest_balance - baseline.lowest_balance)
    parts.append(
        f"The lowest projected balance changes from {money_str(baseline.lowest_balance)} "
        f"({baseline.lowest_balance_date.isoformat()}) to {money_str(simulated.lowest_balance)} "
        f"({simulated.lowest_balance_date.isoformat()}), a difference of {money_str(diff)} {cur}."
    )
    if new_short:
        parts.append(
            f"This creates a cash shortfall on {len(new_short)} day(s), starting "
            f"{new_short[0].isoformat()}. Consider following up early, delaying a bill, or "
            "arranging short-term funds."
        )
    elif simulated.shortfalls:
        parts.append("Cash is already projected to fall below the threshold in both scenarios.")
    else:
        parts.append("Cash stays above the shortfall threshold throughout the period.")
    parts.append("This is a simulation only; no records were changed.")
    return " ".join(parts)
