"""LiveSession (app/services/agent/live.py) with fake browser socket, fake Sarvam STT/TTS and a fake agent turn.

UNIT: no network, no database. The fake agent runs in a worker thread exactly like orchestrator.run_turn does, so
cancellation, superseding and disconnect behaviour are exercised with the real concurrency of the live session."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketState

from app.core.config import Settings
from app.integrations.sarvam.realtime import RealtimeProviderError
from app.services.agent import live, orchestrator
from app.services.agent.live import LiveSession, is_echo, split_sentences

pytestmark = pytest.mark.anyio
USER = __import__("uuid").uuid4()
BUSINESS = __import__("uuid").uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ---------------------------------------------------------------- fakes


class FakeBrowser:
    def __init__(self) -> None:
        self.client_state = WebSocketState.CONNECTED
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.out: list = []
        self.closed_with: tuple | None = None

    async def send_json(self, payload) -> None:
        self.out.append(payload)

    async def send_bytes(self, payload) -> None:
        self.out.append(payload)

    async def receive(self):
        return await self.inbox.get()

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)
        self.client_state = WebSocketState.DISCONNECTED
        await self.inbox.put({"type": "websocket.disconnect"})

    def audio(self, frame: bytes) -> None:
        self.inbox.put_nowait({"type": "websocket.receive", "bytes": frame})

    def control(self, text: str) -> None:
        self.inbox.put_nowait({"type": "websocket.receive", "text": text})

    def disconnect(self) -> None:
        self.inbox.put_nowait({"type": "websocket.disconnect"})

    def events(self, kind: str) -> list[dict]:
        return [e for e in self.out if isinstance(e, dict) and e.get("type") == kind]

    def index(self, kind: str) -> int:
        return next(i for i, e in enumerate(self.out) if isinstance(e, dict) and e.get("type") == kind)


class FakeStt:
    instances: list[FakeStt] = []
    script: list[dict] = []

    def __init__(self, settings, config, keyterms=None) -> None:
        self.cfg = FakeStt.script.pop(0) if FakeStt.script else {}
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.ws = object()
        self.sent = bytearray()
        self.pings = 0
        self.closed = False
        self.billed_audio_seconds = 0.0
        self.sent_bytes = 0
        FakeStt.instances.append(self)

    async def connect(self) -> None:
        if self.cfg.get("connect_error"):
            raise self.cfg["connect_error"]

    async def send_pcm(self, pcm: bytes) -> None:
        self.sent += pcm
        self.sent_bytes += len(pcm)

    async def ping(self) -> None:
        self.pings += 1

    def idle_seconds(self) -> float:
        return self.cfg.get("idle", 0.0)

    async def events(self):
        while True:
            ev = await self.inbox.get()
            if ev is None:
                return
            yield ev
            if ev.get("event") == "error" and ev.get("is_fatal"):
                return

    async def close(self) -> None:
        if not self.closed:
            self.billed_audio_seconds += self.cfg.get("billed_on_close", 0.0)
        self.closed = True
        self.ws = None
        self.inbox.put_nowait(None)

    @property
    def sent_audio_seconds(self) -> float:
        return self.sent_bytes / 32000

    def push(self, event: str, **fields) -> None:
        self.inbox.put_nowait({"event": event, **fields})


class FakeTts:
    instances: list[FakeTts] = []
    chunks = 3
    chunk_bytes = 200
    delay = 0.0

    def __init__(self, settings, language_code, speaker) -> None:
        self.language_code, self.speaker = language_code, speaker
        self.texts: list[str] = []
        self.closed = False
        self.characters = 0
        FakeTts.instances.append(self)

    async def open(self) -> None:
        pass

    async def send_text(self, text: str) -> None:
        self.texts.append(text)
        self.characters += len(text)

    async def flush(self) -> None:
        pass

    async def audio(self):
        for _ in range(FakeTts.chunks):
            await asyncio.sleep(FakeTts.delay)
            yield b"\x01\x00" * (FakeTts.chunk_bytes // 2)

    async def close(self) -> None:
        self.closed = True


class FakeAgent:
    """Stands in for orchestrator.run_turn (runs in a worker thread)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.gates: dict[str, threading.Event] = {}
        self.cancelled: dict[str, bool] = {}
        self.finished: list[str] = []

    def run_turn(self, factory, settings, sarvam, *, turn_id, text, language_hint, emit, should_cancel, **kw):
        self.calls.append((turn_id, text))
        gate = self.gates.get(text)
        if gate is not None:
            gate.wait(5)
        self.cancelled[turn_id] = should_cancel()
        self.finished.append(turn_id)
        if self.cancelled[turn_id]:
            emit({"type": "turn.cancelled", "turn_id": turn_id})
            return SimpleNamespace(reply="", language="en-IN", ignored=False, llm_calls=0, tool_runs=[])
        emit({"type": "reply", "turn_id": turn_id, "text": f"Done: {text}."})
        return SimpleNamespace(
            reply=f"Done: {text}. Anything else?",
            language=language_hint or "en-IN",
            ignored=False,
            llm_calls=1,
            tool_runs=[{"tool": "record_payment"}],
        )


@pytest.fixture
def env(monkeypatch):
    FakeStt.instances, FakeStt.script = [], []
    FakeTts.instances, FakeTts.chunks, FakeTts.chunk_bytes, FakeTts.delay = [], 3, 200, 0.0
    live._ACTIVE.clear()
    agent = FakeAgent()
    saved: list[tuple[str, tuple]] = []

    def fake_save(self, status, usage=None):
        saved.append((status, usage if usage is not None else self._take_usage()))

    monkeypatch.setattr(live, "SttStream", FakeStt)
    monkeypatch.setattr(live, "TtsStream", FakeTts)
    monkeypatch.setattr(orchestrator, "run_turn", agent.run_turn)
    monkeypatch.setattr(LiveSession, "_load_keyterms", lambda self: ["Ravi"])
    monkeypatch.setattr(LiveSession, "_save_usage", fake_save)
    monkeypatch.setattr(live, "backoff_delay", lambda attempt: 0.0)
    return SimpleNamespace(agent=agent, saved=saved)


def make_session(browser: FakeBrowser, user=USER, session_id=None, **settings_kw) -> LiveSession:
    settings = Settings(
        _env_file=None, SARVAM_API_KEY="sk_test_dummy", AGENT_TURN_TIMEOUT_SECONDS=3, **settings_kw
    )
    state = SimpleNamespace(settings=settings, session_factory=None, sarvam=None, rate_limiter=None)
    return LiveSession(
        browser,
        state,
        user_id=user,
        business_id=BUSINESS,
        session_id=session_id or __import__("uuid").uuid4(),
    )


async def until(predicate, timeout: float = 3.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not predicate():
        if loop.time() > end:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


async def start(browser: FakeBrowser, **kw):
    session = make_session(browser, **kw)
    task = asyncio.create_task(session.run())
    await until(lambda: FakeStt.instances and session.stt_ready.is_set())
    return session, task


async def stop(browser: FakeBrowser, task) -> None:
    browser.disconnect()
    await asyncio.wait_for(task, 10)


# ---------------------------------------------------------------- pure helpers


def test_split_sentences_handles_indic_punctuation():
    assert split_sentences("Done. Paid ₹500! Next?") == ["Done.", "Paid ₹500!", "Next?"]
    assert split_sentences("रवि ने ५०० दिए। और कुछ?") == ["रवि ने ५०० दिए।", "और कुछ?"]
    assert split_sentences("   ") == []


def test_echo_filter_keeps_short_answers():
    spoken = "Shall I record 500 rupees from Ravi? Say yes to confirm."
    assert is_echo("shall i record 500 rupees from ravi", spoken)
    assert not is_echo("yes", spoken)
    assert not is_echo("no", spoken)
    assert not is_echo("record 900 from suresh", spoken)
    assert not is_echo("", spoken)


def test_backoff_grows_and_is_capped():
    assert 0.4 <= live.backoff_delay(0) <= 0.6
    assert 1.6 <= live.backoff_delay(2) <= 2.4
    assert live.backoff_delay(10) <= live.STT_BACKOFF_MAX * 1.2


# ---------------------------------------------------------------- duplicate finals and turn claiming


async def test_duplicate_final_while_turn_in_flight_runs_one_business_turn(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    gate = env.agent.gates["Record 500 from Ravi"] = threading.Event()
    stt = FakeStt.instances[-1]
    stt.push("transcript.final", text="Record 500 from Ravi", language="en-IN")
    await until(lambda: env.agent.calls)
    stt.push("transcript.final", text="record 500 from Ravi!", language="en-IN")  # Sarvam repeats the final
    stt.push("transcript.final", text="Record 500 from Ravi.", language="en-IN")
    await asyncio.sleep(0.1)
    gate.set()
    await until(lambda: browser.events("turn.completed"))
    await asyncio.sleep(0.1)
    assert len(env.agent.calls) == 1
    assert len(browser.events("transcript.final")) == 1
    await stop(browser, task)


async def test_duplicate_final_after_quick_completion_is_dropped_then_allowed_later(env, monkeypatch):
    monkeypatch.setattr(live, "FINAL_DEDUPE_SECONDS", 0.3)
    browser = FakeBrowser()
    session, task = await start(browser)
    stt = FakeStt.instances[-1]
    stt.push("transcript.final", text="yes", language="en-IN")
    await until(lambda: len(browser.events("turn.completed")) == 1)
    stt.push("transcript.final", text="Yes.", language="en-IN")  # duplicate within the window
    await asyncio.sleep(0.05)
    assert len(env.agent.calls) == 1
    await asyncio.sleep(0.35)
    stt.push("transcript.final", text="yes", language="en-IN")  # a genuine new answer later
    await until(lambda: len(env.agent.calls) == 2)
    await stop(browser, task)


async def test_typed_resend_of_inflight_turn_is_ignored(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    gate = env.agent.gates["pay 100"] = threading.Event()
    browser.control('{"type": "text", "text": "pay 100", "turn_id": "t-1"}')
    await until(lambda: env.agent.calls)
    browser.control('{"type": "text", "text": "pay 100", "turn_id": "t-1"}')
    await asyncio.sleep(0.1)
    gate.set()
    await until(lambda: browser.events("turn.completed"))
    assert env.agent.calls == [("t-1", "pay 100")]
    assert env.agent.cancelled["t-1"] is False
    await stop(browser, task)


async def test_distinct_finals_supersede_and_the_old_turn_never_speaks(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    gate = env.agent.gates["first request"] = threading.Event()
    stt = FakeStt.instances[-1]
    stt.push("transcript.final", text="first request", language="en-IN")
    await until(lambda: env.agent.calls)
    stt.push("transcript.final", text="second request", language="en-IN")
    await asyncio.sleep(0.05)
    gate.set()
    await until(lambda: browser.events("tts.end"))
    first_id, second_id = env.agent.calls[0][0], env.agent.calls[1][0]
    assert env.agent.cancelled[first_id] is True  # the superseded turn saw its cancel flag before any write
    assert [e["turn_id"] for e in browser.events("tts.start")] == [second_id]
    assert len(FakeTts.instances) == 1 and "second request" in "".join(FakeTts.instances[0].texts)
    await stop(browser, task)


# ---------------------------------------------------------------- TTS, barge-in, echo


async def test_reply_is_spoken_in_detected_language_with_valid_speaker(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    FakeStt.instances[-1].push("transcript.final", text="రవి 500 ఇచ్చాడు", language="te-IN")
    await until(lambda: browser.events("tts.end"))
    tts = FakeTts.instances[0]
    assert tts.language_code == "te-IN" and tts.speaker == "kavitha_te_conversation"
    start_ev = browser.events("tts.start")[0]
    assert start_ev["sample_rate"] == session.settings.AGENT_TTS_SAMPLE_RATE
    assert browser.events("tts.first_audio")[0]["ms_from_utterance_end"] >= 0
    frames = [e for e in browser.out if isinstance(e, bytes)]
    assert len(frames) == FakeTts.chunks
    assert tts.closed
    assert tts.texts == ["Done: రవి 500 ఇచ్చాడు. ", "Anything else? "]  # sentence by sentence
    await stop(browser, task)


async def test_unsupported_reply_language_falls_back_to_english_voice(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    FakeStt.instances[-1].push("transcript.final", text="vanakkam", language="ta-IN")
    await until(lambda: browser.events("tts.end"))
    assert FakeTts.instances[0].language_code == "en-IN"
    assert FakeTts.instances[0].speaker == "aparna_en_companion"
    await stop(browser, task)


async def test_speech_start_during_tts_stops_it_and_closes_the_socket(env):
    FakeTts.chunks, FakeTts.delay = 200, 0.02
    browser = FakeBrowser()
    session, task = await start(browser)
    stt = FakeStt.instances[-1]
    stt.push("transcript.final", text="tell me the dues", language="en-IN")
    await until(lambda: any(isinstance(e, bytes) for e in browser.out))
    stt.push("vad.speech_start")
    await until(lambda: [e for e in browser.events("tts.stop") if e["reason"] == "speech"])
    assert FakeTts.instances[0].closed
    stop_at = max(i for i, e in enumerate(browser.out) if isinstance(e, dict) and e.get("reason") == "speech")
    await asyncio.sleep(0.1)
    assert not any(isinstance(e, bytes) for e in browser.out[stop_at:])  # no audio after tts.stop
    assert not browser.events("tts.end")
    await stop(browser, task)


async def test_speech_start_while_browser_still_plays_sent_audio_stops_playback(env):
    FakeTts.chunks, FakeTts.chunk_bytes = 2, 44100  # 2 x 1 s at 22 050 Hz: playback outlives the TTS socket
    browser = FakeBrowser()
    session, task = await start(browser)
    stt = FakeStt.instances[-1]
    stt.push("transcript.final", text="what is pending", language="en-IN")
    await until(lambda: browser.events("tts.end"))
    stt.push("vad.speech_start")
    await until(lambda: [e for e in browser.events("tts.stop") if e["reason"] == "speech"])
    await stop(browser, task)


async def test_speech_start_when_silent_sends_no_tts_stop(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    FakeStt.instances[-1].push("vad.speech_start")
    await until(lambda: browser.events("vad"))
    await asyncio.sleep(0.05)
    assert browser.events("tts.stop") == []
    assert session.speak_task is None
    await stop(browser, task)


async def test_interrupt_button_always_sends_tts_stop(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    browser.control('{"type": "interrupt"}')
    await until(lambda: browser.events("tts.stop"))
    assert browser.events("tts.stop")[0]["reason"] == "user"
    await stop(browser, task)


async def test_echo_of_own_reply_is_dropped_but_yes_is_a_turn(env):
    FakeTts.chunks, FakeTts.chunk_bytes = 1, 44100
    browser = FakeBrowser()
    session, task = await start(browser)
    stt = FakeStt.instances[-1]
    stt.push("transcript.final", text="record payment", language="en-IN")
    await until(lambda: browser.events("tts.end"))
    stt.push("transcript.final", text="Done record payment anything else", language="en-IN")
    await until(lambda: browser.events("transcript.echo"))
    assert len(env.agent.calls) == 1
    stt.push("transcript.final", text="else", language="en-IN")  # one word that the reply also contained
    await until(lambda: len(env.agent.calls) == 2)
    await stop(browser, task)


# ---------------------------------------------------------------- disconnect and recovery


async def test_disconnect_lets_inflight_turn_finish_and_never_speaks(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    gate = env.agent.gates["pay ravi 500"] = threading.Event()
    FakeStt.instances[-1].push("transcript.final", text="pay ravi 500", language="en-IN")
    await until(lambda: env.agent.calls)
    browser.disconnect()
    await asyncio.sleep(0.2)
    assert not task.done()  # the session waits for the claimed turn to store its reply
    gate.set()
    await asyncio.wait_for(task, 10)
    turn_id = env.agent.calls[0][0]
    assert env.agent.cancelled[turn_id] is False  # not cancelled: a resend with this turn_id replays it
    assert env.agent.finished == [turn_id]
    assert FakeTts.instances == []  # nothing is synthesised for a closed socket
    assert FakeStt.instances[-1].closed
    assert env.saved[-1][0] == "ended"
    assert live._ACTIVE == {}


async def test_newer_socket_for_same_user_replaces_the_old_one(env):
    old_browser, new_browser = FakeBrowser(), FakeBrowser()
    old, old_task = await start(old_browser)
    new = make_session(new_browser)
    new_task = asyncio.create_task(new.run())
    await asyncio.wait_for(old_task, 10)
    err = old_browser.events("error")[-1]
    assert err["code"] == "SESSION_REPLACED" and err["fatal"] is True
    assert old_browser.closed_with[0] == 1000
    assert live._ACTIVE[USER] is new
    await until(lambda: new.stt_ready.is_set())
    await stop(new_browser, new_task)


# ---------------------------------------------------------------- STT reconnect, buffering, keepalive, usage


async def test_stt_server_error_reconnects_without_fatal_and_checkpoints_billing(env):
    FakeStt.script = [{"billed_on_close": 1.5}, {"billed_on_close": 0.75}]
    browser = FakeBrowser()
    session, task = await start(browser)
    first = FakeStt.instances[0]
    first.push("error", code="closed_1011", is_fatal=True, message="internal")
    await until(lambda: len(FakeStt.instances) == 2 and session.stt_ready.is_set())
    assert first.closed
    assert [e for e in browser.events("error") if e.get("fatal")] == []  # the browser keeps its session
    assert browser.events("status")[-1]["stt"] == "connected"
    assert any(
        e.get("stt") == "reconnecting" and e.get("reason") == "closed_1011" for e in browser.events("status")
    )
    assert env.saved[0][0] == "active" and env.saved[0][1][0] == pytest.approx(1.5)  # billed on reconnect
    await stop(browser, task)
    assert env.saved[0][1][3] == 1  # the provider error is persisted with the checkpoint
    assert env.saved[-1] == ("ended", (pytest.approx(0.75), 0.0, 0, 0))
    total_billed = sum(u[0] for _, u in env.saved)
    assert total_billed == pytest.approx(2.25)
    assert sum(u[3] for _, u in env.saved) == 1  # one provider error counted once


@pytest.mark.parametrize("code", ["invalid_subscription_key", "closed_1003", "closed_4000", "invalid_model"])
async def test_stt_unrecoverable_errors_stop_with_fatal_error(env, code):
    browser = FakeBrowser()
    session, task = await start(browser)
    FakeStt.instances[0].push("error", code=code, is_fatal=True, message="no")
    await until(lambda: [e for e in browser.events("error") if e.get("fatal")])
    await asyncio.sleep(0.05)
    assert len(FakeStt.instances) == 1
    assert FakeStt.instances[0].closed
    await stop(browser, task)


async def test_stt_auth_failure_at_connect_is_fatal(env):
    FakeStt.script = [{"connect_error": RealtimeProviderError("PROVIDER_AUTH", "bad key")}]
    browser = FakeBrowser()
    session = make_session(browser)
    task = asyncio.create_task(session.run())
    await until(lambda: browser.events("error"))
    assert browser.events("error")[0] == {
        "type": "error",
        "source": "stt",
        "code": "PROVIDER_AUTH",
        "message": "bad key",
        "fatal": True,
    }
    await asyncio.sleep(0.05)
    assert len(FakeStt.instances) == 1
    await stop(browser, task)


async def test_stt_idle_close_reconnects_without_counting_an_error(env, monkeypatch):
    monkeypatch.setattr(live, "STT_MIN_HEALTHY_SECONDS", 0.0)
    browser = FakeBrowser()
    session, task = await start(browser)
    FakeStt.instances[0].push("error", code="inactivity_timeout", is_fatal=True, message="idle")
    await until(lambda: len(FakeStt.instances) == 2 and session.stt_ready.is_set())
    await stop(browser, task)
    assert sum(u[3] for _, u in env.saved) == 0
    assert not [e for e in browser.events("error")]


async def test_stt_flapping_clean_closes_give_up(env):
    browser = FakeBrowser()
    session = make_session(browser)
    task = asyncio.create_task(session.run())

    async def closer():
        seen = 0
        while not task.done():
            while seen < len(FakeStt.instances):
                FakeStt.instances[seen].inbox.put_nowait(None)  # server closes 1000 right after connect
                seen += 1
            await asyncio.sleep(0.005)

    killer = asyncio.create_task(closer())
    await until(lambda: [e for e in browser.events("error") if e.get("code") == "STT_UNSTABLE"])
    assert len(FakeStt.instances) <= live.STT_MAX_QUICK_FAILURES + 2
    await stop(browser, task)
    killer.cancel()


async def test_audio_during_reconnect_is_buffered_capped_and_replayed(env):
    FakeStt.script = [{}, {}]
    browser = FakeBrowser()
    session, task = await start(browser)
    first = FakeStt.instances[0]
    session.stt_ready.clear()  # as if the stream just dropped
    frame = b"\x02\x00" * 1600  # 100 ms
    for _ in range(30):  # 3 s arrives while not ready
        browser.audio(frame)
    await until(lambda: len(session.stt_buffer) == int(live.STT_BUFFER_SECONDS * live.BYTES_PER_SECOND))
    first.push("error", code="closed_1011", is_fatal=True, message="x")
    await until(lambda: len(FakeStt.instances) == 2 and session.stt_ready.is_set())
    assert len(FakeStt.instances[1].sent) == int(live.STT_BUFFER_SECONDS * live.BYTES_PER_SECOND)
    assert session.stt_buffer == bytearray()
    browser.audio(frame)  # direct path again
    await until(lambda: len(FakeStt.instances[1].sent) == 2 * 32000 + len(frame))
    await stop(browser, task)


async def test_muted_audio_is_neither_sent_nor_buffered(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    browser.control('{"type": "mute"}')
    await until(lambda: session.muted)
    browser.audio(b"\x00\x00" * 1600)
    await asyncio.sleep(0.05)
    assert len(FakeStt.instances[0].sent) == 0 and len(session.stt_buffer) == 0
    browser.control('{"type": "unmute"}')
    browser.audio(b"\x00\x00" * 1600)
    await until(lambda: len(FakeStt.instances[0].sent) == 3200)
    await stop(browser, task)


async def test_keepalive_pings_only_when_audio_stopped(env, monkeypatch):
    monkeypatch.setattr(live, "STT_KEEPALIVE_CHECK_SECONDS", 0.01)
    FakeStt.script = [{"idle": 30.0}]
    browser = FakeBrowser()
    session, task = await start(browser)
    await until(lambda: FakeStt.instances[0].pings >= 2)
    await stop(browser, task)

    FakeStt.instances.clear()
    FakeStt.script = [{"idle": 0.0}]
    browser = FakeBrowser()
    session, task = await start(browser)
    await asyncio.sleep(0.1)
    assert FakeStt.instances[0].pings == 0
    await stop(browser, task)


async def test_oversized_frame_and_garbage_control_messages(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    browser.audio(b"\x00" * (live.MAX_FRAME_BYTES + 2))
    browser.control("[1, 2]")
    browser.control("not json")
    browser.control('{"type": "ping"}')
    await until(lambda: browser.events("pong"))
    assert browser.events("error")[0]["code"] == "FRAME_TOO_LARGE"
    assert browser.events("error")[0]["fatal"] is False
    await stop(browser, task)


async def test_non_fatal_stt_error_is_forwarded_as_non_fatal(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    FakeStt.instances[0].push("error", code="chunk_too_large", is_fatal=False, message="big")
    await until(lambda: browser.events("error"))
    assert browser.events("error")[0]["fatal"] is False
    assert len(FakeStt.instances) == 1
    await stop(browser, task)


async def test_partial_reports_first_partial_latency_once(env):
    browser = FakeBrowser()
    session, task = await start(browser)
    stt = FakeStt.instances[0]
    stt.push("vad.speech_start")
    stt.push("transcript.partial", text="re", language="en-IN")
    stt.push("transcript.partial", text="record", language="en-IN")
    await until(lambda: len(browser.events("transcript.partial")) == 2)
    p1, p2 = browser.events("transcript.partial")
    assert isinstance(p1["first_partial_ms"], int) and p2["first_partial_ms"] is None
    assert env.agent.calls == []  # partials are never acted on
    await stop(browser, task)
