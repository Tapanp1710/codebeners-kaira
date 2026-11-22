"""Live voice session: browser WebSocket <-> Sarvam realtime STT, agent turns, Sarvam streaming TTS.

Browser -> server:  binary frames = 16 kHz mono linear16 PCM (only while the user's live session is on and
                    unmuted); JSON {"type": "mute"|"unmute"|"interrupt"|"ping"} or
                    {"type": "text", "text": "...", "turn_id": "..."} for typed input in the same conversation.
Server -> browser:  JSON events (status, vad, transcript.partial/final, turn.*, tool.*, reply, tts.start/end/stop,
                    error, usage) and binary frames = linear16 PCM at AGENT_TTS_SAMPLE_RATE for the current reply.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import re
import time
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Any
from uuid import UUID

from fastapi import WebSocket
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.core.config import Settings
from app.integrations.sarvam.realtime import RealtimeProviderError, SttConfig, SttStream, TtsStream
from app.models import AgentSession, Customer
from app.services.agent import orchestrator

logger = logging.getLogger(__name__)
SENTENCE = re.compile(r"(?<=[.!?।॥])\s+")


def _norm(text: str) -> str:
    return re.sub(r"[^\w\s]", "", text.lower()).strip()


def split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in SENTENCE.split(text) if p.strip()]
    return parts or ([text.strip()] if text.strip() else [])


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
        self.turn_task: asyncio.Task | None = None
        self.speak_task: asyncio.Task | None = None
        self.cancel_turn: dict[str, bool] = {}
        self.speaking_text = ""
        self.speaking_until = 0.0
        self.last_final: tuple[str, float] = ("", 0.0)
        self.billed_seconds = 0.0
        self.sent_seconds = 0.0
        self.tts_chars = 0
        self.provider_errors = 0
        self.keyterms: list[str] = []
        self.speech_started_at: float | None = None
        self.loop = asyncio.get_running_loop()

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
            except (WebSocketDisconnect, RuntimeError):
                self.closed = True

    def emit_threadsafe(self, event: dict[str, Any]) -> None:
        self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.send(event)))

    # ------------------------------------------------------------------ lifecycle
    async def run(self) -> None:
        self.keyterms = await asyncio.to_thread(self._load_keyterms)
        stt_task = asyncio.create_task(self._stt_loop())
        try:
            await self._browser_loop()
        finally:
            self.closed = True
            for t in (self.turn_task, self.speak_task):
                if t and not t.done():
                    t.cancel()
            stt_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await stt_task
            if self.stt is not None:
                with contextlib.suppress(Exception):
                    await self.stt.close()
                self._account_stt(self.stt)
            await asyncio.to_thread(self._save_usage, "ended")

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

    def _save_usage(self, status: str) -> None:
        with self.factory() as db:
            s = db.get(AgentSession, self.session_id)
            if s is None:
                return
            s.stt_audio_seconds = (s.stt_audio_seconds or Decimal("0")) + Decimal(
                str(round(self.billed_seconds, 2))
            )
            s.stt_audio_sent_seconds = (s.stt_audio_sent_seconds or Decimal("0")) + Decimal(
                str(round(self.sent_seconds, 2))
            )
            s.tts_characters = (s.tts_characters or 0) + self.tts_chars
            s.provider_errors = (s.provider_errors or 0) + self.provider_errors
            if status == "ended":
                from datetime import UTC, datetime

                s.status = "ended"
                s.ended_at = datetime.now(UTC)
            db.commit()

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
                if not self.muted and self.stt is not None and self.stt_ready.is_set():
                    try:
                        await self.stt.send_pcm(msg["bytes"])
                    except Exception:  # noqa: BLE001 - the STT loop reconnects
                        self.stt_ready.clear()
                continue
            import json

            try:
                data = json.loads(msg.get("text") or "{}")
            except ValueError:
                continue
            kind = data.get("type")
            if kind == "mute":
                self.muted = True
                await self.send({"type": "status", "listening": False, "muted": True})
            elif kind == "unmute":
                self.muted = False
                await self.send({"type": "status", "listening": True, "muted": False})
            elif kind == "interrupt":
                await self._barge_in("user")
            elif kind == "ping":
                await self.send({"type": "pong"})
            elif kind == "text" and str(data.get("text", "")).strip():
                turn_id = str(data.get("turn_id") or self._turn_id(data["text"]))[:64]
                await self._start_turn(str(data["text"])[:1000], None, "text", turn_id)

    # ------------------------------------------------------------------ STT
    async def _stt_loop(self) -> None:
        attempt = 0
        while not self.closed:
            self.stt = SttStream(self.settings, SttConfig.from_settings(self.settings), self.keyterms)
            try:
                await self.stt.connect()
            except RealtimeProviderError as exc:
                self.provider_errors += 1
                await self.send(
                    {
                        "type": "error",
                        "source": "stt",
                        "code": exc.code,
                        "message": exc.message,
                        "fatal": exc.code == "PROVIDER_AUTH",
                    }
                )
                if exc.code == "PROVIDER_AUTH" or attempt >= 5:
                    return
                attempt += 1
                await asyncio.sleep(min(8, 0.5 * 2**attempt))
                continue
            attempt = 0
            self.stt_ready.set()
            await self.send(
                {"type": "status", "stt": "connected", "listening": not self.muted, "muted": self.muted}
            )
            keepalive = asyncio.create_task(self._stt_keepalive())
            fatal_error = None
            try:
                async for ev in self.stt.events():
                    await self._on_stt_event(ev)
                    if ev.get("event") == "error" and ev.get("is_fatal"):
                        fatal_error = ev
            finally:
                keepalive.cancel()
                self.stt_ready.clear()
                self._account_stt(self.stt)
            if self.closed:
                return
            self.provider_errors += 1 if fatal_error else 0
            code = str((fatal_error or {}).get("code", ""))
            await self.send({"type": "status", "stt": "reconnecting", "reason": code or "closed"})
            if code in ("invalid_subscription_key", "closed_1003"):
                await self.send(
                    {
                        "type": "error",
                        "source": "stt",
                        "code": "PROVIDER_AUTH_OR_QUOTA",
                        "message": "Sarvam refused the session (key, rate limit or quota).",
                        "fatal": True,
                    }
                )
                return
            attempt += 1
            await asyncio.sleep(min(8, 0.5 * 2**attempt))

    async def _stt_keepalive(self) -> None:
        while True:
            await asyncio.sleep(20)
            if self.muted and self.stt is not None:
                with contextlib.suppress(Exception):
                    await self.stt.ping()

    async def _on_stt_event(self, ev: dict[str, Any]) -> None:
        kind = ev.get("event")
        now = time.perf_counter()
        if kind == "vad.speech_start":
            self.speech_started_at = now
            await self.send({"type": "vad", "speech": True})
            if self.speak_task and not self.speak_task.done():
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
            text = (ev.get("text") or "").strip()
            if not text:
                return
            norm = _norm(text)
            if norm == self.last_final[0] and now - self.last_final[1] < 3:
                return  # duplicate final event
            self.last_final = (norm, now)
            if self._is_echo(norm, now):
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
            await self._start_turn(text, ev.get("language"), "voice", self._turn_id(text))
        elif kind == "error":
            self.provider_errors += 1
            await self.send(
                {
                    "type": "error",
                    "source": "stt",
                    "code": ev.get("code"),
                    "message": ev.get("message"),
                    "fatal": bool(ev.get("is_fatal")),
                }
            )

    def _is_echo(self, norm: str, now: float) -> bool:
        """Drop KAIRA's own voice picked up by the microphone (echo cancellation is the first defence)."""
        if not self.speaking_text or now > self.speaking_until + 2.0:
            return False
        return SequenceMatcher(None, norm, _norm(self.speaking_text)).ratio() > 0.6 or norm in _norm(
            self.speaking_text
        )

    def _turn_id(self, text: str) -> str:
        return hashlib.sha256(f"{self.session_id}:{time.time_ns()}:{text}".encode()).hexdigest()[:32]

    # ------------------------------------------------------------------ turns
    async def _barge_in(self, reason: str) -> None:
        if self.speak_task and not self.speak_task.done():
            self.speak_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.speak_task
        self.speaking_until = time.perf_counter()
        await self.send({"type": "tts.stop", "reason": reason})

    async def _start_turn(self, text: str, language: str | None, mode: str, turn_id: str) -> None:
        await self._barge_in("new_turn")
        for tid in list(self.cancel_turn):
            self.cancel_turn[tid] = True  # an older turn stops before its next step; finished writes stay
        self.cancel_turn[turn_id] = False
        utterance_end = time.perf_counter()

        async def runner() -> None:
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
            if result.reply and not self.closed:
                self.speak_task = asyncio.create_task(
                    self._speak(turn_id, result.reply, result.language, utterance_end)
                )

        self.turn_task = asyncio.create_task(runner())

    async def _speak(self, turn_id: str, text: str, language: str, utterance_end: float) -> None:
        lang = language if language in ("te-IN", "hi-IN", "en-IN") else "en-IN"
        tts = TtsStream(self.settings, lang, self.settings.tts_speaker_for(lang))
        self.speaking_text = text
        try:
            await tts.open()
            await self.send(
                {
                    "type": "tts.start",
                    "turn_id": turn_id,
                    "sample_rate": self.settings.AGENT_TTS_SAMPLE_RATE,
                    "speaker": tts.speaker,
                    "language": lang,
                }
            )
            for sentence in split_sentences(text):
                await tts.send_text(sentence + " ")
            await tts.flush()
            first = True
            samples = 0
            async for chunk in tts.audio():
                if first:
                    await self.send(
                        {
                            "type": "tts.first_audio",
                            "turn_id": turn_id,
                            "ms_from_utterance_end": int((time.perf_counter() - utterance_end) * 1000),
                        }
                    )
                    first = False
                samples += len(chunk) // 2
                self.speaking_until = time.perf_counter() + samples / self.settings.AGENT_TTS_SAMPLE_RATE
                await self.send(chunk)
            await self.send({"type": "tts.end", "turn_id": turn_id})
        except asyncio.CancelledError:
            raise
        except RealtimeProviderError as exc:
            self.provider_errors += 1
            await self.send(
                {"type": "error", "source": "tts", "code": exc.code, "message": exc.message, "fatal": False}
            )
        finally:
            self.tts_chars += tts.characters
            with contextlib.suppress(Exception):
                await tts.close()
