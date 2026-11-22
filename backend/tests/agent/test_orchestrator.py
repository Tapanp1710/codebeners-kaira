"""MOCKED LLM/STT/TTS: agent orchestrator turns against PostgreSQL with the seeded demo business.

The Sarvam client is replaced by FakeSarvam, whose chat_tools() returns scripted assistant messages (tool calls,
then a final text). Everything else - tools, proposal pipeline, ledger, idempotency - is the real code."""

from __future__ import annotations

import json
import threading
import time
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select, update

from app.models import AgentMessage, PaymentCommitment
from app.services.agent import orchestrator
from tests.agent.conftest import (
    FakeSarvam,
    counts,
    financial_counts,
    last_tool_result,
    messages_of,
    outstanding,
    payments_of,
    say,
    tool_call,
    tool_executions,
)
from tests.conftest import add_user, today

PAY_TEXT = "Ramesh paid 5,000 today."
PAY_ARGS = {
    "customer_name": "Ramesh",
    "amount": 5000,
    "evidence": {"customer_name": "Ramesh", "amount": "5,000"},
}


def types(events):
    return [e["type"] for e in events]


def history_facts(messages):
    """Every fact dict the orchestrator put into earlier assistant messages."""
    out = []
    for m in messages:
        if m["role"] == "assistant" and "(facts from tools:" in (m.get("content") or ""):
            raw = m["content"].split("(facts from tools: ", 1)[1].rsplit(")", 1)[0]
            out.extend(json.loads(raw))
    return out


def record_payment_turn(demo, turn_id="t-pay"):
    fake = FakeSarvam(
        tool_call("record_customer_payment", PAY_ARGS),
        say("Recorded ₹5,000 from Ramesh Kumar. He now owes ₹7,000."),
    )
    result, _ = demo.turn(fake, PAY_TEXT, turn_id=turn_id)
    assert result.tool_runs[0]["result"]["status"] == "completed"
    return result


# ----------------------------------------------------------------------------- multi-step turn
def test_multi_step_turn_emits_events_in_order(demo, db):
    fake = FakeSarvam(
        tool_call("get_customer", {"customer_name": "Ramesh"}),
        tool_call("record_customer_payment", PAY_ARGS),
        say("Recorded ₹5,000 from Ramesh Kumar. He now owes ₹7,000."),
    )
    result, events = demo.turn(fake, PAY_TEXT, turn_id="t-multi")
    assert types(events) == [
        "turn.started",
        "thinking",
        "tool.started",
        "tool.completed",
        "focus",
        "thinking",
        "tool.started",
        "tool.completed",
        "thinking",
        "reply",
    ]
    started = [e for e in events if e["type"] == "tool.started"]
    completed = [e for e in events if e["type"] == "tool.completed"]
    assert [e["tool"] for e in started] == ["get_customer", "record_customer_payment"]
    assert [e["kind"] for e in started] == ["read", "write"]
    assert "evidence" not in started[1]["arguments"]
    assert completed[0]["result"]["outstanding"] == "12000.00"
    assert completed[1]["status"] == "completed"
    assert completed[1]["refresh"] == ["financial"]
    assert completed[1]["replayed"] is False
    assert all(e["turn_id"] == "t-multi" for e in events)
    assert events[-1]["text"] == result.reply == "Recorded ₹5,000 from Ramesh Kumar. He now owes ₹7,000."
    assert result.llm_calls == 3 and not result.ignored
    # the LLM saw the first tool's result before deciding on the second call
    assert last_tool_result(fake.calls[1])["outstanding"] == "12000.00"
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")
    msgs = messages_of(db, demo.owner.id)
    assert [(m.role, m.turn_id) for m in msgs] == [("user", "t-multi"), ("assistant", "t-multi")]
    facts = msgs[1].data["facts"]
    assert facts[0]["customer_id"] == str(demo.ramesh.id)
    assert len(facts[1]["payment_ids"]) == 1


def test_same_turn_id_replays_stored_reply_without_running_tools(demo, db):
    first = record_payment_turn(demo, "t-lost")
    before = counts(db)
    fake = FakeSarvam()  # any LLM call would fail the test
    again, events = demo.turn(fake, PAY_TEXT, turn_id="t-lost")
    assert again.replayed is True and again.reply == first.reply
    assert fake.calls == []
    assert types(events) == ["reply"] and events[0]["replayed"] is True
    assert counts(db) == before
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2


def _crash_after_payment(demo, db, turn_id):
    """The provider fails on the reply call after the payment committed (the turn raises; no reply stored)."""
    broken = FakeSarvam(tool_call("record_customer_payment", PAY_ARGS), RuntimeError("connection reset"))
    with pytest.raises(RuntimeError):
        demo.turn(broken, PAY_TEXT, turn_id=turn_id)
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2


def test_retry_of_a_crashed_turn_never_pays_twice(demo, db, monkeypatch):
    """Scenario I, financial half: whatever the retry of a crashed turn does, the payment exists exactly once
    and the user's utterance is stored once."""
    _crash_after_payment(demo, db, "t-scenario-i")
    monkeypatch.setattr(demo.settings, "AGENT_TURN_TIMEOUT_SECONDS", 1.0)  # bound the retry's wait
    retry = FakeSarvam(
        tool_call("record_customer_payment", PAY_ARGS),
        say("Recorded ₹5,000 from Ramesh Kumar. He now owes ₹7,000."),
    )
    demo.turn(retry, PAY_TEXT, turn_id="t-scenario-i")
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")
    assert [m.role for m in messages_of(db, demo.owner.id)].count("user") == 1


def test_turn_interrupted_after_payment_recovers_without_second_payment(demo, db, monkeypatch):
    _crash_after_payment(demo, db, "t-scenario-i")
    monkeypatch.setattr(demo.settings, "AGENT_TURN_TIMEOUT_SECONDS", 1.0)
    retry = FakeSarvam(
        tool_call("record_customer_payment", PAY_ARGS),
        say("Recorded ₹5,000 from Ramesh Kumar. He now owes ₹7,000."),
    )
    result, events = demo.turn(retry, PAY_TEXT, turn_id="t-scenario-i")
    completed = [e for e in events if e["type"] == "tool.completed"]
    assert completed and completed[0]["replayed"] is True and completed[0]["status"] == "completed"
    assert result.reply
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2


def test_concurrent_duplicate_turn_waits_for_the_first_and_replays_it(demo, db):
    """Atomic claim: a client resend while the first request is still running does not run the turn again; it
    waits for the stored reply."""
    started = threading.Event()

    def slow_reply(_messages):
        started.set()
        time.sleep(1.5)
        return say("Ramesh Kumar owes ₹12,000.")

    first_llm = FakeSarvam(tool_call("get_customer", {"customer_name": "Ramesh"}), slow_reply)
    second_llm = FakeSarvam()  # any LLM call by the duplicate fails the test
    out = {}

    def first():
        out["first"] = demo.turn(first_llm, "How much does Ramesh owe?", turn_id="t-race")

    th = threading.Thread(target=first)
    th.start()
    assert started.wait(10)
    dup, events = demo.turn(second_llm, "How much does Ramesh owe?", turn_id="t-race")
    th.join(10)
    assert second_llm.calls == []
    assert dup.replayed is True and dup.reply == out["first"][0].reply == "Ramesh Kumar owes ₹12,000."
    assert [e["type"] for e in events] == ["reply"] and events[0]["replayed"] is True
    msgs = messages_of(db, demo.owner.id)
    assert [(m.role, m.turn_id) for m in msgs] == [("user", "t-race"), ("assistant", "t-race")]


def test_identical_tool_call_repeated_within_turn_is_idempotent(demo, db):
    fake = FakeSarvam(
        tool_call("record_customer_payment", PAY_ARGS),
        tool_call("record_customer_payment", PAY_ARGS),
        say("Recorded ₹5,000. Ramesh now owes ₹7,000."),
    )
    result, events = demo.turn(fake, PAY_TEXT, turn_id="t-dup")
    completed = [e for e in events if e["type"] == "tool.completed"]
    assert [e["replayed"] for e in completed] == [False, True]
    assert completed[0]["result"]["action_id"] == completed[1]["result"]["action_id"]
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")
    assert len(tool_executions(db, "t-dup")) == 1


# ----------------------------------------------------------------------------- Scenario H: not addressed to KAIRA
def test_ignore_reply_is_ignored_and_writes_nothing(demo, db):
    before = counts(db)
    fake = FakeSarvam(say("[[IGNORE]]"))
    result, events = demo.turn(
        fake, "Arey, did you watch the match yesterday? Five thousand runs!", turn_id="t-h"
    )
    assert result.ignored is True and result.reply == ""
    assert types(events) == ["turn.started", "thinking", "ignored"]
    assert counts(db) == before
    msgs = messages_of(db, demo.owner.id)
    assert msgs[0].data == {"ignored": True}
    assert msgs[1].content == "" and msgs[1].data["ignored"] is True
    # ignored chatter is not shown in the conversation history
    with demo.factory() as s:
        assert orchestrator.conversation(s, demo.business.id, demo.owner.id) == []


# ----------------------------------------------------------------------------- reply verification
def test_reply_with_unverified_amount_is_replaced_by_tool_summaries(demo, db):
    fake = FakeSarvam(
        tool_call("record_customer_payment", PAY_ARGS),
        say("Done. Ramesh now owes ₹9,999 and paid ₹5,000."),
    )
    result, events = demo.turn(fake, PAY_TEXT)
    assert "9,999" not in result.reply and "9999" not in result.reply
    summary = result.tool_runs[0]["result"]["summary"].rstrip(".")
    assert result.reply.rstrip(".") == summary
    assert events[-1]["type"] == "reply" and events[-1]["text"].rstrip(".") == summary


def test_reply_with_amounts_from_tools_is_kept(demo):
    fake = FakeSarvam(
        tool_call("get_customer", {"customer_name": "Ramesh"}), say("Ramesh Kumar owes ₹12,000.")
    )
    result, _ = demo.turn(fake, "How much does Ramesh owe?")
    assert result.reply == "Ramesh Kumar owes ₹12,000."


def test_reply_amount_without_any_tool_is_replaced(demo):
    fake = FakeSarvam(say("Your cash is ₹4,50,000."))
    result, _ = demo.turn(fake, "How much cash do I have?")
    assert "450000" not in result.reply.replace(",", "")
    assert result.reply == "I could not verify those figures, so please check the screen."


# ----------------------------------------------------------------------------- Scenario E: corrections
def _payment_id_from_history(messages):
    ids = [pid for f in history_facts(messages) for pid in f.get("payment_ids", [])]
    assert ids, "payment id must be available from history facts"
    return ids[-1]


def test_correction_flow_confirms_records_difference_once_and_refuses_decrease(demo, db):
    record_payment_turn(demo, "t-e1")
    agent_payment = [p for p in payments_of(db, demo.inv_ramesh.id) if p.source_action_id][0]

    # 1. "Actually it was 6,000": proposal only
    fake = FakeSarvam(
        lambda msgs: tool_call(
            "correct_payment_amount",
            {
                "payment_id": _payment_id_from_history(msgs),
                "correct_amount": 6000,
                "evidence": {"correct_amount": "6,000"},
            },
        ),
        say("Should I record the extra ₹1,000 so the payment totals ₹6,000?"),
    )
    r, _ = demo.turn(fake, "Actually it was 6,000, not 5,000.", turn_id="t-e2")
    res = r.tool_runs[0]["result"]
    assert r.tool_runs[0]["arguments"]["payment_id"] == str(agent_payment.id)
    assert res["status"] == "needs_confirmation" and res["difference_to_record"] == "1000.00"
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")

    # 2. "yes" in a later turn, the amount evidenced by the user's earlier words: records only the difference
    confirmed = {
        "payment_id": str(agent_payment.id),
        "correct_amount": 6000,
        "confirmed": True,
        "evidence": {"correct_amount": "6,000"},
    }
    fake = FakeSarvam(tool_call("correct_payment_amount", confirmed), say("Done, Ramesh now owes ₹6,000."))
    r, _ = demo.turn(fake, "Yes.", turn_id="t-e3")
    res = r.tool_runs[0]["result"]
    assert res["status"] == "completed" and res["difference_recorded"] == "1000.00"
    assert res["invoice_outstanding_after"] == "6000.00"
    pays = payments_of(db, demo.inv_ramesh.id)
    assert sorted(str(p.amount) for p in pays) == ["1000.00", "5000.00", "6000.00"]
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("6000.00")

    # 3. a repeated "yes" (new turn): earlier corrections are counted, so nothing more is recorded
    fake = FakeSarvam(tool_call("correct_payment_amount", confirmed), say("That is already recorded."))
    r, _ = demo.turn(fake, "Yes, record it.", turn_id="t-e4")
    res = r.tool_runs[0]["result"]
    assert res["status"] == "completed" and "already matches" in res["message"], res
    assert len(payments_of(db, demo.inv_ramesh.id)) == 3
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("6000.00")

    # 4. a decrease is refused and changes nothing
    before = financial_counts(db)
    fake = FakeSarvam(
        tool_call(
            "correct_payment_amount",
            {"payment_id": str(agent_payment.id), "correct_amount": 4000, "confirmed": True},
        ),
        say("I cannot reduce a recorded payment."),
    )
    r, _ = demo.turn(fake, "Sorry, it was only 4,000.", turn_id="t-e5")
    assert r.tool_runs[0]["result"]["status"] == "unsupported"
    assert financial_counts(db) == before
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("6000.00")


def _offer_and_confirm_correction(demo, pid, amount, words, n):
    """Turn A: the user states the corrected total (offer). Turn B: the user says yes (confirm)."""
    args = {"payment_id": pid, "correct_amount": amount, "evidence": {"correct_amount": words}}
    offer = demo.tool("correct_payment_amount", args, f"Actually it was {words}.", turn_id=f"t-offer-{n}")
    assert offer["status"] == "needs_confirmation", offer
    return demo.tool(
        "correct_payment_amount",
        {**args, "confirmed": True},
        f"Actually it was {words}.\nYes.",  # the orchestrator's window holds the user's recent words
        turn_id=f"t-yes-{n}",
    )


def test_second_correction_records_only_the_remaining_difference(demo, db):
    """Regression (was a strict-xfail BUG): corrections already recorded for a payment are counted."""
    record_payment_turn(demo, "t-c1")
    pid = str([p for p in payments_of(db, demo.inv_ramesh.id) if p.source_action_id][0].id)
    first = _offer_and_confirm_correction(demo, pid, 6000, "6,000", 1)
    assert first["status"] == "completed" and first["difference_recorded"] == "1000.00", first
    second = _offer_and_confirm_correction(demo, pid, 7000, "7,000", 2)
    assert second["status"] == "completed" and second["difference_recorded"] == "1000.00", second
    assert second["total_now_recorded"] == "7000.00"
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("5000.00")  # 12,000 - 7,000
    assert sorted(str(p.amount) for p in payments_of(db, demo.inv_ramesh.id)) == [
        "1000.00",
        "1000.00",
        "5000.00",
        "6000.00",
    ]
    # correcting the correction payment itself is counted against the same original payment
    corr = [p for p in payments_of(db, demo.inv_ramesh.id) if str(p.amount) == "1000.00"][0]
    same = demo.tool(
        "correct_payment_amount",
        {"payment_id": str(corr.id), "correct_amount": 7000, "confirmed": True},
        "it was 7,000",
        turn_id="t-c-same",
    )
    assert same["status"] == "completed" and "already matches" in same["message"], same
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("5000.00")


def test_correction_cannot_skip_confirmation_or_evidence(demo, db):
    """Regression (was a strict-xfail BUG): confirmed=true from the model is not enough."""
    record_payment_turn(demo, "t-s1")
    pid = str([p for p in payments_of(db, demo.inv_ramesh.id) if p.source_action_id][0].id)
    # (a) no earlier offer, amount not in the user's words
    r = demo.tool(
        "correct_payment_amount",
        {"payment_id": pid, "correct_amount": 9000, "confirmed": True},
        "Actually it was 6,000, not 5,000.",
        turn_id="t-s2",
    )
    assert r["status"] == "needs_confirmation", r
    # (b) offered and evidenced, but "confirmed" in the SAME turn as the offer
    args = {"payment_id": pid, "correct_amount": 6000, "evidence": {"correct_amount": "6,000"}}
    demo.tool("correct_payment_amount", args, "Actually it was 6,000.", turn_id="t-s3")
    r = demo.tool(
        "correct_payment_amount", {**args, "confirmed": True}, "Actually it was 6,000.", turn_id="t-s3"
    )
    assert r["status"] == "needs_confirmation", r
    # (c) offered in an earlier turn, but the confirming call's amount is not evidenced
    r = demo.tool(
        "correct_payment_amount",
        {"payment_id": pid, "correct_amount": 6000, "confirmed": True},
        "Yes.",
        turn_id="t-s4",
    )
    assert r["status"] == "needs_confirmation", r
    # (d) offered for 6,000 in an earlier turn; a confirm for a DIFFERENT amount does not ride on that offer
    r = demo.tool(
        "correct_payment_amount",
        {
            "payment_id": pid,
            "correct_amount": 6500,
            "confirmed": True,
            "evidence": {"correct_amount": "6,500"},
        },
        "Make it 6,500.",
        turn_id="t-s5",
    )
    assert r["status"] == "needs_confirmation", r
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2


def test_correction_by_a_different_user_does_not_ride_on_the_owners_offer(demo, db):
    record_payment_turn(demo, "t-u1")
    pid = str([p for p in payments_of(db, demo.inv_ramesh.id) if p.source_action_id][0].id)
    args = {"payment_id": pid, "correct_amount": 6000, "evidence": {"correct_amount": "6,000"}}
    demo.tool("correct_payment_amount", args, "Actually it was 6,000.", turn_id="t-u2")
    other_owner = add_user(db, demo.business, "owner")
    r = demo.tool(
        "correct_payment_amount",
        {**args, "confirmed": True},
        "Actually it was 6,000. Yes.",
        user=other_owner,
        turn_id="t-u3",
    )
    assert r["status"] == "needs_confirmation", r
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")


def test_did_not_pay_marks_promise_broken_and_never_touches_payments(demo, db):
    db.execute(
        update(PaymentCommitment)
        .where(PaymentCommitment.customer_id == demo.ramesh.id)
        .values(expected_payment_date=today() - timedelta(days=1))
    )
    db.commit()
    before = financial_counts(db)
    fake = FakeSarvam(
        tool_call("record_missed_promise", {"customer_name": "Ramesh"}),
        say("Noted. Ramesh missed his promise and still owes ₹12,000."),
    )
    result, _ = demo.turn(fake, "Ramesh did not pay.")
    res = result.tool_runs[0]["result"]
    assert res["status"] == "completed"
    assert res["promise_marked_broken"]["amount"] == "4000.00"
    assert res["outstanding_unchanged"] == "12000.00"
    assert financial_counts(db) == before
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("12000.00")
    db.expire_all()
    k = db.scalar(select(PaymentCommitment).where(PaymentCommitment.customer_id == demo.ramesh.id))
    assert k.status == "broken"
    assert "Did not pay as promised" in db.get(type(demo.ramesh), demo.ramesh.id).notes
    assert result.reply == "Noted. Ramesh missed his promise and still owes ₹12,000."


def test_did_not_pay_with_no_due_promise_only_adds_note(demo, db):
    before = financial_counts(db)
    r = demo.tool("record_missed_promise", {"customer_name": "Ramesh"}, "Ramesh did not pay.")
    assert r["status"] == "completed" and r["promise_marked_broken"] is None
    assert financial_counts(db) == before
    db.expire_all()
    assert (
        db.scalar(select(PaymentCommitment.status).where(PaymentCommitment.customer_id == demo.ramesh.id))
        == "pending"
    )


# ----------------------------------------------------------------------------- pronoun follow-up
def test_pronoun_follow_up_uses_customer_id_from_history(demo, db):
    fake = FakeSarvam(
        tool_call("get_customer", {"customer_name": "Ramesh"}), say("Ramesh Kumar owes ₹12,000.")
    )
    demo.turn(fake, "How much does Ramesh owe?", turn_id="t-p1")

    seen = {}

    def follow_up(msgs):
        facts = history_facts(msgs)
        seen["customer_id"] = facts[0]["customer_id"]
        return tool_call(
            "record_customer_payment",
            {"customer_id": seen["customer_id"], "amount": 2000, "evidence": {"amount": "2,000"}},
        )

    fake = FakeSarvam(follow_up, say("Recorded ₹2,000. He now owes ₹10,000."))
    result, _ = demo.turn(fake, "He paid 2,000 just now.", turn_id="t-p2")
    assert seen["customer_id"] == str(demo.ramesh.id)
    # the earlier user question is in the LLM context too
    assert any(m["role"] == "user" and m["content"] == "How much does Ramesh owe?" for m in fake.calls[0])
    assert result.tool_runs[0]["result"]["status"] == "completed"
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("10000.00")
    assert result.reply == "Recorded ₹2,000. He now owes ₹10,000."


# ----------------------------------------------------------------------------- languages
def test_telugu_turn_detects_language_and_executes(demo, db):
    text = "రమేష్ ఈరోజు ఐదు వేల రూపాయలు ఇచ్చాడు"
    fake = FakeSarvam(
        tool_call(
            "record_customer_payment",
            {
                "customer_name": "Ramesh",
                "amount": 5000,
                "evidence": {"customer_name": "రమేష్", "amount": "ఐదు వేల"},
            },
        ),
        say("రమేష్ కుమార్ నుండి ₹5,000 నమోదు చేశాను. ఇంకా ₹7,000 బాకీ ఉంది."),
    )
    result, events = demo.turn(fake, text)
    assert result.language == "te-IN"
    assert "Telugu script" in fake.calls[0][0]["content"]
    assert events[0] == {"type": "turn.started", "turn_id": result.turn_id, "text": text, "language": "te-IN"}
    assert result.tool_runs[0]["result"]["status"] == "completed"
    assert result.reply.startswith("రమేష్")
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")


def test_hindi_turn_detects_language_and_executes(demo, db):
    text = "रमेश ने आज पाँच हज़ार रुपये दिए"
    fake = FakeSarvam(
        tool_call(
            "record_customer_payment",
            {
                "customer_name": "Ramesh",
                "amount": 5000,
                "evidence": {"customer_name": "रमेश", "amount": "पाँच हज़ार"},
            },
        ),
        say("रमेश कुमार से ₹5,000 दर्ज किए। अब ₹7,000 बाकी हैं।"),
    )
    result, _ = demo.turn(fake, text)
    assert result.language == "hi-IN"
    assert "Devanagari" in fake.calls[0][0]["content"]
    assert result.tool_runs[0]["result"]["status"] == "completed"
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")


# ----------------------------------------------------------------------------- robustness
def test_unknown_tool_and_bad_arguments_are_reported_not_executed(demo, db):
    before = financial_counts(db)
    fake = FakeSarvam(
        tool_call("delete_everything", {}),
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "x",
                    "type": "function",
                    "function": {"name": "record_customer_payment", "arguments": "{not json"},
                }
            ],
        },
        say("Sorry, I could not do that."),
    )
    result, events = demo.turn(fake, "Ramesh paid 5,000")
    statuses = [e["status"] for e in events if e["type"] == "tool.completed"]
    assert statuses == ["error", "needs_clarification"]
    assert financial_counts(db) == before


def test_max_tool_steps_stops_the_loop(demo, db):
    steps = demo.settings.AGENT_MAX_TOOL_STEPS
    fake = FakeSarvam(*[tool_call("receivables_overview", {"limit": i + 1}) for i in range(steps + 5)])
    result, _ = demo.turn(fake, "Who owes me?")
    assert result.llm_calls == steps
    assert result.reply  # a fallback reply, never empty


@pytest.mark.parametrize(
    "role,tool,args",
    [
        ("staff", "confirm_pending_action", {"action_id": "00000000-0000-0000-0000-000000000001"}),
        (
            "owner",
            "record_payment_and_promise",
            {
                "customer_name": "Ramesh",
                "amount": -5,  # refused by validation -> INVALID_AMOUNT (the failure record must still fit)
                "expected_payment_date": "2026-12-01",
                "evidence": {"customer_name": "Ramesh", "amount": "5,000"},
            },
        ),
    ],
    ids=["staff-forbidden", "owner-invalid-amount"],
)
def test_refused_tool_with_realistic_turn_id_reports_error(demo, db, role, tool, args):
    user = add_user(db, demo.business, "staff") if role == "staff" else demo.owner
    turn_id = uuid.uuid4().hex  # 32 chars, like every real client
    fake = FakeSarvam(tool_call(tool, args), say("I could not do that."))
    result, events = demo.turn(
        fake, "Ramesh paid 5,000, rest next Monday. Confirm it.", turn_id=turn_id, user=user
    )
    assert [e["status"] for e in events if e["type"] == "tool.completed"] == ["error"]
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1


def test_refused_tool_with_short_turn_id_reports_error(demo, db):
    """Same refusal with a short turn id (key fits): reported as an error step, nothing written."""
    staff = add_user(db, demo.business, "staff")
    fake = FakeSarvam(
        tool_call("confirm_pending_action", {"action_id": "00000000-0000-0000-0000-000000000001"}),
        say("Only the owner can confirm that."),
    )
    result, events = demo.turn(fake, "yes, confirm it", turn_id="t-short", user=staff)
    done = [e for e in events if e["type"] == "tool.completed"]
    assert [(e["status"], e["result"]["code"]) for e in done] == [("error", "FORBIDDEN")]
    assert result.reply == "Only the owner can confirm that."


def test_turn_id_replay_is_scoped_to_the_user(demo, db):
    """Regression (was a strict-xfail BUG): another user's turn_id never replays someone else's reply."""
    fake = FakeSarvam(
        tool_call("get_customer", {"customer_name": "Ramesh"}), say("Ramesh Kumar owes ₹12,000.")
    )
    demo.turn(fake, "How much does Ramesh owe?", turn_id="shared-turn")
    staff = add_user(db, demo.business, "staff")
    fake2 = FakeSarvam(say("Hello! How can I help?"))
    result, _ = demo.turn(fake2, "Hello KAIRA", turn_id="shared-turn", user=staff)
    assert result.replayed is False
    assert result.reply == "Hello! How can I help?"
    assert "12,000" not in result.reply
    # each user sees only their own turn in the conversation
    with demo.factory() as s:
        staff_conv = orchestrator.conversation(s, demo.business.id, staff.id)
        owner_conv = orchestrator.conversation(s, demo.business.id, demo.owner.id)
    assert [m["text"] for m in staff_conv] == ["Hello KAIRA", "Hello! How can I help?"]
    assert [m["text"] for m in owner_conv] == ["How much does Ramesh owe?", "Ramesh Kumar owes ₹12,000."]


def _run_with_cancel(demo, fake, turn_id, cancel_from_check):
    calls = {"n": 0}

    def should_cancel():
        calls["n"] += 1
        return calls["n"] >= cancel_from_check

    events = []
    result = orchestrator.run_turn(
        demo.factory,
        demo.settings,
        fake,
        user_id=demo.owner.id,
        business_id=demo.business.id,
        session_id=None,
        turn_id=turn_id,
        text=PAY_TEXT,
        language_hint=None,
        input_mode="voice",
        emit=events.append,
        should_cancel=should_cancel,
    )
    return result, events


def _assistant_reply_stored(db, turn_id):
    db.expire_all()
    return db.scalar(
        select(AgentMessage).where(AgentMessage.turn_id == turn_id, AgentMessage.role == "assistant")
    )


def test_cancelled_turn_never_starts_a_write(demo, db):
    """Cancelled while the LLM was choosing the write (check 1 = before the LLM call, check 2 = right before
    the write): the write never starts."""
    fake = FakeSarvam(tool_call("record_customer_payment", PAY_ARGS), say("never reached"))
    result, events = _run_with_cancel(demo, fake, "t-cancel", cancel_from_check=2)
    assert events[-1] == {"type": "turn.cancelled", "turn_id": "t-cancel"}
    assert "tool.started" not in [e["type"] for e in events]
    assert result.reply == "" and len(fake.calls) == 1
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1  # seed payment only
    assert tool_executions(db, "t-cancel") == []
    assert _assistant_reply_stored(db, "t-cancel") is None


def test_cancelled_turn_stops_before_next_step(demo, db):
    """Cancelled after a write finished: that write stays (exactly once), nothing more runs."""
    fake = FakeSarvam(tool_call("record_customer_payment", PAY_ARGS), say("never reached"))
    result, events = _run_with_cancel(demo, fake, "t-cancel-2", cancel_from_check=3)
    assert events[-1] == {"type": "turn.cancelled", "turn_id": "t-cancel-2"}
    assert [e["status"] for e in events if e["type"] == "tool.completed"] == ["completed"]
    assert result.reply == "" and len(fake.calls) == 1
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")
    assert _assistant_reply_stored(db, "t-cancel-2") is None


def test_detect_language_and_verify_reply_units():
    assert orchestrator.detect_language("రమేష్", None) == "te-IN"
    assert orchestrator.detect_language("रमेश", None) == "hi-IN"
    assert orchestrator.detect_language("Ramesh", None) == "en-IN"
    assert orchestrator.detect_language("Ramesh", "hi-IN") == "hi-IN"
    assert orchestrator.verify_reply("He owes ₹12,000 after 3 days", '{"outstanding": "12000.00"}')
    assert orchestrator.verify_reply("₹1,50,000 due", "150000.00")
    assert not orchestrator.verify_reply("He owes ₹12,500", '{"outstanding": "12000.00"}')
