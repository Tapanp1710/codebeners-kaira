"""Evidence verification, record resolution, validation and confidence scoring.

Confidence is NOT the model's self-reported probability. It is derived from:
evidence completeness (every value backed by a verbatim transcript fragment), resolution
quality (exact / fuzzy / ambiguous / missing record matches) and validation results."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Customer, Invoice
from app.schemas.ai import WRITE_INTENTS, Operation
from app.services import ledger
from app.services.ai.text_parse import normalise_invoice_number, normalise_text, romanize
from app.utils.money import ZERO, money_str, q2

VERIFIED_FIELDS = (
    "customer_name",
    "vendor_name",
    "invoice_reference",
    "amount",
    "date",
    "due_date",
    "expected_payment_date",
    "amount_is_remaining",
)
HONORIFICS = {
    "ji",
    "garu",
    "gaaru",
    "sir",
    "bhai",
    "anna",
    "akka",
    "mr",
    "mrs",
    "ms",
    "shri",
    "sri",
    "smt",
    "seth",
    "saab",
    "sahab",
}


@dataclass
class Warn:
    code: str
    message: str
    operation_index: int | None = None
    blocking: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "operation_index": self.operation_index,
            "blocking": self.blocking,
        }


@dataclass
class Resolved:
    status: str = "not_applicable"  # resolved | ambiguous | not_found | not_applicable | new
    id: uuid.UUID | None = None
    label: str | None = None
    candidates: list[dict[str, Any]] = field(default_factory=list)
    mismatch: str | None = (
        None  # why a customer id was not trusted (it names someone other than the user said)
    )

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "id": str(self.id) if self.id else None,
            "label": self.label,
            "candidates": self.candidates,
        }


# ------------------------------------------------------------------ evidence
def verify_evidence(transcript: str, op: Operation, index: int, warnings: list[Warn]) -> list[dict[str, Any]]:
    """Drop any value whose evidence fragment is missing or not in the transcript."""
    norm_transcript = normalise_text(transcript)
    evidence_out = []
    for name in VERIFIED_FIELDS:
        value = getattr(op, name)
        if value in (None, False):
            continue
        fragment = op.evidence.get(name)
        verified = (
            bool(fragment)
            and normalise_text(fragment) in norm_transcript
            and evidence_matches_value(name, value, fragment)
        )
        if fragment:
            evidence_out.append(
                {"field": name, "fragment": fragment, "verified": verified, "operation_index": index}
            )
        if not verified:
            setattr(op, name, False if name == "amount_is_remaining" else None)
            warnings.append(
                Warn(
                    "UNSUPPORTED_VALUE_REMOVED",
                    f"'{name}' was removed because it is not stated in the transcript.",
                    index,
                )
            )
    for name, fragment in op.evidence.items():
        if name not in VERIFIED_FIELDS and fragment:
            evidence_out.append(
                {
                    "field": name,
                    "fragment": fragment,
                    "verified": normalise_text(fragment) in norm_transcript,
                    "operation_index": index,
                }
            )
    return evidence_out


def _invoice_digits(ref: str) -> int | None:
    digits = re.sub(r"\D", "", ref or "")
    return int(digits) if digits else None


def evidence_matches_value(name: str, value: Any, fragment: str) -> bool:
    """The user's words for a value must mean that value, not just appear somewhere in the transcript: the words
    "Ramesh" do not evidence the customer name "Suresh", and "INV-0018" does not evidence INV-0019."""
    if name in ("customer_name", "vendor_name") and isinstance(value, str):
        return name_score(fragment, value) >= NAME_MATCH or name_score(value, fragment) >= NAME_MATCH
    if name == "invoice_reference" and isinstance(value, str):
        said, ref = _invoice_digits(fragment), _invoice_digits(value)
        if said is None or ref is None:
            return normalise_invoice_number(fragment) == normalise_invoice_number(value)
        return said == ref
    return True


# ------------------------------------------------------------------ customers
# A name the user said counts as naming a stored customer from this score up (same bar as a resolution candidate).
NAME_MATCH = 0.75


def _clean_name(name: str) -> str:
    # Indic-script names are romanized first so "రమేష్" / "रमेश" match a customer stored as "Ramesh".
    tokens = [t for t in re.split(r"[^\w]+", romanize(name).casefold()) if t and t not in HONORIFICS]
    return " ".join(tokens)


def name_score(query: str, candidate: str) -> float:
    q, c = _clean_name(query), _clean_name(candidate)
    if not q or not c:
        return 0.0
    if q == c:
        return 1.0
    q_tokens, c_tokens = q.split(), c.split()
    if set(q_tokens) <= set(c_tokens):
        return 0.92  # "Ramesh" vs "Ramesh Kumar"
    best_token = max(SequenceMatcher(None, qt, ct).ratio() for qt in q_tokens for ct in c_tokens)
    return round(max(SequenceMatcher(None, q, c).ratio(), best_token * 0.9), 3)


def resolve_customer(
    db: Session,
    business_id: uuid.UUID,
    op: Operation,
    outstanding: dict[uuid.UUID, Decimal],
    *,
    strict_name: bool = False,
) -> Resolved:
    """strict_name (values taken from the user's words): a customer_id must agree with the name the user said
    (customer_name and its evidence). An id that names someone else is never trusted: the result is ambiguous with
    both the id's customer and the customers matching the spoken name as candidates, so nothing is written
    silently. A near match (e.g. a misheard spelling) resolves with its score so it is read back first."""
    if op.customer_id:
        c = db.scalar(
            select(Customer).where(Customer.id == op.customer_id, Customer.business_id == business_id)
        )
        if c is None:
            return Resolved("not_found")
        said = [n for n in (op.customer_name, op.evidence.get("customer_name")) if n and n.strip()]
        if not strict_name or not said:
            return Resolved("resolved", c.id, c.name)
        score = min(name_score(n, c.name) for n in said)
        own = {
            "id": str(c.id),
            "label": c.name,
            "score": score,
            "outstanding": money_str(outstanding.get(c.id, ZERO)),
        }
        if score >= NAME_MATCH:
            return Resolved("resolved", c.id, c.name, [own])
        by_name = resolve_customer(
            db, business_id, Operation(type=op.type, customer_name=said[0]), outstanding
        ).candidates
        return Resolved(
            "ambiguous",
            None,
            None,
            [own, *[x for x in by_name if x["id"] != own["id"]]][:5],
            mismatch=f"'{said[0]}' does not match the customer {c.name}",
        )
    if not op.customer_name:
        return Resolved("not_found")
    customers = db.execute(
        select(Customer.id, Customer.name).where(Customer.business_id == business_id)
    ).all()
    scored = sorted(
        ((name_score(op.customer_name, n), cid, n) for cid, n in customers), key=lambda x: x[0], reverse=True
    )
    candidates = [
        {"id": str(cid), "label": n, "score": s, "outstanding": money_str(outstanding.get(cid, ZERO))}
        for s, cid, n in scored
        if s >= NAME_MATCH
    ][:5]
    strong = [x for x in scored if x[0] >= 0.9]
    if len(strong) == 1:
        s, cid, n = strong[0]
        return Resolved("resolved", cid, n, candidates)
    if len(strong) > 1:
        return Resolved("ambiguous", None, None, candidates)
    if len(candidates) == 1:
        return Resolved("resolved", uuid.UUID(candidates[0]["id"]), candidates[0]["label"], candidates)
    if candidates:
        return Resolved("ambiguous", None, None, candidates)
    return Resolved("not_found")


# ------------------------------------------------------------------ invoices
def _invoice_candidates(balances: list[ledger.InvoiceBalance]) -> list[dict[str, Any]]:
    return [
        {
            "id": str(b.invoice.id),
            "label": f"{b.invoice.invoice_number} (due {b.invoice.due_date.isoformat()})",
            "score": 1.0,
            "outstanding": money_str(b.outstanding),
        }
        for b in balances
    ]


def resolve_invoice(
    db: Session,
    business_id: uuid.UUID,
    today: date,
    op: Operation,
    customer: Resolved,
    pending_payments: dict[uuid.UUID, Decimal],
) -> Resolved:
    if op.invoice_id:
        bal = ledger.invoice_balance(db, business_id, op.invoice_id, today)
        if bal is None:
            return Resolved("not_found")
        return Resolved("resolved", bal.invoice.id, bal.invoice.invoice_number, _invoice_candidates([bal]))
    if op.invoice_reference:
        number = normalise_invoice_number(op.invoice_reference)
        inv = db.scalar(
            select(Invoice).where(Invoice.business_id == business_id, Invoice.invoice_number == number)
        )
        if inv is None:
            return Resolved("not_found", label=number)
        return Resolved("resolved", inv.id, inv.invoice_number)
    if customer.status != "resolved":
        return Resolved("not_found")
    open_invoices = ledger.invoice_balances(db, business_id, today, customer_id=customer.id, open_only=True)
    open_invoices = (
        [b for b in open_invoices if b.outstanding - pending_payments.get(b.invoice.id, ZERO) > ZERO]
        if op.type != "record_payment"
        else open_invoices
    )
    if not open_invoices:
        return Resolved("not_found")
    cands = _invoice_candidates(open_invoices)
    if len(open_invoices) == 1:
        b = open_invoices[0]
        return Resolved("resolved", b.invoice.id, b.invoice.invoice_number, cands)
    if op.amount is not None:
        exact = [b for b in open_invoices if b.outstanding == q2(op.amount)]
        if len(exact) == 1:
            return Resolved("resolved", exact[0].invoice.id, exact[0].invoice.invoice_number, cands)
    return Resolved("ambiguous", None, None, cands)


# ------------------------------------------------------------------ assemble
REQUIRED = {
    "record_payment": ["customer", "invoice", "amount"],
    "record_sale": ["amount"],
    "create_invoice": ["customer", "amount"],
    "create_expense": ["vendor_name", "amount"],
    "create_customer": ["customer_name"],
    "create_payment_commitment": ["customer", "amount", "expected_payment_date"],
}


@dataclass
class AnalysedOperation:
    index: int
    op: Operation
    customer: Resolved
    invoice: Resolved
    missing: list[str]
    computed: dict[str, Any]


@dataclass
class Analysis:
    operations: list[AnalysedOperation]
    warnings: list[Warn]
    evidence: list[dict[str, Any]]
    confidence: str

    @property
    def can_approve(self) -> bool:
        if not self.operations:
            return False
        for a in self.operations:
            if a.op.type not in WRITE_INTENTS or a.missing:
                return False
            if a.customer.status == "ambiguous" or a.invoice.status == "ambiguous":
                return False
        return not any(w.blocking for w in self.warnings)


def analyse(
    db: Session,
    business,
    today: date,
    transcript: str,
    ops: list[Operation],
    *,
    verify: bool,
    prior_warnings: list[Warn] | None = None,
) -> Analysis:
    warnings: list[Warn] = list(prior_warnings or [])
    evidence: list[dict[str, Any]] = []
    analysed: list[AnalysedOperation] = []
    outstanding_by_customer: dict[uuid.UUID, Decimal] = {}
    for b in ledger.invoice_balances(db, business.id, today, open_only=True):
        outstanding_by_customer[b.invoice.customer_id] = (
            outstanding_by_customer.get(b.invoice.customer_id, ZERO) + b.outstanding
        )
    pending_payments: dict[uuid.UUID, Decimal] = {}  # invoice -> amount paid earlier in this action
    pending_by_customer: dict[uuid.UUID, Decimal] = {}
    new_customers: set[str] = set()

    for index, op in enumerate(ops):
        if verify:
            evidence.extend(verify_evidence(transcript, op, index, warnings))
        customer = Resolved()
        invoice = Resolved()
        computed: dict[str, Any] = {}
        missing: list[str] = []

        if op.type == "create_customer":
            if op.customer_name:
                existing = resolve_customer(db, business.id, op, outstanding_by_customer)
                if existing.status in ("resolved", "ambiguous") and any(
                    c["score"] >= 0.95 for c in existing.candidates
                ):
                    warnings.append(
                        Warn(
                            "POSSIBLE_DUPLICATE_CUSTOMER",
                            f"A customer named like '{op.customer_name}' already exists.",
                            index,
                        )
                    )
                customer = Resolved("new", None, op.customer_name, existing.candidates)
                new_customers.add(_clean_name(op.customer_name))
        elif op.type in (
            "record_payment",
            "create_invoice",
            "create_payment_commitment",
            "request_payment_reminder",
            "record_sale",
        ):
            if op.customer_name and _clean_name(op.customer_name) in new_customers and not op.customer_id:
                customer = Resolved("new", None, op.customer_name)
            elif op.type == "record_sale" and not op.customer_name and not op.customer_id:
                customer = Resolved("not_applicable")
            else:
                customer = resolve_customer(db, business.id, op, outstanding_by_customer, strict_name=verify)
            if customer.mismatch:
                warnings.append(
                    Warn(
                        "CUSTOMER_MISMATCH",
                        f"{customer.mismatch}; nothing was recorded. Which customer did you mean?",
                        index,
                        True,
                    )
                )
            elif customer.status == "not_found" and (op.customer_name or op.customer_id):
                blocking = op.type != "record_sale"
                warnings.append(
                    Warn(
                        "CUSTOMER_NOT_FOUND",
                        f"No customer matches '{op.customer_name}'. Choose an existing customer "
                        "or add a create_customer step."
                        if blocking
                        else f"No customer matches '{op.customer_name}'; the sale will be recorded without one.",
                        index,
                        blocking,
                    )
                )
            elif customer.status == "ambiguous":
                warnings.append(
                    Warn(
                        "AMBIGUOUS_CUSTOMER",
                        f"Several customers match '{op.customer_name}'. Choose one.",
                        index,
                    )
                )
            elif (
                customer.status == "resolved"
                and customer.candidates
                and customer.candidates[0]["score"] < 0.9
            ):
                warnings.append(
                    Warn(
                        "FUZZY_CUSTOMER_MATCH",
                        f"'{op.customer_name or op.evidence.get('customer_name')}' was matched to "
                        f"'{customer.label}'. Please confirm.",
                        index,
                    )
                )

        if op.type in ("record_payment", "create_payment_commitment"):
            if op.type == "create_payment_commitment" and not (op.invoice_id or op.invoice_reference):
                # Reuse the invoice of an earlier payment for the same customer in this utterance.
                prev = next(
                    (
                        a
                        for a in reversed(analysed)
                        if a.op.type == "record_payment"
                        and a.customer.id
                        and a.customer.id == customer.id
                        and a.invoice.id
                    ),
                    None,
                )
                if prev:
                    invoice = Resolved(
                        "resolved", prev.invoice.id, prev.invoice.label, prev.invoice.candidates
                    )
                else:
                    invoice = resolve_invoice(db, business.id, today, op, customer, pending_payments)
                    if invoice.status in ("ambiguous", "not_found") and customer.status == "resolved":
                        invoice = Resolved("not_applicable", candidates=invoice.candidates)
            else:
                invoice = resolve_invoice(db, business.id, today, op, customer, pending_payments)
            if op.type == "record_payment":
                if invoice.status == "ambiguous":
                    warnings.append(
                        Warn(
                            "AMBIGUOUS_INVOICE",
                            "This customer has several open invoices. Choose which one was paid.",
                            index,
                        )
                    )
                elif invoice.status == "not_found" and customer.status == "resolved":
                    warnings.append(
                        Warn(
                            "NO_OPEN_INVOICE",
                            f"No matching open invoice was found for {customer.label}.",
                            index,
                            True,
                        )
                    )

        # ---- amounts and validation
        if op.type == "record_payment" and invoice.status == "resolved" and op.amount is not None:
            bal = ledger.invoice_balance(db, business.id, invoice.id, today)
            available = bal.outstanding - pending_payments.get(invoice.id, ZERO)
            computed["invoice_outstanding_before"] = money_str(available)
            if q2(op.amount) > available:
                warnings.append(
                    Warn(
                        "OVERPAYMENT",
                        f"Payment of {money_str(op.amount)} exceeds the outstanding "
                        f"{money_str(available)} on {bal.invoice.invoice_number}.",
                        index,
                        True,
                    )
                )
            else:
                computed["invoice_outstanding_after"] = money_str(available - q2(op.amount))
                pending_payments[invoice.id] = pending_payments.get(invoice.id, ZERO) + q2(op.amount)
                if customer.id:
                    pending_by_customer[customer.id] = pending_by_customer.get(customer.id, ZERO) + q2(
                        op.amount
                    )
            if not op.date:
                computed["payment_date_defaulted"] = today.isoformat()
                warnings.append(
                    Warn("DATE_DEFAULTED", "No payment date was stated; today's date will be used.", index)
                )

        if (
            op.type == "create_payment_commitment"
            and op.amount_is_remaining
            and customer.status == "resolved"
        ):
            if invoice.status == "resolved":
                bal = ledger.invoice_balance(db, business.id, invoice.id, today)
                remaining = bal.outstanding - pending_payments.get(invoice.id, ZERO)
            else:
                remaining = outstanding_by_customer.get(customer.id, ZERO) - pending_by_customer.get(
                    customer.id, ZERO
                )
            computed["remaining_amount"] = money_str(max(remaining, ZERO))
            if remaining <= ZERO:
                warnings.append(
                    Warn("NOTHING_REMAINING", "Nothing would remain outstanding to promise.", index, True)
                )
            else:
                computed["supersedes_existing_commitments"] = True
        if (
            op.type == "create_payment_commitment"
            and op.expected_payment_date
            and op.expected_payment_date < today
        ):
            warnings.append(Warn("DATE_IN_PAST", "The promised payment date is in the past.", index, True))

        if op.type == "create_expense" and op.paid_now and not op.date:
            computed["payment_date_defaulted"] = today.isoformat()

        # ---- missing fields
        for req in REQUIRED.get(op.type, []):
            if req == "customer":
                if customer.status not in ("resolved", "new"):
                    missing.append("customer")
            elif req == "invoice":
                if invoice.status != "resolved":
                    missing.append("invoice")
            elif req == "amount":
                has_remaining = (
                    op.type == "create_payment_commitment"
                    and op.amount_is_remaining
                    and "remaining_amount" in computed
                )
                if op.amount is None and not has_remaining and not (op.type == "create_invoice" and op.items):
                    missing.append("amount")
            elif getattr(op, req, None) in (None, ""):
                missing.append(req)
        if op.type == "unknown":
            warnings.append(
                Warn(
                    "NOT_UNDERSTOOD",
                    "This request could not be understood as a business operation.",
                    index,
                    True,
                )
            )
        analysed.append(AnalysedOperation(index, op, customer, invoice, missing, computed))

    confidence = _confidence(analysed, warnings)
    return Analysis(analysed, warnings, evidence, confidence)


def _confidence(analysed: list[AnalysedOperation], warnings: list[Warn]) -> str:
    if any(a.missing or a.op.type == "unknown" for a in analysed) or any(w.blocking for w in warnings):
        return "low"
    if any(a.customer.status == "ambiguous" or a.invoice.status == "ambiguous" for a in analysed):
        return "low"
    soft = {
        "FUZZY_CUSTOMER_MATCH",
        "UNSUPPORTED_VALUE_REMOVED",
        "POSSIBLE_DUPLICATE_CUSTOMER",
        "DATE_DEFAULTED",
        "EDITED_BY_OWNER",
    }
    if any(w.code in soft for w in warnings):
        return "medium"
    return "high"
