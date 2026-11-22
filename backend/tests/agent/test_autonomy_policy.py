"""Autonomy policy of the agent's financial write tools against PostgreSQL (seeded demo business).

Tools are invoked through the orchestrator's execution path (orchestrator._exec_tool) with the user's own words
as the transcript, exactly as an LLM tool call would arrive. No LLM is involved, so nothing is mocked here."""

from __future__ import annotations

import copy
import unicodedata
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select, update

from app.models import AuditLog, Customer, Invoice, Payment, PaymentCommitment, ProposedAction
from tests.agent.conftest import financial_counts, outstanding, payments_of
from tests.conftest import add_user, make_business, today

PAY_EN = "Ramesh paid 5,000 today."


def next_monday():
    t = today()
    return t + timedelta(days=(0 - t.weekday()) % 7 or 7)


def pay_args(**over):
    args = {
        "customer_name": "Ramesh",
        "amount": 5000,
        "evidence": {"customer_name": "Ramesh", "amount": "5,000"},
    }
    args.update(over)
    return args


def proposals(db):
    db.expire_all()
    return list(db.scalars(select(ProposedAction)))


def assert_executed_once(db, demo, result, amount="5000.00", after="7000.00"):
    assert result["status"] == "completed", result
    action_id = result["action_id"]
    pays = payments_of(db, demo.inv_ramesh.id)
    agent_pays = [p for p in pays if str(p.source_action_id) == action_id]
    assert [str(p.amount) for p in agent_pays] == [amount]
    assert outstanding(db, demo.inv_ramesh.id) == Decimal(after)
    assert result["customer_outstanding_after"] == after
    assert result["invoice_outstanding_after"] == {demo.inv_ramesh.invoice_number: after}
    audit = set(db.scalars(select(AuditLog.action_type).where(AuditLog.source_action_id == action_id)))
    assert {"action.proposed", "payment.recorded", "action.approved"} <= audit
    return agent_pays[0]


# ----------------------------------------------------------------------------- owner, evidenced: executes
def test_owner_evidenced_payment_executes_exactly_once(demo, db):
    result = demo.tool("record_customer_payment", pay_args(), PAY_EN, turn_id="t-pay-1")
    payment = assert_executed_once(db, demo, result)
    assert payment.payment_date == today()
    action = db.get(ProposedAction, payment.source_action_id)
    assert action.status == "executed" and action.approved_by == demo.owner.id
    # identical call in the same turn: stored result, no second payment
    again = demo.tool("record_customer_payment", pay_args(), PAY_EN, turn_id="t-pay-1")
    assert again["_replayed"] is True and again["action_id"] == result["action_id"]
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2  # seed 6,000 + agent 5,000
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")


def test_payment_and_promise_with_remaining_evidence(demo, db):
    text = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."
    args = {
        "customer_name": "Ramesh",
        "amount": 5000,
        "expected_payment_date": next_monday().isoformat(),
        "evidence": {
            "customer_name": "Ramesh",
            "amount": "5,000",
            "expected_payment_date": "next Monday",
            "amount_is_remaining": "the remaining amount",
        },
    }
    result = demo.tool("record_payment_and_promise", args, text)
    assert_executed_once(db, demo, result)
    db.expire_all()
    promises = db.scalars(
        select(PaymentCommitment).where(PaymentCommitment.customer_id == demo.ramesh.id)
    ).all()
    by_status = sorted((k.status, str(k.amount), k.expected_payment_date) for k in promises)
    assert ("pending", "7000.00", next_monday()) in by_status  # the promise for the rest, stored separately
    assert ("cancelled", "4000.00") in {(s, a) for s, a, _ in by_status}  # old promise superseded
    # the promise did not create any payment
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2


def test_payment_and_promise_with_schema_remaining_balance_key_executes(demo, db):
    """Regression (was a strict-xfail BUG): the tool schema now asks for the 'remaining_balance' evidence key and
    the tool maps it to the remainder flag, so the evidence the schema asks for is enough."""
    text = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."
    args = {
        "customer_name": "Ramesh",
        "amount": 5000,
        "expected_payment_date": next_monday().isoformat(),
        "evidence": {
            "customer_name": "Ramesh",
            "amount": "5,000",
            "expected_payment_date": "next Monday",
            "remaining_balance": "the remaining amount",
        },
    }
    result = demo.tool("record_payment_and_promise", args, text)
    assert_executed_once(db, demo, result)
    db.expire_all()
    pending = db.scalars(
        select(PaymentCommitment).where(
            PaymentCommitment.customer_id == demo.ramesh.id, PaymentCommitment.status == "pending"
        )
    ).all()
    assert [(str(k.amount), k.expected_payment_date) for k in pending] == [("7000.00", next_monday())]


def test_payment_and_promise_remainder_is_grounded_in_the_users_words(demo, db):
    """The remainder is a value too. The model forgot to cite it, but the user did say "remaining": the server
    grounds the flag in the user's own words, and the compound executes exactly once."""
    text = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."
    args = {
        "customer_name": "Ramesh",
        "amount": 5000,
        "expected_payment_date": next_monday().isoformat(),
        "evidence": {"customer_name": "Ramesh", "amount": "5,000", "expected_payment_date": "next Monday"},
    }
    result = demo.tool("record_payment_and_promise", args, text)
    assert result["status"] == "completed", result
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2  # the seeded 6,000 + exactly one new 5,000


def test_payment_and_promise_without_remainder_words_executes_nothing(demo, db):
    """If the user never said "the rest/remaining/balance", no remainder promise (and no payment) is written."""
    text = "Ramesh paid me 5,000 rupees today. He will come by next Monday."
    args = {
        "customer_name": "Ramesh",
        "amount": 5000,
        "expected_payment_date": next_monday().isoformat(),
        "evidence": {"customer_name": "Ramesh", "amount": "5,000", "expected_payment_date": "next Monday"},
    }
    before = financial_counts(db)
    result = demo.tool("record_payment_and_promise", args, text)
    assert result["status"] != "completed", result
    assert financial_counts(db) == before
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("12000.00")


def test_record_payment_promise_stored_without_payment(demo, db):
    friday = today() + timedelta(days=(4 - today().weekday()) % 7 or 7)
    text = "Lakshmi Stores will pay 10,000 next Friday."
    before = financial_counts(db)
    result = demo.tool(
        "record_payment_promise",
        {
            "customer_name": "Lakshmi Stores",
            "amount": 10000,
            "expected_payment_date": friday.isoformat(),
            "evidence": {
                "customer_name": "Lakshmi Stores",
                "amount": "10,000",
                "expected_payment_date": "next Friday",
            },
        },
        text,
    )
    assert result["status"] == "completed", result
    after = financial_counts(db)
    assert after["Payment"] == before["Payment"] and after["CashTransaction"] == before["CashTransaction"]
    assert after["PaymentCommitment"] == before["PaymentCommitment"] + 1
    k = db.scalar(select(PaymentCommitment).where(PaymentCommitment.customer_id == demo.lakshmi.id))
    assert (str(k.amount), k.expected_payment_date, k.status) == ("10000.00", friday, "pending")


def test_create_invoice_executes(demo, db):
    text = "Create an invoice for Lakshmi Stores for 8,000 rupees."
    result = demo.tool(
        "create_invoice",
        {
            "customer_name": "Lakshmi Stores",
            "amount": 8000,
            "description": "Oil tins",
            "evidence": {"customer_name": "Lakshmi Stores", "amount": "8,000"},
        },
        text,
    )
    assert result["status"] == "completed", result
    inv = result["invoice"]
    assert (inv["customer"], inv["total"], inv["outstanding"]) == ("Lakshmi Stores", "8000.00", "8000.00")
    db.expire_all()
    row = db.scalar(select(Invoice).where(Invoice.invoice_number == inv["invoice_number"]))
    assert row.customer_id == demo.lakshmi.id
    linked = set(
        db.scalars(select(AuditLog.entity_id).where(AuditLog.source_action_id == result["action_id"]))
    )
    assert row.id in linked  # the invoice's audit row is linked to the agent's action
    assert demo.tool("get_customer", {"customer_name": "Lakshmi Stores"})["outstanding"] == "30500.00"


# ----------------------------------------------------------------------------- not executed
def test_missing_amount_needs_clarification_and_writes_nothing(demo, db):
    before = financial_counts(db)
    r = demo.tool(
        "record_customer_payment",
        {"customer_name": "Ramesh", "evidence": {"customer_name": "Ramesh"}},
        "Ramesh paid today.",
    )
    assert r["status"] == "needs_clarification" and r["missing"] == ["amount"]
    assert financial_counts(db) == before and proposals(db) == []


@pytest.mark.parametrize(
    "transcript,evidence",
    [
        ("Ramesh paid today.", {"customer_name": "Ramesh"}),  # no evidence for the amount at all
        ("Ramesh paid something today.", {"customer_name": "Ramesh", "amount": "5,000"}),  # not in his words
    ],
)
def test_amount_not_in_users_words_is_not_executed(demo, db, transcript, evidence):
    before = financial_counts(db)
    r = demo.tool("record_customer_payment", pay_args(evidence=evidence), transcript)
    assert r["status"] == "needs_clarification", r
    assert any("amount" in w for w in r["warnings"])
    assert financial_counts(db) == before
    assert proposals(db) == []
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("12000.00")


def test_amount_contradicting_its_evidence_is_not_executed(demo, db):
    """Regression (was a strict-xfail BUG): amount=9000 with evidence '5,000' (which the user did say) is read
    back for confirmation instead of executing a 9,000 payment."""
    r = demo.tool("record_customer_payment", pay_args(amount=9000), PAY_EN)
    assert r["status"] == "needs_confirmation", r
    assert any("9000.00" in reason for reason in r["confirmation_reasons"])
    assert "9000.00" in r["summary"]  # what is read back is what would be recorded
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("12000.00")
    assert [p.status for p in proposals(db)] == ["pending"]


@pytest.mark.parametrize(
    "transcript,fragment",
    [
        ("Ramesh paid five thousand today.", "five thousand"),
        ("Ramesh paid 5000 rupees today.", "5000 rupees"),
        ("Ramesh paid ₹5,000 today.", "₹5,000"),
    ],
)
def test_spoken_amount_that_parses_exactly_executes(demo, db, transcript, fragment):
    r = demo.tool(
        "record_customer_payment",
        pay_args(evidence={"customer_name": "Ramesh", "amount": fragment}),
        transcript,
    )
    assert_executed_once(db, demo, r)


@pytest.mark.parametrize(
    "transcript,fragment",
    [
        ("Ramesh paid the usual amount today.", "the usual amount"),  # said, but not a number
        ("Ramesh paid fifty thousand today.", "fifty thousand"),  # parses, but to 50,000 not 5,000
        ("Ramesh paid 500 today.", "500"),
    ],
)
def test_spoken_amount_unparsed_or_mismatched_needs_confirmation(demo, db, transcript, fragment):
    before = financial_counts(db)
    r = demo.tool(
        "record_customer_payment",
        pay_args(evidence={"customer_name": "Ramesh", "amount": fragment}),
        transcript,
    )
    assert r["status"] == "needs_confirmation", r
    assert any("could not be matched exactly" in reason for reason in r["confirmation_reasons"])
    assert financial_counts(db) == before


def test_unreferenced_customer_id_needs_confirmation(demo, db):
    """A customer_id the model did not get from an earlier result of this conversation (and the user named no
    one) is read back, even though it is a valid id of this business."""
    before = financial_counts(db)
    r = demo.tool(
        "record_customer_payment",
        {"customer_id": str(demo.ramesh.id), "amount": 5000, "evidence": {"amount": "5,000"}},
        "He paid 5,000 today.",
    )
    assert r["status"] == "needs_confirmation", r
    assert any("not named" in reason for reason in r["confirmation_reasons"])
    assert financial_counts(db) == before


def test_customer_id_from_an_earlier_result_executes(demo, db):
    from app.services.agent import orchestrator

    r = orchestrator._exec_tool(
        demo.factory,
        demo.settings,
        None,
        demo.owner.id,
        demo.business.id,
        "t-known-id",
        "record_customer_payment",
        {"customer_id": str(demo.ramesh.id), "amount": 5000, "evidence": {"amount": "5,000"}},
        "He paid 5,000 today.",
        "en-IN",
        {str(demo.ramesh.id)},  # known_ids: the id appeared in an earlier tool result of this conversation
    )
    assert_executed_once(db, demo, r)


def test_overpayment_is_blocked(demo, db):
    before = financial_counts(db)
    r = demo.tool(
        "record_customer_payment",
        pay_args(amount=15000, evidence={"customer_name": "Ramesh", "amount": "15,000"}),
        "Ramesh paid 15,000 today.",
    )
    assert r["status"] == "needs_clarification"
    assert any("exceeds" in w for w in r["warnings"])
    assert financial_counts(db) == before and proposals(db) == []


def test_fuzzy_name_needs_confirmation_then_confirm_executes_once(demo, db):
    text = "Rames paid 5,000 today."
    r = demo.tool(
        "record_customer_payment",
        pay_args(customer_name="Rames", evidence={"customer_name": "Rames", "amount": "5,000"}),
        text,
    )
    assert r["status"] == "needs_confirmation", r
    assert any("Ramesh Kumar" in w for w in r["warnings"])
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1  # nothing recorded yet
    [p] = proposals(db)
    assert p.status == "pending"
    c1 = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "yes", turn_id="t-yes-1")
    assert_executed_once(db, demo, c1)
    # a second "yes" in another turn: the action is no longer pending, nothing more is recorded
    c2 = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "yes", turn_id="t-yes-2")
    assert c2["status"] == "error" and c2["code"] == "NOT_PENDING", c2
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2


def _fuzzy_proposal(demo, *, user=None, turn_id="t-offer"):
    r = demo.tool(
        "record_customer_payment",
        pay_args(customer_name="Rames", evidence={"customer_name": "Rames", "amount": "5,000"}),
        "Rames paid 5,000 today.",
        user=user,
        turn_id=turn_id,
    )
    assert r["status"] == "needs_confirmation", r
    return r


def test_confirm_in_the_same_turn_as_the_offer_is_refused(demo, db):
    """The user has not heard the read-back yet: a confirm in the offering turn is not a confirmation."""
    r = _fuzzy_proposal(demo, turn_id="t-same")
    c = demo.tool(
        "confirm_pending_action", {"action_id": r["action_id"]}, "Rames paid 5,000 today.", turn_id="t-same"
    )
    assert c["status"] == "error" and c["code"] == "NOT_OFFERED", c
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1
    assert proposals(db)[0].status == "pending"


def test_confirm_of_an_offer_made_to_another_user_is_refused(demo, db):
    other_owner = add_user(db, demo.business, "owner")
    r = _fuzzy_proposal(demo, user=other_owner)
    c = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "yes", turn_id="t-yes")
    assert c["status"] == "error" and c["code"] == "NOT_OFFERED", c
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1


def test_confirm_of_an_expired_offer_is_refused(demo, db):
    from app.models import AgentToolExecution

    r = _fuzzy_proposal(demo)
    db.execute(
        update(AgentToolExecution)
        .where(AgentToolExecution.turn_id == "t-offer")
        .values(created_at=AgentToolExecution.created_at - timedelta(minutes=31))
    )
    db.commit()
    c = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "yes", turn_id="t-yes")
    assert c["status"] == "error" and c["code"] == "NOT_OFFERED", c
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1


def test_confirm_of_a_proposal_changed_after_read_back_is_refused(demo, db):
    """The proposal was edited (e.g. on the Approvals screen) after KAIRA read it back: 'yes' no longer
    covers it."""
    r = _fuzzy_proposal(demo)
    action = db.get(ProposedAction, uuid.UUID(r["action_id"]))
    data = copy.deepcopy(action.extracted_data)
    data["operations"][0]["amount"] = "4000.00"
    action.extracted_data = data
    db.commit()
    c = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "yes", turn_id="t-yes")
    assert c["status"] == "error" and c["code"] == "CHANGED_SINCE_READ_BACK", c
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1
    assert proposals(db)[0].status == "pending"


# NOTE: the staff tests below use short turn ids on purpose. With a 32-char turn id (what the frontend and
# live.py generate) a refused owner-only tool crashes instead of returning FORBIDDEN: see the strict-xfail
# test_refused_tool_with_realistic_turn_id_reports_error in test_orchestrator.py. Nothing is written either way.
def test_staff_gets_owner_approval_and_cannot_confirm(demo, db):
    staff = add_user(db, demo.business, "staff")
    r = demo.tool("record_customer_payment", pay_args(), PAY_EN, user=staff, turn_id="t-staff-1")
    assert r["status"] == "needs_owner_approval", r
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1
    c = demo.tool(
        "confirm_pending_action", {"action_id": r["action_id"]}, "yes", user=staff, turn_id="t-staff-2"
    )
    assert c["status"] == "error" and c["code"] == "FORBIDDEN"
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1
    assert proposals(db)[0].status == "pending"
    # the owner was never read this proposal in conversation, so "yes" to KAIRA does not execute it ...
    c = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "yes", turn_id="t-owner-yes")
    assert c["status"] == "error" and c["code"] == "NOT_OFFERED", c
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1
    # ... the owner approves it on the Approvals screen, exactly once
    api = demo.api()
    approved = api.data(api.post(f"/actions/{r['action_id']}/approve"))
    assert approved["action"]["status"] == "executed" and approved["replayed"] is False
    again = api.data(api.post(f"/actions/{r['action_id']}/approve"))
    assert again["replayed"] is True
    agent_pays = [p for p in payments_of(db, demo.inv_ramesh.id) if str(p.source_action_id) == r["action_id"]]
    assert [str(p.amount) for p in agent_pays] == ["5000.00"]
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")


def test_staff_cannot_correct_or_cancel(demo, db):
    staff = add_user(db, demo.business, "staff")
    pay = payments_of(db, demo.inv_ramesh.id)[0]
    r = demo.tool(
        "correct_payment_amount",
        {"payment_id": str(pay.id), "correct_amount": 7000, "confirmed": True},
        "actually 7,000",
        user=staff,
        turn_id="t-staff-fix",
    )
    assert r["status"] == "error" and r["code"] == "FORBIDDEN"
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1


def test_customer_of_another_business_is_not_found(demo, db):
    other_biz, other_owner = make_business(db, name="Other Co")
    foreign = Customer(business_id=other_biz.id, name="Foreign Buyer")
    db.add(foreign)
    db.commit()
    before = financial_counts(db)
    r = demo.tool(
        "record_customer_payment",
        {"customer_id": str(foreign.id), "amount": 500, "evidence": {"amount": "500"}},
        "He paid 500.",
    )
    assert r["status"] == "needs_clarification"
    assert r["operations"][0]["customer"] == "not_found"
    g = demo.tool("get_customer", {"customer_id": str(foreign.id)})
    assert g["status"] == "needs_clarification" and "Foreign Buyer" not in str(g)
    assert financial_counts(db) == before and proposals(db) == []


def test_confirm_action_of_another_business_is_not_found(demo, db):
    other_biz, other_owner = make_business(db, name="Other Co")
    c = Customer(business_id=other_biz.id, name="Ramesh Kumar")
    db.add(c)
    db.commit()
    from app.services.agent import orchestrator

    r = orchestrator._exec_tool(
        demo.factory,
        demo.settings,
        None,
        other_owner.id,
        other_biz.id,
        "t-other",
        "record_customer_payment",
        {"customer_name": "Rames", "amount": 1, "evidence": {"customer_name": "Rames", "amount": "1"}},
        "Rames paid 1",
        "en-IN",
    )
    # whatever the other business got, our owner cannot execute its action
    action_id = r.get("action_id")
    if action_id:
        x = demo.tool("confirm_pending_action", {"action_id": action_id}, "yes")
        assert x["status"] == "error" and x["code"] == "NOT_FOUND"
    x = demo.tool("confirm_pending_action", {"action_id": "00000000-0000-0000-0000-000000000001"}, "yes")
    assert x["status"] == "error" and x["code"] == "NOT_FOUND"


# ----------------------------------------------------------------------------- Telugu / Hindi
def test_telugu_native_script_evidence_executes(demo, db):
    text = "రమేష్ ఈరోజు ఐదు వేల రూపాయలు ఇచ్చాడు"
    r = demo.tool(
        "record_customer_payment",
        pay_args(evidence={"customer_name": "రమేష్", "amount": "ఐదు వేల"}),
        text,
        language="te-IN",
    )
    assert_executed_once(db, demo, r)
    action = db.get(ProposedAction, r["action_id"])
    assert action.extracted_data["language"] == "te-IN"
    assert all(e["verified"] for e in action.evidence)


def test_hindi_native_script_evidence_executes(demo, db):
    text = "रमेश ने आज पाँच हज़ार रुपये दिए"
    r = demo.tool(
        "record_customer_payment",
        pay_args(evidence={"customer_name": "रमेश", "amount": "पाँच हज़ार"}),
        text,
        language="hi-IN",
    )
    assert_executed_once(db, demo, r)


def test_telugu_amount_evidence_absent_from_transcript_is_rejected(demo, db):
    text = "రమేష్ ఈరోజు డబ్బులు ఇచ్చాడు"  # "Ramesh gave money today" - no amount spoken
    r = demo.tool(
        "record_customer_payment",
        pay_args(evidence={"customer_name": "రమేష్", "amount": "ఐదు వేల"}),
        text,
        language="te-IN",
    )
    assert r["status"] == "needs_clarification"
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("12000.00")


def test_hindi_evidence_with_different_unicode_normal_form_executes(demo, db):
    text = "रमेश ने आज पाँच हज़ार रुपये दिए"  # precomposed ZA (as some STT output is)
    evidence_amount = "पाँच हज़ार"  # the same words, decomposed (as the LLM may copy them)
    assert unicodedata.normalize("NFC", evidence_amount) == unicodedata.normalize("NFC", "पाँच हज़ार")
    assert evidence_amount not in text
    r = demo.tool(
        "record_customer_payment",
        pay_args(evidence={"customer_name": "रमेश", "amount": evidence_amount}),
        text,
        language="hi-IN",
    )
    assert r["status"] == "completed", r


# Regression (was a strict-xfail BUG/GAP): Indic-script names are romanised for matching since 78d2fb0.
@pytest.mark.parametrize(
    "language,text,name,amount",
    [
        ("te-IN", "రమేష్ ఈరోజు ఐదు వేల రూపాయలు ఇచ్చాడు", "రమేష్", "ఐదు వేల"),
        ("hi-IN", "रमेश ने आज पाँच हज़ार रुपये दिए", "रमेश", "पाँच हज़ार"),
    ],
    ids=["telugu", "hindi"],
)
def test_indic_name_in_native_script_resolves(demo, db, language, text, name, amount):
    r = demo.tool(
        "record_customer_payment",
        {"customer_name": name, "amount": 5000, "evidence": {"customer_name": name, "amount": amount}},
        text,
        language=language,
    )
    assert_executed_once(db, demo, r)


def test_confirm_mode_requires_confirmation_even_for_owner(demo, db):
    demo.settings.AGENT_AUTONOMY = "confirm"
    try:
        r = demo.tool("record_customer_payment", pay_args(), PAY_EN)
    finally:
        demo.settings.AGENT_AUTONOMY = "auto"
    assert r["status"] == "needs_confirmation"
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1


def test_cancel_pending_action_writes_nothing(demo, db):
    r = demo.tool(
        "record_customer_payment",
        pay_args(customer_name="Rames", evidence={"customer_name": "Rames", "amount": "5,000"}),
        "Rames paid 5,000 today.",
    )
    before = financial_counts(db)
    c = demo.tool("cancel_pending_action", {"action_id": r["action_id"]}, "no")
    assert c["status"] == "completed" and c["rejected"] is True
    assert financial_counts(db) == before
    x = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "yes")
    assert x["status"] == "error"
    assert financial_counts(db) == before
    assert db.scalar(select(Payment).where(Payment.source_action_id == r["action_id"])) is None
