"""SarvamClient retry policy and request shape, against httpx.MockTransport (no network, MOCKED provider).

The policy follows Sarvam's errors guide: back off and retry 429/5xx and transport failures; never retry
400/402/403/422, nor a 429 whose code says a seat's spend budget is exhausted."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from app.core.config import Settings
from app.core.exceptions import ProviderError, ProviderNotConfiguredError, ServiceUnavailableError
from app.integrations.sarvam import client as client_module
from app.integrations.sarvam.client import SarvamClient


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", recorded.append)
    return recorded


def make_client(responses, **settings) -> tuple[SarvamClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    s = Settings(_env_file=None, SARVAM_API_KEY="sk_test_dummy", **settings)
    return SarvamClient(s, transport=httpx.MockTransport(handler)), seen


def err(status: int, code: str, message: str = "x") -> httpx.Response:
    return httpx.Response(status, json={"error": {"message": message, "code": code, "request_id": "r"}})


def tts_ok() -> httpx.Response:
    return httpx.Response(200, json={"request_id": "r1", "audios": [base64.b64encode(b"RIFFdata").decode()]})


def test_rate_limit_is_retried_twice_with_exponential_backoff(sleeps):
    c, seen = make_client([err(429, "rate_limit_exceeded_error")] * 3)
    with pytest.raises(ServiceUnavailableError) as exc:
        c.speak("hi", "en-IN", "aparna_en_companion", 1.0)
    assert exc.value.code == "PROVIDER_RATE_LIMITED"
    assert len(seen) == 3  # 1 + SARVAM_MAX_RETRIES (2)
    assert sleeps == [0.5, 1.0]


def test_transient_failure_then_success(sleeps):
    c, seen = make_client([err(503, "model_overloaded"), tts_ok()])
    assert c.speak("hi", "en-IN", "aparna_en_companion", 1.0).audio == b"RIFFdata"
    assert len(seen) == 2 and sleeps == [0.5]


def test_exhausted_seat_budget_is_not_retried(sleeps):
    c, seen = make_client([err(429, "seat_budget_exhausted_error", "Seat budget exhausted")])
    with pytest.raises(ProviderError) as exc:
        c.speak("hi", "en-IN", "aparna_en_companion", 1.0)
    assert len(seen) == 1 and sleeps == []
    assert "budget" in exc.value.message
    assert exc.value.details["provider_code"] == "seat_budget_exhausted_error"


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "invalid_request_error"),
        (402, "insufficient_quota_error"),
        (403, "invalid_api_key_error"),
        (422, "unprocessable_entity_error"),
    ],
)
def test_permanent_errors_are_not_retried(sleeps, status, code):
    c, seen = make_client([err(status, code)])
    with pytest.raises(ProviderError) as exc:
        c.speak("hi", "en-IN", "aparna_en_companion", 1.0)
    assert len(seen) == 1 and sleeps == []
    assert "sk_test_dummy" not in exc.value.message and "sk_test_dummy" not in json.dumps(exc.value.details)


def test_timeouts_are_retried_then_reported(sleeps):
    c, seen = make_client([httpx.ReadTimeout("slow")] * 3)
    with pytest.raises(ServiceUnavailableError) as exc:
        c.transcribe(b"RIFF" + b"\0" * 200, "a.wav", "audio/wav", "te-IN")
    assert exc.value.code == "PROVIDER_TIMEOUT"
    assert len(seen) == 3 and sleeps == [0.5, 1.0]


def test_timeout_setting_reaches_the_http_client():
    c, _ = make_client([], SARVAM_TIMEOUT_SECONDS=60.0)
    with c._client() as http:
        assert http.timeout.read == 60.0 and http.timeout.connect == 10.0


def test_missing_key_fails_before_any_request():
    s = Settings(_env_file=None, SARVAM_API_KEY=None)
    c = SarvamClient(s, transport=httpx.MockTransport(lambda r: pytest.fail("no request expected")))
    with pytest.raises(ProviderNotConfiguredError):
        c.speak("hi", "en-IN", "aparna_en_companion", 1.0)


@pytest.mark.parametrize(
    ("language", "speaker"),
    [("te-IN", "kavitha_te_conversation"), ("hi-IN", "aparna_hi_customer"), ("en-IN", "aparna_en_companion")],
)
def test_tts_request_always_names_model_and_speaker(sleeps, language, speaker):
    c, seen = make_client([tts_ok()])
    c.speak("నమస్తే", language, c.settings.tts_speaker_for(language), 1.0)
    body = json.loads(seen[0].content)
    assert body["model"] == "bulbul:v4-flash"
    assert body["speaker"] == speaker
    assert body["language_code"] == language
    assert seen[0].headers["api-subscription-key"] == "sk_test_dummy"
    assert str(seen[0].url) == "https://api.sarvam.ai/text-to-speech"


def test_stt_request_uses_saaras_v4_transcribe_mode(sleeps):
    ok = httpx.Response(
        200,
        json={
            "request_id": "r",
            "transcript": " రమేష్ ",
            "language_code": "te-IN",
            "language_probability": 0.9,
        },
    )
    c, seen = make_client([ok])
    t = c.transcribe(b"RIFF" + b"\0" * 200, "a.wav", "audio/wav", None)
    assert t.transcript == "రమేష్" and t.language_code == "te-IN"
    form = seen[0].content.decode("utf8", "replace")
    assert 'name="model"\r\n\r\nsaaras:v4' in form and 'name="mode"\r\n\r\ntranscribe' in form
    assert 'name="language_code"' not in form  # omitted -> provider auto-detects
