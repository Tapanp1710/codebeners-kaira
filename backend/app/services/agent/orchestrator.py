"""KAIRA agent orchestrator: one conversational turn = LLM tool-calling loop over the business tool registry.

Runs synchronously (call it from a worker thread in async code). Events are reported through `emit`.

Guarantees:
* Identity, business and role come from the database rows of the authenticated user, never from the model.
* A turn_id that was already processed replays the stored reply (duplicate final transcripts, reconnects,
  lost responses) instead of running tools again.
* Every tool call has an idempotency key (turn, tool, arguments). Its business writes and its execution record
  commit in one transaction, so a repeated call returns the stored result.
* The spoken reply may only contain amounts that appear in tool results, earlier conversation or the user's
  own words; otherwise it is replaced by the tools' own summaries.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.exceptions import AppError
from app.db.dependencies import AuthContext
from app.models import AgentMessage, AgentSession, AgentToolExecution, Business, User
from app.services.agent import dates as dateres
from app.services.agent import tools as toolset
from app.utils.dates import business_today

logger = logging.getLogger(__name__)
IGNORE = "[[IGNORE]]"
LANG_NAMES = {"te-IN": "Telugu", "hi-IN": "Hindi", "en-IN": "English"}
Emit = Callable[[dict[str, Any]], None]


def detect_language(text: str, hint: str | None) -> str:
    if hint in LANG_NAMES:
        return hint
    if re.search(r"[ఀ-౿]", text):
        return "te-IN"
    if re.search(r"[ऀ-ॿ]", text):
        return "hi-IN"
    return "en-IN"


def system_prompt(business: Business, role: str, today, language: str) -> str:
    return f"""You are KAIRA, the voice operations agent of "{business.name}", a small Indian business.
Today is {today.isoformat()} ({today.strftime("%A")}), timezone {business.timezone}, currency INR. You are talking
by voice with the business {role}.

Rules:
1. Every amount, balance, count, date and invoice number you say must come from a tool result in this
   conversation. Never estimate, add up or compute money yourself: call a tool.
2. To record or change anything, call the matching tool. Never say something was recorded, created or updated
   unless a tool result in this turn has status "completed".
3. A tool result with status "needs_clarification": ask one short question. "needs_confirmation": read the
   summary back briefly and ask the user to confirm; when they then say yes, call confirm_pending_action with
   that action_id (no on cancel_pending_action). "needs_owner_approval": say it is waiting for the owner.
   "error"/"rejected"/"unsupported": say plainly what happened.
4. For write tools, fill "evidence" with the user's exact words for each value, copied verbatim in the
   language and script they spoke. Never pass a value the user did not say (amounts above all).
5. Words like he/she/him/that customer/that invoice refer to the earlier conversation: reuse the customer_id or
   payment_id from earlier tool results.
6. A payment AND a promise for the rest in one statement -> record_payment_and_promise.
   "X did not pay" -> record_missed_promise (never a payment). "Mark INV-.. as paid" -> invoice_status first; an
   invoice is paid only through recorded payments. "Actually it was 6,000, not 5,000" -> correct_payment_amount.
7. Dates: {dateres.cheat_sheet(today)}. Pass dates as YYYY-MM-DD AND put the user's own date words in
   evidence under the same field name (e.g. evidence.expected_payment_date = "next Monday"); the server resolves
   those words itself and asks the user when they disagree with your date. Hindi "कल" means yesterday or
   tomorrow and "परसों" two days before or after: use the verb tense, and ask if it is unclear. When you say a
   date, say exactly the date in the tool result.
8. If the latest utterance is not addressed to you - background conversation, TV, a stray fragment with no
   business question or instruction - reply with exactly {IGNORE} and call no tool.
9. Your reply is spoken aloud: 1-3 short sentences, no lists, no markdown, no ids. Say amounts like ₹12,500.
   Reply in {LANG_NAMES.get(language, "English")}{" using Telugu script" if language == "te-IN" else ""}{" using Devanagari script" if language == "hi-IN" else ""}.
10. Nothing is ever sent to customers; reminders are drafts.
"""


@dataclass
class TurnResult:
    turn_id: str
    reply: str
    language: str
    ignored: bool = False
    replayed: bool = False
    tool_runs: list[dict[str, Any]] = field(default_factory=list)
    llm_calls: int = 0
    duration_ms: int = 0


def _actor(db: Session, user_id: UUID, business_id: UUID) -> AuthContext:
    user = db.get(User, user_id)
    business = db.get(Business, business_id)
    if user is None or business is None or not user.is_active or user.business_id != business_id:
        raise AppError("UNAUTHORIZED", "The session is no longer valid.", 401)
    return AuthContext(
        user_id=user.id, business_id=business.id, role=user.role, csrf="", user=user, business=business
    )


def _history(db: Session, business_id: UUID, user_id: UUID, limit: int) -> list[AgentMessage]:
    rows = db.scalars(
        select(AgentMessage)
        .where(
            AgentMessage.business_id == business_id,
            AgentMessage.user_id == user_id,
            AgentMessage.role.in_(("user", "assistant")),
        )
        .order_by(AgentMessage.created_at.desc())
        .limit(limit * 2)
    ).all()
    kept = [r for r in rows if not (r.data or {}).get("ignored")][:limit]
    return list(reversed(kept))


def _brief(result: dict[str, Any]) -> dict[str, Any]:
    """The identifiers and figures a later turn may need (customer_id, payment_id, balances)."""
    keep = {}
    for k, v in result.items():
        if k in (
            "customer_id",
            "customer",
            "outstanding",
            "status",
            "action_id",
            "summary",
            "invoice",
            "customer_outstanding_after",
            "invoice_outstanding_after",
            "total_received",
            "difference_recorded",
            "stored",
            "dates",
            "due_date",
            "expected_date",
        ):
            keep[k] = v
    for r in result.get("results", []) or []:
        if r.get("entity_type") == "payment":
            keep.setdefault("payment_ids", []).append(r["entity_id"])
    return keep


UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SUCCESS_CLAIM = re.compile(
    r"\b(i(?:'ve| have)? (?:recorded|created|added|updated|saved|marked)|has been (?:recorded|created|added|"
    r"updated|saved)|was (?:recorded|created|added|updated|saved)|is (?:now )?recorded|done)\b"
    r"|दर्ज कर|दर्ज हो|बना दिया|రికార్డ్ చేశ|నమోదు చేశ|సృష్టించా",
    re.IGNORECASE,
)


def claims_success(reply: str) -> bool:
    return bool(SUCCESS_CLAIM.search(reply or ""))


def _money_tokens(text: str) -> set[str]:
    return {t.replace(",", "") for t in re.findall(r"\d[\d,]*(?:\.\d+)?", text or "")}


def verify_reply(reply: str, allowed_text: str) -> bool:
    """True when every number of 100 or more in the reply appears in the allowed text (tool results, history,
    user words). Small numbers (days, counts, dates) are not checked."""
    allowed = _money_tokens(allowed_text)
    allowed |= {a.split(".")[0] for a in allowed}
    for tok in _money_tokens(reply):
        base = tok.split(".")[0]
        if base.isdigit() and int(base) >= 100 and tok not in allowed and base not in allowed:
            return False
    return True


def verify_reply_dates(reply: str, allowed_text: str, user_words: str, today) -> bool:
    """True when every explicit date in the reply (ISO, '25 November', '25th November 2026', Hindi/Telugu month
    names) is a date from the tool results / conversation, a date the user's own words resolve to, or today."""
    if not dateres.reply_dates(reply):
        return True
    allowed = dateres.iso_dates_in(allowed_text) | {today}
    for prefer in (dateres.PAST, dateres.FUTURE):
        allowed |= {m.date for m in dateres.find_dates(user_words, today, prefer=prefer) if m.date}
    return not dateres.unsupported_reply_dates(reply, allowed)


def _fallback_reply(tool_runs: list[dict[str, Any]], language: str) -> str:
    parts = []
    for r in tool_runs:
        res = r["result"]
        status = res.get("status")
        if status == "completed" and res.get("summary"):
            parts.append(str(res["summary"]).rstrip(".") + ".")
        elif status == "needs_confirmation" and res.get("summary"):
            # Spoken read-back built from the stored proposal (never the model-directed instruction text).
            notes = " ".join(
                str(d["message"])
                for d in res.get("dates") or []
                if isinstance(d, dict) and d.get("decision") == "confirm" and d.get("message")
            )
            parts.append(
                (notes + " " if notes else "")
                + f"Nothing is recorded yet: {res['summary']}. Shall I go ahead?"
            )
        elif status == "needs_owner_approval" and res.get("summary"):
            parts.append(f"{res['summary']}: waiting for the owner's approval.")
        elif res.get("message"):
            parts.append(str(res["message"]))
    return " ".join(parts) or UNVERIFIED.get(language, UNVERIFIED["en-IN"])


NUDGE = (
    "(System check, not the user: no write tool has completed in this turn, so nothing has been recorded yet. "
    "If the user asked you to record something, call the right tool now. Otherwise answer without saying that "
    "anything was recorded, created or updated.)"
)
NOTHING_RECORDED = {
    "en-IN": "I have not recorded anything yet. Please say it once more with the customer and the amount.",
    "hi-IN": "मैंने अभी कुछ भी दर्ज नहीं किया है। कृपया ग्राहक और रकम के साथ फिर से बताइए।",
    "te-IN": "నేను ఇంకా ఏదీ నమోదు చేయలేదు. దయచేసి కస్టమర్ పేరు, మొత్తంతో మళ్లీ చెప్పండి.",
}
UNVERIFIED = {
    "en-IN": "I could not verify those figures, so please check the screen.",
    "hi-IN": "मैं उन आंकड़ों की पुष्टि नहीं कर सका, कृपया स्क्रीन देखें।",
    "te-IN": "ఆ సంఖ్యలను నేను నిర్ధారించలేకపోయాను, దయచేసి స్క్రీన్ చూడండి.",
}


def _write_completed(tool_runs: list[dict[str, Any]]) -> bool:
    return any(
        r["result"].get("status") == "completed"
        and toolset.REGISTRY.get(r["tool"]) is not None
        and toolset.REGISTRY[r["tool"]].kind == "write"
        for r in tool_runs
    )


def _claims_new_change(reply: str) -> bool:
    """A question or a read-back ("shall I record...?") is not a claim of success."""
    return not reply.rstrip().endswith(("?", "？"))


def _exec_tool(
    factory: sessionmaker[Session],
    settings: Settings,
    sarvam,
    user_id: UUID,
    business_id: UUID,
    turn_id: str,
    name: str,
    args: dict[str, Any],
    transcript: str,
    language: str,
    known_ids: set[str] | None = None,
    current_text: str | None = None,
) -> dict[str, Any]:
    kind = toolset.REGISTRY[name].kind if name in toolset.REGISTRY else "read"
    started = time.perf_counter()
    if kind == "read":
        key = execution_key(user_id, turn_id, name, "read", time.time_ns())  # reads are never replayed
    else:
        key = execution_key(user_id, turn_id, name, operation_digest(args))
    with factory() as db:
        existing = db.scalar(
            select(AgentToolExecution).where(
                AgentToolExecution.business_id == business_id, AgentToolExecution.idempotency_key == key
            )
        )
        if existing is not None and existing.status != "running":
            return {**(existing.result or {}), "_replayed": True, "_execution_id": str(existing.id)}
        actor = _actor(db, user_id, business_id)
        ctx = toolset.ToolContext(
            db=db,
            actor=actor,
            settings=settings,
            today=business_today(actor.business.timezone),
            transcript=transcript,
            language=language,
            turn_id=turn_id,
            sarvam=sarvam,
            known_ids=set(known_ids or ()),
            current_text=current_text,
        )
        execution = AgentToolExecution(
            business_id=business_id,
            user_id=user_id,
            turn_id=turn_id,
            idempotency_key=key,
            tool_name=name,
            kind=kind,
            arguments=json.loads(json.dumps(args, default=str)),
        )
        try:
            db.add(execution)
            db.flush()
            result = toolset.run(ctx, name, args)
        except IntegrityError:
            db.rollback()
            existing = db.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.business_id == business_id, AgentToolExecution.idempotency_key == key
                )
            )
            return {
                **((existing.result if existing else None) or {"status": "error", "code": "IN_PROGRESS"}),
                "_replayed": True,
            }
        except AppError as exc:
            db.rollback()
            result = {"status": "error", "code": exc.code, "message": exc.message}
            execution = AgentToolExecution(
                business_id=business_id,
                user_id=user_id,
                turn_id=turn_id,
                idempotency_key=key + ":failed:" + str(int(time.time() * 1000)),
                tool_name=name,
                kind=kind,
                arguments=execution.arguments,
            )
            db.add(execution)
        except Exception:  # noqa: BLE001 - reported to the user as a failed step, never as success
            db.rollback()
            logger.exception("agent tool %s failed", name)
            result = {
                "status": "error",
                "code": "TOOL_FAILED",
                "message": "That step failed; nothing was changed.",
            }
            execution = AgentToolExecution(
                business_id=business_id,
                user_id=user_id,
                turn_id=turn_id,
                idempotency_key=key + ":failed:" + str(int(time.time() * 1000)),
                tool_name=name,
                kind=kind,
                arguments=execution.arguments,
            )
            db.add(execution)
        status = result.get("status", "completed")
        execution.status = {
            "needs_clarification": "needs_clarification",
            "needs_confirmation": "needs_confirmation",
            "needs_owner_approval": "needs_confirmation",
            "error": "failed",
            "rejected": "failed",
            "unsupported": "failed",
        }.get(status, "completed")
        if result.get("action_id"):
            try:
                execution.proposed_action_id = UUID(str(result["action_id"]))
            except ValueError:
                pass
        full = json.loads(json.dumps(result, default=str))
        # Read results can hold customer PII; only their status is kept. Write results are kept for replay.
        execution.result = full if kind == "write" else {"status": full.get("status", "completed")}
        execution.duration_ms = int((time.perf_counter() - started) * 1000)
        db.commit()
        return {**full, "_events": ctx.events, "_execution_id": str(execution.id)}


def execution_key(*parts: Any) -> str:
    """Fixed-length idempotency key ("x1:" + 64 hex = 67 chars; +":failed:<ms>" stays far below the column's 128).
    The same parts always give the same key, so replay lookups are unchanged."""
    return "x1:" + hashlib.sha256(":".join(str(p) for p in parts).encode()).hexdigest()


def operation_digest(args: dict[str, Any]) -> str:
    """What the operation does, not how the model phrased it: evidence and free text are excluded, so a
    regenerated call for the same payment maps to the same key."""
    free_text = {"evidence", "notes", "note", "description"}

    def norm(v: Any) -> Any:
        if isinstance(v, str):
            return " ".join(v.casefold().split())
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: norm(x) for k, x in sorted(v.items()) if k not in free_text}
        if isinstance(v, list):
            return [norm(x) for x in v]
        return v

    return hashlib.sha256(
        json.dumps(norm(args), sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()[:24]


def _stored_reply(db: Session, business_id: UUID, user_id: UUID, turn_id: str) -> AgentMessage | None:
    return db.scalar(
        select(AgentMessage).where(
            AgentMessage.business_id == business_id,
            AgentMessage.user_id == user_id,
            AgentMessage.turn_id == turn_id,
            AgentMessage.role == "assistant",
        )
    )


def _run_turn(
    factory: sessionmaker[Session],
    settings: Settings,
    sarvam,
    *,
    user_id: UUID,
    business_id: UUID,
    session_id: UUID | None,
    turn_id: str,
    text: str,
    language_hint: str | None,
    input_mode: str,
    emit: Emit,
    should_cancel: Callable[[], bool] = lambda: False,
    claim_state: dict[str, bool] | None = None,
) -> TurnResult:
    t0 = time.perf_counter()
    text = text.strip()
    language = detect_language(text, language_hint)
    with factory() as db:
        prior = _stored_reply(db, business_id, user_id, turn_id)
        if prior is not None:
            emit(
                {
                    "type": "reply",
                    "turn_id": turn_id,
                    "text": prior.content,
                    "language": prior.language,
                    "replayed": True,
                }
            )
            return TurnResult(turn_id, prior.content, prior.language or language, replayed=True)
        actor = _actor(db, user_id, business_id)
        today = business_today(actor.business.timezone)
        history = _history(db, business_id, user_id, settings.AGENT_HISTORY_MESSAGES)
        prompt = system_prompt(actor.business, actor.role, today, language)
        # Claim the turn atomically (unique business/user/turn/role): a concurrent duplicate - a client resend
        # while the first request is still running - waits for the stored reply instead of running again.
        db.add(
            AgentMessage(
                business_id=business_id,
                user_id=user_id,
                session_id=session_id,
                turn_id=turn_id,
                role="user",
                content=text,
                language=language,
                input_mode=input_mode,
            )
        )
        try:
            db.commit()
            claimed = True
            if claim_state is not None:
                claim_state["claimed"] = True
        except IntegrityError:
            db.rollback()
            claimed = False
    if not claimed:
        wait_until = time.perf_counter() + settings.AGENT_TURN_TIMEOUT_SECONDS
        while time.perf_counter() < wait_until:
            with factory() as db:
                prior = _stored_reply(db, business_id, user_id, turn_id)
            if prior is not None:
                emit(
                    {
                        "type": "reply",
                        "turn_id": turn_id,
                        "text": prior.content,
                        "language": prior.language,
                        "replayed": True,
                    }
                )
                return TurnResult(turn_id, prior.content, prior.language or language, replayed=True)
            time.sleep(0.5)
        emit({"type": "turn.failed", "turn_id": turn_id, "message": "That request is still being processed."})
        return TurnResult(turn_id, "", language, replayed=True)

    messages: list[dict[str, Any]] = [{"role": "system", "content": prompt}]
    recent_user_words = []
    allowed_text = text
    for h in history:
        if h.role == "user":
            messages.append({"role": "user", "content": h.content})
            recent_user_words.append(h.content)
        else:
            facts = (h.data or {}).get("facts")
            content = h.content + (
                f"\n(facts from tools: {json.dumps(facts, ensure_ascii=False)})" if facts else ""
            )
            messages.append({"role": "assistant", "content": content})
            allowed_text += " " + content
    # The reply language follows the latest utterance, not the earlier conversation (language switching).
    messages.append(
        {
            "role": "system",
            "content": f"The user's latest message is in {LANG_NAMES.get(language, 'English')}. Reply in "
            f"{LANG_NAMES.get(language, 'English')} only. Dates must be exactly as in tool results.",
        }
    )
    messages.append({"role": "user", "content": text})
    transcript_window = "\n".join([*recent_user_words[-4:], text])
    known_ids = set(UUID_RE.findall(allowed_text))

    emit({"type": "turn.started", "turn_id": turn_id, "text": text, "language": language})
    tool_runs: list[dict[str, Any]] = []
    reply = ""
    llm_calls = 0
    deadline = t0 + settings.AGENT_TURN_TIMEOUT_SECONDS
    specs = toolset.specs()
    nudged = False
    for _step in range(settings.AGENT_MAX_TOOL_STEPS):
        if should_cancel():
            emit({"type": "turn.cancelled", "turn_id": turn_id})
            if claim_state is not None:
                claim_state["cancelled"] = True
            return TurnResult(turn_id, "", language, tool_runs=tool_runs, llm_calls=llm_calls)
        if time.perf_counter() > deadline:
            reply = "That took too long, so I stopped. Nothing else was changed."
            break
        emit({"type": "thinking", "turn_id": turn_id})
        message, _usage = sarvam.chat_tools(messages, specs)
        llm_calls += 1
        calls = message.get("tool_calls") or []
        if not calls:
            reply = (message.get("content") or "").strip()
            if claims_success(reply) and not _write_completed(tool_runs) and not nudged:
                # The model says it did something it did not do. Tell it so once, then let it act or rephrase.
                nudged = True
                messages.append({"role": "assistant", "content": reply})
                messages.append({"role": "user", "content": NUDGE})
                continue
            break
        call = calls[0]
        name = call["function"]["name"]
        try:
            args = json.loads(call["function"].get("arguments") or "{}")
        except ValueError:
            args = {}
        tool = toolset.REGISTRY.get(name)
        if tool is not None and tool.kind == "write" and should_cancel():
            emit({"type": "turn.cancelled", "turn_id": turn_id})
            if claim_state is not None:
                claim_state["cancelled"] = True
            return TurnResult(turn_id, "", language, tool_runs=tool_runs, llm_calls=llm_calls)
        emit(
            {
                "type": "tool.started",
                "turn_id": turn_id,
                "tool": name,
                "kind": tool.kind if tool else "read",
                "arguments": {k: v for k, v in args.items() if k != "evidence"},
            }
        )
        result = _exec_tool(
            factory,
            settings,
            sarvam,
            user_id,
            business_id,
            turn_id,
            name,
            args,
            transcript_window,
            language,
            known_ids,
            text,
        )
        events = result.pop("_events", [])
        tool_runs.append({"tool": name, "arguments": args, "result": result})
        allowed_text += " " + json.dumps(result, ensure_ascii=False, default=str)
        known_ids |= set(UUID_RE.findall(json.dumps(result, default=str)))
        emit(
            {
                "type": "tool.completed",
                "turn_id": turn_id,
                "tool": name,
                "kind": tool.kind if tool else "read",
                "status": result.get("status", "completed"),
                "summary": result.get("summary") or result.get("message"),
                "result": result,
                "refresh": list(tool.refresh) if tool else [],
                "replayed": bool(result.get("_replayed")),
            }
        )
        for ev in events:
            emit({**ev, "turn_id": turn_id})
        messages.append(
            {
                "role": "assistant",
                "content": message.get("content") or "",
                "tool_calls": [
                    {
                        "id": call.get("id") or f"call_{len(tool_runs)}",
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
                    }
                ],
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": call.get("id") or f"call_{len(tool_runs)}",
                "content": json.dumps(
                    {k: v for k, v in result.items() if not k.startswith("_")},
                    ensure_ascii=False,
                    default=str,
                )[:6000],
            }
        )
    else:
        reply = reply or _fallback_reply(tool_runs, language)

    ignored = reply.strip() == IGNORE or (reply.strip().startswith(IGNORE) and not tool_runs)
    if (
        not ignored
        and claims_success(reply)
        and not _write_completed(tool_runs)
        and _claims_new_change(reply)
    ):
        logger.warning("agent reply claimed a change without a completed write; replaced")
        reply = NOTHING_RECORDED.get(language, NOTHING_RECORDED["en-IN"])
    if not ignored and not verify_reply(reply, allowed_text):
        logger.warning("agent reply contained unverified figures; replaced with tool summaries")
        reply = _fallback_reply(tool_runs, language)
    if not ignored and not verify_reply_dates(reply, allowed_text, transcript_window, today):
        logger.warning("agent reply contained a date that no tool result or user word supports; replaced")
        reply = _fallback_reply(tool_runs, language)
    if not ignored and not reply:
        reply = _fallback_reply(tool_runs, language)

    with factory() as db:
        if ignored:
            user_msg = db.scalar(
                select(AgentMessage).where(
                    AgentMessage.business_id == business_id,
                    AgentMessage.turn_id == turn_id,
                    AgentMessage.role == "user",
                )
            )
            if user_msg is not None:
                user_msg.data = {"ignored": True}
        facts = [{"tool": r["tool"], **toolset_brief(r["result"])} for r in tool_runs]
        db.add(
            AgentMessage(
                business_id=business_id,
                user_id=user_id,
                session_id=session_id,
                turn_id=turn_id,
                role="assistant",
                content="" if ignored else reply,
                language=language,
                data={"facts": facts, "ignored": ignored, "llm_calls": llm_calls},
            )
        )
        if session_id is not None:
            s = db.get(AgentSession, session_id)
            if s is not None:
                s.llm_calls += llm_calls
        db.commit()

    duration = int((time.perf_counter() - t0) * 1000)
    if ignored:
        emit({"type": "ignored", "turn_id": turn_id, "text": text})
    else:
        emit(
            {
                "type": "reply",
                "turn_id": turn_id,
                "text": reply,
                "language": language,
                "duration_ms": duration,
            }
        )
    return TurnResult(
        turn_id,
        "" if ignored else reply,
        language,
        ignored=ignored,
        tool_runs=tool_runs,
        llm_calls=llm_calls,
        duration_ms=duration,
    )


toolset_brief = _brief


def conversation(db: Session, business_id: UUID, user_id: UUID, limit: int = 50) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(AgentMessage)
        .where(AgentMessage.business_id == business_id, AgentMessage.user_id == user_id)
        .where(AgentMessage.created_at >= datetime.now(UTC) - timedelta(days=30))
        .order_by(AgentMessage.created_at.desc())
        .limit(limit)
    ).all()
    out = []
    for r in reversed(rows):
        if r.role == "tool" or (r.data or {}).get("ignored"):
            continue
        out.append(
            {
                "turn_id": r.turn_id,
                "role": r.role,
                "text": r.content,
                "language": r.language,
                "at": r.created_at.isoformat(),
                "facts": (r.data or {}).get("facts") if r.role == "assistant" else None,
            }
        )
    return out


def run_turn(*args: Any, **kwargs: Any) -> TurnResult:
    """Run one turn. If it raises or is cancelled (barge-in) after claiming the turn and no reply was stored, the
    claim is released, so resending the same turn_id runs it again instead of waiting for a reply that will never
    come. That is safe: every tool call that already ran replays from its execution record (no second
    payment)."""
    claim_state: dict[str, bool] = {"claimed": False, "cancelled": False}
    factory = args[0] if args else kwargs["factory"]
    try:
        result = _run_turn(*args, claim_state=claim_state, **kwargs)
    except BaseException:
        if claim_state["claimed"]:
            _release_claim(factory, kwargs)
        raise
    if claim_state["claimed"] and claim_state["cancelled"]:
        _release_claim(factory, kwargs)
    return result


def _release_claim(factory: sessionmaker[Session], kw: dict[str, Any]) -> None:
    try:
        with factory() as db:
            if _stored_reply(db, kw["business_id"], kw["user_id"], kw["turn_id"]) is None:
                db.query(AgentMessage).filter(
                    AgentMessage.business_id == kw["business_id"],
                    AgentMessage.user_id == kw["user_id"],
                    AgentMessage.turn_id == kw["turn_id"],
                    AgentMessage.role == "user",
                ).delete(synchronize_session=False)
                db.commit()
    except Exception:  # noqa: BLE001 - never mask the original failure
        logger.exception("could not release the claim of a failed agent turn")
