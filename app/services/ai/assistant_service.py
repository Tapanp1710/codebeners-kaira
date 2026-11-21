"""Assistant orchestration: extraction, conversational queries and reminder drafts.

The LLM may interpret a request and (optionally) translate an answer. Every number in an
answer is computed by backend services; translations that alter any number are discarded
in favour of the English text."""

from __future__ import annotations

import logging
import re
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.exceptions import AppError, BusinessRuleError, NotFoundError
from app.integrations.sarvam import SarvamClient
from app.models import Conversation
from app.schemas.ai import (
    QUERY_INTENTS,
    WRITE_INTENTS,
    AnswerOut,
    ExtractionOutput,
    ExtractRequest,
    ExtractResponse,
    Operation,
    ReminderOut,
)
from app.services import customer_service, forecast_service, ledger, receivables_service
from app.services.ai import action_service
from app.services.ai.llm_extractor import SarvamExtractor
from app.services.ai.resolution import Warn, analyse, resolve_customer, verify_evidence
from app.services.ai.rules_extractor import RulesExtractor
from app.utils.dates import business_today
from app.utils.money import ZERO, q2

logger = logging.getLogger(__name__)
LANG_NAMES = {"te-IN": "Telugu", "hi-IN": "Hindi", "en-IN": "English"}


def inr(amount: Decimal) -> str:
    """Indian digit grouping: 150000.5 -> ₹1,50,000.50"""
    amount = q2(amount)
    sign = "-" if amount < 0 else ""
    whole, frac = f"{abs(amount):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        head = ",".join(re.findall(r"\d{1,2}", head[::-1]))[::-1]
        whole = f"{head},{tail}"
    return f"{sign}₹{whole}.{frac}"


def get_extractor(settings: Settings, client: SarvamClient, timezone: str):
    if settings.extraction_provider == "sarvam":
        return SarvamExtractor(client, timezone)
    return RulesExtractor()


# ------------------------------------------------------------------ extract
def extract(
    db: Session, ctx, settings: Settings, client: SarvamClient, req: ExtractRequest
) -> ExtractResponse:
    business = ctx.business
    today = business_today(business.timezone)
    extractor = get_extractor(settings, client, business.timezone)
    conversation = Conversation(
        business_id=ctx.business_id,
        user_id=ctx.user_id,
        transcript=req.transcript,
        language=req.language,
        input_mode=req.input_mode,
        provider=extractor.name,
        processing_status="received",
    )
    db.add(conversation)
    db.flush()
    try:
        output: ExtractionOutput = extractor.extract(req.transcript, today, req.language)
    except AppError:
        conversation.processing_status = "failed"
        db.commit()
        raise
    language = req.language or output.language
    conversation.language = language
    ops = output.operations
    writes = [o for o in ops if o.type in WRITE_INTENTS]
    queries = [o for o in ops if o.type in QUERY_INTENTS]
    reminders = [o for o in ops if o.type == "request_payment_reminder"]

    response = ExtractResponse(
        conversation_id=conversation.id,
        transcript=req.transcript,
        language=language,
        provider=extractor.name,
        kind="unknown",
    )
    if writes:
        analysis = analyse(db, business, today, req.transcript, writes, verify=True)
        action = action_service.create_proposal(
            db, ctx, conversation, writes, analysis, language, extractor.name
        )
        response.kind = "proposal"
        response.proposal = action_service.present(action)
        conversation.processing_status = "proposed"
    if queries:
        response.answer = answer(db, ctx, settings, client, queries[0], req.transcript, language)
        if not writes:
            response.kind = "answer"
            conversation.processing_status = "answered"
    if reminders and not writes and not queries:
        op = reminders[0]
        verify_evidence(req.transcript, op, 0, [])
        customer = resolve_customer(db, ctx.business_id, op, {})
        if customer.status == "resolved":
            response.reminder = draft_reminder(
                db, ctx, settings, client, customer.id, None, language or "en-IN"
            )
            response.kind = "reminder"
            conversation.processing_status = "answered"
        else:
            response.message = (
                f"I could not identify the customer '{op.customer_name}'."
                if customer.status == "not_found"
                else "Several customers match that name. Please choose one."
            )
    if response.kind == "unknown" and not response.message:
        response.message = (
            "I could not understand that as a business operation or question. Try, for example: "
            "'Ramesh paid me 5,000 rupees today' or 'How much do my customers owe me?'"
        )
        conversation.processing_status = "not_understood"
    return response


# ------------------------------------------------------------------ queries
def answer(
    db: Session,
    ctx,
    settings: Settings,
    client: SarvamClient,
    op: Operation,
    transcript: str,
    language: str | None,
) -> AnswerOut:
    business = ctx.business
    cur_lang = language or "en-IN"
    verify_evidence(transcript, op, 0, [])
    if op.type == "query_customer_balance":
        text, data = _answer_customer(db, business, op)
    elif op.type == "query_receivables":
        text, data = _answer_receivables(db, business)
    else:
        text, data = _answer_cash(db, business, op)
    final_text, final_lang = translate_preserving_numbers(settings, client, text, cur_lang)
    return AnswerOut(
        intent=op.type, language=cur_lang, answer=final_text, answer_language=final_lang, data=data
    )


def _answer_customer(db, business, op: Operation) -> tuple[str, dict[str, Any]]:
    res = resolve_customer(db, business.id, op, {})
    if res.status == "ambiguous":
        names = ", ".join(c["label"] for c in res.candidates)
        return f"Several customers match '{op.customer_name}': {names}. Which one do you mean?", {
            "candidates": res.candidates
        }
    if res.status != "resolved":
        return f"I could not find a customer named '{op.customer_name}'.", {}
    s = customer_service.summary(db, business, res.id)
    parts = [f"{s.customer.name} owes {inr(s.outstanding)}"]
    if s.overdue > ZERO:
        parts.append(f", of which {inr(s.overdue)} is overdue")
    parts.append(f" across {s.open_invoice_count} open invoice(s).")
    if s.pending_commitments > ZERO:
        parts.append(f" They have promised {inr(s.pending_commitments)}.")
    return "".join(parts), {
        "customer_id": str(s.customer.id),
        "customer_name": s.customer.name,
        "outstanding": str(s.outstanding),
        "overdue": str(s.overdue),
        "open_invoice_count": s.open_invoice_count,
        "pending_commitments": str(s.pending_commitments),
    }


def _answer_receivables(db, business) -> tuple[str, dict[str, Any]]:
    rs = receivables_service.summary(db, business)
    if rs.total_outstanding <= ZERO:
        return "No customer owes you money right now.", {"total_outstanding": "0.00"}
    text = (
        f"Customers owe you {inr(rs.total_outstanding)} across {rs.open_invoice_count} invoice(s). "
        f"{inr(rs.total_overdue)} is overdue on {rs.overdue_invoice_count} invoice(s)."
    )
    overdue_customers = [c for c in rs.customers if c.overdue > ZERO][:3]
    if overdue_customers:
        text += (
            " Not yet paid (overdue): "
            + ", ".join(f"{c.customer_name} {inr(c.overdue)}" for c in overdue_customers)
            + "."
        )
    if rs.commitments_due_next_7_days > ZERO:
        text += f" {inr(rs.commitments_due_next_7_days)} is promised within 7 days."
    return text, {
        "total_outstanding": str(rs.total_outstanding),
        "total_overdue": str(rs.total_overdue),
        "open_invoice_count": rs.open_invoice_count,
        "overdue_invoice_count": rs.overdue_invoice_count,
        "overdue_customers": [
            {"customer_id": str(c.customer_id), "name": c.customer_name, "overdue": str(c.overdue)}
            for c in overdue_customers
        ],
        "pending_commitments_total": str(rs.pending_commitments_total),
    }


def _answer_cash(db, business, op: Operation) -> tuple[str, dict[str, Any]]:
    cash = ledger.cash_position(db, business)
    if op.delay_days:
        customer_id = None
        if op.customer_name:
            res = resolve_customer(db, business.id, op, {})
            if res.status != "resolved":
                return f"I could not identify the customer '{op.customer_name}'.", {}
            customer_id = res.id
        try:
            sim = forecast_service.simulate_delay(
                db,
                business,
                delay_days=op.delay_days,
                customer_id=customer_id,
                largest=customer_id is None,
                horizon_days=90,
            )
        except (BusinessRuleError, NotFoundError) as exc:
            return exc.message, {}
        return sim.explanation, {
            "simulation": True,
            "target": sim.target_label,
            "delay_days": sim.delay_days,
            "baseline_lowest_balance": str(sim.baseline.lowest_balance),
            "simulated_lowest_balance": str(sim.simulated.lowest_balance),
            "new_shortfall_dates": [d.isoformat() for d in sim.new_shortfall_dates],
        }
    if op.horizon_days:
        p = forecast_service.forecast(db, business, op.horizon_days)
        text = (
            f"You have {inr(cash.current_cash)} now. After {op.horizon_days} days you are projected to have "
            f"{inr(p.end_balance)} (expected in {inr(p.expected_inflows)}, out {inr(p.expected_outflows)}). "
            f"The lowest point is {inr(p.lowest_balance)} on {p.lowest_balance_date.isoformat()}."
        )
        if p.shortfalls:
            text += f" Warning: cash is projected to fall below the threshold from {p.shortfalls[0].start.isoformat()}."
        return text, {
            "current_cash": str(cash.current_cash),
            "horizon_days": op.horizon_days,
            "projected_balance": str(p.end_balance),
            "lowest_balance": str(p.lowest_balance),
            "lowest_balance_date": p.lowest_balance_date.isoformat(),
            "projected": True,
        }
    today = business_today(business.timezone)
    bills = [
        b
        for b in ledger.bill_balances(db, business.id, today, open_only=True)
        if b.bill.due_date <= today + timedelta(days=14)
    ]
    text = f"Your current cash is {inr(cash.current_cash)}."
    if bills:
        total = q2(sum((b.outstanding for b in bills), ZERO))
        text += f" {len(bills)} bill(s) totalling {inr(total)} are due in the next 14 days."
    return text, {"current_cash": str(cash.current_cash), "bills_due_14_days": len(bills)}


def translate_preserving_numbers(
    settings: Settings, client: SarvamClient, text: str, language: str
) -> tuple[str, str]:
    if language == "en-IN" or not settings.sarvam_configured:
        return text, "en-IN"
    try:
        translated = client.chat_text(
            [
                {
                    "role": "system",
                    "content": (
                        f"Translate the user's message into natural, polite {LANG_NAMES.get(language, 'English')} "
                        "for a small-business owner. Keep every number, amount, ₹ sign and date exactly as written "
                        "(same digits). Output only the translation."
                    ),
                },
                {"role": "user", "content": text},
            ]
        ).strip()
    except AppError as exc:
        logger.warning("Translation failed: %s", exc.code)
        return text, "en-IN"
    numbers = re.findall(r"\d[\d,]*(?:\.\d+)?", text)
    if all(n in translated for n in numbers):
        return translated, language
    logger.warning("Translation altered numbers; using English answer")
    return text, "en-IN"


# ------------------------------------------------------------------ reminders
def draft_reminder(
    db: Session,
    ctx,
    settings: Settings,
    client: SarvamClient,
    customer_id: uuid.UUID,
    invoice_id: uuid.UUID | None,
    language: str,
    tone: str = "friendly",
) -> ReminderOut:
    business = ctx.business
    today = business_today(business.timezone)
    customer = customer_service.get(db, business.id, customer_id)
    balances = ledger.invoice_balances(db, business.id, today, customer_id=customer_id, open_only=True)
    if invoice_id is not None:
        balances = [b for b in balances if b.invoice.id == invoice_id]
        if not balances:
            raise BusinessRuleError("NOTHING_OUTSTANDING", "That invoice has no outstanding balance.")
    if not balances:
        raise BusinessRuleError("NOTHING_OUTSTANDING", f"{customer.name} has no outstanding invoices.")
    total = q2(sum((b.outstanding for b in balances), ZERO))
    overdue = q2(sum((b.outstanding for b in balances if b.is_overdue), ZERO))
    lines = "; ".join(
        f"{b.invoice.invoice_number} - {inr(b.outstanding)} (due {b.invoice.due_date.strftime('%d %b %Y')})"
        for b in balances
    )
    if tone == "firm" and overdue > ZERO:
        max_days = max(b.days_overdue for b in balances)
        pay_by = (today + timedelta(days=3)).strftime("%d %b %Y")
        text = (
            f"Dear {customer.name}, this is a reminder from {business.name} that {inr(overdue)} is overdue "
            f"(up to {max_days} days). Outstanding: {lines}. Total due: {inr(total)}. "
            f"Please clear the payment by {pay_by}. Thank you."
        )
    else:
        text = (
            f"Hello {customer.name}, this is a gentle reminder from {business.name}. "
            f"The following amount is pending: {lines}. Total: {inr(total)}. "
            "Kindly arrange the payment at your earliest convenience. Thank you!"
        )
    final, final_lang = translate_preserving_numbers(settings, client, text, language)
    return ReminderOut(
        customer_id=customer.id,
        customer_name=customer.name,
        invoice_ids=[b.invoice.id for b in balances],
        total_outstanding=total,
        overdue_amount=overdue,
        language=final_lang,
        tone=tone,
        message=final,
        generated_by="template+sarvam_translation" if final_lang != "en-IN" else "template",
    )


__all__ = ["Warn", "answer", "draft_reminder", "extract", "get_extractor", "inr"]
