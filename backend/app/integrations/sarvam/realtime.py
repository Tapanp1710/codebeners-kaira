"""Sarvam realtime WebSocket adapters for the live agent (asyncio, `websockets` client).

Verified against docs.sarvam.ai on 2026-11-22:

STT  wss://api.sarvam.ai/speech-to-text-realtime/ws?language_code=auto&model=saaras:v4&stream_type=fast
     &encoding=linear16&sample_rate=16000&endpointing=vad&threshold=..&silence_duration_ms=..
     &prefix_padding_ms=..&min_speech_duration_ms=..
     send  {"event": "audio_input", "audio": "<base64 PCM, <= 500 ms per frame>"}, {"event": "end"}, {"event": "ping"}
     recv  session.begin, vad.speech_start, vad.speech_end, transcript.partial {text, language},
           transcript.final {text, language, language_confidence}, session.end {audio_duration_s}, pong,
           error {code, is_fatal, message}
TTS  wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v4-flash&send_completion_event=true
     send  {"type": "config", "data": {language_code, speaker, output_audio_codec, speech_sample_rate, pace}},
           {"type": "text", "data": {"text": ...}}, {"type": "flush"}, {"type": "ping"}
     recv  {"type": "audio", "data": {"audio": "<base64>", "content_type"}}, {"type": "event", "data":
           {"event_type": "final"}}, {"type": "error", "data": {"message", "code"}}
     There is no cancel message: barge-in closes the socket and the next reply opens a new one.
STT close codes: 1003 key/rate limit/quota (do not retry), 1008 inactivity (no audio or ping for 60 s; reconnect),
     1011 server error (retry with backoff), 4000 invalid parameter or account not enabled (do not retry).
     Fatal error codes: invalid_request, invalid_model, invalid_subscription_key, inactivity_timeout. chunk_too_large
     is not fatal. `session.end.audio_duration_s` is the billed audio; it arrives only after a graceful `end`.
Auth: the `api-subscription-key` header, sent from this server only. The key never reaches the browser or logs.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from app.core.config import Settings
from app.core.exceptions import ProviderNotConfiguredError

logger = logging.getLogger(__name__)
FRAME_BYTES = 3200  # 100 ms of 16 kHz mono linear16; Sarvam caps a frame at 500 ms on stream_type=fast
TTS_IDLE_TIMEOUT_SECONDS = 20.0  # no audio/event from Sarvam TTS for this long ends the reply with an error

# What the live session does after an STT stream ends (see classify_stt_end).
STT_STOP = "stop"  # configuration, key, quota: reconnecting cannot help
STT_RECONNECT_NOW = "reconnect_now"  # idle timeout / normal close: reconnect without counting a failure
STT_RECONNECT_BACKOFF = "reconnect_backoff"  # server error or network drop: reconnect with backoff
_STT_STOP_CODES = {
    "invalid_subscription_key",
    "invalid_request",
    "invalid_model",
    "closed_1003",
    "closed_4000",
}
_STT_IDLE_CODES = {"inactivity_timeout", "closed_1008"}


def classify_stt_end(error: dict[str, Any] | None) -> str:
    """Decide how to recover from the end of one STT stream. `error` is the last fatal error event, if any."""
    if not error:
        return STT_RECONNECT_NOW
    code = str(error.get("code") or "")
    if code in _STT_STOP_CODES or code.startswith("closed_4"):
        return STT_STOP
    if code in _STT_IDLE_CODES:
        return STT_RECONNECT_NOW
    return STT_RECONNECT_BACKOFF


class RealtimeProviderError(Exception):
    def __init__(self, code: str, message: str, fatal: bool = True) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fatal = fatal


def ws_base(settings: Settings) -> str:
    base = settings.SARVAM_BASE_URL.rstrip("/")
    return (
        "wss://" + base[len("https://") :]
        if base.startswith("https://")
        else base.replace("http://", "ws://")
    )


def _key(settings: Settings, feature: str) -> str:
    if not settings.SARVAM_API_KEY:
        raise ProviderNotConfiguredError(feature)
    return settings.SARVAM_API_KEY


def _handshake_error(exc: Exception) -> RealtimeProviderError:
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status in (401, 403):
        return RealtimeProviderError("PROVIDER_AUTH", "Sarvam rejected the API key. Check SARVAM_API_KEY.")
    if status == 429:
        return RealtimeProviderError("PROVIDER_RATE_LIMITED", "Sarvam rate limit or quota reached.")
    return RealtimeProviderError(
        "PROVIDER_UNAVAILABLE", f"Could not connect to Sarvam ({type(exc).__name__})."
    )


@dataclass
class SttConfig:
    language_code: str = "auto"
    stream_type: str = "fast"
    threshold: float = 0.3
    silence_duration_ms: int = 900
    prefix_padding_ms: int = 300
    min_speech_duration_ms: int = 250

    @classmethod
    def from_settings(cls, s: Settings) -> SttConfig:
        return cls(
            language_code=s.AGENT_STT_LANGUAGE,
            stream_type=s.AGENT_STT_STREAM_TYPE,
            threshold=s.AGENT_VAD_THRESHOLD,
            silence_duration_ms=s.AGENT_VAD_SILENCE_MS,
            prefix_padding_ms=s.AGENT_VAD_PREFIX_PADDING_MS,
            min_speech_duration_ms=s.AGENT_VAD_MIN_SPEECH_MS,
        )


class SttStream:
    """One Sarvam realtime STT connection. send_pcm() takes raw 16 kHz mono linear16 bytes."""

    def __init__(self, settings: Settings, config: SttConfig, keyterms: list[str] | None = None) -> None:
        self.settings = settings
        self.config = config
        self.keyterms = keyterms or []
        self.ws: ClientConnection | None = None
        self.billed_audio_seconds: float = 0.0
        self.sent_bytes = 0
        self.session_ended = False  # session.end (billed audio) was received for this connection
        self.last_send_at = 0.0  # loop time of the last audio frame or ping (Sarvam closes after 60 s idle)

    def url(self) -> str:
        params: dict[str, Any] = {
            "language_code": self.config.language_code,
            "model": self.settings.SARVAM_STT_MODEL,
            "stream_type": self.config.stream_type,
            "mode": "transcribe",
            "endpointing": "vad",
            "encoding": "linear16",
            "sample_rate": 16000,
            "threshold": self.config.threshold,
            "silence_duration_ms": self.config.silence_duration_ms,
            "prefix_padding_ms": self.config.prefix_padding_ms,
            "min_speech_duration_ms": self.config.min_speech_duration_ms,
        }
        if self.keyterms:
            params["keyterms"] = json.dumps([k[:64] for k in self.keyterms[:50]], ensure_ascii=False)
        return f"{ws_base(self.settings)}/speech-to-text-realtime/ws?{urlencode(params)}"

    async def connect(self) -> None:
        key = _key(self.settings, "Live speech recognition")
        try:
            self.ws = await connect(
                self.url(), additional_headers={"api-subscription-key": key}, open_timeout=10, max_size=2**22
            )
        except (InvalidHandshake, OSError, TimeoutError) as exc:
            raise _handshake_error(exc) from None
        self.last_send_at = asyncio.get_running_loop().time()

    async def send_pcm(self, pcm: bytes) -> None:
        if self.ws is None:
            return
        for i in range(0, len(pcm), FRAME_BYTES):
            chunk = pcm[i : i + FRAME_BYTES]
            await self.ws.send(
                json.dumps({"event": "audio_input", "audio": base64.b64encode(chunk).decode()})
            )
            self.sent_bytes += len(chunk)
            self.last_send_at = asyncio.get_running_loop().time()

    async def ping(self) -> None:
        if self.ws is not None:
            await self.ws.send(json.dumps({"event": "ping"}))
            self.last_send_at = asyncio.get_running_loop().time()

    def idle_seconds(self) -> float:
        return asyncio.get_running_loop().time() - self.last_send_at

    def _session_end(self, msg: dict[str, Any]) -> None:
        if not self.session_ended:
            self.session_ended = True
            try:
                self.billed_audio_seconds += max(0.0, float(msg.get("audio_duration_s") or 0))
            except (TypeError, ValueError):
                pass

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        assert self.ws is not None
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("event") == "session.end":
                    self._session_end(msg)
                if msg.get("event") == "error":
                    yield msg
                    if msg.get("is_fatal"):
                        return
                    continue
                yield msg
        except ConnectionClosed as exc:
            code = exc.rcvd.code if exc.rcvd else 1006  # no close frame: network drop
            if code != 1000:
                yield {
                    "event": "error",
                    "code": f"closed_{code}",
                    "is_fatal": True,
                    "message": (exc.rcvd.reason if exc.rcvd else "")[:200],
                }

    async def close(self) -> None:
        """Graceful end so Sarvam reports session.end (billed audio) before the socket closes."""
        if self.ws is None:
            return
        if self.session_ended:  # the server already ended this session
            ws, self.ws = self.ws, None
            with contextlib.suppress(ConnectionClosed, RuntimeError, OSError):
                await ws.close()
            return
        try:
            await self.ws.send(json.dumps({"event": "end"}))
            # Read until session.end (server-authoritative billed audio) or a short timeout.
            deadline = asyncio.get_running_loop().time() + 3.0
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if isinstance(msg, dict) and msg.get("event") == "session.end":
                    self._session_end(msg)
                    break
        except (ConnectionClosed, TimeoutError, RuntimeError, OSError):
            pass
        ws, self.ws = self.ws, None
        with contextlib.suppress(ConnectionClosed, RuntimeError, OSError):
            await ws.close()

    @property
    def sent_audio_seconds(self) -> float:
        return self.sent_bytes / 32000


class TtsStream:
    """One reply's speech. Open, send sentences as they are ready, flush, read PCM chunks until 'final'."""

    def __init__(self, settings: Settings, language_code: str, speaker: str) -> None:
        self.settings = settings
        self.language_code = language_code
        self.speaker = speaker
        self.ws: ClientConnection | None = None
        self.characters = 0

    async def open(self) -> None:
        key = _key(self.settings, "Live speech output")
        q = urlencode({"model": self.settings.SARVAM_TTS_MODEL, "send_completion_event": "true"})
        try:
            self.ws = await connect(
                f"{ws_base(self.settings)}/text-to-speech/ws?{q}",
                additional_headers={"api-subscription-key": key},
                open_timeout=10,
                max_size=2**24,
            )
        except (InvalidHandshake, OSError, TimeoutError) as exc:
            raise _handshake_error(exc) from None
        try:
            await self._send_config()
        except ConnectionClosed:
            await self.close()
            raise RealtimeProviderError("PROVIDER_UNAVAILABLE", "Sarvam closed the speech socket.") from None

    async def _send_config(self) -> None:
        assert self.ws is not None
        await self.ws.send(
            json.dumps(
                {
                    "type": "config",
                    "data": {
                        "language_code": self.language_code,
                        "speaker": self.speaker,
                        "output_audio_codec": "linear16",
                        "speech_sample_rate": self.settings.AGENT_TTS_SAMPLE_RATE,
                        "pace": float(self.settings.SARVAM_TTS_PACE),
                        "enable_preprocessing": True,
                        "min_buffer_size": 30,
                        "max_chunk_length": 200,
                    },
                }
            )
        )

    async def send_text(self, text: str) -> None:
        if self.ws is None or not text.strip():
            return
        self.characters += len(text)
        await self.ws.send(json.dumps({"type": "text", "data": {"text": text[:2500]}}))

    async def flush(self) -> None:
        if self.ws is not None:
            await self.ws.send(json.dumps({"type": "flush"}))

    async def audio(self, idle_timeout: float = TTS_IDLE_TIMEOUT_SECONDS) -> AsyncIterator[bytes]:
        """Yields raw PCM (linear16) until the completion event. A silent provider ends it with TTS_TIMEOUT."""
        assert self.ws is not None
        try:
            while True:
                try:
                    raw = await asyncio.wait_for(self.ws.recv(), timeout=idle_timeout)
                except TimeoutError:
                    raise RealtimeProviderError("TTS_TIMEOUT", "Sarvam speech output stalled.") from None
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if not isinstance(msg, dict):
                    continue
                kind = msg.get("type")
                if kind == "audio":
                    data = msg.get("data") or {}
                    try:
                        pcm = base64.b64decode(data.get("audio") or "")
                    except ValueError:
                        continue
                    if pcm:
                        yield pcm
                elif kind == "event" and (msg.get("data") or {}).get("event_type") == "final":
                    return
                elif kind == "error":
                    data = msg.get("data") or {}
                    raise RealtimeProviderError(
                        f"TTS_{data.get('code', 'ERROR')}", str(data.get("message", ""))[:300]
                    )
        except ConnectionClosed:
            return

    async def close(self) -> None:
        ws, self.ws = self.ws, None
        if ws is not None:
            with contextlib.suppress(ConnectionClosed, RuntimeError, OSError):
                await ws.close()
