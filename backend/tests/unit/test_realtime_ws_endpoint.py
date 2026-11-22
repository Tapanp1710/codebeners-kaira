"""WS /api/v1/agent/live endpoint: ticket, origin and user checks, and the full socket lifecycle with usage saved.

REAL PostgreSQL (TEST_DATABASE_URL, *_test) + in-process WebSocket via Starlette's TestClient. Sarvam STT/TTS and the
agent turn are fakes (no network), so this checks the endpoint and LiveSession's SQL usage accounting."""

from __future__ import annotations

import json
import time
from decimal import Decimal

import pytest
from starlette.websockets import WebSocketDisconnect

from app.models import AgentSession, User
from app.services.agent import live, orchestrator
from tests.unit.test_realtime_live import FakeAgent, FakeStt, FakeTts

WS = "/api/v1/agent/live"


def ticket(owner, resume=None) -> dict:
    return owner.data(owner.post("/agent/session", {"resume_session_id": resume}))


def test_ticket_is_single_use_and_checked(owner):
    t = ticket(owner)
    with pytest.raises(WebSocketDisconnect) as info:
        with owner.client.websocket_connect(f"{WS}?ticket=not-a-ticket") as ws:
            ws.receive_json()
    assert info.value.code == 1008
    # Not configured: the socket opens, reports a fatal configuration error and closes normally.
    with owner.client.websocket_connect(f"{WS}?ticket={t['ticket']}") as ws:
        msg = ws.receive_json()
        assert msg["code"] == "PROVIDER_NOT_CONFIGURED" and msg["fatal"] is True
    with pytest.raises(WebSocketDisconnect) as info:
        with owner.client.websocket_connect(f"{WS}?ticket={t['ticket']}") as ws:
            ws.receive_json()
    assert info.value.code == 1008  # the same ticket a second time


def test_origin_must_be_allowed(owner):
    t = ticket(owner)
    with pytest.raises(WebSocketDisconnect) as info:
        with owner.client.websocket_connect(
            f"{WS}?ticket={t['ticket']}", headers={"origin": "https://evil.example"}
        ) as ws:
            ws.receive_json()
    assert info.value.code == 1008


def test_deactivated_user_is_refused(owner, db):
    t = ticket(owner)
    user = db.get(User, owner.user.id)
    user.is_active = False
    db.commit()
    with pytest.raises(WebSocketDisconnect) as info:
        with owner.client.websocket_connect(f"{WS}?ticket={t['ticket']}") as ws:
            ws.receive_json()
    assert info.value.code == 1008


@pytest.fixture
def fake_voice(app, monkeypatch):
    FakeStt.instances, FakeStt.script = [], [{"billed_on_close": 2.25}]
    FakeTts.instances, FakeTts.chunks, FakeTts.chunk_bytes, FakeTts.delay = [], 2, 400, 0.0
    live._ACTIVE.clear()
    agent = FakeAgent()
    monkeypatch.setattr(live, "SttStream", FakeStt)
    monkeypatch.setattr(live, "TtsStream", FakeTts)
    monkeypatch.setattr(orchestrator, "run_turn", agent.run_turn)
    object.__setattr__(app.state.settings, "SARVAM_API_KEY", "sk_test_dummy")
    return agent


def test_live_socket_lifecycle_saves_usage(owner, db, fake_voice):
    t = ticket(owner)
    with owner.client.websocket_connect(f"{WS}?ticket={t['ticket']}") as ws:
        assert ws.receive_json()["stt"] == "connected"
        ws.send_bytes(b"\x00\x00" * 16000)  # 1 s of audio
        ws.send_json({"type": "text", "text": "how much is pending", "turn_id": "ws-t1"})
        kinds = []
        while "tts.end" not in kinds:
            msg = ws.receive()
            if msg.get("text"):
                kinds.append(json.loads(msg["text"])["type"])
        assert {"reply", "turn.completed", "tts.start", "tts.first_audio"} <= set(kinds)
    deadline = time.time() + 10
    session = None
    while time.time() < deadline:
        db.expire_all()
        session = db.get(AgentSession, t["session_id"])
        if session.status == "ended":
            break
        time.sleep(0.05)
    assert session is not None and session.status == "ended" and session.ended_at is not None
    assert session.stt_audio_seconds == Decimal("2.25")  # billed from session.end
    assert session.stt_audio_sent_seconds == Decimal("1.00")
    assert session.tts_characters == len("Done: how much is pending. Anything else? ")
    assert fake_voice.calls == [("ws-t1", "how much is pending")]
    assert FakeStt.instances[0].closed and FakeTts.instances[0].closed
    usage = owner.data(owner.get(f"/agent/sessions/{t['session_id']}"))
    assert usage["stt_audio_seconds_billed"] == "2.25"

    # Resume the same session: usage accumulates atomically on the same row.
    FakeStt.script = [{"billed_on_close": 0.5}]
    t2 = ticket(owner, resume=t["session_id"])
    assert t2["session_id"] == t["session_id"]
    with owner.client.websocket_connect(f"{WS}?ticket={t2['ticket']}") as ws:
        assert ws.receive_json()["stt"] == "connected"
    deadline = time.time() + 10
    while time.time() < deadline:
        db.expire_all()
        session = db.get(AgentSession, t["session_id"])
        if session.stt_audio_seconds == Decimal("2.75") and session.status == "ended":
            break
        time.sleep(0.05)
    assert session.stt_audio_seconds == Decimal("2.75")
    assert session.status == "ended"
