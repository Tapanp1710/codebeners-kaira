"""Agent write tools: server-side date resolution (real PostgreSQL through the orchestrator's tool executor).

Every call goes through orchestrator._exec_tool, i.e. the same idempotency record, transaction and commit the live
agent uses. The model's arguments are scripted; no provider is called."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import Bill, Invoice, Payment, PaymentCommitment, ProposedAction
from app.services.agent import dates as D
from app.services.agent import orchestrator
from tests.conftest import today as business_today


def next_weekday(d: date, wd: int) -> date:
    return d + timedelta(days=(wd - d.weekday()) % 7 or 7)


class Agent:
    def __init__(self, app, settings, owner, language="en-IN"):
        self.factory = app.state.session_factory
        self.settings = settings
        self.user_id = owner.user.id
        self.business_id = owner.business.id
        self.language = language
        self.turn = 0
        self.known: set[str] = set()

    def call(self, tool: str, args: dict, said: str, *, turn: str | None = None) -> dict:
        if turn is None:
            self.turn += 1
            turn = f"t{self.turn}-{uuid.uuid4().hex[:6]}"
        r = orchestrator._exec_tool(
            self.factory,
            self.settings,
            None,
            self.user_id,
            self.business_id,
            turn,
            tool,
            args,
            said,
            self.language,
            self.known,
        )
        r.pop("_events", None)
        self.known |= set(orchestrator.UUID_RE.findall(str(r)))
        return r


@pytest.fixture
def setup(owner, app, settings, db):
    cust = owner.customer("Ramesh Kumar")
    inv = owner.invoice(cust["id"], "12000.00")
    agent = Agent(app, settings, owner)
    agent.customer_id, agent.invoice_id = cust["id"], inv["id"]
    return agent


def payments(db) -> list[Payment]:
    db.expire_all()
    return list(db.scalars(select(Payment)))


def promises(db) -> list[PaymentCommitment]:
    db.expire_all()
    return list(db.scalars(select(PaymentCommitment).where(PaymentCommitment.status == "pending")))


COMBINED_EN = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."
COMBINED_TE = "రమేష్ ఈరోజు ఐదు వేల రూపాయలు ఇచ్చాడు. మిగిలిన మొత్తం వచ్చే సోమవారం ఇస్తాడు."
COMBINED_HI = "रमेश ने आज पाँच हज़ार रुपये दिए, बाकी अगले सोमवार को देगा।"


@pytest.mark.parametrize(
    ("said", "ev"),
    [
        (COMBINED_EN, {"customer_name": "Ramesh", "amount": "5,000", "date": "today",
                       "expected_payment_date": "next Monday", "remaining_balance": "remaining"}),
        (COMBINED_TE, {"customer_name": "రమేష్", "amount": "ఐదు వేల", "date": "ఈరోజు",
                       "expected_payment_date": "వచ్చే సోమవారం", "remaining_balance": "మిగిలిన"}),
        (COMBINED_HI, {"customer_name": "रमेश", "amount": "पाँच हज़ार", "date": "आज",
                       "expected_payment_date": "अगले सोमवार", "remaining_balance": "बाकी"}),
    ],
)  # fmt: skip
def test_paid_today_rest_next_monday_stores_resolved_dates(setup, db, said, ev):
    today = business_today()
    monday = next_weekday(today, 0)
    r = setup.call(
        "record_payment_and_promise",
        {"customer_name": ev["customer_name"], "amount": 5000, "expected_payment_date": monday.isoformat(),
         "evidence": ev},
        said,
    )  # fmt: skip
    assert r["status"] == "completed", r
    (p,) = payments(db)
    (k,) = promises(db)
    assert p.amount == Decimal("5000.00") and p.payment_date == today
    assert k.amount == Decimal("7000.00") and k.expected_payment_date == monday
    stored = {s["type"]: s for s in r["stored"]}
    assert stored["payment"]["payment_date"] == today.isoformat()
    assert stored["promise"]["expected_payment_date"] == monday.isoformat()
    assert monday.isoformat() in r["summary"] and today.isoformat() in r["summary"]
    # evidence is preserved on the proposal for audit
    action = db.get(ProposedAction, uuid.UUID(r["action_id"]))
    fields = {e["field"]: e["fragment"] for e in action.evidence if e["operation_index"] == 1}
    assert fields["expected_payment_date"] in said


def test_model_date_that_contradicts_the_words_is_read_back_with_both(setup, db):
    today = business_today()
    monday = next_weekday(today, 0)
    wrong = monday + timedelta(days=7)  # the classic 'next Monday' off-by-a-week
    args = {
        "customer_name": "Ramesh",
        "amount": 5000,
        "expected_payment_date": wrong.isoformat(),
        "evidence": {
            "customer_name": "Ramesh",
            "amount": "5,000",
            "date": "today",
            "expected_payment_date": "next Monday",
        },
    }
    r = setup.call("record_payment_and_promise", args, COMBINED_EN)
    assert r["status"] == "needs_confirmation", r
    assert payments(db) == [] and promises(db) == []
    msg = " ".join(r["confirmation_reasons"])
    assert monday.isoformat() in msg and wrong.isoformat() in msg
    action = db.get(ProposedAction, uuid.UUID(r["action_id"]))
    assert action.extracted_data["operations"][1]["expected_payment_date"] == monday.isoformat()
    # the user says yes in the next turn: the date from their words is stored, never the model's
    done = setup.call("confirm_pending_action", {"action_id": r["action_id"]}, COMBINED_EN + "\nyes")
    assert done["status"] == "completed", done
    (k,) = promises(db)
    assert k.expected_payment_date == monday


def test_ambiguous_hindi_kal_asks_instead_of_guessing(setup, db):
    tomorrow = business_today() + timedelta(days=1)
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "रमेश", "amount": 3000, "expected_payment_date": tomorrow.isoformat(),
         "evidence": {"customer_name": "रमेश", "amount": "3000", "expected_payment_date": "कल"}},
        "रमेश 3000 कल",
    )  # fmt: skip
    assert r["status"] == "needs_clarification", r
    assert "expected_payment_date" in r["missing"]
    assert promises(db) == []
    # with a future verb the same word is unambiguous
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "रमेश", "amount": 3000, "expected_payment_date": tomorrow.isoformat(),
         "evidence": {"customer_name": "रमेश", "amount": "3000", "expected_payment_date": "कल"}},
        "रमेश 3000 कल देगा",
    )  # fmt: skip
    assert r["status"] == "completed", r
    (k,) = promises(db)
    assert k.expected_payment_date == tomorrow


def test_promise_on_explicit_date(setup, db):
    today = business_today()
    dec5 = D.find_dates("5th December", today)[0].date
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "Ramesh", "amount": 3000, "expected_payment_date": dec5.isoformat(),
         "evidence": {"customer_name": "Ramesh", "amount": "3000", "expected_payment_date": "5th December"}},
        "Ramesh will pay 3000 on 5th December",
    )  # fmt: skip
    assert r["status"] == "completed", r
    (k,) = promises(db)
    assert k.expected_payment_date == dec5 and k.amount == Decimal("3000.00")
    assert r["stored"][0]["expected_payment_date"] == dec5.isoformat()


def test_promise_without_any_date_words_is_clarified(setup, db):
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "Ramesh", "amount": 3000, "expected_payment_date": "",
         "evidence": {"customer_name": "Ramesh", "amount": "3000"}},
        "Ramesh will pay 3000",
    )  # fmt: skip
    assert r["status"] == "needs_clarification" and promises(db) == []


def test_payment_without_date_words_defaults_to_business_today(setup, db):
    r = setup.call(
        "record_customer_payment",
        {
            "customer_name": "Ramesh",
            "amount": 2000,
            "evidence": {"customer_name": "Ramesh", "amount": "2000"},
        },
        "Ramesh paid 2000",
    )
    assert r["status"] == "completed", r
    (p,) = payments(db)
    assert p.payment_date == business_today()
    assert r["dates"][0]["decision"] == "defaulted"
    assert any("No payment date was stated" in w for w in db.get(ProposedAction, uuid.UUID(r["action_id"])).warnings
               for w in [w["message"]])  # fmt: skip


def test_payment_date_the_user_never_said_is_not_used(setup, db):
    yesterday = business_today() - timedelta(days=1)
    r = setup.call(
        "record_customer_payment",
        {"customer_name": "Ramesh", "amount": 2000, "date": yesterday.isoformat(),
         "evidence": {"customer_name": "Ramesh", "amount": "2000"}},
        "Ramesh paid 2000",
    )  # fmt: skip
    assert r["status"] == "needs_confirmation", r
    assert payments(db) == []
    assert "No date was said" in " ".join(r["confirmation_reasons"])


def test_payment_yesterday_from_the_words(setup, db):
    yesterday = business_today() - timedelta(days=1)
    r = setup.call(
        "record_customer_payment",
        {"customer_name": "రమేష్", "amount": 2000, "date": yesterday.isoformat(),
         "evidence": {"customer_name": "రమేష్", "amount": "2000", "date": "నిన్న"}},
        "రమేష్ నిన్న 2000 ఇచ్చాడు",
    )  # fmt: skip
    assert r["status"] == "completed", r
    (p,) = payments(db)
    assert p.payment_date == yesterday


def test_payment_dated_in_the_future_is_refused(setup, db):
    r = setup.call(
        "record_customer_payment",
        {"customer_name": "Ramesh", "amount": 3000,
         "evidence": {"customer_name": "Ramesh", "amount": "3000", "date": "5th December"}},
        "Ramesh paid 3000 on 5th December",
    )  # fmt: skip
    if D.find_dates("5th December", business_today(), prefer=D.PAST)[0].date <= business_today():
        pytest.skip("5 December has already passed this year")
    assert r["status"] == "needs_clarification", r
    assert payments(db) == []


def test_sunday_edge_next_monday_is_tomorrow(setup, db, monkeypatch):
    sunday = date(2031, 1, 5)  # a Sunday in the future, so the promise is valid against the real clock too
    assert sunday.weekday() == 6
    monkeypatch.setattr(orchestrator, "business_today", lambda tz: sunday)
    good = date(2031, 1, 6)
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "Ramesh", "amount": 3000, "expected_payment_date": "2031-01-13",
         "evidence": {"customer_name": "Ramesh", "amount": "3000", "expected_payment_date": "next Monday"}},
        "Ramesh will pay 3000 next Monday",
    )  # fmt: skip
    assert r["status"] == "needs_confirmation", r
    d = r["dates"][0]
    assert d["date"] == good.isoformat() and d["date_proposed"] == "2031-01-13"
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "రమేష్", "amount": 3000, "expected_payment_date": good.isoformat(),
         "evidence": {"customer_name": "రమేష్", "amount": "3000", "expected_payment_date": "వచ్చే సోమవారం"}},
        "రమేష్ వచ్చే సోమవారం 3000 ఇస్తాడు",
    )  # fmt: skip
    assert r["status"] == "completed", r
    assert [k.expected_payment_date for k in promises(db)] == [good]


def test_business_timezone_not_server_utc_decides_the_date(setup, db, monkeypatch):
    # 20:00 UTC on Sunday 5 Jan 2031 is already Monday 6 Jan in India.
    instant = datetime(2031, 1, 5, 20, 0, tzinfo=UTC)
    monkeypatch.setattr(orchestrator, "business_today", lambda tz: D.local_today(tz, instant))
    r = setup.call(
        "record_payment_promise",
        {"customer_name": "Ramesh", "amount": 3000, "expected_payment_date": "2031-01-13",
         "evidence": {"customer_name": "Ramesh", "amount": "3000", "expected_payment_date": "next Monday"}},
        "Ramesh will pay 3000 next Monday",
    )  # fmt: skip
    assert r["status"] == "completed", r  # Monday in IST -> next Monday is the 13th, as proposed
    assert [k.expected_payment_date for k in promises(db)] == [date(2031, 1, 13)]


def test_expense_paid_today_and_bill_due_date(setup, db):
    today = business_today()
    r = setup.call(
        "record_expense",
        {"vendor_name": "landlord", "amount": 15000, "description": "shop rent", "paid_now": True,
         "evidence": {"vendor_name": "landlord", "amount": "15000", "date": "today"}},
        "I paid the landlord 15000 shop rent today",
    )  # fmt: skip
    assert r["status"] == "completed", r
    db.expire_all()
    (bill,) = db.scalars(select(Bill)).all()
    assert bill.bill_date == today
    assert r["stored"][0]["bill_date"] == today.isoformat()
    due = D.find_dates("end of month", today)[0].date
    r = setup.call(
        "record_expense",
        {"vendor_name": "Sharma Supplies", "amount": 4000, "due_date": due.isoformat(),
         "evidence": {"vendor_name": "Sharma Supplies", "amount": "4000", "due_date": "end of month"}},
        "Bill from Sharma Supplies for 4000, due end of month",
    )  # fmt: skip
    assert r["status"] == "completed", r
    assert r["stored"][0]["due_date"] == due.isoformat()


def test_update_invoice_due_date_follows_the_words(setup, db):
    today = business_today()
    friday = next_weekday(today, 4)
    db.expire_all()
    number = db.get(Invoice, uuid.UUID(setup.invoice_id)).invoice_number
    spoken_number = str(int(number.split("-")[1]))  # "invoice 1", not "INV-0001"
    r = setup.call(
        "update_invoice",
        {"invoice_number": spoken_number, "due_date": (friday + timedelta(days=1)).isoformat(),
         "evidence": {"due_date": "next Friday"}},
        f"Move invoice {spoken_number} to next Friday",
    )  # fmt: skip
    assert r["status"] == "needs_clarification", r
    db.expire_all()
    assert db.get(Invoice, uuid.UUID(setup.invoice_id)).due_date != friday
    r = setup.call(
        "update_invoice",
        {
            "invoice_number": spoken_number,
            "due_date": friday.isoformat(),
            "evidence": {"due_date": "next Friday"},
        },
        f"Move invoice {spoken_number} to next Friday",
    )
    assert r["status"] == "completed", r
    db.expire_all()
    assert db.get(Invoice, uuid.UUID(setup.invoice_id)).due_date == friday
    assert r["due_date"] == friday.isoformat()
