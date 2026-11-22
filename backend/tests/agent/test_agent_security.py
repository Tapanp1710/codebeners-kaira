"""Security review regressions for the live agent (real PostgreSQL, seeded demo business, no LLM or provider calls).

1. A customer_id must agree with the customer the user named; the name/invoice evidence must mean the value.
2. confirm_pending_action needs an explicit yes in the CURRENT utterance.
3. cancel_pending_action needs a no/cancel in the current utterance; non-financial edits need their values in it.
4. A cancelled (barge-in) turn releases its claim; resending the turn runs it without a second payment.
5. WebSocket tickets are redacted from uvicorn's log records."""

from __future__ import annotations

import logging
import uuid

import pytest
from sqlalchemy import select

from app.core.logging import REDACTED, RedactSecretsFilter, install_redaction, redact_secrets
from app.models import AgentMessage, Customer, ProposedAction
from app.schemas.ai import Operation
from app.services.agent import orchestrator
from app.services.agent.tools import affirmed, declined
from app.services.ai.resolution import Warn, evidence_matches_value, verify_evidence
from tests.agent.conftest import FakeSarvam, financial_counts, payments_of, say, tool_call
from tests.agent.test_autonomy_policy import PAY_EN, assert_executed_once, pay_args, proposals


def known_tool(demo, name, args, said, known=(), *, turn_id=None):
    """One tool call with ids that earlier tool results of this conversation returned (known_ids)."""
    r = orchestrator._exec_tool(
        demo.factory,
        demo.settings,
        None,
        demo.owner.id,
        demo.business.id,
        turn_id or uuid.uuid4().hex,
        name,
        args,
        said,
        "en-IN",
        set(known),
    )
    r.pop("_events", None)
    return r


# ----------------------------------------------------------------------------- 1. id / name binding
def test_id_of_another_customer_with_the_spoken_name_writes_nothing(demo, db):
    """Turn 1 returned Lakshmi's id; turn 2 'Ramesh paid 5,000' arrives with Lakshmi's id + name Ramesh."""
    before = financial_counts(db)
    r = known_tool(
        demo,
        "record_customer_payment",
        pay_args(customer_id=str(demo.lakshmi.id)),
        PAY_EN,
        {str(demo.lakshmi.id)},
    )
    assert r["status"] == "needs_clarification", r
    assert any("does not match" in w for w in r["warnings"]), r
    assert financial_counts(db) == before and proposals(db) == []


def test_id_with_a_name_value_that_contradicts_its_evidence_writes_nothing(demo, db):
    before = financial_counts(db)
    r = known_tool(
        demo,
        "record_customer_payment",
        pay_args(
            customer_id=str(demo.lakshmi.id),
            customer_name="Lakshmi",
            evidence={"customer_name": "Ramesh", "amount": "5,000"},
        ),
        PAY_EN,
        {str(demo.lakshmi.id)},
    )
    assert r["status"] in ("needs_clarification", "needs_confirmation"), r
    assert financial_counts(db) == before
    assert not payments_of(db, demo.inv_ramesh.id)[1:]


def test_id_only_while_the_user_names_someone_else_is_read_back_with_the_real_customer(demo, db):
    before = financial_counts(db)
    r = known_tool(
        demo,
        "record_customer_payment",
        {"customer_id": str(demo.ramesh.id), "amount": 5000, "evidence": {"amount": "5,000"}},
        "Lakshmi paid 5,000 today.",
        {str(demo.ramesh.id)},
    )
    assert r["status"] == "needs_confirmation", r
    assert "Ramesh Kumar" in r["summary"], r  # the read-back names the customer it would be recorded against
    assert any("lakshmi" in reason for reason in r["confirmation_reasons"]), r
    assert financial_counts(db) == before


def test_matching_id_and_name_executes_exactly_once(demo, db):
    r = known_tool(
        demo,
        "record_customer_payment",
        pay_args(customer_id=str(demo.ramesh.id)),
        PAY_EN,
        {str(demo.ramesh.id)},
        turn_id="t-bound",
    )
    assert_executed_once(db, demo, r)
    again = known_tool(
        demo,
        "record_customer_payment",
        pay_args(customer_id=str(demo.ramesh.id)),
        PAY_EN,
        {str(demo.ramesh.id)},
        turn_id="t-bound",
    )
    assert again.get("_replayed") is True
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2  # the seeded payment + this one, once


def test_evidence_must_mean_the_value():
    assert evidence_matches_value("customer_name", "Ramesh Kumar", "Ramesh")
    assert evidence_matches_value("customer_name", "Ramesh", "రమేష్")
    assert not evidence_matches_value("customer_name", "Suresh", "Ramesh")
    assert evidence_matches_value("invoice_reference", "INV-0018", "invoice 18")
    assert not evidence_matches_value("invoice_reference", "INV-0019", "invoice 18")
    op = Operation(
        type="record_payment",
        customer_name="Ramesh",
        invoice_reference="INV-0019",
        evidence={"customer_name": "Ramesh", "invoice_reference": "invoice 18"},
    )
    warnings: list[Warn] = []
    verify_evidence("Ramesh paid invoice 18", op, 0, warnings)
    assert op.invoice_reference is None and op.customer_name == "Ramesh"
    assert [w.code for w in warnings] == ["UNSUPPORTED_VALUE_REMOVED"]


# ----------------------------------------------------------------------------- 2. confirm needs a yes now
@pytest.mark.parametrize(
    "said",
    ["yes", "Yes, go ahead.", "ok", "okay do it", "confirm", "haan", "ji haan", "theek hai", "kar do", "avunu",
     "sare", "cheyyi", "हाँ", "हां, कर दो", "ठीक है", "అవును", "సరే"],
)  # fmt: skip
def test_affirmations(said):
    assert affirmed(said)


@pytest.mark.parametrize(
    "said",
    ["wait, what is Ramesh's balance?", "yes?", "no", "ok wait", "don't", "what about Lakshmi", "नहीं",
     "వద్దు", "Ramesh paid 5,000 today.", "", "ok so what is the balance",
     "haan kitna baaki hai", "సరే ఎంత ఇవ్వాలి"],
)  # fmt: skip
def test_not_affirmations(said):
    assert not affirmed(said)


def test_affirmation_is_nfc_normalised():
    import unicodedata

    assert affirmed(unicodedata.normalize("NFD", "हाँ"))
    assert affirmed("  YES  ")


def _offer(demo):
    r = demo.tool(
        "record_customer_payment",
        pay_args(customer_name="Rames", evidence={"customer_name": "Rames", "amount": "5,000"}),
        "Rames paid 5,000 today.",
        turn_id="t-offer",
    )
    assert r["status"] == "needs_confirmation", r
    return r


def test_confirm_with_a_question_does_not_execute_then_yes_does(demo, db):
    r = _offer(demo)
    before = financial_counts(db)
    q = demo.tool(
        "confirm_pending_action",
        {"action_id": r["action_id"]},
        "Rames paid 5,000 today.\nwait, what is Ramesh's balance?",
        turn_id="t-question",
    )
    assert q["status"] == "needs_clarification" and q["code"] == "NOT_AFFIRMED", q
    assert financial_counts(db) == before
    db.expire_all()
    assert db.get(ProposedAction, uuid.UUID(r["action_id"])).status == "pending"
    ok = demo.tool("confirm_pending_action", {"action_id": r["action_id"]}, "हाँ, कर दो", turn_id="t-haan")
    assert_executed_once(db, demo, ok)


# ----------------------------------------------------------------------------- 3. cancel / edits
def test_declines():
    for said in ("no", "No, cancel it", "nahi", "नहीं", "వద్దు", "don't record it"):
        assert declined(said), said
    for said in ("yes", "what is the balance", "ok"):
        assert not declined(said), said


def test_cancel_needs_a_no_in_the_current_utterance(demo, db):
    r = _offer(demo)
    x = demo.tool(
        "cancel_pending_action", {"action_id": r["action_id"]}, "what is Ramesh's balance", turn_id="c1"
    )
    assert x["status"] == "needs_clarification" and x["code"] == "NOT_DECLINED", x
    db.expire_all()
    assert db.get(ProposedAction, uuid.UUID(r["action_id"])).status == "pending"
    y = demo.tool("cancel_pending_action", {"action_id": r["action_id"]}, "వద్దు", turn_id="c2")
    assert y["status"] == "completed" and y["rejected"] is True, y


def test_cancel_of_a_proposal_never_read_back_to_this_user_is_refused(demo, db):
    staff = demo.staff(db)
    db.commit()
    pending = demo.tool("record_customer_payment", pay_args(), PAY_EN, user=staff)
    assert pending["status"] == "needs_owner_approval", pending
    x = demo.tool("cancel_pending_action", {"action_id": pending["action_id"]}, "no, cancel it")
    assert x["status"] == "error" and x["code"] == "NOT_OFFERED", x
    db.expire_all()
    assert db.get(ProposedAction, uuid.UUID(pending["action_id"])).status == "pending"


def _phone(db, customer_id):
    db.expire_all()
    return db.get(Customer, customer_id).phone


def test_update_customer_value_not_said_is_read_back_then_confirmed(demo, db):
    old = _phone(db, demo.ramesh.id)
    args = {"customer_name": "Ramesh", "phone": "9123456780", "evidence": {"customer_name": "Ramesh"}}
    r = demo.tool("update_customer", args, "update Ramesh's phone number", turn_id="u1")
    assert r["status"] == "needs_confirmation", r
    assert _phone(db, demo.ramesh.id) == old
    # the model claims confirmation in the same breath without a read-back: still not written
    r2 = demo.tool("update_customer", {**args, "confirmed": True}, "yes", turn_id="u1")
    assert r2["status"] == "needs_confirmation" and _phone(db, demo.ramesh.id) == old
    # a question is not a yes
    r3 = demo.tool("update_customer", {**args, "confirmed": True}, "which number?", turn_id="u2")
    assert r3["status"] == "needs_confirmation" and _phone(db, demo.ramesh.id) == old
    done = demo.tool("update_customer", {**args, "confirmed": True}, "yes", turn_id="u3")
    assert done["status"] == "completed", done
    assert _phone(db, demo.ramesh.id) == "9123456780"


def test_update_customer_value_said_executes(demo, db):
    r = demo.tool(
        "update_customer",
        {"customer_name": "Ramesh", "phone": "9123456780", "evidence": {"customer_name": "Ramesh"}},
        "Ramesh's new number is 91234 56780",
    )
    assert r["status"] == "completed", r
    assert _phone(db, demo.ramesh.id) == "9123456780"


def test_note_for_the_wrong_customer_id_is_refused(demo, db):
    db.expire_all()
    notes = db.get(Customer, demo.lakshmi.id).notes
    r = demo.tool(
        "add_collection_note",
        {"customer_id": str(demo.lakshmi.id), "customer_name": "Ramesh", "note": "will visit Friday"},
        "Ramesh will visit Friday",
    )
    assert r["status"] == "needs_clarification", r
    db.expire_all()
    assert db.get(Customer, demo.lakshmi.id).notes == notes


def test_missed_promise_note_not_said_is_read_back(demo, db):
    db.expire_all()
    notes = db.get(Customer, demo.ramesh.id).notes
    r = demo.tool(
        "record_missed_promise",
        {"customer_name": "Ramesh", "note": "refused to pay and was rude"},
        "Ramesh did not pay",
    )
    assert r["status"] == "needs_confirmation", r
    db.expire_all()
    assert db.get(Customer, demo.ramesh.id).notes == notes
    ok = demo.tool("record_missed_promise", {"customer_name": "Ramesh"}, "Ramesh did not pay")
    assert ok["status"] == "completed", ok


def test_update_invoice_number_not_said_is_read_back(demo, db):
    number = demo.inv_ramesh.invoice_number
    r = demo.tool(
        "update_invoice", {"invoice_number": number, "notes": "call first"}, "add a note: call first"
    )
    assert r["status"] == "needs_confirmation", r
    n = str(int(number.split("-")[1]))
    ok = demo.tool(
        "update_invoice",
        {"invoice_number": number, "notes": "call first"},
        f"note on invoice {n}: call first",
    )
    assert ok["status"] == "completed", ok


# ----------------------------------------------------------------------------- 4. cancelled turn
def test_cancelled_turn_releases_its_claim_and_the_resend_pays_once(demo, db):
    paid_before = len(payments_of(db, demo.inv_ramesh.id))
    checks = iter([False, False, True])  # loop top, before the write, next loop top (barge-in)
    fake = FakeSarvam(tool_call("record_customer_payment", pay_args()))
    events: list[dict] = []
    kw = dict(
        user_id=demo.owner.id,
        business_id=demo.business.id,
        session_id=None,
        turn_id="t-barge",
        text=PAY_EN,
        language_hint=None,
        input_mode="voice",
    )
    first = orchestrator.run_turn(
        demo.factory, demo.settings, fake, emit=events.append, should_cancel=lambda: next(checks), **kw
    )
    assert first.reply == "" and any(e["type"] == "turn.cancelled" for e in events)
    assert len(payments_of(db, demo.inv_ramesh.id)) == paid_before + 1
    db.expire_all()
    assert not db.scalars(
        select(AgentMessage).where(AgentMessage.turn_id == "t-barge")
    ).all()  # claim released

    fake2 = FakeSarvam(tool_call("record_customer_payment", pay_args()), say("Recorded the payment."))
    events2: list[dict] = []
    second = orchestrator.run_turn(demo.factory, demo.settings, fake2, emit=events2.append, **kw)
    assert not second.replayed and second.reply, second
    assert second.tool_runs[0]["result"].get("_replayed") is True
    assert len(payments_of(db, demo.inv_ramesh.id)) == paid_before + 1  # no second payment
    db.expire_all()
    roles = sorted(m.role for m in db.scalars(select(AgentMessage).where(AgentMessage.turn_id == "t-barge")))
    assert roles == ["assistant", "user"]


# ----------------------------------------------------------------------------- 5. ticket redaction
def test_ticket_is_redacted_from_uvicorn_records():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJ4In0.c2lnbmF0dXJl"
    assert jwt not in redact_secrets(f"/api/v1/agent/live?ticket={jwt}")
    assert (
        redact_secrets("/api/v1/agent/live?x=1&ticket=abc&y=2")
        == f"/api/v1/agent/live?x=1&ticket={REDACTED}&y=2"
    )

    install_redaction()
    install_redaction()  # idempotent
    for name in ("uvicorn.error", "uvicorn.access"):
        filters = [f for f in logging.getLogger(name).filters if isinstance(f, RedactSecretsFilter)]
        assert len(filters) == 1

    # uvicorn.error: '%s - "WebSocket %s" [accepted]'
    rec = logging.LogRecord(
        "uvicorn.error", logging.INFO, __file__, 1, '%s - "WebSocket %s" [accepted]',
        ("127.0.0.1:5000", f"/api/v1/agent/live?ticket={jwt}"), None,
    )  # fmt: skip
    assert RedactSecretsFilter().filter(rec)
    assert jwt not in rec.getMessage() and REDACTED in rec.getMessage()

    # uvicorn.access keeps its 5-tuple args (the AccessFormatter unpacks them)
    from uvicorn.logging import AccessFormatter

    acc = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", "GET", f"/api/v1/agent/live?ticket={jwt}", "1.1", 403), None,
    )  # fmt: skip
    assert RedactSecretsFilter().filter(acc)
    line = AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s').format(acc)
    assert jwt not in line and REDACTED in line


def test_redaction_through_a_real_logger(caplog):
    install_redaction()
    lg = logging.getLogger("uvicorn.error")
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        lg.addHandler(caplog.handler)
        try:
            lg.info('%s - "WebSocket %s" [accepted]', "1.2.3.4:1", "/api/v1/agent/live?ticket=secret-jwt")
        finally:
            lg.removeHandler(caplog.handler)
    assert "secret-jwt" not in caplog.text and REDACTED in caplog.text
