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
import hashlib
import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.exceptions import AppError, BusinessRuleError, NotFoundError, PermissionDeniedError
from app.models import (
    AgentToolExecution,
    AuditLog,
    Bill,
    CashTransaction,
    Conversation,
    Customer,
    Invoice,
    Payment,
    PaymentCommitment,
    ProposedAction,
)
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
from app.services.agent import dates as dateres
from app.services.agent.numbers import spoken_amount
from app.services.ai import action_service
from app.services.ai.resolution import (
    Analysis,
    _clean_name,
    analyse,
    resolve_customer,
)
from app.services.ai.text_parse import normalise_invoice_number, normalise_text
from app.utils.money import ZERO, money_str, q2

CORRECTION_PREFIX = "agent-correction:"
# Soft warnings that still allow autonomous execution of an owner's clear instruction.
AUTO_OK_WARNINGS = {"DATE_DEFAULTED"}
# A payment of the same amount on the same invoice this recently is read back before it is recorded again.
RECENT_DUPLICATE_MINUTES = 15
REMAINING_WORDS = re.compile(
    r"\b(?:the rest|rest of (?:it|the \w+)|remaining|remainder|balance|baki|baaki)\b"
    r"|बाकी|बाक़ी|बचा|बचे|बची|शेष|మిగిలిన|మిగతా|మిగిలింది|మిగిలినది|మిగులు|బాకీ|బ్యాలెన్స్",
    re.IGNORECASE,
)


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
    known_ids: set[str] = field(default_factory=set)  # ids that appeared in tool results of this conversation
    # The user's utterance of THIS turn (confirm / cancel / edit values must be grounded in it). None = fall back
    # to the last line of the transcript window.
    current_text: str | None = None


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
    '"రమేష్", "date": "ఈరోజు", "expected_payment_date": "వచ్చే సోమవారం", "remaining_balance": "మిగిలిన"}). '
    'Use the key "remaining_balance" for the words meaning "the rest / remaining / balance" (e.g. "बाकी", '
    '"మిగిలిన", "the rest"). Values the user did not say are rejected.',
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


# --------------------------------------------------------------------------- dates
@dataclass
class DateDecision:
    """What the server decided for one date field from the user's own words.

    action: ok (use `value`), defaulted (no date said: the service uses business today), confirm (use `value` but
    read it back first, e.g. the model's date differs from what the words mean), clarify (ask; record nothing)."""

    field: str
    label: str
    action: str
    value: dt.date | None = None
    evidence: str | None = None
    message: str | None = None
    said: dt.date | None = None
    proposed: dt.date | None = None
    candidates: tuple[dt.date, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"field": self.field, "decision": self.action}
        if self.value:
            out["date"] = self.value.isoformat()
        if self.evidence:
            out["words"] = self.evidence
        if self.said:
            out["date_from_words"] = self.said.isoformat()
        if self.proposed:
            out["date_proposed"] = self.proposed.isoformat()
        if self.candidates:
            out["could_mean"] = [d.isoformat() for d in self.candidates]
        if self.message:
            out["message"] = self.message
        return out


def _latest_utterance(ctx: ToolContext) -> str:
    if getattr(ctx, "current_text", None) is not None:
        return ctx.current_text or ""
    lines = [ln for ln in (ctx.transcript or "").splitlines() if ln.strip()]
    return lines[-1] if lines else ""


# --------------------------------------------------------------------------- what the user said this turn
_PUNCT = re.compile(r"[\s,.!;:।॥\"'()\-]+")
AFFIRM = (
    "yes", "yeah", "yep", "yup", "ok", "okay", "confirm", "confirmed", "go ahead", "do it", "sure", "correct",
    "haan", "haa", "haan ji", "ji haan", "theek hai", "thik hai", "kar do", "kardo",
    "avunu", "sare", "cheyyi", "cheyi",
    "हाँ", "हां", "हाँ जी", "हां जी", "जी हाँ", "जी हां", "ठीक है", "कर दो", "करो",
    "అవును", "సరే", "చేయి", "చెయ్యి", "చేయండి",
)  # fmt: skip
DECLINE = (
    "no", "nope", "cancel", "dont", "don't", "do not", "not", "stop", "wait", "never mind", "nevermind",
    "nahi", "nahin", "mat", "mat karo", "rehne do", "ruko", "vaddu", "ledu", "kadu", "kaadu", "aagu",
    "नहीं", "नही", "मत", "रुको", "रहने दो", "रद्द", "కాదు", "వద్దు", "లేదు", "ఆగు", "రద్దు",
)  # fmt: skip
# Speech-to-text often drops the "?": a question word means the user is asking, not agreeing.
QUESTION = (
    "what", "what's", "whats", "why", "how", "which", "who", "when", "where", "kya", "kitna", "kitne", "kaun",
    "kyun", "enti", "entha", "evaru", "ela", "क्या", "कितना", "कितने", "कौन", "क्यों", "कैसे",
    "ఏమిటి", "ఏంటి", "ఎంత", "ఎవరు", "ఎలా", "ఎందుకు",
)  # fmt: skip


def _phrase_text(text: str) -> str:
    """NFC-normalised, casefolded words padded with spaces, for whole-word phrase matching in any script."""
    words = [w for w in _PUNCT.split(normalise_text(text or "")) if w]
    return f" {' '.join(words)} "


def _has_phrase(text: str, phrases: tuple[str, ...]) -> bool:
    padded = _phrase_text(text)
    return any(_phrase_text(p) in padded for p in phrases)


def affirmed(text: str) -> bool:
    """An explicit yes in this utterance: not a question, no 'no / wait / don't' alongside it."""
    if "?" in (text or "") or "？" in (text or ""):
        return False
    return _has_phrase(text, AFFIRM) and not _has_phrase(text, DECLINE) and not _has_phrase(text, QUESTION)


def declined(text: str) -> bool:
    return _has_phrase(text, DECLINE)


def decide_date(
    ctx: ToolContext,
    a: dict[str, Any],
    field_name: str,
    *,
    label: str,
    evidence_keys: tuple[str, ...],
    prefer: str,
    required: bool = False,
    default_today: bool = False,
    not_after_today: bool = False,
    not_before_today: bool = False,
    exclude: tuple[str, ...] = (),
) -> DateDecision:
    """Resolve a date field deterministically. The model's value is only a proposal: the user's words (its
    evidence phrase, else the date phrases in what they said) decide, and a disagreement is read back."""
    today = ctx.today
    raw = a.get(field_name)
    proposed: dt.date | None = None
    words: list[str] = []
    ev = a.get("evidence") or {}
    for k in evidence_keys:
        if isinstance(ev, dict) and ev.get(k):
            words.append(str(ev[k]))
    if raw not in (None, ""):
        try:
            proposed = dt.date.fromisoformat(str(raw).strip()[:10])
        except ValueError:
            words.append(
                str(raw)
            )  # the model passed words ("next Monday"): treat them as a phrase to resolve
    transcript = ctx.transcript or ""
    said_text = normalise_text(transcript)

    def finish(d: DateDecision) -> DateDecision:
        v = d.value
        if v is not None and d.action == "ok" and not_after_today and v < today - dt.timedelta(days=30):
            # e.g. "paid on 5th December" said in November resolves to last December: read it back first.
            d = DateDecision(
                d.field,
                d.label,
                "confirm",
                value=v,
                evidence=d.evidence,
                said=d.said,
                proposed=d.proposed,
                message=f"'{d.evidence}' is read as {dateres.describe(v)}, more than a month ago. "
                f"The {label} will be {dateres.describe(v)} unless you correct it.",
            )
        if v is not None and d.action in ("ok", "confirm"):
            if not_after_today and v > today:
                return DateDecision(
                    field_name,
                    label,
                    "clarify",
                    message=f"The {label} would be {dateres.describe(v)}, which is in the future. Did the money "
                    "already come in? If it is still to come, that is a promise, not a payment.",
                    said=d.said,
                    proposed=d.proposed,
                )
            if not_before_today and v < today:
                return DateDecision(
                    field_name,
                    label,
                    "clarify",
                    message=f"The {label} would be {dateres.describe(v)}, which has already passed. Which date "
                    "did you mean?",
                    said=d.said,
                    proposed=d.proposed,
                )
        return d

    # 1. The evidence phrase for this field, read in the sentence it was spoken in.
    found: list[tuple[str, list[dateres.DateMention]]] = []
    for frag in words:
        if normalise_text(frag) not in said_text:
            continue
        mentions = dateres.mentions_in_fragment(frag, transcript, today, prefer=prefer)
        if mentions:
            found.append((frag, mentions))
    if proposed is not None:  # any evidence phrase that means exactly the proposed date settles it
        for _frag, mentions in found:
            hit = next((x for x in mentions if x.date == proposed), None)
            if hit is not None:
                return finish(
                    DateDecision(field_name, label, "ok", value=proposed, evidence=hit.phrase, said=proposed)
                )
    for frag, mentions in found[:1]:
        resolved = [x for x in mentions if not x.ambiguous]
        ambiguous = [x for x in mentions if x.ambiguous]
        hit = next((x for x in resolved if proposed and x.date == proposed), None)
        if hit is None and ambiguous and not resolved:
            amb = ambiguous[0]
            return DateDecision(
                field_name,
                label,
                "clarify",
                message=f"{amb.reason}. Which one is the {label}?",
                proposed=proposed,
                candidates=amb.candidates,
            )
        if hit is None and len({x.date for x in resolved}) == 1:
            hit = resolved[0]
        if hit is None:
            return DateDecision(
                field_name,
                label,
                "clarify",
                message=f"'{frag}' mentions more than one date. Which one is the {label}?",
                proposed=proposed,
                candidates=tuple(sorted({x.date for x in resolved})),
            )
        if proposed is not None and proposed != hit.date:
            return finish(
                DateDecision(
                    field_name,
                    label,
                    "confirm",
                    value=hit.date,
                    evidence=hit.phrase,
                    said=hit.date,
                    proposed=proposed,
                    message=f"You said '{hit.phrase}', which is {dateres.describe(hit.date)}, but "
                    f"{dateres.describe(proposed)} was proposed. The {label} will be "
                    f"{dateres.describe(hit.date)} unless you correct it.",
                )
            )
        return finish(
            DateDecision(field_name, label, "ok", value=hit.date, evidence=hit.phrase, said=hit.date)
        )

    # 2. No usable evidence phrase: look at the date words the user actually said.
    latest = _latest_utterance(ctx)
    excl = [normalise_text(e) for e in exclude if e]

    def own(x: dateres.DateMention) -> bool:  # not a phrase another field of this call already used
        p = normalise_text(x.phrase)
        return not any(p in e or e in p for e in excl)

    latest_mentions = [x for x in dateres.find_dates(latest, today, prefer=prefer) if own(x)]
    latest_resolved = [x for x in latest_mentions if not x.ambiguous]
    if proposed is not None:
        pool = latest_resolved + [
            x for x in dateres.find_dates(transcript, today, prefer=prefer) if not x.ambiguous and own(x)
        ]
        hit = next((x for x in pool if x.date == proposed), None)
        if hit is not None:
            return finish(
                DateDecision(field_name, label, "ok", value=proposed, evidence=hit.phrase, said=proposed)
            )
        if (
            default_today
            and proposed == today
            and not any(x.ambiguous or x.date < today for x in latest_mentions)
        ):
            return DateDecision(field_name, label, "defaulted", proposed=proposed)
        if not latest_mentions and default_today:
            if proposed == today:
                return DateDecision(field_name, label, "defaulted", proposed=proposed)
            return DateDecision(
                field_name,
                label,
                "confirm",
                proposed=proposed,
                message=f"No date was said, so the {label} will be today, {dateres.describe(today)} "
                f"(not {dateres.describe(proposed)}).",
            )
        if not latest_mentions and not required:
            return DateDecision(
                field_name,
                label,
                "confirm",
                proposed=proposed,
                message=f"The {label} {dateres.describe(proposed)} was not said, so it is left out.",
            )
        fits = sorted(
            {
                x.date
                for x in latest_resolved
                if not (not_before_today and x.date < today) and not (not_after_today and x.date > today)
            }
        )
        if len(fits) > 1 and prefer == dateres.FUTURE and today in fits:
            fits.remove(today)  # "paid today, the rest next Monday": today is the payment, not this date
        if len(fits) == 1 and not [x for x in latest_mentions if x.ambiguous]:
            d = next(x for x in latest_resolved if x.date == fits[0])
            return finish(
                DateDecision(
                    field_name,
                    label,
                    "confirm",
                    value=d.date,
                    evidence=d.phrase,
                    said=d.date,
                    proposed=proposed,
                    message=f"You said '{d.phrase}', which is {dateres.describe(d.date)}, but "
                    f"{dateres.describe(proposed)} was proposed. The {label} will be "
                    f"{dateres.describe(d.date)} unless you correct it.",
                )
            )
        return DateDecision(
            field_name,
            label,
            "clarify",
            proposed=proposed,
            message=f"I could not match {dateres.describe(proposed)} to what was said. What is the {label}?",
        )
    if default_today:
        ambiguous = [x for x in latest_mentions if x.ambiguous]
        fitting = [x for x in latest_resolved if x.date <= today]
        dates_said = {x.date for x in fitting}
        if not fitting and not ambiguous:
            return DateDecision(field_name, label, "defaulted")
        if dates_said == {today} and not ambiguous:
            return DateDecision(field_name, label, "ok", value=today, evidence=fitting[0].phrase, said=today)
        if len(dates_said) == 1 and not ambiguous:
            d = fitting[0]
            return finish(
                DateDecision(
                    field_name,
                    label,
                    "confirm",
                    value=d.date,
                    evidence=d.phrase,
                    said=d.date,
                    message=f"You said '{d.phrase}', so the {label} will be {dateres.describe(d.date)}.",
                )
            )
        if ambiguous and not fitting:
            amb = ambiguous[0]
            return DateDecision(
                field_name,
                label,
                "clarify",
                message=f"{amb.reason}. Which one is the {label}?",
                candidates=amb.candidates,
            )
        return DateDecision(
            field_name,
            label,
            "clarify",
            message=f"Several dates were mentioned. What is the {label}?",
            candidates=tuple(sorted(dates_said)),
        )
    if required:
        return DateDecision(field_name, label, "clarify", message=f"What is the {label}?")
    return DateDecision(field_name, label, "ok")


def _date_clarification(decisions: list[DateDecision]) -> dict[str, Any] | None:
    asks = [d for d in decisions if d.action == "clarify"]
    if not asks:
        return None
    return {
        "status": "needs_clarification",
        "missing": [d.field for d in asks],
        "dates": [d.as_dict() for d in decisions],
        "message": " ".join(d.message or f"What is the {d.label}?" for d in asks) + " Nothing was recorded.",
    }


def _apply_date(op: Operation, attr: str, decision: DateDecision) -> None:
    setattr(op, attr, decision.value)
    if decision.value is not None and decision.evidence:
        op.evidence[attr] = decision.evidence
    elif decision.value is None:
        op.evidence.pop(attr, None)


def _outstanding_map(ctx: ToolContext) -> dict[uuid.UUID, Decimal]:
    out: dict[uuid.UUID, Decimal] = {}
    for b in ledger.invoice_balances(ctx.db, ctx.actor.business_id, ctx.today, open_only=True):
        out[b.invoice.customer_id] = out.get(b.invoice.customer_id, ZERO) + b.outstanding
    return out


def find_customer(
    ctx: ToolContext, args: dict[str, Any], *, write: bool = False
) -> tuple[Customer | None, dict[str, Any] | None]:
    """(customer, None) when resolved; (None, clarification) when missing, ambiguous or unknown. For a write, a
    customer_id must agree with the name the user said (see resolve_customer strict_name)."""
    cid = _uuid(args.get("customer_id"))
    name = (args.get("customer_name") or "").strip() or None
    if not cid and not name:
        return None, {"status": "needs_clarification", "missing": ["customer"], "message": "Which customer?"}
    ev = _evidence(args) if write else {}
    r = resolve_customer(
        ctx.db,
        ctx.actor.business_id,
        Operation(
            type="query_customer_balance",
            customer_id=cid,
            customer_name=name,
            evidence={k: v for k, v in ev.items() if k == "customer_name"},
        ),
        _outstanding_map(ctx),
        strict_name=write,
    )
    if r.status == "resolved" and r.id:
        return customer_service.get(ctx.db, ctx.actor.business_id, r.id), None
    if r.status == "ambiguous":
        return None, {
            "status": "needs_clarification",
            "message": (f"{r.mismatch}. Which customer did you mean? Nothing was changed.")
            if r.mismatch
            else f"More than one customer matches '{name}'.",
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
    query = (a.get("query") or "").strip()
    if query and not rows:
        # The SQL search is a plain substring match on the stored (usually Latin) name, so "రమేష్" / "रमेश" or a
        # misheard spelling finds nothing. Fall back to the same fuzzy, romanizing matcher the write tools use.
        r = resolve_customer(
            ctx.db,
            ctx.actor.business_id,
            Operation(type="query_customer_balance", customer_name=query),
            _outstanding_map(ctx),
        )
        ids = [uuid.UUID(c["id"]) for c in r.candidates] or ([r.id] if r.id else [])
        found = [customer_service.get(ctx.db, ctx.actor.business_id, i) for i in ids]
        sums = customer_service.summaries(ctx.db, ctx.actor.business, found)
        rows = [sums[c.id] for c in found]
        if a.get("with_balance_only"):
            rows = [s for s in rows if s.outstanding > ZERO]
        total = len(rows)
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
            "has_notes": bool(c.notes),
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
        page_size=100 if status == "open" else int(a.get("limit") or 15),
    )
    if status == "open":
        rows = [r for r in rows if r.outstanding > ZERO]
        total = len(rows)
    out_sum = m(sum((r.outstanding for r in rows), ZERO))
    rows = rows[: int(a.get("limit") or 15)]
    return {
        "total": total,
        "invoices": [invoice_row(r) for r in rows],
        "outstanding_sum": out_sum,
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
    offered = ctx.db.scalars(
        select(AgentToolExecution.proposed_action_id).where(
            AgentToolExecution.business_id == ctx.actor.business_id,
            AgentToolExecution.user_id == ctx.actor.user_id,
            AgentToolExecution.status == "needs_confirmation",
            AgentToolExecution.proposed_action_id.is_not(None),
        )
    ).all()
    rows = [
        r
        for r in (ctx.db.get(ProposedAction, aid) for aid in dict.fromkeys(offered))
        if r is not None and r.status == "pending"
    ][:10]
    return {
        "count": len(rows),
        "pending": [{"action_id": str(r.id), "summary": _proposal_summary(r)} for r in rows],
        "note": "Only operations KAIRA read back to you. Others are on the Approvals screen.",
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
    if a["screen"] == "customer":
        cid = _uuid(a.get("customer_id"))
        owned = cid and ctx.db.scalar(
            select(Customer.id).where(Customer.id == cid, Customer.business_id == ctx.actor.business_id)
        )
        if not owned:  # never navigate to an id that is not this business's customer
            return {"status": "needs_clarification", "message": "Which customer?"}
        path = f"/customers/{cid}"
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
    analysis = {x.get("index"): x for x in (action.extracted_data or {}).get("analysis", [])}
    for i, op in enumerate(action.extracted_data.get("operations", [])):
        amt = (
            f" ₹{op['amount']}"
            if op.get("amount")
            else (" (remaining balance)" if op.get("amount_is_remaining") else "")
        )
        # Read back the customer the operation will actually be recorded against, not the model's spelling.
        resolved = (analysis.get(i) or {}).get("customer") or {}
        who = (
            (resolved.get("label") if resolved.get("status") == "resolved" else None)
            or op.get("customer_name")
            or op.get("vendor_name")
            or ""
        )
        when = ""
        if op["type"] == "create_payment_commitment" and op.get("expected_payment_date"):
            when = f" by {op['expected_payment_date']}"
        elif op["type"] in ("record_payment", "create_expense", "record_sale"):
            when = f" dated {op['date']}" if op.get("date") else " dated today"
        if op.get("due_date"):
            when += f" due {op['due_date']}"
        parts.append(f"{op['type'].replace('_', ' ')}{amt}" + (f" for {who}" if who else "") + when)
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
    out["stored"] = stored_records(ctx, results)
    out["summary"] = "; ".join(s["summary"] for s in out["stored"]) or _proposal_summary(action)
    return out


def stored_records(ctx: ToolContext, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What is actually in the database after execution, with its ISO dates (read back from the rows, so the
    reply can only repeat the stored dates)."""
    out: list[dict[str, Any]] = []
    bid = ctx.actor.business_id
    for r in results:
        eid = _uuid(r.get("entity_id"))
        et = r.get("entity_type")
        if eid is None:
            continue
        if et == "payment":
            p = ctx.db.scalar(select(Payment).where(Payment.id == eid, Payment.business_id == bid))
            if p is not None:
                inv = ctx.db.get(Invoice, p.invoice_id)
                out.append(
                    {
                        "type": "payment",
                        "payment_id": str(p.id),
                        "amount": m(p.amount),
                        "payment_date": p.payment_date.isoformat(),
                        "invoice": inv.invoice_number if inv else None,
                        "summary": f"Recorded payment of {m(p.amount)} on "
                        f"{inv.invoice_number if inv else 'the invoice'} dated {p.payment_date.isoformat()}",
                    }
                )
        elif et == "payment_commitment":
            k = ctx.db.scalar(
                select(PaymentCommitment).where(
                    PaymentCommitment.id == eid, PaymentCommitment.business_id == bid
                )
            )
            if k is not None:
                out.append(
                    {
                        "type": "promise",
                        "commitment_id": str(k.id),
                        "amount": m(k.amount),
                        "expected_payment_date": k.expected_payment_date.isoformat(),
                        "summary": f"Promise of {m(k.amount)} expected on {k.expected_payment_date.isoformat()}",
                    }
                )
        elif et == "invoice":
            inv = ctx.db.scalar(select(Invoice).where(Invoice.id == eid, Invoice.business_id == bid))
            if inv is not None:
                out.append(
                    {
                        "type": "invoice",
                        "invoice_number": inv.invoice_number,
                        "invoice_date": inv.invoice_date.isoformat(),
                        "due_date": inv.due_date.isoformat() if inv.due_date else None,
                        "summary": f"Created invoice {inv.invoice_number} dated {inv.invoice_date.isoformat()}"
                        + (f", due {inv.due_date.isoformat()}" if inv.due_date else ""),
                    }
                )
        elif et == "bill":
            b = ctx.db.scalar(select(Bill).where(Bill.id == eid, Bill.business_id == bid))
            if b is not None:
                out.append(
                    {
                        "type": "bill",
                        "bill_id": str(b.id),
                        "amount": m(b.amount),
                        "bill_date": b.bill_date.isoformat(),
                        "due_date": b.due_date.isoformat() if b.due_date else None,
                        "paid": bool(r.get("bill_payment_id")),
                        "summary": str(r.get("summary") or "Added bill")
                        + f" dated {b.bill_date.isoformat()}"
                        + (
                            f", due {b.due_date.isoformat()}"
                            if b.due_date and b.due_date != b.bill_date
                            else ""
                        ),
                    }
                )
        elif r.get("summary"):
            out.append({"type": et, "summary": str(r["summary"])})
    return out


def proposal_hash(action: ProposedAction) -> str:
    ops = (action.extracted_data or {}).get("operations", [])
    return hashlib.sha256(json.dumps(ops, sort_keys=True, default=str).encode()).hexdigest()[:24]


def amount_evidenced(amount: Decimal, evidence: dict[str, str], transcript: str | None) -> bool:
    """True when some evidence fragment the user actually said parses to exactly this amount. The preferred
    key is "amount", but models also use "correct_amount"/"new_amount"; the key does not matter, the words do."""
    said_text = normalise_text(transcript or "")
    fragments = [evidence.get("amount"), *evidence.values()]
    for frag in fragments:
        if not frag:
            continue
        if transcript is not None and normalise_text(frag) not in said_text:
            continue
        if spoken_amount(frag) == q2(amount):
            return True
    return False


def value_checks(ctx: ToolContext, ops: list[Operation]) -> list[str]:
    """Reasons to read an operation back instead of executing it, even for the owner in auto mode."""
    reasons = []
    for op in ops:
        if op.amount is not None:
            if not amount_evidenced(q2(op.amount), op.evidence, ctx.transcript):
                reasons.append(f"the amount {m(op.amount)} could not be matched exactly to the words spoken")
        if op.customer_id and not op.customer_name and str(op.customer_id) not in ctx.known_ids:
            reasons.append("the customer was not named and did not come from an earlier result")
        if op.items:
            reasons.append("line items were not dictated item by item")
    return reasons


def _first_name_tokens(name: str) -> set[str]:
    tokens = _clean_name(name).split()
    return {tokens[0]} if tokens and len(tokens[0]) >= 3 else set()


def other_customer_named(ctx: ToolContext, customer_id: uuid.UUID, label: str) -> str | None:
    """When a write refers to a customer only by id (a pronoun: 'he paid'), the user's words of this turn must not
    name a different customer while never naming this one ('Ramesh paid 5,000' after a result about Suresh)."""
    said = _latest_utterance(ctx)
    if not said:
        return None
    words = set(_clean_name(said).split())
    own = set(_clean_name(label).split())
    if words & own:
        return None
    rows = ctx.db.execute(
        select(Customer.id, Customer.name).where(
            Customer.business_id == ctx.actor.business_id, Customer.id != customer_id
        )
    ).all()
    for _cid, n in rows:
        hit = (_first_name_tokens(n) - own) & words
        if hit:
            return f"you said '{next(iter(hit))}' but the customer from earlier is {label}"
    return None


def binding_checks(ctx: ToolContext, analysis: Analysis) -> list[str]:
    """Reasons to read back because the customer resolved from an id is not obviously the one the user named."""
    reasons = []
    for a in analysis.operations:
        if (
            a.op.customer_id
            and a.customer.status == "resolved"
            and a.customer.id
            and not a.op.customer_name
            and not a.op.evidence.get("customer_name")
        ):
            why = other_customer_named(ctx, a.customer.id, a.customer.label or "")
            if why:
                reasons.append(why)
    return reasons


def _payments_done_this_turn(ctx: ToolContext) -> dict[tuple[str, Decimal], dict[str, Any]]:
    """(invoice id, amount) of every payment an executed action of THIS turn recorded -> that execution's result."""
    rows = ctx.db.execute(
        select(AgentToolExecution.proposed_action_id, AgentToolExecution.result).where(
            AgentToolExecution.business_id == ctx.actor.business_id,
            AgentToolExecution.user_id == ctx.actor.user_id,
            AgentToolExecution.turn_id == ctx.turn_id,
            AgentToolExecution.status == "completed",
            AgentToolExecution.proposed_action_id.is_not(None),
        )
    ).all()
    done: dict[tuple[str, Decimal], dict[str, Any]] = {}
    for action_id, result in rows:
        action = ctx.db.get(ProposedAction, action_id)
        if action is None or action.status != "executed":
            continue
        data = action.extracted_data or {}
        analysis = {x["index"]: x for x in data.get("analysis", [])}
        for i, op in enumerate(data.get("operations", [])):
            inv = ((analysis.get(i) or {}).get("invoice") or {}).get("id")
            if op.get("type") == "record_payment" and inv and op.get("amount") is not None:
                done[(str(inv), q2(Decimal(str(op["amount"]))))] = result or {"action_id": str(action.id)}
    return done


def duplicate_checks(
    ctx: ToolContext, analysis: Analysis
) -> tuple[set[int], dict[str, Any] | None, list[str]]:
    """Payments that would be recorded twice. Returns (indexes to drop because this turn already recorded exactly
    that payment, the earlier result, reasons to read back because a same-amount payment on the same invoice was
    recorded in the last few minutes)."""
    done = _payments_done_this_turn(ctx)
    drop: set[int] = set()
    earlier: dict[str, Any] | None = None
    reasons: list[str] = []
    since = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=RECENT_DUPLICATE_MINUTES)
    for a in analysis.operations:
        if a.op.type != "record_payment" or a.invoice.status != "resolved" or a.op.amount is None:
            continue
        key = (str(a.invoice.id), q2(a.op.amount))
        if key in done:
            drop.add(a.index)
            earlier = done[key]
            continue
        recent = ctx.db.scalar(
            select(func.count())
            .select_from(Payment)
            .where(
                Payment.business_id == ctx.actor.business_id,
                Payment.invoice_id == a.invoice.id,
                Payment.amount == q2(a.op.amount),
                Payment.created_at >= since,
            )
        )
        if recent:
            reasons.append(
                f"a payment of {m(a.op.amount)} on {a.invoice.label} was already recorded in the last "
                f"{RECENT_DUPLICATE_MINUTES} minutes; this would record a second one"
            )
    return drop, earlier, reasons


def run_operations(
    ctx: ToolContext,
    ops: list[Operation],
    *,
    needs_confirmation: bool = False,
    dates: list[DateDecision] | None = None,
) -> dict[str, Any]:
    business = ctx.actor.business
    dates = dates or []
    clar = _date_clarification(dates)
    if clar:
        return clar
    analysis = analyse(ctx.db, business, ctx.today, ctx.transcript, ops, verify=True)
    drop, earlier, dup_reasons = duplicate_checks(ctx, analysis)
    if drop:
        kept = [op for i, op in enumerate(ops) if i not in drop]
        if not kept:
            return {
                **{k: v for k, v in (earlier or {}).items() if not k.startswith("_")},
                "status": "completed",
                "replayed": True,
                "message": "That payment was already recorded earlier in this turn; it was not recorded again.",
            }
        ops = kept
        analysis = analyse(ctx.db, business, ctx.today, ctx.transcript, ops, verify=True)
    reasons = value_checks(ctx, ops) if analysis.can_approve else []
    reasons += binding_checks(ctx, analysis) if analysis.can_approve else []
    reasons += dup_reasons if analysis.can_approve else []
    reasons += [d.message or f"the {d.label} needs checking" for d in dates if d.action == "confirm"]
    decision = autonomy_decision(ctx, analysis, needs_confirmation or bool(reasons))
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
        "proposal_hash": proposal_hash(action),
    }
    if dates:
        preview["dates"] = [d.as_dict() for d in dates]
    if drop:
        preview["already_recorded_this_turn"] = (
            "The payment itself was already recorded earlier in this turn."
        )
    if reasons:
        preview["confirmation_reasons"] = reasons
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
    out = _execute_action(ctx, action)
    if dates:
        out["dates"] = preview["dates"]
    if drop:
        out["already_recorded_this_turn"] = preview["already_recorded_this_turn"]
    return out


def _evidence(a: dict[str, Any]) -> dict[str, str]:
    raw = a.get("evidence")
    ev = {str(k): str(v) for k, v in raw.items() if v} if isinstance(raw, dict) else {}
    if "remaining_balance" in ev and "amount_is_remaining" not in ev:
        ev["amount_is_remaining"] = ev["remaining_balance"]
    return ev


def _ground_remaining(ctx: ToolContext, op: Operation) -> None:
    """The 'rest/remaining' flag needs the user's own word for it. Models often set the flag but forget the
    evidence; take the word from what the user said (never invent it)."""
    if not op.amount_is_remaining or op.evidence.get("amount_is_remaining"):
        return
    hit = REMAINING_WORDS.search(_latest_utterance(ctx)) or REMAINING_WORDS.search(ctx.transcript or "")
    if hit:
        op.evidence["amount_is_remaining"] = hit.group(0)


def _op(kind: str, a: dict[str, Any], **extra: Any) -> Operation:
    return Operation(
        type=kind,
        customer_id=_uuid(a.get("customer_id")),
        customer_name=a.get("customer_name"),
        invoice_reference=a.get("invoice_number"),
        amount=_amount(a.get("amount")),
        evidence=_evidence(a),
        **extra,
    )


def _payment_date(ctx: ToolContext, a: dict[str, Any], *, exclude: tuple[str, ...] = ()) -> DateDecision:
    return decide_date(
        ctx,
        a,
        "date",
        label="payment date",
        evidence_keys=("date", "payment_date"),
        prefer=dateres.PAST,
        default_today=True,
        not_after_today=True,
        exclude=exclude,
    )


def _promise_date(ctx: ToolContext, a: dict[str, Any], *, with_payment: bool = False) -> DateDecision:
    # With a payment in the same call, evidence["date"] is the payment's date, never the promise's.
    keys = (
        ("expected_payment_date", "promise_date")
        if with_payment
        else (
            "expected_payment_date",
            "promise_date",
            "due_date",
            "date",
        )
    )
    return decide_date(
        ctx,
        a,
        "expected_payment_date",
        label="promised payment date",
        evidence_keys=keys,
        prefer=dateres.FUTURE,
        required=True,
        not_before_today=True,
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
    when = _payment_date(ctx, a)
    op = _op("record_payment", a, payment_method=a.get("payment_method"))
    _apply_date(op, "date", when)
    return run_operations(ctx, [op], dates=[when])


@tool(
    "record_payment_promise",
    "ONLY a promise to pay later (a commitment) by a date: a stated amount or 'the remaining balance'. "
    "It records NO payment. If the user also says money was paid now (e.g. 'paid 5,000 today, the rest next "
    "Monday'), do not use this tool: use record_payment_and_promise.",
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
    when = _promise_date(ctx, a)
    op = _op("create_payment_commitment", a, amount_is_remaining=bool(a.get("remaining_balance")))
    _apply_date(op, "expected_payment_date", when)
    _ground_remaining(ctx, op)
    return run_operations(ctx, [op], dates=[when])


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
    promised_for = _promise_date(ctx, a, with_payment=True)
    paid_on = _payment_date(ctx, a, exclude=(promised_for.evidence or "",))
    pay = _op("record_payment", a, payment_method=a.get("payment_method"))
    _apply_date(pay, "date", paid_on)
    pay.evidence.pop("expected_payment_date", None)
    promise = _op("create_payment_commitment", {**a, "amount": None}, amount_is_remaining=True)
    promise.evidence.pop("date", None)
    _apply_date(promise, "expected_payment_date", promised_for)
    _ground_remaining(ctx, promise)
    return run_operations(ctx, [pay, promise], dates=[paid_on, promised_for])


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
    due = decide_date(
        ctx,
        a,
        "due_date",
        label="invoice due date",
        evidence_keys=("due_date", "date"),
        prefer=dateres.FUTURE,
    )
    op = _op("create_invoice", a, description=a.get("description"), items=items)
    _apply_date(op, "due_date", due)
    return run_operations(ctx, [op], dates=[due])


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
    paid_now = bool(a.get("paid_now"))
    due = DateDecision("due_date", "bill due date", "ok")
    if a.get("due_date") or (a.get("evidence") or {}).get("due_date"):
        due = decide_date(
            ctx,
            a,
            "due_date",
            label="bill due date",
            evidence_keys=("due_date",),
            prefer=dateres.FUTURE,
        )
    # The expense/bill date is on or before today; no date words = today.
    bill_date = decide_date(
        ctx,
        a,
        "date",
        label="expense date" if paid_now else "bill date",
        evidence_keys=("date", "bill_date", "expense_date"),
        prefer=dateres.PAST,
        default_today=True,
        not_after_today=True,
        exclude=(due.evidence or "",),
    )
    decisions = [bill_date] + ([due] if due.field and (a.get("due_date") or due.evidence) else [])
    op = Operation(
        type="create_expense",
        vendor_name=a.get("vendor_name"),
        amount=_amount(a.get("amount")),
        description=a.get("description"),
        category=a.get("category"),
        paid_now=paid_now,
        payment_method=a.get("payment_method"),
        evidence=_evidence(a),
    )
    _apply_date(op, "date", bill_date)
    _apply_date(op, "due_date", due)
    start = op.date or ctx.today
    if op.due_date and op.due_date < start:
        return {
            "status": "needs_clarification",
            "missing": ["due_date"],
            "dates": [d.as_dict() for d in decisions],
            "message": f"The due date {op.due_date.isoformat()} is before the bill date {start.isoformat()}. "
            "Which due date? Nothing was recorded.",
        }
    return run_operations(ctx, [op], dates=decisions)


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
                evidence=_evidence(a),
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
    if action.status != "pending":
        return {
            "status": "error",
            "code": "NOT_PENDING",
            "action_id": str(action.id),
            "message": f"That operation is already {action.status}; nothing was done.",
        }
    # Only an operation KAIRA offered to THIS user for confirmation in a previous turn can be confirmed here;
    # anything else (another user's proposal, one never read back) goes through the Approvals screen.
    offer = _offered_for_confirmation(ctx, action_id=action.id)
    if offer is None:
        return {
            "status": "error",
            "code": "NOT_OFFERED",
            "message": "I can only confirm an operation I read back to you a moment ago. Nothing was done.",
        }
    if (offer.result or {}).get("proposal_hash") != proposal_hash(action):
        return {
            "status": "error",
            "code": "CHANGED_SINCE_READ_BACK",
            "message": "That operation was changed after I read it back, so I did not run it. Please review it.",
        }
    # The model deciding the user agreed is not enough: what the user said in THIS turn must be a clear yes.
    if not affirmed(_latest_utterance(ctx)):
        return {
            "status": "needs_clarification",
            "code": "NOT_AFFIRMED",
            "action_id": str(action.id),
            "summary": _proposal_summary(action),
            "message": "The user did not clearly say yes, so nothing was recorded. Answer what they asked; the "
            "read-back is still waiting for a yes or no.",
        }
    return _execute_action(ctx, action)


def _offered_for_confirmation(
    ctx: ToolContext,
    *,
    action_id: uuid.UUID | None = None,
    tool: str | None = None,
    match: Callable[[dict[str, Any]], bool] | None = None,
    minutes: int = 30,
) -> AgentToolExecution | None:
    """The execution of an earlier turn (not this one) of this user that returned needs_confirmation for it."""
    q = select(AgentToolExecution).where(
        AgentToolExecution.business_id == ctx.actor.business_id,
        AgentToolExecution.user_id == ctx.actor.user_id,
        AgentToolExecution.status == "needs_confirmation",
        AgentToolExecution.turn_id != ctx.turn_id,
        AgentToolExecution.created_at >= dt.datetime.now(dt.UTC) - dt.timedelta(minutes=minutes),
    )
    if action_id is not None:
        q = q.where(AgentToolExecution.proposed_action_id == action_id)
    if tool is not None:
        q = q.where(AgentToolExecution.tool_name == tool)
    rows = ctx.db.scalars(q.order_by(AgentToolExecution.created_at.desc()).limit(20)).all()
    return next((r for r in rows if match is None or match(r.arguments or {})), None)


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
    action = action_service.get_action(ctx.db, ctx.actor.business_id, aid)
    # Only something KAIRA read back to this user can be declined here; another user's proposal (e.g. staff work
    # waiting for the owner) is decided on the Approvals screen, never by a conversational "no".
    if _offered_for_confirmation(ctx, action_id=action.id, minutes=24 * 60) is None:
        return {
            "status": "error",
            "code": "NOT_OFFERED",
            "message": "I can only cancel an operation I read back to you. Nothing was changed.",
        }
    if action.status == "executed":
        return {
            "status": "error",
            "code": "NOT_PENDING",
            "message": "That operation was already recorded, so it cannot be cancelled here. Nothing was changed.",
        }
    if not declined(_latest_utterance(ctx)):
        return {
            "status": "needs_clarification",
            "code": "NOT_DECLINED",
            "message": "The user did not say no or cancel, so the read-back is still pending. Nothing was changed.",
        }
    action, _ = action_service.reject(ctx.db, ctx.actor, aid, "Declined in conversation with KAIRA")
    return {
        "status": "completed",
        "action_id": str(action.id),
        "rejected": True,
        "summary": f"Cancelled: {_proposal_summary(action)}. Nothing was recorded.",
    }


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
            "description": "true only when the user said yes to the correction you read back in an earlier turn",
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
    # A correction payment points back at its original through its idempotency key; corrections of the same
    # payment are summed so "6,000" then "7,000" records 1,000 then 1,000 more, never 2,000.
    if (pay.idempotency_key or "").startswith(CORRECTION_PREFIX):
        base_id = _uuid(pay.idempotency_key.split(":")[1])
        base = ctx.db.scalar(
            select(Payment).where(Payment.id == base_id, Payment.business_id == ctx.actor.business_id)
        )
        pay = base or pay
    already = q2(
        ctx.db.scalar(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.business_id == ctx.actor.business_id,
                Payment.idempotency_key.like(f"{CORRECTION_PREFIX}{pay.id}:%"),
            )
        )
    )
    recorded_total = q2(pay.amount + already)
    diff = q2(correct - recorded_total)
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
            "recorded_amount": m(recorded_total),
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
    # The model's `confirmed` flag alone is not enough: the same correction must have been offered for
    # confirmation to this user in an earlier turn (so the user actually heard it and said yes).
    offered = _offered_for_confirmation(
        ctx,
        tool="correct_payment_amount",
        match=lambda args: (
            _uuid(args.get("payment_id")) == pay.id and _amount(args.get("correct_amount")) == correct
        ),
    )
    evidenced = amount_evidenced(correct, _evidence(a), ctx.transcript)
    if not a.get("confirmed") or offered is None or not evidenced or not affirmed(_latest_utterance(ctx)):
        return {
            "status": "needs_confirmation",
            "recorded_amount": m(recorded_total),
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
        idempotency_key=f"{CORRECTION_PREFIX}{pay.id}:{m(correct)}",
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


# --------------------------------------------------------------------------- non-financial edits
EDIT_CONFIRMED = {
    "type": "boolean",
    "description": "true only when the user said yes to this exact change you read back in an earlier turn",
}
NOTE_KEYS = {"note": "notes", "notes": "note"}


def _tokens(text: str) -> list[str]:
    return [w for w in _PUNCT.split(normalise_text(text or "")) if w]


def _text_said(value: str, said: str) -> bool:
    """Free text (a note, an address) counts as said when its words are (nearly all) the user's words, and every
    number in it was said."""
    vt, st = _tokens(value), set(_tokens(said))
    if not vt or any(any(ch.isdigit() for ch in t) and t not in st for t in vt):
        return False
    return sum(t in st for t in vt) / len(vt) >= 0.75


def _value_said(field_name: str, value: str, said: str, fragment: str | None) -> bool:
    if field_name == "phone":
        digits = re.sub(r"\D", "", value)
        return len(digits) >= 6 and digits in re.sub(r"\D", "", said)
    if field_name == "email":
        v = value.strip().casefold()
        spoken = re.sub(r"\s+", "", normalise_text(said).replace(" at ", "@").replace(" dot ", "."))
        return bool(v) and (v in normalise_text(said) or v in spoken)
    if field_name == "invoice_number":
        n = re.sub(r"\D", "", value)
        return bool(n) and int(n) in {int(x) for x in re.findall(r"\d+", said)}
    if _text_said(value, said):
        return True
    return bool(fragment) and normalise_text(fragment) in normalise_text(said) and _text_said(value, fragment)


def _change_key(args: dict[str, Any]) -> str:
    return json.dumps(
        {k: v for k, v in sorted(args.items()) if k not in ("evidence", "confirmed")},
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    ).casefold()


def edit_gate(
    ctx: ToolContext,
    tool_name: str,
    a: dict[str, Any],
    values: dict[str, Any],
    *,
    customer: Customer | None = None,
    summary: str,
) -> dict[str, Any] | None:
    """None when the edit may run now: every changed value is in the user's words of this turn (and an id-only
    customer is not contradicted by a name they said), or the user said yes this turn to this exact change read
    back to them in an earlier turn. Otherwise a needs_confirmation result; nothing is written."""
    said = _latest_utterance(ctx)
    ev = _evidence(a)
    reasons = [
        f"the {k.replace('_', ' ')} '{v}' is not in what the user just said"
        for k, v in values.items()
        if v not in (None, "") and not _value_said(k, str(v), said, ev.get(k) or ev.get(NOTE_KEYS.get(k, k)))
    ]
    id_only = _uuid(a.get("customer_id")) and not (a.get("customer_name") or ev.get("customer_name"))
    if customer is not None and id_only:
        why = other_customer_named(ctx, customer.id, customer.name)
        if why:
            reasons.append(why)
    if not reasons:
        return None
    key = _change_key(a)
    if (
        a.get("confirmed")
        and affirmed(said)
        and _offered_for_confirmation(ctx, tool=tool_name, match=lambda args: _change_key(args) == key)
    ):
        return None
    return {
        "status": "needs_confirmation",
        "customer": customer.name if customer is not None else None,
        "summary": summary,
        "confirmation_reasons": reasons,
        "message": f"Nothing changed yet. Read the change back and ask the user to confirm; on yes call {tool_name} "
        "again with exactly the same values and confirmed=true.",
    }


@tool(
    "update_customer",
    "Change a customer's phone, email, address or notes.",
    {
        **CUSTOMER_REF,
        "phone": S,
        "email": S,
        "address": S,
        "notes": S,
        "evidence": EVIDENCE,
        "confirmed": EDIT_CONFIRMED,
    },
    kind="write",
    refresh=("customers",),
)
def update_customer(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    c, clar = find_customer(ctx, a, write=True)
    if clar:
        return clar
    changes = {k: str(a[k]).strip() for k in ("phone", "email", "address") if a.get(k)}
    said = {**changes, **({"notes": str(a["notes"]).strip()} if a.get("notes") else {})}
    if said:
        gate = edit_gate(
            ctx,
            "update_customer",
            a,
            said,
            customer=c,
            summary=f"Update {', '.join(f'{k} to {v}' for k, v in said.items())} for {c.name}",
        )
        if gate:
            return gate
    if a.get("notes"):
        # Notes hold the dated collection history: a new note is appended, never written over it.
        line = f"[{ctx.today.isoformat()}] {str(a['notes']).strip()[:400]}"
        changes["notes"] = f"{c.notes}\n{line}" if c.notes else line
    if not changes:
        return {"status": "needs_clarification", "message": "What should change?"}
    before = {k: getattr(c, k) for k in changes if k != "notes"}
    c = customer_service.update(ctx.db, ctx.actor, c.id, changes)
    return {
        "status": "completed",
        "customer_id": str(c.id),
        "customer": c.name,
        "changed": sorted(changes),
        "before": before,
        "after": {k: getattr(c, k) for k in changes if k != "notes"},
        "summary": f"Updated {', '.join(sorted(changes))} for {c.name}",
    }


@tool(
    "add_collection_note",
    "Add a dated collection note to a customer (e.g. 'said he will visit Friday'). Does not "
    "change any balance.",
    {**CUSTOMER_REF, "note": S, "evidence": EVIDENCE, "confirmed": EDIT_CONFIRMED},
    kind="write",
    required=("note",),
    refresh=("customers",),
)
def add_collection_note(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    c, clar = find_customer(ctx, a, write=True)
    if clar:
        return clar
    note = str(a.get("note") or "").strip()
    gate = edit_gate(
        ctx,
        "add_collection_note",
        a,
        {"note": note},
        customer=c,
        summary=f"Add the note '{note[:120]}' for {c.name}",
    )
    if gate:
        return gate
    line = f"[{ctx.today.isoformat()}] {a['note'].strip()[:400]}"
    c = customer_service.update(ctx.db, ctx.actor, c.id, {"notes": f"{c.notes}\n{line}" if c.notes else line})
    return {"status": "completed", "customer": c.name, "note": line}


@tool(
    "record_missed_promise",
    "The customer did NOT pay as promised: marks their due pending promise as broken and "
    "adds a collection note. Never touches payments.",
    {**CUSTOMER_REF, "note": S, "evidence": EVIDENCE, "confirmed": EDIT_CONFIRMED},
    kind="write",
    refresh=("financial",),
)
def record_missed_promise(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    c, clar = find_customer(ctx, a, write=True)
    if clar:
        return clar
    note = str(a.get("note") or "").strip()
    gate = edit_gate(
        ctx,
        "record_missed_promise",
        a,
        {"note": note},
        customer=c,
        summary=f"Mark {c.name}'s due promise as missed" + (f" with the note '{note[:120]}'" if note else ""),
    )
    if gate:
        return gate
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
    {
        "invoice_number": S,
        "due_date": {**S, "description": "YYYY-MM-DD"},
        "notes": S,
        "evidence": EVIDENCE,
        "confirmed": EDIT_CONFIRMED,
    },
    kind="write",
    required=("invoice_number",),
    refresh=("financial",),
)
def update_invoice(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    inv = find_invoice(ctx, a["invoice_number"])
    if inv is None:
        return {"status": "needs_clarification", "message": f"No invoice {a['invoice_number']}."}
    changes: dict[str, Any] = {}
    out_dates: list[dict[str, Any]] = []
    if a.get("due_date") or (a.get("evidence") or {}).get("due_date"):
        due = decide_date(
            ctx,
            a,
            "due_date",
            label="new due date",
            evidence_keys=("due_date", "date"),
            prefer=dateres.FUTURE,
        )
        out_dates.append(due.as_dict())
        # There is no read-back step for this edit, so any disagreement between the words and the proposed date
        # is asked about instead of being applied.
        if due.action in ("clarify", "confirm") or due.value is None:
            return {
                "status": "needs_clarification",
                "missing": ["due_date"],
                "dates": out_dates,
                "message": (due.message or "What is the new due date?") + " Nothing was changed.",
            }
        changes["due_date"] = due.value
    if a.get("notes"):
        changes["notes"] = a["notes"]
    if not changes:
        return {"status": "needs_clarification", "message": "What should change on the invoice?"}
    gate = edit_gate(
        ctx,
        "update_invoice",
        a,
        {
            "invoice_number": str(a["invoice_number"]),
            **({"notes": str(a["notes"])} if a.get("notes") else {}),
        },
        summary=f"Update {' and '.join(sorted(changes))} of {inv.invoice_number}"
        + (f" (due {changes['due_date'].isoformat()})" if "due_date" in changes else ""),
    )
    if gate:
        return gate
    before = inv.due_date.isoformat() if inv.due_date else None
    invoice_service.update_invoice(ctx.db, ctx.actor, inv.id, changes)
    row = invoice_row(invoice_service.invoice_detail(ctx.db, ctx.actor.business, inv.id))
    # The invoice's payment status must not overwrite the tool status ("unpaid" would read as not done).
    out = {
        **row,
        "payment_status": row["status"],
        "status": "completed",
        "changed": sorted(changes),
        "summary": f"Updated {' and '.join(sorted(changes))} of {row['invoice_number']}"
        + (f"; due {row['due_date']}" if "due_date" in changes else ""),
    }
    if "due_date" in changes:
        out["due_date_before"] = before
        out["dates"] = out_dates
    return out


def find_invoice(ctx: ToolContext, ref: Any) -> Invoice | None:
    """An invoice of this business by number as spoken: 'INV-0018', 'inv 18', '18'."""
    raw = str(ref or "").strip()
    if not raw:
        return None
    for number in dict.fromkeys([raw.upper(), normalise_invoice_number(raw)]):
        inv = ctx.db.scalar(
            select(Invoice).where(
                Invoice.business_id == ctx.actor.business_id, func.upper(Invoice.invoice_number) == number
            )
        )
        if inv is not None:
            return inv
    return None


@tool(
    "invoice_status",
    "Look up one invoice by number, e.g. before 'mark INV-0018 as paid'. An invoice is paid only "
    "when recorded payments settle it; KAIRA never marks one paid without a payment.",
    {"invoice_number": S},
    required=("invoice_number",),
)
def invoice_status(ctx: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    inv = find_invoice(ctx, a["invoice_number"])
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
