"""Deterministic English extractor.

Used when no LLM is configured (typed workflows keep working without credentials) and
in tests. It only extracts values that literally appear in the transcript and records
the verbatim fragment for every value as evidence. It does not understand Telugu or
Hindi script; those require the Sarvam LLM provider."""

from __future__ import annotations

import re
from datetime import date

from app.schemas.ai import ExtractionOutput, Operation
from app.services.ai import text_parse as tp

PRONOUNS = {"he", "she", "they", "him", "her", "it", "i", "we", "me", "us", "you"}
NON_NAMES = PRONOUNS | {
    "customer",
    "customers",
    "my",
    "the",
    "a",
    "an",
    "someone",
    "somebody",
    "everyone",
    "people",
    "client",
    "clients",
    "what",
    "who",
    "which",
    "how",
}
NAME = r"(?P<name>[A-Za-z][A-Za-z.'-]+(?:\s(?-i:[A-Z])[A-Za-z.'-]+)?)"
AMT = tp.AMOUNT_RE
F = re.IGNORECASE

P_PAYMENT = [
    re.compile(
        rf"\b{NAME}\s+(?:has\s+|just\s+|already\s+)?(?:paid|gave|sent|transferred|cleared)\s+(?:me\s+|us\s+)?{AMT}",
        F,
    ),
    re.compile(rf"\b(?:received|got|collected)\s+{AMT}\s+from\s+{NAME}", F),
]
P_COMMIT = re.compile(
    rf"\b(?:(?P<pron>he|she|they)|{NAME})\s+(?:will|'ll|shall|promised to|said (?:he|she|they)(?: will|'ll))\s+"
    rf"(?:clear|pay|settle|give|send|transfer)\s+(?:me\s+|us\s+)?(?:the\s+)?"
    rf"(?:(?P<rem>remaining|rest|balance|pending|remaining amount|rest of the amount|balance amount)\b|{AMT})",
    F,
)
P_INVOICE = re.compile(
    rf"\b(?:create|make|raise|generate|prepare|issue)\s+(?:an?\s+)?(?:new\s+)?invoice\s+(?:for|to)\s+{NAME}\s+"
    rf"(?:for|of|worth|amounting to)\s+{AMT}(?:\s+for\s+(?P<desc>[^,.;]+?))?(?=\s+due\b|[,.;]|$)",
    F,
)
P_EXPENSE_PAID = re.compile(
    rf"\b(?:i|we)\s+(?:have\s+)?(?:paid|spent)\s+{AMT}\s+(?:for|on|to|towards)\s+(?P<what>[^,.;]+?)(?=\s+(?:today|yesterday|on|by|via|through|in cash|by upi)\b|[,.;]|$)",
    F,
)
P_EXPENSE_BILL = re.compile(
    rf"\b(?:add|record|log|enter|create)\s+(?:an?\s+)?(?:new\s+)?(?:expense|bill)\s+(?:of|for)\s+{AMT}\s+"
    rf"(?:for|from|to|towards)\s+(?P<what>[^,.;]+?)(?=\s+due\b|\s+(?:today|tomorrow|on|by)\b|[,.;]|$)",
    F,
)
P_CUSTOMER = re.compile(
    rf"\b(?:add|create|register)\s+(?:a\s+)?(?:new\s+)?customer\s+(?:named\s+|called\s+)?{NAME}", F
)
P_SALE = re.compile(
    rf"\b(?:sold\s+(?P<what>[^,.;]+?)\s+(?:for|worth)|(?:cash\s+)?sale\s+of|made\s+a\s+sale\s+of)\s+{AMT}", F
)
P_REMINDER = re.compile(
    rf"\b(?:draft|write|send|prepare|create|make)\s+(?:a\s+)?(?:payment\s+)?reminder\s+(?:for|to)\s+{NAME}", F
)
P_Q_CUSTOMER = [
    re.compile(rf"\bhow much (?:does|do|did|will) {NAME} (?:still )?owe", F),
    re.compile(rf"\bwhat (?:does|do) {NAME} (?:still )?owe", F),
    re.compile(rf"\b{NAME}(?:'s)? (?:balance|outstanding|dues)\b", F),
]
P_Q_SIMULATE = re.compile(
    r"\bwhat (?:happens|if|would happen)\b.*?\b(?P<who>biggest|largest|top|major|main)?\s*customer\b.*?\b(?P<n>\d{1,3})\s+days?\s+late",
    F,
)
P_Q_SIMULATE_NAME = re.compile(
    rf"\bwhat (?:happens|would happen) if {NAME} pays? (?P<n>\d{{1,3}})\s+days?\s+late", F
)
P_Q_HORIZON = re.compile(r"\bcash\b.*?\b(?:after|in|over)\s+(?:the\s+)?(?:next\s+)?(?P<n>\d{1,3})\s+days?", F)
P_Q_CASH = re.compile(
    r"\b(?:current cash|cash position|cash in hand|cash balance|how much cash|bank balance|which bills|bills (?:are )?(?:coming )?due|upcoming bills)\b",
    F,
)
P_Q_RECEIVABLES = re.compile(
    r"\b(?:how much do (?:my )?customers owe|how much (?:money )?(?:am i|are we) owed|receivables?|who (?:has|have)(?: not|n't) paid|"
    r"who hasn't paid|which invoices are overdue|overdue invoices|unpaid invoices|what payments are expected|expected payments|outstanding (?:amount|invoices|payments))\b",
    F,
)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?;])\s+|\n+")


def _name(m: re.Match) -> str | None:
    name = m.groupdict().get("name")
    if not name:
        return None
    name = name.strip(" .'-")
    first = name.split()[0].lower()
    if first in NON_NAMES:
        return None
    return name


def _amount(m: re.Match):
    if not m.groupdict().get("amt"):
        return None
    return tp.parse_amount(m["amt"], m.groupdict().get("mult"))


def _amount_fragment(m: re.Match) -> str:
    start, end = m.span("amt")
    if m.groupdict().get("mult") and m.end("mult") > end:
        end = m.end("mult")
    return m.string[start:end]


class RulesExtractor:
    name = "rules"

    def extract(self, transcript: str, today: date, language: str | None = None) -> ExtractionOutput:
        ops: list[Operation] = []
        last_customer: tuple[str, str] | None = None  # (name, fragment)
        for sentence in [s for s in _SENTENCE_SPLIT.split(transcript) if s.strip()]:
            found = self._sentence(sentence, today, last_customer)
            for op in found:
                if op.customer_name:
                    last_customer = (op.customer_name, op.evidence.get("customer_name", op.customer_name))
            ops.extend(found)
        if not ops:
            ops = [Operation(type="unknown")]
        return ExtractionOutput(language=language or "en-IN", operations=ops[:5])

    # ------------------------------------------------------------------
    def _sentence(self, s: str, today: date, last_customer) -> list[Operation]:
        ops: list[Operation] = []

        q = self._query(s)
        if q is not None:
            return [q]

        m = P_REMINDER.search(s)
        if m and _name(m):
            return [
                Operation(
                    type="request_payment_reminder",
                    customer_name=_name(m),
                    evidence={"customer_name": m["name"]},
                )
            ]

        m = P_CUSTOMER.search(s)
        if m and _name(m):
            ev = {"customer_name": m["name"]}
            phone = re.search(r"(\+?\d[\d\s-]{8,}\d)", s)
            op = Operation(type="create_customer", customer_name=_name(m), evidence=ev)
            ev = op.evidence
            if phone:
                op.phone = re.sub(r"[\s-]", "", phone.group(1))
                ev["phone"] = phone.group(1)
            return [op]

        m = P_INVOICE.search(s)
        if m and _name(m) and _amount(m):
            ev = {"customer_name": m["name"], "amount": _amount_fragment(m)}
            op = Operation(type="create_invoice", customer_name=_name(m), amount=_amount(m), evidence=ev)
            ev = op.evidence
            if m["desc"]:
                op.description = m["desc"].strip()
                ev["description"] = m["desc"].strip()
            due = re.search(r"\bdue\b(.*)$", s, F)
            if due:
                found = tp.find_date(due.group(1), today)
                if found:
                    op.due_date, ev["due_date"] = found
            return [op]

        for rx, paid in ((P_EXPENSE_PAID, True), (P_EXPENSE_BILL, False)):
            m = rx.search(s)
            if m and _amount(m):
                what = m["what"].strip()
                ev = {"amount": _amount_fragment(m), "vendor_name": what}
                op = Operation(
                    type="create_expense",
                    vendor_name=what,
                    description=what,
                    amount=_amount(m),
                    paid_now=paid,
                    evidence=ev,
                )
                ev = op.evidence
                if paid:
                    ev["paid_now"] = m.group(0)
                    found = tp.find_date(s[m.end() :], today, prefer="past")
                    if found:
                        op.date, ev["date"] = found
                else:
                    due = re.search(r"\bdue\b(.*)$", s, F)
                    found = tp.find_date(due.group(1) if due else s[m.end() :], today)
                    if found:
                        op.due_date, ev["due_date"] = found
                method = tp.find_method(s)
                if method and paid:
                    op.payment_method, ev["payment_method"] = method
                return [op]

        for rx in P_PAYMENT:
            m = rx.search(s)
            if m and _name(m) and _amount(m):
                ev = {"customer_name": m["name"], "amount": _amount_fragment(m)}
                op = Operation(type="record_payment", customer_name=_name(m), amount=_amount(m), evidence=ev)
                ev = op.evidence
                found = tp.find_date(s, today, prefer="past")
                if found:
                    op.date, ev["date"] = found
                method = tp.find_method(s)
                if method:
                    op.payment_method, ev["payment_method"] = method
                ref = tp.find_invoice_reference(s)
                if ref:
                    op.invoice_reference, ev["invoice_reference"] = ref
                ops.append(op)
                break

        m = P_COMMIT.search(s)
        if m:
            name = _name(m)
            ev: dict[str, str] = {}
            if name:
                ev["customer_name"] = m["name"]
            elif m["pron"]:
                if ops and ops[-1].customer_name:
                    name, ev["customer_name"] = ops[-1].customer_name, ops[-1].evidence["customer_name"]
                elif last_customer:
                    name, ev["customer_name"] = last_customer
            op = Operation(type="create_payment_commitment", customer_name=name, evidence=ev)
            ev = op.evidence
            if m["rem"]:
                op.amount_is_remaining = True
                ev["amount_is_remaining"] = m["rem"]
            elif _amount(m):
                op.amount = _amount(m)
                ev["amount"] = _amount_fragment(m)
            found = tp.find_date(s[m.end() :], today) or tp.find_date(s, today)
            if found:
                op.expected_payment_date, ev["expected_payment_date"] = found
            ref = tp.find_invoice_reference(s)
            if ref:
                op.invoice_reference, ev["invoice_reference"] = ref
            ops.append(op)

        if not ops:
            m = P_SALE.search(s)
            if m and _amount(m):
                ev = {"amount": _amount_fragment(m)}
                op = Operation(type="record_sale", amount=_amount(m), evidence=ev)
                ev = op.evidence
                if m["what"]:
                    op.description = m["what"].strip()
                    ev["description"] = m["what"].strip()
                found = tp.find_date(s, today, prefer="past")
                if found:
                    op.date, ev["date"] = found
                ops.append(op)
        return ops

    def _query(self, s: str) -> Operation | None:
        m = P_Q_SIMULATE_NAME.search(s)
        if m and _name(m):
            return Operation(
                type="query_cash_position",
                customer_name=_name(m),
                delay_days=int(m["n"]),
                evidence={"customer_name": m["name"], "delay_days": m["n"]},
            )
        m = P_Q_SIMULATE.search(s)
        if m:
            op = Operation(
                type="query_cash_position", delay_days=int(m["n"]), evidence={"delay_days": m["n"]}
            )
            if m["who"]:
                op.target = "largest_customer"
                op.evidence["target"] = m["who"]
            return op
        for rx in P_Q_CUSTOMER:
            m = rx.search(s)
            if m and _name(m) and _name(m).lower() not in ("customers", "my customers"):
                return Operation(
                    type="query_customer_balance",
                    customer_name=_name(m),
                    evidence={"customer_name": m["name"]},
                )
        m = P_Q_HORIZON.search(s)
        if m:
            return Operation(
                type="query_cash_position", horizon_days=int(m["n"]), evidence={"horizon_days": m["n"]}
            )
        if P_Q_RECEIVABLES.search(s):
            return Operation(type="query_receivables")
        if P_Q_CASH.search(s):
            return Operation(type="query_cash_position")
        return None
