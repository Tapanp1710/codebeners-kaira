"""Live voice session: browser WebSocket <-> Sarvam realtime STT, agent turns, Sarvam streaming TTS.

Browser -> server:  binary frames = 16 kHz mono linear16 PCM (only while the user's live session is on and
                    unmuted); JSON {"type": "mute"|"unmute"|"interrupt"|"ping"} or
                    {"type": "text", "text": "...", "turn_id": "..."} for typed input in the same conversation.
Server -> browser:  JSON events (status, vad, transcript.partial/final, turn.*, tool.*, reply, tts.start/end/stop,
                    error, usage) and binary frames = linear16 PCM at AGENT_TTS_SAMPLE_RATE for the current reply.

Reliability rules (see tests/unit/test_realtime_live.py):
* A transcript.final whose text matches a turn still in flight, or one finalised in the last few seconds, never
  starts a second turn (Sarvam can repeat a final; a duplicate must not reach a second business operation).
* A typed turn whose turn_id is already in flight in this session is ignored; across sockets the orchestrator's
  atomic turn claim turns a resend into a replay.
* When the browser disconnects, an in-flight turn is NOT cancelled: it finishes (bounded wait) and stores its reply,
  so a reconnecting client that resends the same turn_id gets a replay instead of a restart or a hang.
* Only the newest turn may speak. A superseded turn's reply is never synthesised.
* One live socket per user per process: a newer socket ends the older one with a fatal SESSION_REPLACED error, so
  two tabs can never both turn the same speech into business operations.
* STT reconnects with exponential backoff + jitter; key/quota/parameter failures stop; idle closes reconnect free.
  Up to STT_BUFFER_SECONDS of audio received while reconnecting is replayed to the new stream.
* Usage (billed seconds from Sarvam session.end, sent seconds, TTS characters, errors) is saved as atomic deltas
  after every STT connection and at the end.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import random
import re
import time
from datetime import UTC, datetime
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Any
from uuid import UUID

from fastapi import WebSocket
from sqlalchemy import select, update
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.core.config import Settings
from app.integrations.sarvam.realtime import (
    STT_RECONNECT_NOW,
    STT_STOP,
    RealtimeProviderError,
    SttConfig,
    SttStream,
    TtsStream,
    classify_stt_end,
)
from app.models import AgentSession, Customer
from app.services.agent import orchestrator

logger = logging.getLogger(__name__)
BYTES_PER_SECOND = 32000  # 16 kHz mono Int16
MAX_FRAME_BYTES = BYTES_PER_SECOND  # 1 s
PACING_SLACK_SECONDS = 10
STT_BUFFER_SECONDS = 2.0  # audio kept while the STT stream reconnects (newest wins)
STT_KEEPALIVE_IDLE_SECONDS = 15.0  # ping Sarvam when no audio was sent for this long (it closes at 60 s)
STT_KEEPALIVE_CHECK_SECONDS = 5.0
STT_MAX_QUICK_FAILURES = 5
STT_MIN_HEALTHY_SECONDS = 5.0  # a stream that ended sooner counts as a failure even on a clean close
STT_BACKOFF_BASE = 0.5
STT_BACKOFF_MAX = 8.0
FINAL_DEDUPE_SECONDS = 4.0  # an identical final within this window is a duplicate, not a new request
ECHO_TAIL_SECONDS = 2.0
TURN_DRAIN_GRACE_SECONDS = 5.0
SENTENCE = re.compile(r"(?<=[.!?।॥])\s+")

# user_id -> the live session currently owning that user's voice (per process).
_ACTIVE: dict[UUID, LiveSession] = {}


def _norm(text: str) -> str:
    return re.sub(r"[^\w\s]", "", text.lower()).strip()


def split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in SENTENCE.split(text) if p.strip()]
    return parts or ([text.strip()] if text.strip() else [])


def backoff_delay(attempt: int) -> float:
    return min(STT_BACKOFF_MAX, STT_BACKOFF_BASE * 2**attempt) * (0.8 + 0.4 * random.random())


def is_echo(norm: str, speaking_text: str) -> bool:
    """True when a final transcript is KAIRA's own voice picked up by the microphone.

    A short answer ("yes", "haan", "avunu") is never treated as echo just because the reply contained that word:
    containment only counts for utterances of three words or more."""
    spoken = _norm(speaking_text)
    if not norm or not spoken:
        return False
    if SequenceMatcher(None, norm, spoken).ratio() > 0.6:
        return True
    return len(norm.split()) >= 3 and norm in spoken


class LiveSession:
    def __init__(
        self, ws: WebSocket, app_state: Any, *, user_id: UUID, business_id: UUID, session_id: UUID
    ) -> None:
        self.ws = ws
        self.settings: Settings = app_state.settings
        self.factory = app_state.session_factory
        self.sarvam = app_state.sarvam
        self.user_id, self.business_id, self.session_id = user_id, business_id, session_id
        self.send_lock = asyncio.Lock()
        self.muted = False
        self.closed = False
        self.stt: SttStream | None = None
        self.stt_ready = asyncio.Event()
        self.stt_buffer = bytearray()
        self.turn_task: asyncio.Task | None = None
        self.speak_task: asyncio.Task | None = None
        self.cancel_turn: dict[str, bool] = {}
        self.active_turn_id: str | None = None  # the newest turn; only it may speak
        self.inflight_texts: dict[str, str] = {}  # turn_id -> normalised utterance, while the turn runs
        self.recent_finals: dict[str, float] = {}  # normalised final -> perf_counter when it started a turn
        self.speaking_text = ""
        self.speaking_until = 0.0  # estimated end of browser playback (perf_counter)
        self.billed_seconds = 0.0
        self.sent_seconds = 0.0
        self.tts_chars = 0
        self.provider_errors = 0
        self.keyterms: list[str] = []
        self.speech_started_at: float | None = None
        self.loop = asyncio.get_running_loop()
        self.rate_limiter = getattr(app_state, "rate_limiter", None)
        self.started_at = time.monotonic()
        self.audio_bytes_in = 0  # for pacing: audio may not arrive faster than real time
        self.replaced = False

    # ------------------------------------------------------------------ io
    async def send(self, payload: dict[str, Any] | bytes) -> None:
        if self.closed or self.ws.client_state != WebSocketState.CONNECTED:
            return
        async with self.send_lock:
            try:
                if isinstance(payload, bytes):
                    await self.ws.send_bytes(payload)
                else:
                    await self.ws.send_json(payload)
            except (WebSocketDisconnect, RuntimeError, OSError):
                self.closed = True

    def emit_threadsafe(self, event: dict[str, Any]) -> None:
        if self.closed:
            return
        with contextlib.suppress(RuntimeError):  # loop already closed at shutdown
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.send(event)))

    # ------------------------------------------------------------------ lifecycle
    async def _replace_previous(self) -> None:
        previous = _ACTIVE.get(self.user_id)
        _ACTIVE[self.user_id] = self
        if previous is None or previous is self or previous.closed:
            return
        previous.replaced = True
        await previous.send(
            {
                "type": "error",
                "source": "session",
                "code": "SESSION_REPLACED",
                "fatal": True,
                "message": "Live voice moved to another window. Turn it on here again to use it here.",
            }
        )
        previous.closed = True
        with contextlib.suppress(Exception):
            await previous.ws.close(code=1000, reason="replaced by a newer live session")

    async def run(self) -> None:
        await self._replace_previous()
        stt_task: asyncio.Task | None = None
        try:
            self.keyterms = await asyncio.to_thread(self._load_keyterms)
            stt_task = asyncio.create_task(self._stt_loop())
            await self._browser_loop()
        finally:
            self.closed = True
            if _ACTIVE.get(self.user_id) is self:
                _ACTIVE.pop(self.user_id, None)
            await self._stop_speaking()
            if stt_task is not None:
                stt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await stt_task
            if self.stt is not None:
                with contextlib.suppress(Exception):
                    await self.stt.close()
                self._account_stt(self.stt)
            # The in-flight turn (if any) finishes and stores its reply; it is not cancelled by a disconnect.
            await self._drain_turn()
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self._save_usage, "ended")

    async def _drain_turn(self) -> None:
        task = self.turn_task
        if task is None or task.done():
            return
        timeout = float(self.settings.AGENT_TURN_TIMEOUT_SECONDS) + TURN_DRAIN_GRACE_SECONDS
        done, _ = await asyncio.wait({task}, timeout=timeout)
        if not done:
            logger.warning("live session %s: turn still running after disconnect", self.session_id)

    def _load_keyterms(self) -> list[str]:
        with self.factory() as db:
            names = db.scalars(
                select(Customer.name).where(Customer.business_id == self.business_id).limit(45)
            ).all()
        return [*names, "KAIRA", "invoice", "rupees"]

    def _account_stt(self, stt: SttStream) -> None:
        self.billed_seconds += stt.billed_audio_seconds
        self.sent_seconds += stt.sent_audio_seconds
        stt.billed_audio_seconds = 0
        stt.sent_bytes = 0

    def _take_usage(self) -> tuple[float, float, int, int]:
        usage = (self.billed_seconds, self.sent_seconds, self.tts_chars, self.provider_errors)
        self.billed_seconds = self.sent_seconds = 0.0
        self.tts_chars = self.provider_errors = 0
        return usage

    def _save_usage(self, status: str, usage: tuple[float, float, int, int] | None = None) -> None:
        """Adds this session's usage since the last save, atomically (another socket may share the session)."""
        billed, sent, chars, errors = usage if usage is not None else self._take_usage()
        values: dict[str, Any] = {
            "stt_audio_seconds": AgentSession.stt_audio_seconds + Decimal(str(round(billed, 2))),
            "stt_audio_sent_seconds": AgentSession.stt_audio_sent_seconds + Decimal(str(round(sent, 2))),
            "tts_characters": AgentSession.tts_characters + chars,
            "provider_errors": AgentSession.provider_errors + errors,
        }
        live_elsewhere = any(s.session_id == self.session_id for s in _ACTIVE.values() if s is not self)
        if status == "ended" and not live_elsewhere:
            values["status"] = "ended"
            values["ended_at"] = datetime.now(UTC)
        with self.factory() as db:
            db.execute(update(AgentSession).where(AgentSession.id == self.session_id).values(**values))
            db.commit()

    async def _checkpoint_usage(self) -> None:
        usage = self._take_usage()
        if any(usage):
            try:
                await asyncio.to_thread(self._save_usage, "active", usage)
            except Exception:  # noqa: BLE001 - keep the counts for the final save
                logger.exception("live usage checkpoint failed")
                self.billed_seconds += usage[0]
                self.sent_seconds += usage[1]
                self.tts_chars += usage[2]
                self.provider_errors += usage[3]

    # ------------------------------------------------------------------ browser
    async def _browser_loop(self) -> None:
        while not self.closed:
            try:
                msg = await self.ws.receive()
            except (WebSocketDisconnect, RuntimeError):
                return
            if msg.get("type") == "websocket.disconnect":
                return
            if msg.get("bytes") is not None:
                if await self._on_audio(msg["bytes"]) is False:
                    return
                continue
            try:
                data = json.loads(msg.get("text") or "{}")
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            await self._on_control(data)

    async def _on_audio(self, frame: bytes) -> bool:
        if len(frame) > MAX_FRAME_BYTES:
            await self.send(
                {
                    "type": "error",
                    "source": "client",
                    "code": "FRAME_TOO_LARGE",
                    "message": "Audio frames must be at most 1 s of 16 kHz PCM.",
                    "fatal": False,
                }
            )
            return True
        self.audio_bytes_in += len(frame)
        elapsed = time.monotonic() - self.started_at
        if self.audio_bytes_in / BYTES_PER_SECOND > elapsed + PACING_SLACK_SECONDS:
            return True  # faster than real time: dropped (bounds billed STT audio)
        if elapsed > self.settings.AGENT_MAX_SESSION_MINUTES * 60:
            await self.send(
                {
                    "type": "error",
                    "source": "session",
                    "code": "SESSION_TOO_LONG",
                    "message": "The live session reached its time limit. Start it again.",
                    "fatal": True,
                }
            )
            return False
        if self.muted:
            return True
        if self.stt is not None and self.stt_ready.is_set():
            try:
                await self.stt.send_pcm(frame)
            except Exception:  # noqa: BLE001 - the STT loop reconnects; keep this frame for the new stream
                self.stt_ready.clear()
                self._buffer(frame)
        else:
            self._buffer(frame)
        return True

    def _buffer(self, frame: bytes) -> None:
        self.stt_buffer += frame
        limit = int(STT_BUFFER_SECONDS * BYTES_PER_SECOND)
        if len(self.stt_buffer) > limit:
            del self.stt_buffer[: len(self.stt_buffer) - limit]  # keep the newest audio

    async def _on_control(self, data: dict[str, Any]) -> None:
        kind = data.get("type")
        if kind == "mute":
            self.muted = True
            self.stt_buffer.clear()
            await self.send({"type": "status", "listening": False, "muted": True})
        elif kind == "unmute":
            self.muted = False
            await self.send({"type": "status", "listening": True, "muted": False})
        elif kind == "interrupt":
            await self._barge_in("user")
        elif kind == "ping":
            await self.send({"type": "pong"})
        elif kind == "text" and str(data.get("text", "")).strip():
            text = str(data["text"])[:1000]
            turn_id = str(data.get("turn_id") or self._turn_id(text))[:64]
            if turn_id in self.inflight_texts:
                return  # a resend of a turn this session is already running
            if not await self._allow_turn(turn_id):
                return
            await self._start_turn(text, None, "text", turn_id)

    # ------------------------------------------------------------------ STT
    async def _stt_loop(self) -> None:
        attempt = 0
        while not self.closed:
            stt = SttStream(self.settings, SttConfig.from_settings(self.settings), self.keyterms)
            self.stt = stt
            try:
                await stt.connect()
            except RealtimeProviderError as exc:
                self.provider_errors += 1
                stop = exc.code == "PROVIDER_AUTH" or attempt >= STT_MAX_QUICK_FAILURES
                await self.send(
                    {
                        "type": "error",
                        "source": "stt",
                        "code": exc.code,
                        "message": exc.message,
                        "fatal": stop,
                    }
                )
                if stop:
                    return
                await self.send({"type": "status", "stt": "reconnecting", "reason": exc.code})
                await asyncio.sleep(backoff_delay(attempt))
                attempt += 1
                continue
            connected_at = time.monotonic()
            await self._flush_buffer(stt)
            keepalive = asyncio.create_task(self._stt_keepalive(stt))
            fatal_error: dict[str, Any] | None = None
            try:
                await self.send(
                    {"type": "status", "stt": "connected", "listening": not self.muted, "muted": self.muted}
                )
                async for ev in stt.events():
                    if ev.get("event") == "error" and ev.get("is_fatal"):
                        fatal_error = ev  # the loop below decides: reconnect or stop
                        continue
                    await self._on_stt_event(ev)
            finally:
                self.stt_ready.clear()
                keepalive.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await keepalive
                # Close gracefully: no leaked socket, and session.end reports the billed audio of this connection.
                with contextlib.suppress(Exception):
                    await stt.close()
                self._account_stt(stt)
            if self.closed:
                return
            action = classify_stt_end(fatal_error)
            code = str((fatal_error or {}).get("code") or "closed")
            lived = time.monotonic() - connected_at
            healthy_idle_close = action == STT_RECONNECT_NOW and lived >= STT_MIN_HEALTHY_SECONDS
            if not healthy_idle_close:
                self.provider_errors += 1
            # Persist this connection's billed seconds now; a crash later must not lose them.
            await self._checkpoint_usage()
            if action == STT_STOP:
                await self.send(
                    {
                        "type": "error",
                        "source": "stt",
                        "code": "PROVIDER_AUTH_OR_QUOTA" if code != "closed_4000" else "PROVIDER_CONFIG",
                        "message": "Sarvam refused the live transcription session (key, quota or settings). "
                        "Typed input still works.",
                        "fatal": True,
                    }
                )
                return
            await self.send({"type": "status", "stt": "reconnecting", "reason": code})
            if healthy_idle_close:
                attempt = 0
                continue
            # A connection that lived a while resets the budget; quick repeated drops stop after a few tries.
            attempt = 0 if lived > 30 else attempt + 1
            if attempt > STT_MAX_QUICK_FAILURES:
                await self.send(
                    {
                        "type": "error",
                        "source": "stt",
                        "code": "STT_UNSTABLE",
                        "fatal": True,
                        "message": "Live transcription keeps disconnecting. Typed input still works.",
                    }
                )
                return
            await asyncio.sleep(backoff_delay(attempt))

    async def _flush_buffer(self, stt: SttStream) -> None:
        """Sends audio received while reconnecting, then opens the direct path (no await between check and set)."""
        while self.stt_buffer and not self.muted:
            pending = bytes(self.stt_buffer)
            self.stt_buffer.clear()
            try:
                await stt.send_pcm(pending)
            except Exception:  # noqa: BLE001 - the events loop sees the closed socket
                return
        self.stt_buffer.clear()
        self.stt_ready.set()

    async def _stt_keepalive(self, stt: SttStream) -> None:
        """Sarvam closes an STT socket after 60 s without audio (1008). Ping whenever audio stops (muted, tab
        hidden, mic stalled)."""
        while True:
            await asyncio.sleep(STT_KEEPALIVE_CHECK_SECONDS)
            if stt.ws is not None and stt.idle_seconds() >= STT_KEEPALIVE_IDLE_SECONDS:
                with contextlib.suppress(Exception):
                    await stt.ping()

    async def _on_stt_event(self, ev: dict[str, Any]) -> None:
        kind = ev.get("event")
        now = time.perf_counter()
        if kind == "vad.speech_start":
            self.speech_started_at = now
            await self.send({"type": "vad", "speech": True})
            if self._is_speaking(now):
                await self._barge_in("speech")
        elif kind == "vad.speech_end":
            await self.send({"type": "vad", "speech": False})
        elif kind == "transcript.partial":
            first = None
            if self.speech_started_at is not None:
                first = int((now - self.speech_started_at) * 1000)
                self.speech_started_at = None
            await self.send(
                {
                    "type": "transcript.partial",
                    "text": ev.get("text", ""),
                    "language": ev.get("language"),
                    "first_partial_ms": first,
                }
            )
        elif kind == "transcript.final":
            self.speech_started_at = None
            text = (ev.get("text") or "").strip()
            if not text:
                return
            norm = _norm(text)
            if self._is_duplicate_final(norm, now):
                logger.info("live session %s: duplicate final dropped", self.session_id)
                return
            if self.speaking_text and now <= self.speaking_until + ECHO_TAIL_SECONDS:
                if is_echo(norm, self.speaking_text):
                    await self.send({"type": "transcript.echo", "text": text})
                    return
            await self.send(
                {
                    "type": "transcript.final",
                    "text": text,
                    "language": ev.get("language"),
                    "language_confidence": ev.get("language_confidence"),
                }
            )
            if await self._allow_turn():
                self.recent_finals[norm] = now
                await self._start_turn(text, ev.get("language"), "voice", self._turn_id(text))
        elif kind == "error":
            # Non-fatal provider errors only (fatal ones end the stream and are handled by the STT loop).
            self.provider_errors += 1
            await self.send(
                {
                    "type": "error",
                    "source": "stt",
                    "code": ev.get("code"),
                    "message": ev.get("message"),
                    "fatal": False,
                }
            )

    def _is_duplicate_final(self, norm: str, now: float) -> bool:
        for key, at in list(self.recent_finals.items()):
            if now - at > FINAL_DEDUPE_SECONDS:
                self.recent_finals.pop(key, None)
        if not norm:
            return False
        return norm in self.recent_finals or norm in self.inflight_texts.values()

    def _turn_id(self, text: str) -> str:
        return hashlib.sha256(f"{self.session_id}:{time.time_ns()}:{text}".encode()).hexdigest()[:32]

    # ------------------------------------------------------------------ turns
    def _is_speaking(self, now: float | None = None) -> bool:
        """A reply is being synthesised, or the browser is still playing audio already sent."""
        now = time.perf_counter() if now is None else now
        return bool(self.speak_task and not self.speak_task.done()) or now < self.speaking_until

    async def _stop_speaking(self) -> None:
        task = self.speak_task
        if task and not task.done():
            task.cancel()  # closes the TTS socket (finally in _speak)
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _barge_in(self, reason: str) -> None:
        was_speaking = self._is_speaking()
        await self._stop_speaking()
        self.speaking_until = time.perf_counter()
        if was_speaking or reason != "speech":
            await self.send({"type": "tts.stop", "reason": reason})

    async def _allow_turn(self, turn_id: str | None = None) -> bool:
        """The same per-user AI limit as the REST endpoints.

        ``turn_id`` is the client's id of a refused typed turn: it is echoed in the RATE_LIMITED error so the
        browser drops that turn instead of keeping it pending (and replaying it later unasked).
        """
        if self.rate_limiter is None:
            return True
        try:
            await asyncio.to_thread(
                self.rate_limiter.check, f"ai:{self.user_id}", self.settings.RATE_LIMIT_AI_PER_MINUTE
            )
        except Exception:  # noqa: BLE001 - rate limited (or limiter failure): refuse this turn, keep the session
            event: dict[str, Any] = {
                "type": "error",
                "source": "session",
                "code": "RATE_LIMITED",
                "fatal": False,
                "message": "Too many requests. Wait a moment.",
            }
            if turn_id is not None:
                event["turn_id"] = turn_id
            await self.send(event)
            return False
        return True

    async def _start_turn(self, text: str, language: str | None, mode: str, turn_id: str) -> None:
        await self._barge_in("new_turn")
        for tid in list(self.cancel_turn):
            self.cancel_turn[tid] = True  # an older turn stops before its next step or write
        self.cancel_turn[turn_id] = False
        self.active_turn_id = turn_id
        self.inflight_texts[turn_id] = _norm(text)
        utterance_end = time.perf_counter()
        previous = self.turn_task

        async def runner() -> None:
            # One turn at a time per session: the cancelled predecessor winds down first.
            if previous is not None and not previous.done():
                with contextlib.suppress(BaseException):
                    await previous
            try:
                result = await asyncio.to_thread(
                    orchestrator.run_turn,
                    self.factory,
                    self.settings,
                    self.sarvam,
                    user_id=self.user_id,
                    business_id=self.business_id,
                    session_id=self.session_id,
                    turn_id=turn_id,
                    text=text,
                    language_hint=language,
                    input_mode=mode,
                    emit=self.emit_threadsafe,
                    should_cancel=lambda: self.cancel_turn.get(turn_id, True),
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("agent turn failed")
                await self.send(
                    {
                        "type": "turn.failed",
                        "turn_id": turn_id,
                        "message": getattr(exc, "message", "Something went wrong; nothing more was changed."),
                    }
                )
                return
            finally:
                self.cancel_turn.pop(turn_id, None)
                self.inflight_texts.pop(turn_id, None)
            await self.send(
                {
                    "type": "turn.completed",
                    "turn_id": turn_id,
                    "ignored": result.ignored,
                    "response_ms": int((time.perf_counter() - utterance_end) * 1000),
                    "llm_calls": result.llm_calls,
                    "tools": [r["tool"] for r in result.tool_runs],
                }
            )
            # A superseded turn (a newer utterance arrived) never speaks; neither does a closed session.
            if result.reply and not self.closed and self.active_turn_id == turn_id:
                await self._stop_speaking()
                self.speak_task = asyncio.create_task(
                    self._speak(turn_id, result.reply, result.language, utterance_end)
                )

        self.turn_task = asyncio.create_task(runner())

    async def _speak(self, turn_id: str, text: str, language: str, utterance_end: float) -> None:
        lang = language if language in ("te-IN", "hi-IN", "en-IN") else "en-IN"
        tts = TtsStream(self.settings, lang, self.settings.tts_speaker_for(lang))
        self.speaking_text = text
        rate = self.settings.AGENT_TTS_SAMPLE_RATE
        try:
            await tts.open()
            await self.send(
                {
                    "type": "tts.start",
                    "turn_id": turn_id,
                    "sample_rate": rate,
                    "speaker": tts.speaker,
                    "language": lang,
                }
            )
            for sentence in split_sentences(text):
                await tts.send_text(sentence + " ")
            await tts.flush()
            playback_start: float | None = None
            samples = 0
            async for chunk in tts.audio():
                if self.closed or self.active_turn_id != turn_id:
                    return  # superseded while synthesising: stop at once
                now = time.perf_counter()
                if playback_start is None:
                    playback_start = now
                    await self.send(
                        {
                            "type": "tts.first_audio",
                            "turn_id": turn_id,
                            "ms_from_utterance_end": int((now - utterance_end) * 1000),
                        }
                    )
                samples += len(chunk) // 2
                # The browser plays gaplessly from the first chunk: playback ends at start + duration.
                self.speaking_until = max(now, playback_start + samples / rate)
                await self.send(chunk)
            await self.send({"type": "tts.end", "turn_id": turn_id})
        except asyncio.CancelledError:
            raise
        except RealtimeProviderError as exc:
            self.provider_errors += 1
            await self.send(
                {"type": "error", "source": "tts", "code": exc.code, "message": exc.message, "fatal": False}
            )
        except Exception:  # noqa: BLE001 - a TTS failure never ends the session
            logger.exception("live tts failed")
            self.provider_errors += 1
            await self.send(
                {
                    "type": "error",
                    "source": "tts",
                    "code": "TTS_FAILED",
                    "message": "KAIRA could not speak this reply; it is shown as text.",
                    "fatal": False,
                }
            )
        finally:
            self.tts_chars += tts.characters
            with contextlib.suppress(Exception):
                await tts.close()
