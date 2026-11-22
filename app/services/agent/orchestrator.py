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
7. Convert relative dates to YYYY-MM-DD from today. "next Monday" = the first Monday after today.
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
        .limit(limit)
    ).all()
    return list(reversed(rows))


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
        ):
            keep[k] = v
    for r in result.get("results", []) or []:
        if r.get("entity_type") == "payment":
            keep.setdefault("payment_ids", []).append(r["entity_id"])
    return keep


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


def _fallback_reply(tool_runs: list[dict[str, Any]], language: str) -> str:
    parts = []
    for r in tool_runs:
        res = r["result"]
        if res.get("status") == "completed" and res.get("summary"):
            parts.append(str(res["summary"]))
        elif res.get("message"):
            parts.append(str(res["message"]))
    return " ".join(parts) or "I could not verify those figures, so please check the screen."


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
) -> dict[str, Any]:
    kind = toolset.REGISTRY[name].kind if name in toolset.REGISTRY else "read"
    digest = hashlib.sha256(
        json.dumps(args, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()[:20]
    key = f"{turn_id}:{name}:{digest}"
    started = time.perf_counter()
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
        execution.result = json.loads(json.dumps(result, default=str))
        execution.duration_ms = int((time.perf_counter() - started) * 1000)
        if ctx.events:
            execution.result["_events"] = ctx.events
        db.commit()
        return {**execution.result, "_execution_id": str(execution.id)}


def run_turn(
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
) -> TurnResult:
    t0 = time.perf_counter()
    text = text.strip()
    language = detect_language(text, language_hint)
    with factory() as db:
        prior = db.scalar(
            select(AgentMessage).where(
                AgentMessage.business_id == business_id,
                AgentMessage.turn_id == turn_id,
                AgentMessage.role == "assistant",
            )
        )
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
        if not db.scalar(
            select(AgentMessage.id).where(
                AgentMessage.business_id == business_id,
                AgentMessage.turn_id == turn_id,
                AgentMessage.role == "user",
            )
        ):
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
            db.commit()
        prompt = system_prompt(actor.business, actor.role, today, language)

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
    messages.append({"role": "user", "content": text})
    transcript_window = "\n".join([*recent_user_words[-4:], text])

    emit({"type": "turn.started", "turn_id": turn_id, "text": text, "language": language})
    tool_runs: list[dict[str, Any]] = []
    reply = ""
    llm_calls = 0
    deadline = t0 + settings.AGENT_TURN_TIMEOUT_SECONDS
    specs = toolset.specs()
    for _step in range(settings.AGENT_MAX_TOOL_STEPS):
        if should_cancel():
            emit({"type": "turn.cancelled", "turn_id": turn_id})
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
            break
        call = calls[0]
        name = call["function"]["name"]
        try:
            args = json.loads(call["function"].get("arguments") or "{}")
        except ValueError:
            args = {}
        tool = toolset.REGISTRY.get(name)
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
            factory, settings, sarvam, user_id, business_id, turn_id, name, args, transcript_window, language
        )
        events = result.pop("_events", [])
        tool_runs.append({"tool": name, "arguments": args, "result": result})
        allowed_text += " " + json.dumps(result, ensure_ascii=False, default=str)
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
    if not ignored and not verify_reply(reply, allowed_text):
        logger.warning("agent reply contained unverified figures; replaced with tool summaries")
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
