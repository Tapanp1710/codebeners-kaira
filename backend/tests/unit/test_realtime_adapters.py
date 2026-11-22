"""Sarvam realtime adapters (app/integrations/sarvam/realtime.py) against fake sockets. UNIT: no network, no DB.

Covers the documented STT lifecycle (session.end billing, fatal vs non-fatal errors, close codes 1003/1008/1011/4000,
abnormal closure) and the TTS stream (chunks, completion, in-band errors, a stalled provider)."""

from __future__ import annotations

import asyncio
import base64
import json

import pytest
from websockets.exceptions import ConnectionClosed
from websockets.frames import Close

from app.core.config import Settings
from app.integrations.sarvam import realtime as rt
from app.integrations.sarvam.realtime import (
    STT_RECONNECT_BACKOFF,
    STT_RECONNECT_NOW,
    STT_STOP,
    RealtimeProviderError,
    SttConfig,
    SttStream,
    TtsStream,
    classify_stt_end,
)


pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def settings(**kw) -> Settings:
    return Settings(_env_file=None, SARVAM_API_KEY="sk_test_dummy", **kw)


class FakeWs:
    """Minimal websockets ClientConnection: scripted incoming messages, records what was sent."""

    def __init__(self, incoming: list, close_code: int | None = 1000, hang: bool = False) -> None:
        self.incoming = list(incoming)
        self.sent: list[dict] = []
        self.closed = False
        self.close_code = close_code
        self.hang = hang

    def _closed_exc(self) -> ConnectionClosed:
        rcvd = Close(self.close_code, "bye") if self.close_code is not None else None
        return ConnectionClosed(rcvd, None)

    async def send(self, data: str) -> None:
        if self.closed:
            raise self._closed_exc()
        self.sent.append(json.loads(data))

    async def recv(self):
        if self.incoming:
            item = self.incoming.pop(0)
            return item if isinstance(item, str) else json.dumps(item)
        if self.hang:
            await asyncio.sleep(3600)
        raise self._closed_exc()

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self.recv()
        except ConnectionClosed as exc:
            if exc.rcvd is not None and exc.rcvd.code == 1000:
                raise StopAsyncIteration from None
            raise

    async def close(self) -> None:
        self.closed = True


async def collect(agen) -> list:
    return [x async for x in agen]


# ---------------------------------------------------------------- classification


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (None, STT_RECONNECT_NOW),
        ({"code": "inactivity_timeout"}, STT_RECONNECT_NOW),
        ({"code": "closed_1008"}, STT_RECONNECT_NOW),
        ({"code": "invalid_subscription_key"}, STT_STOP),
        ({"code": "invalid_request"}, STT_STOP),
        ({"code": "invalid_model"}, STT_STOP),
        ({"code": "closed_1003"}, STT_STOP),
        ({"code": "closed_4000"}, STT_STOP),
        ({"code": "closed_4001"}, STT_STOP),
        ({"code": "closed_1011"}, STT_RECONNECT_BACKOFF),
        ({"code": "closed_1006"}, STT_RECONNECT_BACKOFF),
        ({"code": "something_new"}, STT_RECONNECT_BACKOFF),
    ],
)
def test_classify_stt_end(error, expected):
    assert classify_stt_end(error) == expected


# ---------------------------------------------------------------- STT


def test_stt_url_has_documented_parameters():
    stt = SttStream(settings(), SttConfig(), keyterms=["Ravi Kumar", "x" * 100])
    url = stt.url()
    assert url.startswith("wss://api.sarvam.ai/speech-to-text-realtime/ws?")
    for part in ("language_code=auto", "model=saaras", "stream_type=fast", "encoding=linear16",
                 "sample_rate=16000", "endpointing=vad", "keyterms="):
        assert part in url
    assert "x" * 65 not in url  # keyterms are capped at 64 characters


async def test_stt_events_bill_session_end_once_and_skip_garbage():
    stt = SttStream(settings(), SttConfig())
    stt.ws = FakeWs(
        [
            {"event": "session.begin"},
            "not json",
            {"event": "transcript.partial", "text": "hel", "language": "en-IN"},
            {"event": "transcript.final", "text": "hello", "language": "en-IN", "language_confidence": 0.9},
            {"event": "session.end", "audio_duration_s": 2.5},
            {"event": "session.end", "audio_duration_s": 2.5},
        ]
    )
    events = await collect(stt.events())
    kinds = [e["event"] for e in events]
    assert kinds == ["session.begin", "transcript.partial", "transcript.final", "session.end", "session.end"]
    assert stt.billed_audio_seconds == 2.5  # a repeated session.end is not billed twice


async def test_stt_non_fatal_error_keeps_stream_fatal_error_ends_it():
    stt = SttStream(settings(), SttConfig())
    stt.ws = FakeWs(
        [
            {"event": "error", "code": "chunk_too_large", "is_fatal": False, "message": "m"},
            {"event": "transcript.final", "text": "after"},
            {"event": "error", "code": "inactivity_timeout", "is_fatal": True, "message": "idle"},
            {"event": "transcript.final", "text": "never"},
        ]
    )
    events = await collect(stt.events())
    assert [e.get("code") or e.get("text") for e in events] == ["chunk_too_large", "after", "inactivity_timeout"]


@pytest.mark.parametrize(("code", "expected"), [(1008, "closed_1008"), (1011, "closed_1011"),
                                                (1003, "closed_1003"), (4000, "closed_4000"), (None, "closed_1006")])
async def test_stt_close_codes_become_fatal_errors(code, expected):
    stt = SttStream(settings(), SttConfig())
    stt.ws = FakeWs([{"event": "session.begin"}], close_code=code)
    events = await collect(stt.events())
    assert events[-1]["event"] == "error"
    assert events[-1]["code"] == expected
    assert events[-1]["is_fatal"] is True


async def test_stt_normal_close_is_not_an_error():
    stt = SttStream(settings(), SttConfig())
    stt.ws = FakeWs([{"event": "session.begin"}], close_code=1000)
    assert [e["event"] for e in await collect(stt.events())] == ["session.begin"]


async def test_stt_send_pcm_rechunks_to_100ms_and_counts_seconds():
    stt = SttStream(settings(), SttConfig())
    ws = FakeWs([])
    stt.ws = ws
    await stt.send_pcm(b"\x01\x00" * 8000)  # 0.5 s
    assert len(ws.sent) == 5
    assert all(m["event"] == "audio_input" for m in ws.sent)
    assert len(base64.b64decode(ws.sent[0]["audio"])) == rt.FRAME_BYTES
    assert stt.sent_audio_seconds == 0.5
    assert stt.idle_seconds() < 1


async def test_stt_close_sends_end_and_reads_billed_audio():
    stt = SttStream(settings(), SttConfig())
    ws = FakeWs([{"event": "transcript.final", "text": "x"}, {"event": "session.end", "audio_duration_s": 4.2}])
    stt.ws = ws
    await stt.close()
    assert ws.sent[-1] == {"event": "end"}
    assert ws.closed and stt.ws is None
    assert stt.billed_audio_seconds == pytest.approx(4.2)
    await stt.close()  # idempotent


async def test_stt_close_after_session_end_does_not_send_end():
    stt = SttStream(settings(), SttConfig())
    ws = FakeWs([{"event": "session.end", "audio_duration_s": 1.0}])
    stt.ws = ws
    await collect(stt.events())
    await stt.close()
    assert ws.sent == [] and ws.closed
    assert stt.billed_audio_seconds == 1.0


async def test_stt_close_times_out_without_session_end(monkeypatch):
    stt = SttStream(settings(), SttConfig())
    ws = FakeWs([], hang=True)
    stt.ws = ws
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    await stt.close()
    assert loop.time() - t0 < 4
    assert ws.closed and stt.billed_audio_seconds == 0


async def test_stt_connect_maps_handshake_failures(monkeypatch):
    class Resp:
        status_code = 403

    from websockets.exceptions import InvalidStatus

    async def refuse(*a, **k):
        raise InvalidStatus(Resp())

    monkeypatch.setattr(rt, "connect", refuse)
    with pytest.raises(RealtimeProviderError) as info:
        await SttStream(settings(), SttConfig()).connect()
    assert info.value.code == "PROVIDER_AUTH"

    async def down(*a, **k):
        raise OSError("no route")

    monkeypatch.setattr(rt, "connect", down)
    with pytest.raises(RealtimeProviderError) as info:
        await SttStream(settings(), SttConfig()).connect()
    assert info.value.code == "PROVIDER_UNAVAILABLE"


# ---------------------------------------------------------------- TTS


def test_default_speakers_belong_to_bulbul_v4_flash():
    s = settings()
    assert s.SARVAM_TTS_MODEL == "bulbul:v4-flash"
    # Names from docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices (bulbul:v4-flash catalog).
    assert s.tts_speaker_for("te-IN") == "kavitha_te_conversation"
    assert s.tts_speaker_for("hi-IN") == "aparna_hi_customer"
    assert s.tts_speaker_for("en-IN") == "aparna_en_companion"


async def test_tts_open_sends_config_first(monkeypatch):
    ws = FakeWs([])

    async def fake_connect(url, **kw):
        assert "model=bulbul%3Av4-flash" in url and "send_completion_event=true" in url
        assert kw["additional_headers"]["api-subscription-key"] == "sk_test_dummy"
        return ws

    monkeypatch.setattr(rt, "connect", fake_connect)
    tts = TtsStream(settings(), "hi-IN", "aparna_hi_customer")
    await tts.open()
    cfg = ws.sent[0]
    assert cfg["type"] == "config"
    assert cfg["data"]["language_code"] == "hi-IN" and cfg["data"]["speaker"] == "aparna_hi_customer"
    assert cfg["data"]["output_audio_codec"] == "linear16"
    assert cfg["data"]["speech_sample_rate"] in (8000, 16000, 22050, 24000)
    assert 30 <= cfg["data"]["min_buffer_size"] <= 200 and 50 <= cfg["data"]["max_chunk_length"] <= 500
    await tts.send_text("Hello there. ")
    await tts.send_text("   ")  # blank text is not sent
    await tts.flush()
    assert [m["type"] for m in ws.sent] == ["config", "text", "flush"]
    assert tts.characters == len("Hello there. ")
    await tts.close()
    assert ws.closed and tts.ws is None


def _audio(b: bytes) -> dict:
    return {"type": "audio", "data": {"audio": base64.b64encode(b).decode(), "content_type": "audio/pcm"}}


async def test_tts_audio_until_final():
    tts = TtsStream(settings(), "en-IN", "aparna_en_companion")
    tts.ws = FakeWs([_audio(b"ab"), "garbage", _audio(b""), _audio(b"cd"),
                     {"type": "event", "data": {"event_type": "final"}}, _audio(b"zz")])
    assert await collect(tts.audio()) == [b"ab", b"cd"]


async def test_tts_error_raises():
    tts = TtsStream(settings(), "en-IN", "aparna_en_companion")
    tts.ws = FakeWs([_audio(b"ab"), {"type": "error", "data": {"code": 422, "message": "bad speaker"}}])
    with pytest.raises(RealtimeProviderError) as info:
        await collect(tts.audio())
    assert info.value.code == "TTS_422"


async def test_tts_stall_times_out():
    tts = TtsStream(settings(), "en-IN", "aparna_en_companion")
    tts.ws = FakeWs([_audio(b"ab")], hang=True)
    with pytest.raises(RealtimeProviderError) as info:
        await collect(tts.audio(idle_timeout=0.05))
    assert info.value.code == "TTS_TIMEOUT"
