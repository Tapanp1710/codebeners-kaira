"""MOCKED LLM/STT/TTS: the agent's HTTP API (session tickets, typed turns, conversation history, usage).

app.state.sarvam is replaced by FakeSarvam (scripted chat_tools responses); no provider is contacted."""

from __future__ import annotations

import uuid
from decimal import Decimal

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import AgentSession
from tests.agent.conftest import FakeSarvam, outstanding, payments_of, say, tool_call
from tests.conftest import Api, add_user, make_business

PAY_ARGS = {
    "customer_name": "Ramesh",
    "amount": 5000,
    "evidence": {"customer_name": "Ramesh", "amount": "5,000"},
}


def login(demo, email) -> Api:
    """A separate browser (own cookie jar) for each user."""
    return Api(TestClient(demo.app), email)


# ----------------------------------------------------------------------------- POST /agent/session
def test_session_requires_auth_and_csrf(demo):
    anon = TestClient(demo.app)
    assert anon.post("/api/v1/agent/session", json={}).status_code == 401
    api = demo.api()
    r = api.client.post("/api/v1/agent/session", json={})  # cookie but no X-CSRF-Token
    assert r.status_code == 403 and r.json()["error"]["code"] == "CSRF_FAILED"


def test_session_returns_a_signed_short_lived_ticket(demo, db):
    api = demo.api()
    data = api.data(api.post("/agent/session", {}))
    assert data["expires_in"] == demo.settings.AGENT_TICKET_TTL_SECONDS == 60
    assert data["ws_url"] == demo.settings.AGENT_PUBLIC_WS_URL
    assert data["voice_configured"] is False  # no SARVAM_API_KEY in tests
    # The ticket is bound to the WebSocket audience: decoding it without that audience must fail, so it can
    # never be replayed as a token for another verifier that skips the audience check.
    with pytest.raises(jwt.InvalidAudienceError):
        jwt.decode(data["ticket"], demo.settings.JWT_SECRET_KEY, algorithms=["HS256"], audience="kaira-api")
    claims = jwt.decode(
        data["ticket"], demo.settings.JWT_SECRET_KEY, algorithms=["HS256"], audience="kaira-agent-ws"
    )
    assert claims["typ"] == "agent_ws" and claims["aud"] == "kaira-agent-ws"
    assert len(claims["jti"]) >= 16  # unique id that makes the ticket single-use
    assert (claims["sub"], claims["bid"], claims["sid"]) == (
        str(demo.owner.id),
        str(demo.business.id),
        data["session_id"],
    )
    assert claims["exp"] - claims.get("iat", claims["exp"] - 60) <= 60
    s = db.get(AgentSession, uuid.UUID(data["session_id"]))
    assert s.user_id == demo.owner.id and s.status == "active"


def test_session_resume_only_own_session(demo, db):
    api = demo.api()
    first = api.data(api.post("/agent/session", {}))["session_id"]
    again = api.data(api.post("/agent/session", {"resume_session_id": first}))["session_id"]
    assert again == first
    staff = add_user(db, demo.business, "staff")
    other = login(demo, staff.email)
    hijack = other.data(other.post("/agent/session", {"resume_session_id": first}))["session_id"]
    assert hijack != first
    db.expire_all()
    assert db.get(AgentSession, uuid.UUID(hijack)).user_id == staff.id


# ----------------------------------------------------------------------------- POST /agent/turn
def test_typed_turn_end_to_end_with_fake_llm(demo, db):
    demo.app.state.sarvam = FakeSarvam(
        tool_call("get_customer", {"customer_name": "Ramesh"}),
        tool_call("record_customer_payment", PAY_ARGS),
        say("Recorded ₹5,000 from Ramesh Kumar. He now owes ₹7,000."),
    )
    api = demo.api()
    data = api.data(api.post("/agent/turn", {"text": "Ramesh paid 5,000 today.", "turn_id": "http-1"}))
    assert data["turn_id"] == "http-1"
    assert data["reply"] == "Recorded ₹5,000 from Ramesh Kumar. He now owes ₹7,000."
    assert (data["ignored"], data["replayed"], data["language"]) == (False, False, "en-IN")
    kinds = [e["type"] for e in data["events"]]
    assert kinds[0] == "turn.started" and kinds[-1] == "reply"
    assert [e["tool"] for e in data["events"] if e["type"] == "tool.completed"] == [
        "get_customer",
        "record_customer_payment",
    ]
    assert outstanding(db, demo.inv_ramesh.id) == Decimal("7000.00")
    # the books seen through the normal API agree
    inv = api.data(api.get(f"/invoices/{demo.inv_ramesh.id}"))
    assert inv["outstanding"] == "7000.00"

    # same turn_id again: stored reply, nothing re-run
    demo.app.state.sarvam = FakeSarvam()
    again = api.data(api.post("/agent/turn", {"text": "Ramesh paid 5,000 today.", "turn_id": "http-1"}))
    assert again["replayed"] is True and again["reply"] == data["reply"]
    assert len(payments_of(db, demo.inv_ramesh.id)) == 2


def test_turn_requires_auth_csrf_and_valid_turn_id(demo):
    demo.app.state.sarvam = FakeSarvam()
    anon = TestClient(demo.app)
    assert anon.post("/api/v1/agent/turn", json={"text": "hi"}).status_code == 401
    api = demo.api()
    assert api.client.post("/api/v1/agent/turn", json={"text": "hi"}).status_code == 403
    assert api.post("/agent/turn", {"text": "hi", "turn_id": "bad turn id!"}).status_code == 422
    assert api.post("/agent/turn", {"text": "hi", "turn_id": "x" * 65}).status_code == 422
    assert api.post("/agent/turn", {"text": ""}).status_code == 422
    assert demo.app.state.sarvam.calls == []


def test_staff_typed_payment_waits_for_owner(demo, db):
    staff = add_user(db, demo.business, "staff")
    demo.app.state.sarvam = FakeSarvam(
        tool_call("record_customer_payment", PAY_ARGS), say("I have sent it to the owner for approval.")
    )
    api = login(demo, staff.email)
    data = api.data(api.post("/agent/turn", {"text": "Ramesh paid 5,000 today."}))
    [done] = [e for e in data["events"] if e["type"] == "tool.completed"]
    assert done["status"] == "needs_owner_approval"
    assert len(payments_of(db, demo.inv_ramesh.id)) == 1


# ----------------------------------------------------------------------------- GET /agent/conversation
def test_conversation_returns_only_the_callers_messages(demo, db):
    demo.app.state.sarvam = FakeSarvam(
        tool_call("get_customer", {"customer_name": "Ramesh"}), say("Ramesh Kumar owes ₹12,000.")
    )
    api = demo.api()
    api.data(api.post("/agent/turn", {"text": "How much does Ramesh owe?", "turn_id": "conv-1"}))
    conv = api.data(api.get("/agent/conversation"))
    assert [(m["role"], m["text"]) for m in conv] == [
        ("user", "How much does Ramesh owe?"),
        ("assistant", "Ramesh Kumar owes ₹12,000."),
    ]
    assert conv[0]["facts"] is None
    assert conv[1]["facts"][0]["customer_id"] == str(demo.ramesh.id)

    # a staff user of the same business sees none of the owner's conversation
    staff = add_user(db, demo.business, "staff")
    staff_api = login(demo, staff.email)
    assert staff_api.data(staff_api.get("/agent/conversation")) == []
    # nor does another business
    _, other_owner = make_business(db, name="Other Co")
    other = login(demo, other_owner.email)
    assert other.data(other.get("/agent/conversation")) == []
    assert TestClient(demo.app).get("/api/v1/agent/conversation").status_code == 401


# ----------------------------------------------------------------------------- GET /agent/sessions/{id}
def test_session_usage_is_business_scoped(demo, db):
    api = demo.api()
    sid = api.data(api.post("/agent/session", {}))["session_id"]
    usage = api.data(api.get(f"/agent/sessions/{sid}"))
    assert usage["session_id"] == sid
    assert (usage["stt_audio_seconds_billed"], usage["tts_characters"], usage["llm_calls"]) == ("0.00", 0, 0)
    _, other_owner = make_business(db, name="Other Co")
    other = login(demo, other_owner.email)
    assert other.get(f"/agent/sessions/{sid}").status_code == 404
    db.expire_all()
    assert db.scalar(select(AgentSession.status).where(AgentSession.id == uuid.UUID(sid))) == "active"
