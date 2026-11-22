"""Proposed actions: create, present, edit, approve (execute) and reject.

Invariants:
- AI output only ever creates a *pending* proposal. Execution happens exclusively through
  ``approve`` called by an authenticated owner - the AI has no code path to approve.
- Approval locks the proposal row (SELECT ... FOR UPDATE), re-validates every operation
  against current data, executes all operations in ONE database transaction and records
  the result. A repeated approval returns the stored result without executing again.
- Each financial write carries an idempotency key derived from (action id, operation
  index), so even a retried transaction can never duplicate a payment.
- Rejection never touches financial records.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, ConflictError, NotFoundError
from app.models import Conversation, ProposedAction
from app.schemas.ai import (
    EvidenceOut,
    Operation,
    OperationOut,
    ProposedActionOut,
    ResolutionOut,
    WarningOut,
)
from app.services import (
    audit_service,
    bill_service,
    commitment_service,
    customer_service,
    invoice_service,
    ledger,
    payment_service,
)
from app.services.ai.resolution import Analysis, Warn, _clean_name, analyse
from app.utils.dates import business_today
from app.utils.money import ZERO, money_str, q2


def _analysis_payload(analysis: Analysis) -> list[dict[str, Any]]:
    return [
        {
            "index": a.index,
            "customer": a.customer.as_dict(),
            "invoice": a.invoice.as_dict(),
            "missing_fields": a.missing,
            "computed": a.computed,
        }
        for a in analysis.operations
    ]


def _action_type(ops: list[Operation]) -> str:
    types = {o.type for o in ops}
    return ops[0].type if len(types) == 1 and len(ops) == 1 else "compound"


def create_proposal(
    db: Session,
    ctx,
    conversation: Conversation,
    ops: list[Operation],
    analysis: Analysis,
    language: str | None,
    provider: str,
) -> ProposedAction:
    action = ProposedAction(
        business_id=ctx.business_id,
        conversation_id=conversation.id,
        action_type=_action_type(ops),
        extracted_data={
            "language": language,
            "provider": provider,
            "operations": [o.model_dump(mode="json") for o in ops],
            "analysis": _analysis_payload(analysis),
            "can_approve": analysis.can_approve,
        },
        evidence=analysis.evidence,
        source_transcript=conversation.transcript,
        confidence_level=analysis.confidence,
        warnings=[w.as_dict() for w in analysis.warnings],
        status="pending",
        idempotency_key=secrets.token_hex(16),
    )
    db.add(action)
    db.flush()
    audit_service.record(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user_id,
        action_type="action.proposed",
        entity_type="proposed_action",
        entity_id=action.id,
        after={
            "action_type": action.action_type,
            "confidence": action.confidence_level,
            "operations": action.extracted_data["operations"],
        },
        source_action_id=action.id,
    )
    return action


def present(action: ProposedAction) -> ProposedActionOut:
    data = action.extracted_data or {}
    ops = data.get("operations", [])
    analysis = {a["index"]: a for a in data.get("analysis", [])}
    operations = []
    for index, raw in enumerate(ops):
        a = analysis.get(index, {})
        fields = {k: v for k, v in raw.items() if k not in ("type", "evidence") and v not in (None, [], {})}
        if "amount" in fields and fields["amount"] is not None:
            fields["amount"] = money_str(Decimal(str(fields["amount"])))
        operations.append(
            OperationOut(
                index=index,
                type=raw["type"],
                fields=fields,
                customer=ResolutionOut.model_validate(a.get("customer", {"status": "not_applicable"})),
                invoice=ResolutionOut.model_validate(a.get("invoice", {"status": "not_applicable"})),
                missing_fields=a.get("missing_fields", []),
                computed=a.get("computed", {}),
            )
        )
    return ProposedActionOut(
        id=action.id,
        conversation_id=action.conversation_id,
        action_type=action.action_type,
        status=action.status,
        source_transcript=action.source_transcript,
        language=data.get("language"),
        provider=data.get("provider"),
        confidence_level=action.confidence_level,
        operations=operations,
        evidence=[EvidenceOut.model_validate(e) for e in action.evidence or []],
        warnings=[WarningOut.model_validate(w) for w in action.warnings or []],
        can_approve=action.status == "pending" and bool(data.get("can_approve")),
        result=action.result,
        approved_by=action.approved_by,
        approved_at=action.approved_at,
        rejected_at=action.rejected_at,
        executed_at=action.executed_at,
        created_at=action.created_at,
        updated_at=action.updated_at,
    )


def get_action(
    db: Session, business_id: uuid.UUID, action_id: uuid.UUID, lock: bool = False
) -> ProposedAction:
    q = select(ProposedAction).where(
        ProposedAction.id == action_id, ProposedAction.business_id == business_id
    )
    if lock:
        q = q.with_for_update()
    action = db.scalar(q)
    if action is None:
        raise NotFoundError("Proposed action not found.")
    return action


def list_actions(db: Session, business_id, *, status: str | None, page: int, page_size: int):
    q = select(ProposedAction).where(ProposedAction.business_id == business_id)
    if status:
        q = q.where(ProposedAction.status == status)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(
        q.order_by(ProposedAction.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    )
    return list(rows), total


def _operations(action: ProposedAction) -> list[Operation]:
    return [Operation.model_validate(o) for o in action.extracted_data.get("operations", [])]


def edit(db: Session, ctx, action_id: uuid.UUID, ops: list[Operation]) -> ProposedAction:
    action = get_action(db, ctx.business_id, action_id, lock=True)
    if action.status != "pending":
        raise ConflictError("Only pending actions can be edited.", code="ACTION_NOT_PENDING")
    before = {"operations": action.extracted_data.get("operations")}
    today = business_today(ctx.business.timezone)
    analysis = analyse(
        db,
        ctx.business,
        today,
        action.source_transcript,
        ops,
        verify=False,
        prior_warnings=[Warn("EDITED_BY_OWNER", "Values were edited by the owner after extraction.")],
    )
    data = dict(action.extracted_data)
    data.update(
        operations=[o.model_dump(mode="json") for o in ops],
        analysis=_analysis_payload(analysis),
        can_approve=analysis.can_approve,
    )
    action.extracted_data = data
    action.action_type = _action_type(ops)
    action.warnings = [w.as_dict() for w in analysis.warnings]
    action.confidence_level = analysis.confidence
    db.flush()
    audit_service.record(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user_id,
        action_type="action.edited",
        entity_type="proposed_action",
        entity_id=action.id,
        before=before,
        after={"operations": data["operations"]},
        source_action_id=action.id,
    )
    return action


def reject(db: Session, ctx, action_id: uuid.UUID, reason: str | None = None) -> tuple[ProposedAction, bool]:
    action = get_action(db, ctx.business_id, action_id, lock=True)
    if action.status == "rejected":
        return action, True
    if action.status != "pending":
        raise ConflictError(
            "This action has already been executed and cannot be rejected.", code="ACTION_NOT_PENDING"
        )
    action.status = "rejected"
    action.rejected_at = datetime.now(UTC)
    db.flush()
    audit_service.record(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user_id,
        action_type="action.rejected",
        entity_type="proposed_action",
        entity_id=action.id,
        after={"reason": reason} if reason else None,
        source_action_id=action.id,
    )
    return action, False


def approve(db: Session, ctx, action_id: uuid.UUID) -> tuple[ProposedAction, bool]:
    """Execute a pending proposal. Returns (action, replayed). Caller commits; on any
    error the caller rolls back so the action stays pending and nothing is written."""
    action = get_action(db, ctx.business_id, action_id, lock=True)
    if action.status == "executed":
        return action, True
    if action.status != "pending":
        raise ConflictError("A rejected action cannot be approved.", code="ACTION_NOT_PENDING")

    business = ctx.business
    today = business_today(business.timezone)
    ops = _operations(action)
    analysis = analyse(db, business, today, action.source_transcript, ops, verify=False)
    if not analysis.can_approve:
        problems = [
            {
                "operation_index": a.index,
                "missing_fields": a.missing,
                "customer": a.customer.status,
                "invoice": a.invoice.status,
            }
            for a in analysis.operations
        ]
        raise BusinessRuleError(
            "ACTION_NOT_EXECUTABLE",
            "This action cannot be approved yet. Resolve the missing or ambiguous details first.",
            {"operations": problems, "warnings": [w.as_dict() for w in analysis.warnings if w.blocking]},
        )

    results = _execute(db, ctx, action, analysis, today)
    now = datetime.now(UTC)
    action.status = "executed"
    action.approved_by = ctx.user_id
    action.approved_at = now
    action.executed_at = now
    action.result = {"operations": results}
    db.flush()
    audit_service.record(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user_id,
        action_type="action.approved",
        entity_type="proposed_action",
        entity_id=action.id,
        after=action.result,
        source_action_id=action.id,
    )
    conversation = db.get(Conversation, action.conversation_id) if action.conversation_id else None
    if conversation is not None:
        conversation.processing_status = "executed"
    return action, False


def _execute(db: Session, ctx, action: ProposedAction, analysis: Analysis, today) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    created_customers: dict[str, uuid.UUID] = {}
    for a in analysis.operations:
        op, idx = a.op, a.index
        key = f"action:{action.id}:{idx}"
        customer_id = a.customer.id or (
            created_customers.get(_clean_name(op.customer_name)) if op.customer_name else None
        )
        if op.type == "create_customer":
            c = customer_service.create(
                db,
                ctx,
                {"name": op.customer_name, "phone": op.phone, "email": op.email, "notes": op.notes},
                source_action_id=action.id,
            )
            created_customers[_clean_name(op.customer_name)] = c.id
            results.append(
                {
                    "index": idx,
                    "type": op.type,
                    "entity_type": "customer",
                    "entity_id": str(c.id),
                    "summary": f"Added customer {c.name}",
                }
            )
        elif op.type == "record_payment":
            r = payment_service.record_customer_payment(
                db,
                ctx,
                invoice_id=a.invoice.id,
                amount=op.amount,
                payment_date=op.date or today,
                payment_method=op.payment_method or "cash",
                notes="Recorded via KAIRA assistant",
                idempotency_key=key,
                source_action_id=action.id,
                expected_customer_id=customer_id,
            )
            bal = ledger.invoice_balance(db, ctx.business_id, a.invoice.id, today)
            results.append(
                {
                    "index": idx,
                    "type": op.type,
                    "entity_type": "payment",
                    "entity_id": str(r.payment.id),
                    "invoice_id": str(a.invoice.id),
                    "invoice_outstanding_after": money_str(bal.outstanding),
                    "summary": f"Recorded payment of {money_str(r.payment.amount)} "
                    f"on {bal.invoice.invoice_number}",
                }
            )
        elif op.type == "create_payment_commitment":
            invoice_id = a.invoice.id if a.invoice.status == "resolved" else None
            amount = op.amount
            if amount is None and op.amount_is_remaining:
                if invoice_id:
                    amount = ledger.invoice_balance(db, ctx.business_id, invoice_id, today).outstanding
                else:
                    amount = sum(
                        (
                            b.outstanding
                            for b in ledger.invoice_balances(
                                db, ctx.business_id, today, customer_id=customer_id, open_only=True
                            )
                        ),
                        ZERO,
                    )
            if amount is None or q2(amount) <= ZERO:
                raise BusinessRuleError("NOTHING_REMAINING", "Nothing remains outstanding to promise.")
            c = commitment_service.create_commitment(
                db,
                ctx,
                customer_id=customer_id,
                invoice_id=invoice_id,
                amount=amount,
                expected_payment_date=op.expected_payment_date,
                notes="Promised via KAIRA assistant",
                source_action_id=action.id,
                supersede_existing=op.amount_is_remaining,
            )
            results.append(
                {
                    "index": idx,
                    "type": op.type,
                    "entity_type": "payment_commitment",
                    "entity_id": str(c.id),
                    "summary": f"Expecting {money_str(c.amount)} on {c.expected_payment_date.isoformat()}",
                }
            )
        elif op.type == "create_invoice":
            items = (
                [i.model_dump() for i in op.items]
                if op.items
                else [
                    {
                        "description": op.description or "Goods / services",
                        "quantity": Decimal("1"),
                        "unit_price": op.amount,
                    }
                ]
            )
            inv = invoice_service.create_invoice(
                db,
                ctx,
                customer_id=customer_id,
                items=items,
                invoice_date=op.date,
                due_date=op.due_date,
                notes=op.notes,
                source_action_id=action.id,
            )
            results.append(
                {
                    "index": idx,
                    "type": op.type,
                    "entity_type": "invoice",
                    "entity_id": str(inv.id),
                    "summary": f"Created invoice {inv.invoice_number}",
                }
            )
        elif op.type == "create_expense":
            bill_date = op.date or today
            bill = bill_service.create_bill(
                db,
                ctx,
                {
                    "vendor_name": op.vendor_name,
                    "description": op.description,
                    "category": op.category or "general",
                    "amount": op.amount,
                    "bill_date": bill_date,
                    "due_date": op.due_date or (bill_date if op.paid_now else None),
                    "notes": op.notes,
                },
                source_action_id=action.id,
            )
            entry = {
                "index": idx,
                "type": op.type,
                "entity_type": "bill",
                "entity_id": str(bill.id),
                "summary": f"Added bill from {bill.vendor_name} for {money_str(bill.amount)}",
            }
            if op.paid_now:
                bp, _ = payment_service.record_bill_payment(
                    db,
                    ctx,
                    bill_id=bill.id,
                    amount=bill.amount,
                    payment_date=bill_date,
                    payment_method=op.payment_method or "cash",
                    idempotency_key=key,
                    source_action_id=action.id,
                )
                entry["bill_payment_id"] = str(bp.id)
                entry["summary"] += " (paid)"
            results.append(entry)
        elif op.type == "record_sale":
            who = f" to {a.customer.label}" if a.customer.status == "resolved" else ""
            txn = payment_service.record_direct_sale(
                db,
                ctx,
                amount=op.amount,
                sale_date=op.date,
                description=f"Sale{who}" + (f": {op.description}" if op.description else ""),
                source_action_id=action.id,
            )
            results.append(
                {
                    "index": idx,
                    "type": op.type,
                    "entity_type": "cash_transaction",
                    "entity_id": str(txn.id),
                    "summary": f"Recorded sale of {money_str(txn.amount)}",
                }
            )
        else:  # pragma: no cover - analyse() blocks non-write operations
            raise BusinessRuleError("UNSUPPORTED_OPERATION", f"Operation {op.type} cannot be executed.")
    return results
