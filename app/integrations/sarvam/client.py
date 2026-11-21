"""Sarvam AI REST adapter: Saaras speech-to-text, Bulbul text-to-speech, chat completions.

Verified against https://docs.sarvam.ai (2026-11-21):
- STT  POST {base}/speech-to-text      multipart: file, model, mode, language_code
       -> {request_id, transcript, language_code, language_probability, ...}; max 30 s audio.
- TTS  POST {base}/text-to-speech      JSON: text (<=2500 chars), language_code, model, speaker,
       pace (0.5-2.0), speech_sample_rate, output_audio_codec -> {request_id, audios: [base64]}
- Chat POST {base}/v1/chat/completions OpenAI-shaped; response_format json_schema supported.
Auth header: ``api-subscription-key``. The key is never logged.
Retries (exponential backoff) only on 429/503/timeouts - these calls never write business data.
"""

from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings
from app.core.exceptions import ProviderError, ProviderNotConfiguredError, ServiceUnavailableError

logger = logging.getLogger(__name__)
RETRY_STATUSES = {429, 500, 502, 503, 504}


@dataclass
class Transcription:
    transcript: str
    language_code: str | None
    language_probability: float | None
    request_id: str | None


@dataclass
class Speech:
    audio: bytes
    request_id: str | None


class SarvamClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        self.settings = settings
        self._transport = transport

    # ------------------------------------------------------------------ plumbing
    def _require_key(self, feature: str) -> str:
        if not self.settings.SARVAM_API_KEY:
            raise ProviderNotConfiguredError(feature)
        return self.settings.SARVAM_API_KEY

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.settings.SARVAM_BASE_URL.rstrip("/"),
            timeout=httpx.Timeout(self.settings.SARVAM_TIMEOUT_SECONDS, connect=10.0),
            transport=self._transport,
        )

    def _post(self, feature: str, path: str, **kwargs: Any) -> dict[str, Any]:
        key = self._require_key(feature)
        headers = {"api-subscription-key": key}
        attempts = self.settings.SARVAM_MAX_RETRIES + 1
        last_error: Exception | None = None
        with self._client() as client:
            for attempt in range(attempts):
                try:
                    response = client.post(path, headers=headers, **kwargs)
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    last_error = exc
                    logger.warning(
                        "Sarvam %s transport error (attempt %d): %s", feature, attempt + 1, type(exc).__name__
                    )
                else:
                    if response.status_code < 400:
                        try:
                            return response.json()
                        except ValueError as exc:
                            raise ProviderError(f"{feature}: provider returned invalid JSON.") from exc
                    if response.status_code in RETRY_STATUSES and attempt + 1 < attempts:
                        logger.warning(
                            "Sarvam %s returned %d (attempt %d)", feature, response.status_code, attempt + 1
                        )
                        last_error = None
                    else:
                        self._raise_for(feature, response)
                if attempt + 1 < attempts:
                    time.sleep(min(8.0, 0.5 * 2**attempt))
        if isinstance(last_error, httpx.TimeoutException):
            raise ServiceUnavailableError(
                f"{feature}: the provider did not respond in time.", code="PROVIDER_TIMEOUT"
            )
        raise ServiceUnavailableError(
            f"{feature}: the provider is unavailable. Please retry.", code="PROVIDER_UNAVAILABLE"
        )

    @staticmethod
    def _raise_for(feature: str, response: httpx.Response) -> None:
        status = response.status_code
        try:
            body = response.json()
        except ValueError:
            body = {}
        provider_message = None
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                provider_message = err.get("message")
            if not provider_message and isinstance(body.get("detail"), str):
                provider_message = body["detail"]
        details = {"provider_status": status}
        if isinstance(provider_message, str):
            details["provider_message"] = provider_message[:300]
        if status in (401, 403):
            raise ProviderError(f"{feature}: Sarvam rejected the API key. Check SARVAM_API_KEY.", details)
        if status == 402:
            raise ProviderError(f"{feature}: the Sarvam account has insufficient credits.", details)
        if status == 429:
            raise ServiceUnavailableError(
                f"{feature}: provider rate limit reached. Try again shortly.",
                details,
                code="PROVIDER_RATE_LIMITED",
            )
        if status >= 500:
            raise ServiceUnavailableError(
                f"{feature}: the provider is unavailable.", details, code="PROVIDER_UNAVAILABLE"
            )
        raise ProviderError(f"{feature}: the provider rejected the request.", details, status_code=502)

    # ------------------------------------------------------------------ STT
    def transcribe(
        self, audio: bytes, filename: str, content_type: str, language_code: str | None
    ) -> Transcription:
        data = {"model": self.settings.SARVAM_STT_MODEL, "mode": self.settings.SARVAM_STT_MODE}
        if language_code:
            data["language_code"] = language_code
        body = self._post(
            "Speech-to-text",
            "/speech-to-text",
            data=data,
            files={"file": (filename, audio, content_type)},
        )
        transcript = body.get("transcript")
        if not isinstance(transcript, str):
            raise ProviderError("Speech-to-text: provider response had no transcript.")
        prob = body.get("language_probability")
        return Transcription(
            transcript=transcript.strip(),
            language_code=body.get("language_code"),
            language_probability=float(prob) if isinstance(prob, int | float) else None,
            request_id=body.get("request_id"),
        )

    # ------------------------------------------------------------------ TTS
    def speak(self, text: str, language_code: str, speaker: str, pace: float) -> Speech:
        body = self._post(
            "Text-to-speech",
            "/text-to-speech",
            json={
                "text": text,
                "language_code": language_code,
                "model": self.settings.SARVAM_TTS_MODEL,
                "speaker": speaker,
                "pace": pace,
                "speech_sample_rate": self.settings.SARVAM_TTS_SAMPLE_RATE,
                "output_audio_codec": self.settings.SARVAM_TTS_CODEC,
            },
        )
        audios = body.get("audios")
        if not isinstance(audios, list) or not audios or not isinstance(audios[0], str):
            raise ProviderError("Text-to-speech: provider response had no audio.")
        try:
            audio = b"".join(base64.b64decode(chunk, validate=True) for chunk in audios)
        except ValueError as exc:
            raise ProviderError("Text-to-speech: provider returned invalid audio data.") from exc
        return Speech(audio=audio, request_id=body.get("request_id"))

    # ------------------------------------------------------------------ chat
    def chat_json(self, messages: list[dict[str, str]], schema: dict[str, Any], name: str) -> str:
        payload: dict[str, Any] = {
            "model": self.settings.SARVAM_LLM_MODEL,
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": self.settings.SARVAM_LLM_MAX_TOKENS,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": name, "schema": schema, "strict": False},
            },
        }
        if self.settings.SARVAM_LLM_REASONING_EFFORT:
            payload["reasoning_effort"] = self.settings.SARVAM_LLM_REASONING_EFFORT
        return self._chat(payload)

    def chat_text(self, messages: list[dict[str, str]]) -> str:
        payload: dict[str, Any] = {
            "model": self.settings.SARVAM_LLM_MODEL,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": self.settings.SARVAM_LLM_MAX_TOKENS,
        }
        if self.settings.SARVAM_LLM_REASONING_EFFORT:
            payload["reasoning_effort"] = self.settings.SARVAM_LLM_REASONING_EFFORT
        return self._chat(payload)

    def _chat(self, payload: dict[str, Any]) -> str:
        body = self._post("AI assistant", "/v1/chat/completions", json=payload)
        try:
            choice = body["choices"][0]
            content = choice["message"].get("content")
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ProviderError("AI assistant: unexpected provider response shape.") from exc
        if not content:
            reason = choice.get("finish_reason") if isinstance(choice, dict) else None
            raise ProviderError("AI assistant: provider returned no content.", {"finish_reason": reason})
        return content
