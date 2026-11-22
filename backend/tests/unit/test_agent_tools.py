"""Agent tool correctness regressions (real PostgreSQL through the orchestrator's tool executor; the model's tool
calls are scripted and, for run_turn, the chat model is a local fake)."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import AgentToolExecution, Customer, Payment, PaymentCommitment, ProposedAction
from app.services.agent import orchestrator
from tests.conftest import make_business
from tests.conftest import today as business_today
from tests.unit.test_agent_tools_dates import Agent, next_weekday


@pytest.fixture
def setup(owner, app, settings):
    cust = owner.customer("Ramesh Kumar")
    inv = owner.invoice(cust["id"], "12000.00")
    agent = Agent(app, settings, owner)
    agent.customer_id, agent.invoice_id = cust["id"], inv["id"]
    agent.owner = owner
    return agent


def count(db, model) -> int:
    db.expire_all()
    return len(db.scalars(select(model)).all())


PAY = {"customer_name": "Ramesh", "amount": 5000, "evidence": {"customer_name": "Ramesh", "amount": "5,000"}}


def test_same_payment_twice_in_one_turn_is_recorded_once(setup, db):
    said = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."
    monday = next_weekday(business_today(), 0)
    first = setup.call("record_customer_payment", PAY, said, turn="turn-dup")
    assert first["status"] == "completed", first
    # the model then (wrongly) also calls the combined tool in the same turn
    second = setup.call(
        "record_payment_and_promise",
        {**PAY, "expected_payment_date": monday.isoformat(),
         "evidence": {**PAY["evidence"], "expected_payment_date": "next Monday", "remaining_balance": "remaining"}},
        said,
        turn="turn-dup",
    )  # fmt: skip
    assert second["status"] == "completed", second
    assert count(db, Payment) == 1
    (k,) = db.scalars(select(PaymentCommitment)).all()
    assert k.amount == Decimal("7000.00") and k.expected_payment_date == monday
    assert "already_recorded_this_turn" in second
    # and the pure repeat in the same turn is a replay, not a third write
    third = setup.call("record_customer_payment", {**PAY, "payment_method": "cash"}, said, turn="turn-dup")
    assert third["status"] == "completed" and third.get("replayed") is True
    assert count(db, Payment) == 1


def test_same_payment_again_minutes_later_is_read_back(setup, db):
    assert setup.call("record_customer_payment", PAY, "Ramesh paid 5,000")["status"] == "completed"
    again = setup.call("record_customer_payment", PAY, "Ramesh paid 5,000")
    assert again["status"] == "needs_confirmation", again
    assert "already recorded" in " ".join(again["confirmation_reasons"])
    assert count(db, Payment) == 1


def test_remaining_flag_is_grounded_in_the_users_word(setup, db):
    monday = next_weekday(business_today(), 0)
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "రమేష్", "remaining_balance": True, "expected_payment_date": monday.isoformat(),
         "evidence": {"customer_name": "రమేష్", "expected_payment_date": "వచ్చే సోమవారం"}},
        "రమేష్ మిగిలిన మొత్తం వచ్చే సోమవారం ఇస్తాడు",
    )  # fmt: skip
    assert r["status"] == "completed", r
    (k,) = db.scalars(select(PaymentCommitment)).all()
    assert k.amount == Decimal("12000.00") and k.expected_payment_date == monday


def test_cancel_only_what_was_read_back_to_this_user(setup, db, app, settings):
    # a staff member's proposal waits for the owner; the owner's conversational "no" must not reject it
    staff = make_business_staff(db, setup)
    staff_agent = Agent(app, settings, staff)
    staff_agent.language = "en-IN"
    pending = staff_agent.call("record_customer_payment", PAY, "Ramesh paid 5,000")
    assert pending["status"] == "needs_owner_approval", pending
    r = setup.call("cancel_pending_action", {"action_id": pending["action_id"]}, "no, cancel it")
    assert r["status"] == "error" and r["code"] == "NOT_OFFERED", r
    db.expire_all()
    assert db.get(ProposedAction, uuid.UUID(pending["action_id"])).status == "pending"
    # the owner's own read-back can be declined in the next turn
    offer = setup.call("record_customer_payment", {**PAY, "date": "2001-01-01"}, "Ramesh paid 5,000")
    assert offer["status"] == "needs_confirmation", offer
    r = setup.call("cancel_pending_action", {"action_id": offer["action_id"]}, "no")
    assert r["status"] == "completed" and r["rejected"] is True
    assert count(db, Payment) == 0


class _Staff:
    pass


def make_business_staff(db, setup):
    from tests.conftest import add_user

    biz = setup.owner.business
    user = add_user(db, biz, role="staff")
    s = _Staff()
    s.user, s.business = user, biz
    return s


def test_update_customer_appends_notes_and_reports_before_after(setup, db):
    # A note the user never said ("add a note") is read back, not written (agent-sec: edit values must be grounded
    # in the current utterance); the same note said in the user's words is written.
    r = setup.call(
        "add_collection_note", {"customer_id": setup.customer_id, "note": "will visit Friday"}, "add a note"
    )
    assert r["status"] == "needs_confirmation", r
    db.expire_all()
    assert "will visit Friday" not in (db.get(Customer, uuid.UUID(setup.customer_id)).notes or "")
    r = setup.call(
        "add_collection_note",
        {"customer_id": setup.customer_id, "note": "will visit Friday"},
        "add a note for Ramesh: he will visit Friday",
    )
    assert r["status"] == "completed", r
    r = setup.call(
        "update_customer",
        {"customer_id": setup.customer_id, "phone": "9876543210", "notes": "prefers UPI"},
        "Ramesh's number is 9876543210, note that he prefers UPI",
    )
    assert r["status"] == "completed" and r["before"]["phone"] is None and r["after"]["phone"] == "9876543210"
    db.expire_all()
    notes = db.get(Customer, uuid.UUID(setup.customer_id)).notes
    assert "will visit Friday" in notes and "prefers UPI" in notes  # history kept, not overwritten


def test_navigate_never_points_at_another_business(setup, db):
    other, _ = make_business(db, name="Other Co")
    foreign = Customer(business_id=other.id, name="Stranger")
    db.add(foreign)
    db.commit()
    r = setup.call("navigate", {"screen": "customer", "customer_id": str(foreign.id)}, "show that customer")
    assert r["status"] == "needs_clarification"
    r = setup.call("navigate", {"screen": "customer", "customer_id": setup.customer_id}, "show Ramesh")
    assert r == {
        "status": "completed",
        "path": f"/customers/{setup.customer_id}",
        "_execution_id": r["_execution_id"],
    }
    # and a foreign customer id never resolves in a read either
    r = setup.call("get_customer", {"customer_id": str(foreign.id)}, "how much does he owe")
    assert r["status"] == "needs_clarification"


def test_invoice_lookup_accepts_spoken_numbers(setup):
    for ref in ("INV-0001", "inv-0001", "invoice 1", "1"):
        r = setup.call("invoice_status", {"invoice_number": ref}, f"status of {ref}")
        assert r.get("invoice_number") == "INV-0001", (ref, r)


def test_update_invoice_reports_completed_not_payment_status(setup):
    r = setup.call(
        "update_invoice",
        {"invoice_number": "INV-0001", "notes": "call before delivery"},
        "add note on invoice 1: call before delivery",
    )
    assert r["status"] == "completed" and r["payment_status"] == "unpaid", r


def test_open_invoice_list_counts_only_open(setup, owner):
    owner.invoice(setup.customer_id, "3000.00")
    inv3 = owner.invoice(setup.customer_id, "1000.00")
    owner.pay(inv3["id"], "1000.00")
    r = setup.call(
        "list_invoices", {"customer_id": setup.customer_id, "status": "open", "limit": 1}, "open ones"
    )
    assert r["total"] == 2 and len(r["invoices"]) == 1
    assert r["outstanding_sum"] == "15000.00"


# --------------------------------------------------------------------------- full turn with a fake chat model
class FakeSarvam:
    def __init__(self, script):
        self.script = list(script)
        self.seen: list[list[dict]] = []

    def chat_tools(self, messages, specs):
        self.seen.append(json.loads(json.dumps(messages, default=str)))
        return self.script.pop(0), {}


def _call(name, args):
    return {
        "content": "",
        "tool_calls": [{"id": "c1", "function": {"name": name, "arguments": json.dumps(args)}}],
    }


def test_reply_with_a_wrong_date_is_replaced_by_the_stored_dates(setup, db, app, settings):
    today = business_today()
    monday = next_weekday(today, 0)
    wrong = monday + timedelta(days=7)
    said = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."
    fake = FakeSarvam(
        [
            _call(
                "record_payment_and_promise",
                {**PAY, "expected_payment_date": monday.isoformat(),
                 "evidence": {**PAY["evidence"], "date": "today", "expected_payment_date": "next Monday",
                              "remaining_balance": "remaining"}},
            ),
            {"content": f"Done. Ramesh will pay the remaining ₹7,000 on {wrong.day} {wrong.strftime('%B')}."},
        ]
    )  # fmt: skip
    events = []
    r = orchestrator.run_turn(
        app.state.session_factory,
        settings,
        fake,
        user_id=setup.user_id,
        business_id=setup.business_id,
        session_id=None,
        turn_id="turn-date-check",
        text=said,
        language_hint="en-IN",
        input_mode="text",
        emit=events.append,
    )
    assert count(db, Payment) == 1
    assert f"{wrong.day} {wrong.strftime('%B')}" not in r.reply
    assert monday.isoformat() in r.reply and today.isoformat() in r.reply
    # the prompt gave the model the resolved date sheet
    assert f"next Monday = {monday.isoformat()}" in fake.seen[0][0]["content"]


def test_reply_with_the_right_date_is_kept(setup, app, settings):
    today = business_today()
    monday = next_weekday(today, 0)
    said = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."
    reply = f"Recorded ₹5,000 from Ramesh. He will pay the remaining ₹7,000 on {monday.day} {monday.strftime('%B')}."
    fake = FakeSarvam(
        [
            _call(
                "record_payment_and_promise",
                {**PAY, "expected_payment_date": monday.isoformat(),
                 "evidence": {**PAY["evidence"], "date": "today", "expected_payment_date": "next Monday",
                              "remaining_balance": "remaining"}},
            ),
            {"content": reply},
        ]
    )  # fmt: skip
    r = orchestrator.run_turn(
        app.state.session_factory,
        settings,
        fake,
        user_id=setup.user_id,
        business_id=setup.business_id,
        session_id=None,
        turn_id="turn-date-ok",
        text=said,
        language_hint="en-IN",
        input_mode="text",
        emit=lambda e: None,
    )
    assert r.reply == reply


def test_failed_tool_is_never_reported_as_done(setup, db, app, settings):
    fake = FakeSarvam(
        [
            _call("record_customer_payment", {**PAY, "amount": 50000, "evidence": {"customer_name": "Ramesh",
                                                                                 "amount": "50,000"}}),
            {"content": "I have recorded ₹50,000 from Ramesh."},
            {"content": "I have recorded ₹50,000 from Ramesh."},
        ]
    )  # fmt: skip
    r = orchestrator.run_turn(
        app.state.session_factory,
        settings,
        fake,
        user_id=setup.user_id,
        business_id=setup.business_id,
        session_id=None,
        turn_id="turn-overpay",
        text="Ramesh paid 50,000",
        language_hint="en-IN",
        input_mode="text",
        emit=lambda e: None,
    )
    assert count(db, Payment) == 0
    assert "I have recorded" not in r.reply
    db.expire_all()
    statuses = {e.status for e in db.scalars(select(AgentToolExecution))}
    assert "completed" not in statuses


def test_find_customers_matches_names_spoken_in_telugu_and_hindi(setup):
    for query in ("రమేష్", "रमेश", "ramesh", "Rmesh Kumar"):
        r = setup.call("find_customers", {"query": query}, f"find {query}")
        assert [c["name"] for c in r["customers"]] == ["Ramesh Kumar"], (query, r)
        assert r["customers"][0]["outstanding"] == "12000.00"
    r = setup.call("find_customers", {"query": "సురేష్"}, "find Suresh")
    assert r["customers"] == []
