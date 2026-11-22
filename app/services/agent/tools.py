"""Typed, permission-aware business tools for the live agent.

Rules every tool follows:
* business_id, user and role come from the authenticated session (ToolContext.actor), never from the model.
* Money is computed by the existing services/ledger with Decimal and returned as exact strings.
* Financial writes (payments, promises, invoices, expenses, sales, new customers) go through the existing
  proposal pipeline: analyse() resolves customers/invoices, checks caps and drops any value the user did not
  actually say (evidence check against the user's own words), then action_service.approve() executes it under
  row locks with per-operation idempotency keys and audit rows. Whether it executes immediately is decided by
  autonomy_decision(), not by the model.
* Other edits call the existing domain services, which write their own audit rows.
* Nothing here sends messages to customers: reminders are drafted only.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.exceptions import AppError, BusinessRuleError, NotFoundError, PermissionDeniedError
from app.models import AuditLog, CashTransaction, Conversation, Customer, Invoice, Payment, ProposedAction
from app.schemas.ai import Operation
from app.services import (
    audit_service,
    bill_service,
    commitment_service,
    customer_service,
    forecast_service,
    invoice_service,
    ledger,
    payment_service,
    receivables_service,
)
from app.services.ai import action_service
from app.services.ai.resolution import Analysis, analyse, resolve_customer
from app.utils.money import ZERO, money_str, q2

# Soft warnings that still allow autonomous execution of an owner's clear instruction.
AUTO_OK_WARNINGS = {"DATE_DEFAULTED"}


@dataclass
class ToolContext:
    db: Session
    actor: Any  # AuthContext-like: business_id, user_id, role, business, is_owner
    settings: Settings
    today: dt.date
    transcript: str  # the user's own recent words; write values must be evidenced here
    language: str | None
    turn_id: str
    sarvam: Any = None
    events: list[dict[str, Any]] = field(default_factory=list)  # UI side effects (navigate, refresh)


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    kind: str  # read | write
    handler: Callable[[ToolContext, dict[str, Any]], dict[str, Any]]
    owner_only: bool = False
    refresh: tuple[str, ...] = ()

    def spec(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": self.parameters},
        }


REGISTRY: dict[str, Tool] = {}


def tool(
    name: str,
    description: str,
    properties: dict[str, Any],
    *,
    kind: str = "read",
    required=(),
    owner_only: bool = False,
    refresh: tuple[str, ...] = (),
):
    def wrap(fn):
        REGISTRY[name] = Tool(
            name,
            description,
            {
                "type": "object",
                "properties": properties,
                "required": list(required),
                "additionalProperties": False,
            },
            kind,
            fn,
            owner_only,
            refresh,
        )
        return fn

    return wrap


# --------------------------------------------------------------------------- helpers
S = {"type": "string"}
EVIDENCE = {
    "type": "object",
    "description": "For every value you pass, the exact words the user said for it, copied verbatim from the "
    'user\'s speech in its original language/script (e.g. {"amount": "ఐదు వేల", "customer_name": '
    '"రమేష్", "date": "today"}). Values the user did not say are rejected.',
    "additionalProperties": {"type": "string"},
}
CUSTOMER_REF = {
    "customer_id": {
        **S,
        "description": "Customer id from an earlier tool result, when the user refers to them",
    },
    "customer_name": {**S, "description": "Customer name exactly as the user said it"},
}


def m(v: Decimal | None) -> str | None:
    return None if v is None else money_str(q2(v))


def _date(v: Any) -> dt.date | None:
    if not v:
        return None
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except ValueError as exc:
        raise BusinessRuleError("INVALID_DATE", f"'{v}' is not a date (use YYYY-MM-DD).") from exc


def _uuid(v: Any) -> uuid.UUID | None:
    if not v:
        return None
    try:
        return uuid.UUID(str(v))
    except ValueError:
        return None


def _amount(v: Any) -> Decimal | None:
    if v in (None, ""):
        return None
    try:
        d = q2(Decimal(str(v).replace(",", "")))
    except (InvalidOperation, ValueError) as exc:
        raise BusinessRuleError("INVALID_AMOUNT", f"'{v}' is not an amount.") from exc
    if d <= ZERO:
        raise BusinessRuleError("INVALID_AMOUNT", "Amount must be greater than zero.")
    return d


def _outstanding_map(ctx: ToolContext) -> dict[uuid.UUID, Decimal]:
    out: dict[uuid.UUID, Decimal] = {}
    for b in ledger.invoice_balances(ctx.db, ctx.actor.business_id, ctx.today, open_only=True):
        out[b.invoice.customer_id] = out.get(b.invoice.customer_id, ZERO) + b.outstanding
    return out


def find_customer(ctx: ToolContext, args: dict[str, Any]) -> tuple[Customer | None, dict[str, Any] | None]:
    """(customer, None) when resolved; (None, clarification) when missing, ambiguous or unknown."""
    cid = _uuid(args.get("customer_id"))
    name = (args.get("customer_name") or "").strip() or None
    if not cid and not name:
        return None, {"status": "needs_clarification", "missing": ["customer"], "message": "Which customer?"}
    r = resolve_customer(
        ctx.db,
        ctx.actor.business_id,
        Operation(type="query_customer_balance", customer_id=cid, customer_name=name),
        _outstanding_map(ctx),
    )
    if r.status == "resolved" and r.id:
        return customer_service.get(ctx.db, ctx.actor.business_id, r.id), None
    if r.status == "ambiguous":
        return None, {
            "status": "needs_clarification",
            "message": f"More than one customer matches '{name}'.",
            "candidates": [{"customer_id": str(c["id"]), "name": c["label"]} for c in r.candidates[:5]],
        }
    return None, {"status": "needs_clarification", "message": f"No customer named '{name or cid}' was found."}


def invoice_row(b: ledger.InvoiceBalance) -> dict[str, Any]:
    inv = b.invoice
    return {
        "invoice_id": str(inv.id),
        "invoice_number": inv.invoice_number,
        "customer": b.customer_name,
        "invoice_date": inv.invoice_date.isoformat(),
        "due_date": inv.due_date.isoformat() if inv.due_date else None,
        "total": m(b.total),
        "paid": m(b.paid),
        "outstanding": m(b.outstanding),
        "status": b.payment_status,
        "days_overdue": b.days_overdue if b.is_overdue else 0,
    }


def customer_balance(ctx: ToolContext, customer: Customer) -> dict[str, Any]:
    open_inv = ledger.invoice_balances(
        ctx.db, ctx.actor.business_id, ctx.today, customer_id=customer.id, open_only=True
    )
    total = q2(sum((b.outstanding for b in open_inv), ZERO))
    overdue = q2(sum((b.outstanding for b in open_inv if b.is_overdue), ZERO))
    oldest = max((b.days_overdue for b in open_inv if b.is_overdue), default=0)
    return {
        "customer_id": str(customer.id),
        "customer": customer.name,
        "outstanding": m(total),
        "overdue": m(overdue),
        "open_invoices": [invoice_row(b) for b in open_inv],
        "oldest_days_overdue": oldest,
    }


# --------------------------------------------------------------------------- read tools
@tool(
    "find_customers",
    "Search customers by name/phone, or list customers with balances (largest first).",
    {
        "query": {**S, "description": "Name or phone fragment; omit to list all"},
        "with_balance_only": {"type": "boolean"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 20},
    },
)
def find_customers(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    rows, total = customer_service.list_customers(
        ctx.db,
        ctx.actor.business,
        search=a.get("query") or None,
        with_balance=True if a.get("with_balance_only") else None,
        sort="outstanding",
        page_size=int(a.get("limit") or 10),
    )
    return {
        "total": total,
        "customers": [
            {
                "customer_id": str(r.customer.id),
                "name": r.customer.name,
                "phone": r.customer.phone,
                "outstanding": m(r.outstanding),
                "overdue": m(r.overdue),
                "open_invoices": r.open_invoice_count,
                "pending_promises": m(r.pending_commitments),
            }
            for r in rows
        ],
    }


@tool(
    "get_customer",
    "A customer's profile, current outstanding balance, open invoices, recent payments and "
    "pending promises. Use for 'how much does X owe'.",
    {**CUSTOMER_REF},
)
def get_customer(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    c, clar = find_customer(ctx, a)
    if clar:
        return clar
    out = customer_balance(ctx, c)
    pays, _ = payment_service.list_payments(ctx.db, ctx.actor.business_id, customer_id=c.id, page_size=5)
    coms, _ = commitment_service.list_commitments(
        ctx.db, ctx.actor.business_id, status="pending", customer_id=c.id
    )
    out.update(
        {
            "phone": c.phone,
            "email": c.email,
            "notes": c.notes,
            "recent_payments": [
                {
                    "payment_id": str(p.id),
                    "date": p.payment_date.isoformat(),
                    "amount": m(p.amount),
                    "method": p.payment_method,
                    "invoice": inv.invoice_number,
                }
                for p, inv, _n in pays
            ],
            "pending_promises": [
                {
                    "commitment_id": str(k.id),
                    "amount": m(k.amount),
                    "expected_date": k.expected_payment_date.isoformat(),
                    "invoice": inv,
                }
                for k, _name, inv in coms
            ],
        }
    )
    ctx.events.append({"type": "focus", "entity": "customer", "id": str(c.id)})
    return out


@tool(
    "list_invoices",
    "Invoices filtered by customer and status (unpaid, partially_paid, paid, overdue, void).",
    {
        **CUSTOMER_REF,
        "status": {"type": "string", "enum": ["unpaid", "partially_paid", "paid", "overdue", "open", "void"]},
        "limit": {"type": "integer", "minimum": 1, "maximum": 30},
    },
)
def list_invoices(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    cid = None
    if a.get("customer_id") or a.get("customer_name"):
        c, clar = find_customer(ctx, a)
        if clar:
            return clar
        cid = c.id
    status = a.get("status")
    rows, total = invoice_service.list_invoices(
        ctx.db,
        ctx.actor.business,
        customer_id=cid,
        status=None if status == "open" else status,
        sort="due_date",
        page_size=int(a.get("limit") or 15),
    )
    if status == "open":
        rows = [r for r in rows if r.outstanding > ZERO]
    return {
        "total": total,
        "invoices": [invoice_row(r) for r in rows],
        "outstanding_sum": m(sum((r.outstanding for r in rows), ZERO)),
    }


@tool(
    "list_payments",
    "Payments received, optionally for one customer and/or a date range. Returns the exact sum.",
    {
        **CUSTOMER_REF,
        "date_from": {**S, "description": "YYYY-MM-DD"},
        "date_to": {**S, "description": "YYYY-MM-DD"},
    },
)
def list_payments(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    cid = None
    if a.get("customer_id") or a.get("customer_name"):
        c, clar = find_customer(ctx, a)
        if clar:
            return clar
        cid = c.id
    d_from, d_to = _date(a.get("date_from")), _date(a.get("date_to"))
    rows, total = payment_service.list_payments(
        ctx.db, ctx.actor.business_id, customer_id=cid, date_from=d_from, date_to=d_to, page_size=20
    )
    q = (
        select(func.coalesce(func.sum(Payment.amount), 0))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .where(Payment.business_id == ctx.actor.business_id)
    )
    if cid:
        q = q.where(Invoice.customer_id == cid)
    if d_from:
        q = q.where(Payment.payment_date >= d_from)
    if d_to:
        q = q.where(Payment.payment_date <= d_to)
    return {
        "count": total,
        "total_received": m(q2(ctx.db.scalar(q))),
        "payments": [
            {
                "payment_id": str(p.id),
                "date": p.payment_date.isoformat(),
                "amount": m(p.amount),
                "method": p.payment_method,
                "invoice": inv.invoice_number,
                "customer": name,
            }
            for p, inv, name in rows
        ],
    }


@tool(
    "receivables_overview",
    "Who owes money: totals, overdue amounts, ageing and the largest debtors.",
    {"limit": {"type": "integer", "minimum": 1, "maximum": 10}},
)
def receivables_overview(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    s = receivables_service.summary(ctx.db, ctx.actor.business)
    rows, _ = customer_service.list_customers(
        ctx.db, ctx.actor.business, with_balance=True, sort="outstanding", page_size=int(a.get("limit") or 5)
    )
    return {
        "total_outstanding": m(s.total_outstanding),
        "total_overdue": m(s.total_overdue),
        "open_invoices": s.open_invoice_count,
        "overdue_invoices": s.overdue_invoice_count,
        "ageing": {k: m(v) for k, v in s.ageing.items()},
        "pending_promises_total": m(s.pending_commitments_total),
        "top_debtors": [
            {
                "customer_id": str(r.customer.id),
                "name": r.customer.name,
                "outstanding": m(r.outstanding),
                "overdue": m(r.overdue),
            }
            for r in rows
        ],
    }


@tool(
    "list_bills",
    "Bills and expenses: unpaid, overdue, or due within N days.",
    {
        "status": {"type": "string", "enum": ["unpaid", "partially_paid", "paid", "overdue"]},
        "due_within_days": {"type": "integer", "minimum": 0, "maximum": 365},
    },
)
def list_bills(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    due_to = (
        ctx.today + dt.timedelta(days=int(a["due_within_days"]))
        if a.get("due_within_days") is not None
        else None
    )
    rows, total = bill_service.list_bills(
        ctx.db, ctx.actor.business, status=a.get("status"), due_to=due_to, page_size=30
    )
    if due_to is not None:
        rows = [r for r in rows if r.outstanding > ZERO]
    return {
        "count": len(rows),
        "outstanding_sum": m(sum((r.outstanding for r in rows), ZERO)),
        "bills": [
            {
                "bill_id": str(r.bill.id),
                "vendor": r.bill.vendor_name,
                "description": r.bill.description,
                "amount": m(r.bill.amount),
                "outstanding": m(r.outstanding),
                "due_date": r.bill.due_date.isoformat() if r.bill.due_date else None,
                "status": r.payment_status,
                "days_overdue": r.days_overdue if r.is_overdue else 0,
            }
            for r in rows
        ],
    }


@tool(
    "list_promises",
    "Payment promises (commitments) customers made, by status.",
    {**CUSTOMER_REF, "status": {"type": "string", "enum": ["pending", "fulfilled", "cancelled", "broken"]}},
)
def list_promises(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    cid = None
    if a.get("customer_id") or a.get("customer_name"):
        c, clar = find_customer(ctx, a)
        if clar:
            return clar
        cid = c.id
    rows, total = commitment_service.list_commitments(
        ctx.db, ctx.actor.business_id, status=a.get("status") or "pending", customer_id=cid, page_size=30
    )
    return {
        "count": total,
        "total": m(sum((k.amount for k, _, _ in rows), ZERO)),
        "promises": [
            {
                "commitment_id": str(k.id),
                "customer": name,
                "invoice": inv,
                "amount": m(k.amount),
                "expected_date": k.expected_payment_date.isoformat(),
                "status": k.status,
                "is_past_due": k.expected_payment_date < ctx.today,
            }
            for k, name, inv in rows
        ],
    }


@tool(
    "cash_forecast",
    "Current cash and projected cash at 30/60/90 days (or a custom horizon), lowest point and shortfalls.",
    {"horizon_days": {"type": "integer", "minimum": 1, "maximum": 365}},
)
def cash_forecast(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    p = forecast_service.forecast(ctx.db, ctx.actor.business, horizon_days=int(a.get("horizon_days") or 90))
    ctx.events.append({"type": "navigate_hint", "path": "/cashflow"})
    return {
        "today": p.today.isoformat(),
        "current_cash": m(p.current_cash),
        "horizon_days": p.horizon_days,
        "balance_at_end": m(p.end_balance),
        "expected_inflows": m(p.expected_inflows),
        "expected_outflows": m(p.expected_outflows),
        "milestones": {f"in_{k}_days": m(v) for k, v in p.milestones.items()},
        "lowest_balance": m(p.lowest_balance),
        "lowest_balance_date": p.lowest_balance_date.isoformat(),
        "shortfall_periods": len(p.shortfalls),
    }


@tool(
    "simulate_late_payment",
    "What-if (read-only): a customer, or the largest customer, pays N days late. Changes nothing.",
    {
        **CUSTOMER_REF,
        "delay_days": {"type": "integer", "minimum": 1, "maximum": 365},
        "largest_customer": {"type": "boolean"},
    },
    required=("delay_days",),
)
def simulate_late_payment(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    cid = None
    if not a.get("largest_customer"):
        c, clar = find_customer(ctx, a)
        if clar:
            return clar
        cid = c.id
    r = forecast_service.simulate_delay(
        ctx.db,
        ctx.actor.business,
        delay_days=int(a["delay_days"]),
        customer_id=cid,
        largest=bool(a.get("largest_customer")),
    )
    ctx.events.append({"type": "navigate_hint", "path": "/scenarios"})
    return {
        "hypothetical": True,
        "target": r.target_label,
        "delay_days": r.delay_days,
        "baseline_lowest": m(r.baseline.lowest_balance),
        "simulated_lowest": m(r.simulated.lowest_balance),
        "baseline_90_days": m(r.baseline.milestones.get(90)),
        "simulated_90_days": m(r.simulated.milestones.get(90)),
        "new_shortfall_dates": [d.isoformat() for d in r.new_shortfall_dates[:5]],
        "explanation": r.explanation,
    }


@tool(
    "business_summary",
    "Money in (payments and sales received) and money out (bills/expenses paid) for a period, "
    "with current cash. Use for 'how much came in this month' / 'how much did I spend this week'.",
    {
        "period": {"type": "string", "enum": ["today", "this_week", "this_month", "this_year", "custom"]},
        "date_from": S,
        "date_to": S,
    },
    required=("period",),
)
def business_summary(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    t = ctx.today
    start = (
        {
            "today": t,
            "this_week": t - dt.timedelta(days=t.weekday()),
            "this_month": t.replace(day=1),
            "this_year": t.replace(month=1, day=1),
        }.get(a["period"])
        or _date(a.get("date_from"))
        or t
    )
    end = _date(a.get("date_to")) if a["period"] == "custom" and a.get("date_to") else t

    def total(direction: str) -> Decimal:
        return q2(
            ctx.db.scalar(
                select(func.coalesce(func.sum(CashTransaction.amount), 0)).where(
                    CashTransaction.business_id == ctx.actor.business_id,
                    CashTransaction.direction == direction,
                    CashTransaction.transaction_date >= start,
                    CashTransaction.transaction_date <= end,
                )
            )
        )

    cash_in, cash_out = total("inflow"), total("outflow")
    p = forecast_service.forecast(ctx.db, ctx.actor.business, horizon_days=30)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "money_in": m(cash_in),
        "money_out": m(cash_out),
        "net": m(cash_in - cash_out),
        "current_cash": m(p.current_cash),
    }


@tool(
    "recent_activity",
    "The audit history: what was recorded recently, by whom and whether via the assistant.",
    {"limit": {"type": "integer", "minimum": 1, "maximum": 20}},
)
def recent_activity(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    rows, _ = audit_service.list_logs(ctx.db, ctx.actor.business_id, page_size=int(a.get("limit") or 10))
    return {
        "entries": [
            {
                "action": r.action_type,
                "entity": r.entity_type,
                "at": r.created_at.isoformat(),
                "via_assistant": r.source_action_id is not None,
            }
            for r in rows
        ]
    }


@tool(
    "pending_confirmations",
    "Operations KAIRA prepared that still wait for confirmation or owner approval.",
    {},
)
def pending_confirmations(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    rows, total = action_service.list_actions(
        ctx.db, ctx.actor.business_id, status="pending", page=1, page_size=10
    )
    return {
        "count": total,
        "pending": [{"action_id": str(r.id), "summary": _proposal_summary(r)} for r in rows],
    }


@tool(
    "navigate",
    "Show a screen in the app while talking (does not change data).",
    {
        "screen": {
            "type": "string",
            "enum": [
                "dashboard",
                "customers",
                "customer",
                "invoices",
                "receivables",
                "cashflow",
                "scenarios",
                "approvals",
                "agent",
            ],
        },
        "customer_id": S,
    },
)
def navigate(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    path = {
        "dashboard": "/dashboard",
        "customers": "/customers",
        "invoices": "/invoices",
        "receivables": "/receivables",
        "cashflow": "/cashflow",
        "scenarios": "/scenarios",
        "approvals": "/actions",
        "agent": "/agent",
    }.get(a["screen"])
    if a["screen"] == "customer" and _uuid(a.get("customer_id")):
        path = f"/customers/{a['customer_id']}"
    if not path:
        return {"status": "needs_clarification", "message": "Which customer?"}
    ctx.events.append({"type": "navigate", "path": path})
    return {"status": "completed", "path": path}


# --------------------------------------------------------------------------- write pipeline
def autonomy_decision(ctx: ToolContext, analysis: Analysis, needs_confirmation: bool) -> str:
    """execute | confirm | clarify | owner_approval. The model cannot override this."""
    if not analysis.can_approve:
        return "clarify"
    if not ctx.actor.is_owner:
        return "owner_approval"
    soft = {w.code for w in analysis.warnings if not w.blocking}
    if needs_confirmation or ctx.settings.AGENT_AUTONOMY == "confirm" or not soft <= AUTO_OK_WARNINGS:
        return "confirm"
    if analysis.confidence == "low":
        return "clarify"
    return "execute"


def _proposal_summary(action: ProposedAction) -> str:
    parts = []
    for op in action.extracted_data.get("operations", []):
        amt = (
            f" ₹{op['amount']}"
            if op.get("amount")
            else (" (remaining balance)" if op.get("amount_is_remaining") else "")
        )
        who = op.get("customer_name") or op.get("vendor_name") or ""
        parts.append(f"{op['type'].replace('_', ' ')}{amt}" + (f" for {who}" if who else ""))
    return "; ".join(parts)


def _clarification(analysis: Analysis) -> dict[str, Any]:
    ops = []
    for a in analysis.operations:
        ops.append(
            {
                "index": a.index,
                "missing": a.missing,
                "customer": a.customer.status,
                "customer_candidates": [c["label"] for c in a.customer.candidates[:4]],
                "invoice": a.invoice.status,
                "invoice_candidates": [c["label"] for c in a.invoice.candidates[:4]],
            }
        )
    return {
        "status": "needs_clarification",
        "operations": ops,
        "warnings": [w.message for w in analysis.warnings],
        "message": "Some details are missing or ambiguous; nothing was recorded. Ask the user a short question.",
    }


def _execute_action(ctx: ToolContext, action: ProposedAction) -> dict[str, Any]:
    action, replayed = action_service.approve(ctx.db, ctx.actor, action.id)
    results = (action.result or {}).get("operations", [])
    out = {"status": "completed", "action_id": str(action.id), "replayed": replayed, "results": results}
    balances = {}
    for r in results:
        if r.get("invoice_id"):
            b = ledger.invoice_balance(ctx.db, ctx.actor.business_id, uuid.UUID(r["invoice_id"]), ctx.today)
            balances[b.invoice.invoice_number] = m(b.outstanding)
            out.setdefault(
                "customer_outstanding_after",
                customer_balance(
                    ctx, customer_service.get(ctx.db, ctx.actor.business_id, b.invoice.customer_id)
                )["outstanding"],
            )
        if r.get("entity_type") == "invoice":
            inv = invoice_service.invoice_detail(ctx.db, ctx.actor.business, uuid.UUID(r["entity_id"]))
            out["invoice"] = invoice_row(inv)
    if balances:
        out["invoice_outstanding_after"] = balances
    return out


def run_operations(
    ctx: ToolContext, ops: list[Operation], *, needs_confirmation: bool = False
) -> dict[str, Any]:
    business = ctx.actor.business
    analysis = analyse(ctx.db, business, ctx.today, ctx.transcript, ops, verify=True)
    decision = autonomy_decision(ctx, analysis, needs_confirmation)
    if decision == "clarify":
        return _clarification(analysis)
    conv = Conversation(
        business_id=ctx.actor.business_id,
        user_id=ctx.actor.user_id,
        transcript=ctx.transcript[-2000:],
        language=ctx.language,
        input_mode="voice",
        provider="sarvam-agent",
        processing_status="proposed",
    )
    ctx.db.add(conv)
    ctx.db.flush()
    action = action_service.create_proposal(
        ctx.db, ctx.actor, conv, ops, analysis, ctx.language, "sarvam-agent"
    )
    preview = {
        "action_id": str(action.id),
        "summary": _proposal_summary(action),
        "warnings": [w.message for w in analysis.warnings],
        "computed": [a.computed for a in analysis.operations if a.computed],
    }
    if decision == "owner_approval":
        return {
            "status": "needs_owner_approval",
            **preview,
            "message": "Prepared for the owner's approval; nothing is recorded until the owner approves.",
        }
    if decision == "confirm":
        return {
            "status": "needs_confirmation",
            **preview,
            "message": "Nothing recorded yet. Read the summary back and ask the user to confirm; on 'yes' call "
            "confirm_pending_action with this action_id.",
        }
    return {**_execute_action(ctx, action), "summary": preview["summary"]}


def _op(kind: str, a: dict[str, Any], **extra: Any) -> Operation:
    return Operation(
        type=kind,
        customer_id=_uuid(a.get("customer_id")),
        customer_name=a.get("customer_name"),
        invoice_reference=a.get("invoice_number"),
        amount=_amount(a.get("amount")),
        date=_date(a.get("date")),
        evidence={k: str(v) for k, v in (a.get("evidence") or {}).items()},
        **extra,
    )


# --------------------------------------------------------------------------- write tools
PAY = {
    **CUSTOMER_REF,
    "amount": {"type": "number", "description": "Rupees the user said were paid"},
    "invoice_number": {**S, "description": "Only if the user named an invoice, e.g. INV-0018"},
    "date": {**S, "description": "YYYY-MM-DD; omit when the user said 'today' or nothing"},
    "payment_method": {"type": "string", "enum": ["cash", "upi", "bank_transfer", "card", "cheque", "other"]},
    "evidence": EVIDENCE,
}


@tool(
    "record_customer_payment",
    "Record money a customer actually paid, against their open invoice. Requires the "
    "amount the user stated; never guess it. Returns the payment and the new outstanding balance.",
    PAY,
    kind="write",
    required=("amount", "evidence"),
    refresh=("financial",),
)
def record_customer_payment(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    if a.get("amount") in (None, ""):
        return {"status": "needs_clarification", "missing": ["amount"], "message": "How much did they pay?"}
    return run_operations(ctx, [_op("record_payment", a, payment_method=a.get("payment_method"))])


@tool(
    "record_payment_promise",
    "Record a customer's promise to pay (a commitment) by a date: a stated amount or "
    "'the remaining balance'. Does not record any payment.",
    {
        **CUSTOMER_REF,
        "amount": {"type": "number"},
        "remaining_balance": {"type": "boolean"},
        "expected_payment_date": {**S, "description": "YYYY-MM-DD"},
        "invoice_number": S,
        "evidence": EVIDENCE,
    },
    kind="write",
    required=("expected_payment_date", "evidence"),
    refresh=("financial",),
)
def record_payment_promise(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    return run_operations(
        ctx,
        [
            _op(
                "create_payment_commitment",
                a,
                amount_is_remaining=bool(a.get("remaining_balance")),
                expected_payment_date=_date(a.get("expected_payment_date")),
            )
        ],
    )


@tool(
    "record_payment_and_promise",
    "One statement with both: a payment made now AND a promise for the rest "
    "(e.g. 'paid 5,000 today, will clear the rest next Monday'). Executes atomically.",
    {
        **CUSTOMER_REF,
        "amount": {"type": "number"},
        "date": S,
        "payment_method": PAY["payment_method"],
        "expected_payment_date": {**S, "description": "YYYY-MM-DD for the promised remainder"},
        "evidence": EVIDENCE,
    },
    kind="write",
    required=("amount", "expected_payment_date", "evidence"),
    refresh=("financial",),
)
def record_payment_and_promise(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    pay = _op("record_payment", a, payment_method=a.get("payment_method"))
    promise = _op(
        "create_payment_commitment",
        {**a, "amount": None, "date": None},
        amount_is_remaining=True,
        expected_payment_date=_date(a.get("expected_payment_date")),
    )
    return run_operations(ctx, [pay, promise])


@tool(
    "create_invoice",
    "Create a new invoice for a customer (single amount, or line items). Returns the invoice number.",
    {
        **CUSTOMER_REF,
        "amount": {"type": "number"},
        "description": S,
        "due_date": {**S, "description": "YYYY-MM-DD"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": S,
                    "quantity": {"type": "number"},
                    "unit_price": {"type": "number"},
                },
                "required": ["description", "quantity", "unit_price"],
            },
        },
        "evidence": EVIDENCE,
    },
    kind="write",
    required=("evidence",),
    refresh=("financial",),
)
def create_invoice(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    items = None
    if a.get("items"):
        items = [
            {
                "description": i["description"],
                "quantity": Decimal(str(i["quantity"])),
                "unit_price": Decimal(str(i["unit_price"])),
            }
            for i in a["items"]
        ]
    if not items and a.get("amount") in (None, ""):
        return {
            "status": "needs_clarification",
            "missing": ["amount"],
            "message": "What is the invoice amount?",
        }
    return run_operations(
        ctx,
        [
            _op(
                "create_invoice",
                a,
                description=a.get("description"),
                items=items,
                due_date=_date(a.get("due_date")),
            )
        ],
    )


@tool(
    "record_expense",
    "Record a business expense or a supplier bill. paid_now=true when the money was already paid.",
    {
        "vendor_name": S,
        "amount": {"type": "number"},
        "description": S,
        "category": S,
        "paid_now": {"type": "boolean"},
        "date": S,
        "due_date": S,
        "payment_method": PAY["payment_method"],
        "evidence": EVIDENCE,
    },
    kind="write",
    required=("amount", "evidence"),
    refresh=("financial",),
)
def record_expense(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    op = Operation(
        type="create_expense",
        vendor_name=a.get("vendor_name"),
        amount=_amount(a.get("amount")),
        description=a.get("description"),
        category=a.get("category"),
        paid_now=bool(a.get("paid_now")),
        date=_date(a.get("date")),
        due_date=_date(a.get("due_date")),
        payment_method=a.get("payment_method"),
        evidence={k: str(v) for k, v in (a.get("evidence") or {}).items()},
    )
    return run_operations(ctx, [op])


@tool(
    "create_customer",
    "Add a new customer.",
    {"customer_name": S, "phone": S, "email": S, "evidence": EVIDENCE},
    kind="write",
    required=("customer_name", "evidence"),
    refresh=("customers",),
)
def create_customer(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    return run_operations(
        ctx,
        [
            Operation(
                type="create_customer",
                customer_name=a.get("customer_name"),
                phone=a.get("phone"),
                email=a.get("email"),
                evidence={k: str(v) for k, v in (a.get("evidence") or {}).items()},
            )
        ],
    )


@tool(
    "confirm_pending_action",
    "Execute an operation the user just confirmed ('yes', 'go ahead'). Owner only.",
    {"action_id": S},
    kind="write",
    required=("action_id",),
    owner_only=True,
    refresh=("financial",),
)
def confirm_pending_action(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    aid = _uuid(a.get("action_id"))
    if not aid:
        return {"status": "needs_clarification", "message": "Which pending operation?"}
    action = action_service.get_action(ctx.db, ctx.actor.business_id, aid)
    return {**_execute_action(ctx, action), "summary": _proposal_summary(action)}


@tool(
    "cancel_pending_action",
    "Discard an operation the user declined ('no', 'cancel'). Writes nothing financial.",
    {"action_id": S},
    kind="write",
    required=("action_id",),
    owner_only=True,
)
def cancel_pending_action(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    aid = _uuid(a.get("action_id"))
    if not aid:
        return {"status": "needs_clarification", "message": "Which pending operation?"}
    action, _ = action_service.reject(ctx.db, ctx.actor, aid, "Declined in conversation with KAIRA")
    return {"status": "completed", "action_id": str(action.id), "rejected": True}


@tool(
    "correct_payment_amount",
    "The user corrects the amount of a payment KAIRA already recorded ('actually he paid "
    "6,000, not 5,000'). Payments are never edited or duplicated: an increase records only the difference as a "
    "linked correction after the user confirms; a decrease cannot be done here.",
    {
        "payment_id": {**S, "description": "From the earlier record_customer_payment result"},
        "correct_amount": {"type": "number"},
        "confirmed": {
            "type": "boolean",
            "description": "true only after the user explicitly confirmed this correction",
        },
        "evidence": EVIDENCE,
    },
    kind="write",
    required=("payment_id", "correct_amount"),
    owner_only=True,
    refresh=("financial",),
)
def correct_payment_amount(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    pid = _uuid(a.get("payment_id"))
    pay = (
        ctx.db.scalar(select(Payment).where(Payment.id == pid, Payment.business_id == ctx.actor.business_id))
        if pid
        else None
    )
    if pay is None:
        return {"status": "needs_clarification", "message": "I could not find that payment."}
    correct = _amount(a.get("correct_amount"))
    diff = q2(correct - pay.amount)
    inv = ledger.invoice_balance(ctx.db, ctx.actor.business_id, pay.invoice_id, ctx.today)
    if diff == ZERO:
        return {
            "status": "completed",
            "message": "The recorded amount already matches.",
            "amount": m(pay.amount),
        }
    if diff < ZERO:
        return {
            "status": "unsupported",
            "recorded_amount": m(pay.amount),
            "correct_amount": m(correct),
            "message": "KAIRA cannot reduce or delete a recorded payment (there is no reversal workflow). "
            "Nothing was changed; the owner must correct it in the books.",
        }
    if diff > inv.outstanding:
        return {
            "status": "rejected",
            "message": f"The extra {m(diff)} would exceed the invoice's outstanding "
            f"{m(inv.outstanding)}. Nothing was changed.",
        }
    if not a.get("confirmed"):
        return {
            "status": "needs_confirmation",
            "recorded_amount": m(pay.amount),
            "correct_amount": m(correct),
            "difference_to_record": m(diff),
            "invoice": inv.invoice.invoice_number,
            "message": "Ask the user to confirm recording the difference; nothing was changed yet.",
        }
    r = payment_service.record_customer_payment(
        ctx.db,
        ctx.actor,
        invoice_id=pay.invoice_id,
        amount=diff,
        payment_date=pay.payment_date,
        payment_method=pay.payment_method,
        notes=f"Correction of payment {pay.id}: total {m(correct)}",
        idempotency_key=f"agent-correction:{pay.id}:{m(correct)}",
    )
    after = ledger.invoice_balance(ctx.db, ctx.actor.business_id, pay.invoice_id, ctx.today)
    return {
        "status": "completed",
        "correction_payment_id": str(r.payment.id),
        "replayed": not r.created,
        "difference_recorded": m(diff),
        "total_now_recorded": m(correct),
        "invoice": after.invoice.invoice_number,
        "invoice_outstanding_after": m(after.outstanding),
    }


@tool(
    "update_customer",
    "Change a customer's phone, email, address or notes.",
    {**CUSTOMER_REF, "phone": S, "email": S, "address": S, "notes": S},
    kind="write",
    refresh=("customers",),
)
def update_customer(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    c, clar = find_customer(ctx, a)
    if clar:
        return clar
    changes = {k: a[k] for k in ("phone", "email", "address", "notes") if a.get(k)}
    if not changes:
        return {"status": "needs_clarification", "message": "What should change?"}
    c = customer_service.update(ctx.db, ctx.actor, c.id, changes)
    return {"status": "completed", "customer_id": str(c.id), "customer": c.name, "changed": list(changes)}


@tool(
    "add_collection_note",
    "Add a dated collection note to a customer (e.g. 'said he will visit Friday'). Does not "
    "change any balance.",
    {**CUSTOMER_REF, "note": S},
    kind="write",
    required=("note",),
    refresh=("customers",),
)
def add_collection_note(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    c, clar = find_customer(ctx, a)
    if clar:
        return clar
    line = f"[{ctx.today.isoformat()}] {a['note'].strip()[:400]}"
    c = customer_service.update(ctx.db, ctx.actor, c.id, {"notes": f"{c.notes}\n{line}" if c.notes else line})
    return {"status": "completed", "customer": c.name, "note": line}


@tool(
    "record_missed_promise",
    "The customer did NOT pay as promised: marks their due pending promise as broken and "
    "adds a collection note. Never touches payments.",
    {**CUSTOMER_REF, "note": S},
    kind="write",
    refresh=("financial",),
)
def record_missed_promise(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    c, clar = find_customer(ctx, a)
    if clar:
        return clar
    rows, _ = commitment_service.list_commitments(
        ctx.db, ctx.actor.business_id, status="pending", customer_id=c.id
    )
    due = sorted(
        [k for k, _, _ in rows if k.expected_payment_date <= ctx.today], key=lambda k: k.expected_payment_date
    )
    line = f"[{ctx.today.isoformat()}] Did not pay as promised." + (
        f" {a['note'].strip()[:300]}" if a.get("note") else ""
    )
    customer_service.update(ctx.db, ctx.actor, c.id, {"notes": f"{c.notes}\n{line}" if c.notes else line})
    if not due:
        future = [k for k, _, _ in rows]
        return {
            "status": "completed",
            "customer": c.name,
            "promise_marked_broken": None,
            "note_added": line,
            "message": "No promise was due yet"
            + (
                f"; the next is due {min(k.expected_payment_date for k in future)}"
                if future
                else "; there were no pending promises"
            )
            + ". Note added.",
        }
    k = commitment_service.update_commitment(ctx.db, ctx.actor, due[0].id, {"status": "broken"})
    return {
        "status": "completed",
        "customer": c.name,
        "note_added": line,
        "promise_marked_broken": {"amount": m(k.amount), "was_due": k.expected_payment_date.isoformat()},
        "outstanding_unchanged": customer_balance(ctx, c)["outstanding"],
    }


@tool(
    "update_invoice",
    "Change an invoice's due date or notes (amounts are changed only via items before any payment).",
    {"invoice_number": S, "due_date": S, "notes": S},
    kind="write",
    required=("invoice_number",),
    refresh=("financial",),
)
def update_invoice(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    inv = ctx.db.scalar(
        select(Invoice).where(
            Invoice.business_id == ctx.actor.business_id,
            func.upper(Invoice.invoice_number) == str(a["invoice_number"]).upper(),
        )
    )
    if inv is None:
        return {"status": "needs_clarification", "message": f"No invoice {a['invoice_number']}."}
    changes = {k: v for k, v in {"due_date": _date(a.get("due_date")), "notes": a.get("notes")}.items() if v}
    if not changes:
        return {"status": "needs_clarification", "message": "What should change on the invoice?"}
    invoice_service.update_invoice(ctx.db, ctx.actor, inv.id, changes)
    return {
        "status": "completed",
        **invoice_row(invoice_service.invoice_detail(ctx.db, ctx.actor.business, inv.id)),
    }


@tool(
    "invoice_status",
    "Look up one invoice by number, e.g. before 'mark INV-0018 as paid'. An invoice is paid only "
    "when recorded payments settle it; KAIRA never marks one paid without a payment.",
    {"invoice_number": S},
    required=("invoice_number",),
)
def invoice_status(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    inv = ctx.db.scalar(
        select(Invoice).where(
            Invoice.business_id == ctx.actor.business_id,
            func.upper(Invoice.invoice_number) == str(a["invoice_number"]).upper(),
        )
    )
    if inv is None:
        return {"status": "needs_clarification", "message": f"No invoice {a['invoice_number']}."}
    return invoice_row(invoice_service.invoice_detail(ctx.db, ctx.actor.business, inv.id))


@tool(
    "draft_payment_reminder",
    "Draft (not send) a polite reminder message for a customer's outstanding balance.",
    {**CUSTOMER_REF},
)
def draft_payment_reminder(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    from app.services.ai import assistant_service

    c, clar = find_customer(ctx, a)
    if clar:
        return clar
    lang = ctx.language if ctx.language in ("te-IN", "hi-IN", "en-IN") else "en-IN"
    r = assistant_service.draft_reminder(ctx.db, ctx.actor, ctx.settings, ctx.sarvam, c.id, None, lang)
    return {
        "status": "drafted",
        "sent": False,
        "draft": r.model_dump(mode="json"),
        "message": "Drafted only. KAIRA has no messaging channel, so nothing was sent.",
    }


# --------------------------------------------------------------------------- dispatch
def specs() -> list[dict[str, Any]]:
    return [t.spec() for t in REGISTRY.values()]


def check_permission(t: Tool, actor) -> None:
    if t.owner_only and not actor.is_owner:
        raise PermissionDeniedError("Only the business owner can do that.")


def run(ctx: ToolContext, name: str, args: dict[str, Any]) -> dict[str, Any]:
    t = REGISTRY.get(name)
    if t is None:
        return {"status": "error", "code": "UNKNOWN_TOOL", "message": f"There is no tool named {name}."}
    check_permission(t, ctx.actor)
    try:
        return t.handler(ctx, args or {})
    except NotFoundError as exc:
        return {"status": "error", "code": "NOT_FOUND", "message": exc.message}
    except AppError:
        raise


def recent_audit_for_turn(db: Session, business_id: uuid.UUID, action_ids: list[uuid.UUID]) -> list[str]:
    if not action_ids:
        return []
    rows = db.scalars(
        select(AuditLog.action_type).where(
            AuditLog.business_id == business_id, AuditLog.source_action_id.in_(action_ids)
        )
    )
    return list(rows)
