"""Pure unit tests for the voice agent's safety helpers (no database, no provider)."""

from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.schemas.ai import Operation
from app.services.agent.numbers import spoken_amount
from app.services.agent.orchestrator import claims_success, detect_language, operation_digest, verify_reply
from app.services.agent.tools import value_checks
from app.services.ai.resolution import name_score
from app.services.ai.text_parse import romanize


@pytest.mark.parametrize(
    ("phrase", "value"),
    [
        ("5,000", "5000"),
        ("₹5,000", "5000"),
        ("5k", "5000"),
        ("five thousand", "5000"),
        ("six thousand five hundred", "6500"),
        ("one lakh twenty thousand", "120000"),
        ("पाँच हज़ार रुपये", "5000"),
        ("5 हज़ार", "5000"),
        ("डेढ़ लाख", "150000"),
        ("ఐదు వేల", "5000"),
        ("ఐదు వేల రూపాయలు", "5000"),
    ],
)
def test_spoken_amount_parses_what_was_said(phrase, value):
    assert spoken_amount(phrase) == Decimal(value).quantize(Decimal("0.01"))


@pytest.mark.parametrize("phrase", ["", "paid", "some money", "he paid me", "రమేష్"])
def test_spoken_amount_refuses_to_guess(phrase):
    assert spoken_amount(phrase) is None


def test_indic_names_match_latin_customers():
    assert romanize("రమేష్") == "ramesh"
    assert romanize("रमेश") == "ramesh"
    assert name_score("రమేష్", "Ramesh Kumar") >= 0.9
    assert name_score("रमेश जी", "Ramesh Kumar") >= 0.9  # honorific ignored
    assert name_score("సురేష్", "Ramesh Kumar") < 0.75  # a different name is not matched


def test_operation_digest_ignores_phrasing_but_not_substance():
    a = {"customer_name": "Ramesh", "amount": 5000, "evidence": {"amount": "five thousand"}, "notes": "x"}
    b = {"customer_name": " ramesh ", "amount": 5000.0, "evidence": {"amount": "5,000"}, "notes": "y"}
    c = {"customer_name": "Ramesh", "amount": 6000, "evidence": {"amount": "6,000"}}
    assert operation_digest(a) == operation_digest(b)
    assert operation_digest(a) != operation_digest(c)


def test_success_claims_are_detected():
    assert claims_success("I've recorded ₹5,000 for Ramesh.")
    assert claims_success("The payment has been recorded.")
    assert claims_success("रमेश का भुगतान दर्ज कर दिया गया है।")
    assert not claims_success("How much did Ramesh pay?")
    assert not claims_success("Ramesh owes you ₹12,000.")


def test_reply_figures_must_come_from_tools_or_the_user():
    allowed = '{"outstanding": "7000.00"} Ramesh paid 5,000'
    assert verify_reply("He now owes ₹7,000.", allowed)
    assert not verify_reply("He now owes ₹9,000.", allowed)


def test_language_detection_by_script():
    assert detect_language("రమేష్ ఇచ్చాడు", None) == "te-IN"
    assert detect_language("रमेश ने दिए", None) == "hi-IN"
    assert detect_language("Ramesh paid", None) == "en-IN"


def _ctx(known=(), said="Ramesh paid ఐదు వేల, maybe 500, he paid 5,000"):
    return SimpleNamespace(known_ids=set(known), transcript=said)


def test_value_checks_require_the_spoken_amount_to_match():
    ok = Operation(
        type="record_payment", customer_name="Ramesh", amount=Decimal("5000"), evidence={"amount": "ఐదు వేల"}
    )
    wrong = Operation(
        type="record_payment", customer_name="Ramesh", amount=Decimal("5000"), evidence={"amount": "500"}
    )
    vague = Operation(
        type="record_payment", customer_name="Ramesh", amount=Decimal("5000"), evidence={"amount": "paid"}
    )
    assert value_checks(_ctx(), [ok]) == []
    assert value_checks(_ctx(), [wrong]) and value_checks(_ctx(), [vague])


def test_value_checks_require_a_known_customer_id():
    cid = "6b0f6e2c-1111-4a5a-9c1e-1234567890ab"
    op = Operation(
        type="record_payment", customer_id=cid, amount=Decimal("5000"), evidence={"amount": "5,000"}
    )
    assert value_checks(_ctx(), [op])  # an id nobody looked up -> read back first
    assert value_checks(_ctx({cid}), [op]) == []


def test_amount_evidence_key_does_not_matter_but_the_words_do():
    from app.services.agent.tools import amount_evidenced

    said = "Actually, he paid six thousand, not five thousand."
    assert amount_evidenced(Decimal("6000"), {"new_amount": "six thousand"}, said)
    assert not amount_evidenced(
        Decimal("6000"), {"new_amount": "six thousand rupees exactly"}, said
    )  # not said
    assert not amount_evidenced(
        Decimal("7000"), {"amount": "six thousand"}, said
    )  # said, but a different amount
