"""MOCKED LLM/STT/TTS: the live voice WebSocket /api/v1/agent/live.

app.services.agent.live.SttStream and TtsStream are replaced by in-process fakes: the fake STT turns test
"control frames" (binary b"EV:" + JSON) into scripted Sarvam STT events and records every real audio frame it
is given; the fake TTS returns fixed PCM chunks. The LLM is FakeSarvam. SARVAM_API_KEY is a dummy value set on
the test Settings only. No network."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import anyio
import jwt
import pytest
from sqlalchemy import select, update
from starlette.websockets import WebSocketDisconnect

from app.integrations.sarvam import realtime
from app.models import AgentMessage, AgentSession, User
from app.services.agent import live
from tests.agent.conftest import FakeSarvam, payments_of, say, tool_call

ORIGIN = "http://localhost:3000"
PCM_CHUNK = b"\x10\x00" * 1000  # 2,000 bytes of fake 22.05 kHz linear16 PCM


class FakeStt:
    """Stands in for realtime.SttStream (same public surface)."""

    instances: list[FakeStt] = []
    session_end_on_close: float | None = None  # Sarvam answers {"event": "end"} with session.end

    def __init__(self, settings, config, keyterms=None) -> None:
        self.settings, self.config, self.keyterms = settings, config, list(keyterms or [])
        self.received: list[bytes] = []
        self.billed_audio_seconds = 0.0
        self.sent_bytes = 0
        self.closed = False
        self.queue: asyncio.Queue = asyncio.Queue()
        type(self).instances.append(self)

    async def connect(self) -> None:
        return None

    async def send_pcm(self, pcm: bytes) -> None:
        if pcm.startswith(b"EV:"):  # test control frame -> scripted provider event
            self.queue.put_nowait(json.loads(pcm[3:].decode()))
            return
        self.received.append(pcm)
        self.sent_bytes += len(pcm)

    async def ping(self) -> None:
        return None

    async def events(self):
        while True:
            ev = await self.queue.get()
            if ev is None:
                return
            if ev.get("event") == "session.end":  # same accounting as the real adapter
                self.billed_audio_seconds += float(ev.get("audio_duration_s") or 0)
            yield ev

    async def close(self) -> None:
        # Like realtime.SttStream.close(): send 'end', read Sarvam's session.end and add its billed seconds.
        # Idempotent like the real adapter: session.end is read (and billed) only on the first close.
        if self.closed:
            return
        self.closed = True
        if self.session_end_on_close is not None:
            self.billed_audio_seconds += self.session_end_on_close

    @property
    def sent_audio_seconds(self) -> float:
        return self.sent_bytes / 32000


class FakeTts:
    """Stands in for realtime.TtsStream."""

    instances: list[FakeTts] = []
    chunks: list[bytes] = [PCM_CHUNK, PCM_CHUNK]
    hold: float = 0.0  # seconds to wait after each chunk (keeps KAIRA "speaking")

    def __init__(self, settings, language_code, speaker) -> None:
        self.language_code, self.speaker = language_code, speaker
        self.texts: list[str] = []
        self.characters = 0
        self.closed = False
        self.cancelled = False
        type(self).instances.append(self)

    async def open(self) -> None:
        return None

    async def send_text(self, text: str) -> None:
        self.texts.append(text)
        self.characters += len(text)

    async def flush(self) -> None:
        return None

    async def audio(self):
        try:
            for chunk in self.chunks:
                yield chunk
                if self.hold:
                    await asyncio.sleep(self.hold)
        except asyncio.CancelledError:
            self.cancelled = True
            raise

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def voice(demo, monkeypatch):
    stt = type("Stt", (FakeStt,), {"instances": [], "session_end_on_close": None})
    tts = type("Tts", (FakeTts,), {"instances": [], "chunks": [PCM_CHUNK, PCM_CHUNK], "hold": 0.0})
    monkeypatch.setattr(live, "SttStream", stt)
    monkeypatch.setattr(live, "TtsStream", tts)
    monkeypatch.setattr(demo.settings, "SARVAM_API_KEY", "sk_test_dummy_not_a_real_key")
    demo.app.state.sarvam = FakeSarvam()
    demo.stt, demo.tts = stt, tts
    return demo


class Live:
    """A connected browser socket with time-bounded receives (the plain TestClient receive blocks forever)."""

    def __init__(self, ws) -> None:
        self.ws = ws
        self.seen: list[Any] = []

    def recv(self, timeout: float = 10.0) -> Any:
        async def _get():
            with anyio.fail_after(timeout):
                return await self.ws._send_rx.receive()

        msg = self.ws.portal.call(_get)
        if msg["type"] == "websocket.close":
            raise WebSocketDisconnect(msg.get("code", 1000))
        item = msg["bytes"] if msg.get("bytes") is not None else json.loads(msg["text"])
        self.seen.append(item)
        return item

    def until(self, pred, timeout: float = 10.0) -> list[Any]:
        out = []
        deadline = time.monotonic() + timeout
        while True:
            item = self.recv(max(0.1, deadline - time.monotonic()))
            out.append(item)
            if pred(item):
                return out

    def until_type(self, kind: str, timeout: float = 10.0) -> list[Any]:
        return self.until(lambda m: isinstance(m, dict) and m.get("type") == kind, timeout)

    def stt_event(self, **event) -> None:
        self.ws.send_bytes(b"EV:" + json.dumps(event, ensure_ascii=False).encode())

    def sync(self) -> list[Any]:
        """Round-trip a ping: everything the server sent before the pong is returned."""
        self.ws.send_json({"type": "ping"})
        return self.until_type("pong")[:-1]


def ticket_for(demo) -> tuple[str, str]:
    api = demo.api()
    data = api.data(api.post("/agent/session", {}))
    return data["ticket"], data["session_id"]


def connect(demo, ticket, origin=ORIGIN):
    headers = {"origin": origin} if origin else {}
    return demo.client.websocket_connect(f"/api/v1/agent/live?ticket={ticket}", headers=headers)


def open_live(demo):
    ticket, sid = ticket_for(demo)
    cm = connect(demo, ticket)
    ws = cm.__enter__()
    lv = Live(ws)
    lv.cm, lv.session_id = cm, sid
    first = lv.until(lambda m: isinstance(m, dict) and m.get("stt") == "connected")
    assert first[-1] == {"type": "status", "stt": "connected", "listening": True, "muted": False}
    return lv


def close_live(lv, demo, wait_saved=True):
    lv.ws.close(1000)
    if wait_saved:  # let the server finish its cleanup before the test client cancels the app task
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with demo.factory() as s:
                if s.get(AgentSession, uuid.UUID(lv.session_id)).status == "ended":
                    break
            time.sleep(0.05)
    lv.cm.__exit__(None, None, None)


@contextlib.contextmanager
def live_open(demo):
    """open_live/close_live that also closes the socket when an assertion fails (an unclosed TestClient socket
    makes the test run hang at teardown instead of reporting the failure)."""
    lv = open_live(demo)
    try:
        yield lv
    finally:
        close_live(lv, demo)


def types(items):
    return [m["type"] if isinstance(m, dict) else "<pcm>" for m in items]


def ramesh_lookup_script(reply="Ramesh Kumar owes ₹12,000."):
    return [tool_call("get_customer", {"customer_name": "Ramesh"}), say(reply)]


# ----------------------------------------------------------------------------- handshake security
def _forged(demo, **over):
    """A ticket with exactly the claims the server issues (so each negative case below changes ONE thing)."""
    claims = {
        "typ": "agent_ws",
        "sub": str(demo.owner.id),
        "bid": str(demo.business.id),
        "sid": str(uuid.uuid4()),
        "jti": uuid.uuid4().hex,
        "aud": "kaira-agent-ws",
        "exp": datetime.now(UTC) + timedelta(seconds=60),
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}  # None = leave the claim out
    secret = claims.pop("_secret", demo.settings.JWT_SECRET_KEY)
    return jwt.encode(claims, secret, algorithm="HS256")


def test_ws_forged_ticket_baseline_is_accepted(voice):
    """Control for the negative cases: a ticket with the server's own claims (and secret) is accepted."""
    with connect(voice, _forged(voice)) as ws:
        lv = Live(ws)
        assert lv.until(lambda m: isinstance(m, dict) and m.get("stt") == "connected")
        ws.close(1000)


@pytest.mark.parametrize(
    "make_ticket",
    [
        lambda demo: "",
        lambda demo: "not-a-jwt",
        lambda demo: _forged(demo, exp=datetime.now(UTC) - timedelta(seconds=1)),
        lambda demo: _forged(demo, typ="access"),
        lambda demo: _forged(demo, _secret="some-other-secret-that-is-long-enough-1234"),
        lambda demo: _forged(demo, sub="not-a-uuid"),
        lambda demo: _forged(demo, aud="kaira-api"),
        lambda demo: _forged(demo, aud=None),
        lambda demo: _forged(demo, jti=None),
        lambda demo: _forged(demo, sub=str(uuid.uuid4())),  # signed, but no such user
        lambda demo: _forged(demo, bid=str(uuid.uuid4())),  # the user does not belong to that business
    ],
    ids=[
        "missing",
        "garbage",
        "expired",
        "wrong-type",
        "wrong-signature",
        "bad-subject",
        "wrong-audience",
        "no-audience",
        "no-jti",
        "unknown-user",
        "wrong-business",
    ],
)
def test_ws_rejects_bad_tickets_with_1008(voice, make_ticket):
    with pytest.raises(WebSocketDisconnect) as exc:
        with connect(voice, make_ticket(voice)):
            pass
    assert exc.value.code == 1008
    assert voice.stt.instances == []


def test_ws_rejects_ticket_of_a_deactivated_user(voice, db):
    ticket, _ = ticket_for(voice)
    db.execute(update(User).where(User.id == voice.owner.id).values(is_active=False))
    db.commit()
    with pytest.raises(WebSocketDisconnect) as exc:
        with connect(voice, ticket):
            pass
    assert exc.value.code == 1008
    assert voice.stt.instances == []


def test_ws_rejects_disallowed_origin_with_1008(voice):
    ticket, _ = ticket_for(voice)
    with pytest.raises(WebSocketDisconnect) as exc:
        with connect(voice, ticket, origin="https://evil.example"):
            pass
    assert exc.value.code == 1008


def test_ws_without_sarvam_key_reports_config_error(voice, monkeypatch):
    monkeypatch.setattr(voice.settings, "SARVAM_API_KEY", None)
    ticket, _ = ticket_for(voice)
    with connect(voice, ticket) as ws:
        lv = Live(ws)
        err = lv.recv()
        assert (err["type"], err["source"], err["code"], err["fatal"]) == (
            "error",
            "config",
            "PROVIDER_NOT_CONFIGURED",
            True,
        )
        with pytest.raises(WebSocketDisconnect) as exc:
            lv.recv()
        assert exc.value.code == 1000
    assert voice.stt.instances == []


def test_ws_ticket_is_single_use(voice):
    """Regression (was a strict-xfail BUG before 78d2fb0): the jti is consumed on first use."""
    ticket, _ = ticket_for(voice)
    with connect(voice, ticket) as ws:
        Live(ws).until(lambda m: isinstance(m, dict) and m.get("stt") == "connected")
        ws.close(1000)
    with pytest.raises(WebSocketDisconnect) as exc:
        with connect(voice, ticket) as ws2:
            Live(ws2).until(lambda m: isinstance(m, dict) and m.get("stt") == "connected")
            ws2.close(1000)
    assert exc.value.code == 1008
    # a reconnect asks /agent/session again and gets a fresh, working ticket
    fresh, _ = ticket_for(voice)
    assert fresh != ticket
    with connect(voice, fresh) as ws3:
        Live(ws3).until(lambda m: isinstance(m, dict) and m.get("stt") == "connected")
        ws3.close(1000)


# ----------------------------------------------------------------------------- audio, transcripts, turns
def test_audio_forwarded_and_final_transcript_runs_a_spoken_turn(voice, db):
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    lv = open_live(voice)
    stt = voice.stt.instances[0]
    assert "Ramesh Kumar" in stt.keyterms and "KAIRA" in stt.keyterms
    frames = [b"\x01\x02" * 1600, b"\x03\x04" * 800]
    for f in frames:
        lv.ws.send_bytes(f)
    lv.sync()
    assert stt.received == frames

    lv.stt_event(event="vad.speech_start")
    lv.stt_event(event="transcript.partial", text="How much", language="en-IN")
    lv.stt_event(event="vad.speech_end")
    lv.stt_event(
        event="transcript.final", text="How much does Ramesh owe?", language="en-IN", language_confidence=0.97
    )
    got = lv.until_type("tts.end")
    t = types(got)
    assert t[:4] == ["vad", "transcript.partial", "vad", "transcript.final"]
    assert got[1]["text"] == "How much" and isinstance(got[1]["first_partial_ms"], int)
    assert got[3]["text"] == "How much does Ramesh owe?" and got[3]["language_confidence"] == 0.97
    for a, b in [
        ("transcript.final", "turn.started"),
        ("turn.started", "tool.started"),
        ("tool.started", "tool.completed"),
        ("tool.completed", "reply"),
        ("reply", "turn.completed"),
        ("turn.completed", "tts.start"),
        ("tts.start", "tts.first_audio"),
        ("tts.first_audio", "<pcm>"),
        ("<pcm>", "tts.end"),
    ]:
        assert t.index(a) < t.index(b), (a, b, t)
    reply = next(m for m in got if isinstance(m, dict) and m["type"] == "reply")
    assert reply["text"] == "Ramesh Kumar owes ₹12,000."
    done = next(m for m in got if isinstance(m, dict) and m["type"] == "turn.completed")
    assert done["tools"] == ["get_customer"] and done["llm_calls"] == 2 and done["ignored"] is False
    start = next(m for m in got if isinstance(m, dict) and m["type"] == "tts.start")
    assert start["sample_rate"] == voice.settings.AGENT_TTS_SAMPLE_RATE and start["language"] == "en-IN"
    assert [m for m in got if isinstance(m, bytes)] == [PCM_CHUNK, PCM_CHUNK]
    assert "".join(voice.tts.instances[0].texts).strip() == "Ramesh Kumar owes ₹12,000."
    close_live(lv, voice)
    with voice.factory() as s:
        msgs = s.scalars(
            select(AgentMessage).where(AgentMessage.session_id == uuid.UUID(lv.session_id))
        ).all()
        assert {(m.role, m.input_mode) for m in msgs} == {("user", "voice"), ("assistant", None)}


def test_partial_transcript_is_never_acted_on(voice):
    lv = open_live(voice)
    lv.stt_event(event="transcript.partial", text="Ramesh paid 5,000", language="en-IN")
    got = lv.sync()
    assert types(got) == ["transcript.partial"]
    assert voice.app.state.sarvam.calls == []
    close_live(lv, voice)


def test_duplicate_final_within_3_seconds_is_ignored(voice):
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    lv = open_live(voice)
    lv.stt_event(event="transcript.final", text="How much does Ramesh owe?", language="en-IN")
    lv.stt_event(event="transcript.final", text="how much does ramesh owe", language="en-IN")
    got = lv.until_type("tts.end")
    got += lv.sync()
    assert types(got).count("transcript.final") == 1
    assert types(got).count("turn.started") == 1
    assert len(voice.app.state.sarvam.calls) == 2  # one turn = tool call + reply
    close_live(lv, voice)


def test_speech_during_tts_barges_in(voice):
    voice.tts.hold = 5.0  # KAIRA keeps "speaking" after the first chunk
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    lv = open_live(voice)
    lv.stt_event(event="transcript.final", text="How much does Ramesh owe?", language="en-IN")
    lv.until(lambda m: isinstance(m, bytes))  # first audio is playing
    lv.stt_event(event="vad.speech_start")
    got = lv.until_type("tts.stop", timeout=3)
    assert got[-2:] == [{"type": "vad", "speech": True}, {"type": "tts.stop", "reason": "speech"}]
    tts = voice.tts.instances[0]
    assert tts.cancelled and tts.closed
    assert "tts.end" not in types(lv.sync())
    close_live(lv, voice)


def test_interrupt_message_stops_tts(voice):
    voice.tts.hold = 5.0
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    lv = open_live(voice)
    lv.ws.send_json({"type": "text", "text": "How much does Ramesh owe?", "turn_id": "typed-int"})
    lv.until(lambda m: isinstance(m, bytes))
    lv.ws.send_json({"type": "interrupt"})
    assert lv.until_type("tts.stop", timeout=3)[-1] == {"type": "tts.stop", "reason": "user"}
    close_live(lv, voice)


def test_echo_of_kairas_own_speech_is_dropped(voice):
    voice.tts.hold = 5.0
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    lv = open_live(voice)
    lv.stt_event(event="transcript.final", text="How much does Ramesh owe?", language="en-IN")
    lv.until(lambda m: isinstance(m, bytes))
    lv.stt_event(event="transcript.final", text="Ramesh Kumar owes 12,000", language="en-IN")
    got = lv.sync()
    assert {"type": "transcript.echo", "text": "Ramesh Kumar owes 12,000"} in got
    assert "turn.started" not in types(got) and "transcript.final" not in types(got)
    assert len(voice.app.state.sarvam.calls) == 2  # no second turn
    close_live(lv, voice)


def test_typed_text_message_runs_a_turn_in_the_live_session(voice, db):
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    lv = open_live(voice)
    lv.ws.send_json({"type": "text", "text": "How much does Ramesh owe?", "turn_id": "typed-1"})
    got = lv.until_type("tts.end")
    started = next(m for m in got if isinstance(m, dict) and m["type"] == "turn.started")
    assert started["turn_id"] == "typed-1"
    assert any(
        isinstance(m, dict) and m["type"] == "reply" and m["text"] == "Ramesh Kumar owes ₹12,000."
        for m in got
    )
    close_live(lv, voice)
    db.expire_all()
    msg = db.scalar(
        select(AgentMessage).where(AgentMessage.turn_id == "typed-1", AgentMessage.role == "user")
    )
    assert msg.input_mode == "text" and str(msg.session_id) == lv.session_id


def test_mute_stops_forwarding_audio(voice):
    lv = open_live(voice)
    stt = voice.stt.instances[0]
    lv.ws.send_json({"type": "mute"})
    assert lv.until_type("status")[-1] == {"type": "status", "listening": False, "muted": True}
    lv.ws.send_bytes(b"\x05\x06" * 100)
    lv.sync()
    assert stt.received == []
    lv.ws.send_json({"type": "unmute"})
    lv.until_type("status")
    lv.ws.send_bytes(b"\x07\x08" * 100)
    lv.sync()
    assert stt.received == [b"\x07\x08" * 100]
    close_live(lv, voice)


# ----------------------------------------------------------------------------- live.py abuse limits
def test_audio_frame_larger_than_one_second_is_refused_not_forwarded(voice):
    with live_open(voice) as lv:
        stt = voice.stt.instances[0]
        lv.ws.send_bytes(b"\x00" * (live.MAX_FRAME_BYTES + 2))  # 1 s of 16 kHz Int16 + one sample
        got = lv.sync()
        errors = [m for m in got if isinstance(m, dict) and m.get("type") == "error"]
        assert [(e["source"], e["code"], e["fatal"]) for e in errors] == [
            ("client", "FRAME_TOO_LARGE", False)
        ]
        assert stt.received == []
        # the session continues, and a frame of exactly 1 s is accepted
        one_second = b"\x00\x00" * 16000
        assert len(one_second) == live.MAX_FRAME_BYTES == 32000
        lv.ws.send_bytes(one_second)
        lv.sync()
        assert stt.received == [one_second]


def test_audio_faster_than_real_time_is_dropped(voice):
    """Frames may not arrive faster than real time (beyond a 10 s slack); the excess never reaches the STT
    provider, which bounds billed audio."""
    with live_open(voice) as lv:
        stt = voice.stt.instances[0]
        t0 = time.monotonic()
        for _ in range(15):
            lv.ws.send_bytes(b"\x00\x00" * 16000)  # 15 x 1 s of audio, sent at once
        lv.sync()
        elapsed = time.monotonic() - t0
        forwarded = len(stt.received)
        assert elapsed < 4, "the machine was too slow for this pacing check to mean anything"
        assert live.PACING_SLACK_SECONDS <= forwarded < 15, forwarded


def test_live_turns_share_the_per_user_ai_rate_limit(voice, monkeypatch):
    monkeypatch.setattr(voice.settings, "RATE_LIMIT_AI_PER_MINUTE", 2)  # POST /agent/session uses the 1st
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    with live_open(voice) as lv:
        lv.ws.send_json({"type": "text", "text": "How much does Ramesh owe?", "turn_id": "rl-1"})
        first = lv.until_type("tts.end")
        assert "turn.started" in types(first), first
        # 3rd and 4th AI requests within the minute: refused, nothing runs, the session stays open
        lv.ws.send_json({"type": "text", "text": "And Lakshmi Stores?", "turn_id": "rl-2"})
        lv.stt_event(event="transcript.final", text="What about Anjali Textiles?", language="en-IN")
        got = lv.until(lambda m: isinstance(m, dict) and m.get("type") == "transcript.final")
        got += lv.until_type("error")  # the STT event is handled by its own task, after the final is echoed
        got += lv.sync()
        errors = [m for m in got if isinstance(m, dict) and m.get("type") == "error"]
        assert [(e["source"], e["code"], e["fatal"]) for e in errors] == [
            ("session", "RATE_LIMITED", False)
        ] * 2, got
        assert "turn.started" not in types(got)
        assert len(voice.app.state.sarvam.calls) == 2  # only the first turn reached the LLM
        with voice.factory() as s:
            assert s.scalar(select(AgentMessage).where(AgentMessage.turn_id == "rl-2")) is None


def test_new_turn_cancels_the_running_turn_before_its_write(voice, db):
    """One turn at a time per live session: a newer utterance cancels the older turn, which stops before it
    starts a write, then the newer turn runs."""

    def slow_payment(_messages):
        time.sleep(1.5)  # the LLM is still thinking when the user speaks again
        return tool_call(
            "record_customer_payment",
            {
                "customer_name": "Ramesh",
                "amount": 5000,
                "evidence": {"customer_name": "Ramesh", "amount": "5,000"},
            },
        )

    voice.app.state.sarvam.push(slow_payment, say("Hello! How can I help?"))
    with live_open(voice) as lv:
        lv.ws.send_json({"type": "text", "text": "Ramesh paid 5,000 today.", "turn_id": "old-turn"})
        lv.until(lambda m: isinstance(m, dict) and m.get("type") == "thinking")
        lv.ws.send_json({"type": "text", "text": "Wait, hello KAIRA.", "turn_id": "new-turn"})
        got = lv.until(
            lambda m: isinstance(m, dict) and m.get("type") == "turn.completed" and m["turn_id"] == "new-turn"
        )
        cancelled = [m for m in got if isinstance(m, dict) and m.get("type") == "turn.cancelled"]
        assert cancelled == [{"type": "turn.cancelled", "turn_id": "old-turn"}], got
        assert types(got).index("turn.cancelled") < max(
            i for i, m in enumerate(got) if isinstance(m, dict) and m.get("turn_id") == "new-turn"
        )
        replies = [m for m in got if isinstance(m, dict) and m.get("type") == "reply"]
        assert [(r["turn_id"], r["text"]) for r in replies] == [("new-turn", "Hello! How can I help?")]
        assert not any(isinstance(m, dict) and m.get("type") == "tool.started" for m in got)
        assert len(payments_of(db, voice.inv_ramesh.id)) == 1  # seed payment only: the write never started


def test_session_usage_saved_on_disconnect(voice, db):
    voice.app.state.sarvam.push(*ramesh_lookup_script())
    lv = open_live(voice)
    lv.ws.send_bytes(b"\x00\x00" * 16000)  # 1.0 s of 16 kHz audio sent
    lv.ws.send_json({"type": "text", "text": "How much does Ramesh owe?", "turn_id": "usage-1"})
    lv.until_type("tts.end")
    lv.stt_event(event="session.end", audio_duration_s=12.5)
    lv.sync()
    close_live(lv, voice)
    db.expire_all()
    s = db.get(AgentSession, uuid.UUID(lv.session_id))
    assert s.status == "ended" and s.ended_at is not None
    assert s.stt_audio_seconds == Decimal("12.50")
    assert s.stt_audio_sent_seconds == Decimal("1.00")
    assert s.llm_calls == 2
    assert s.tts_characters == len("Ramesh Kumar owes ₹12,000. ")
    api = voice.api()
    usage = api.data(api.get(f"/agent/sessions/{lv.session_id}"))
    assert usage["stt_audio_seconds_billed"] == "12.50" and usage["status"] == "ended"


def test_session_end_sent_in_reply_to_end_is_billed(voice, db):
    voice.stt.session_end_on_close = 7.0
    lv = open_live(voice)
    close_live(lv, voice)
    db.expire_all()
    assert db.get(AgentSession, uuid.UUID(lv.session_id)).stt_audio_seconds == Decimal("7.00")


def test_real_stt_adapter_close_collects_session_end():
    class FakeWire:
        def __init__(self):
            self.sent, self.inbox = [], []

        async def send(self, data):
            self.sent.append(json.loads(data))
            if self.sent[-1].get("event") == "end":
                self.inbox.append(json.dumps({"event": "session.end", "audio_duration_s": 4.2}))

        async def close(self):
            return None

        async def recv(self):
            if self.inbox:
                return self.inbox.pop(0)
            raise TimeoutError

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self.inbox:
                return self.inbox.pop(0)
            raise StopAsyncIteration

    async def scenario():
        stt = realtime.SttStream.__new__(realtime.SttStream)
        stt.billed_audio_seconds, stt.sent_bytes = 0.0, 0
        stt.session_ended, stt.last_send_at = False, 0.0
        stt.ws = wire = FakeWire()
        await stt.close()
        assert wire.sent == [{"event": "end"}]
        return stt.billed_audio_seconds

    assert asyncio.run(scenario()) == pytest.approx(4.2)
