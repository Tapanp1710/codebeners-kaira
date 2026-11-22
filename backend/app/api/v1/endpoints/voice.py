from __future__ import annotations

import base64
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, Request, UploadFile

from app.core.exceptions import AppError, ValidationAppError
from app.db.dependencies import Auth, SettingsDep
from app.schemas.ai import SpeakRequest, SpeechOut, TranscriptionOut
from app.schemas.common import Envelope, ok

router = APIRouter(prefix="/voice", tags=["voice"])

# Magic-byte signatures for formats Sarvam's REST STT accepts.
_SIGNATURES = (
    (b"RIFF", "wav"),
    (b"ID3", "mp3"),
    (b"\xff\xfb", "mp3"),
    (b"\xff\xf3", "mp3"),
    (b"\xff\xf2", "mp3"),
    (b"OggS", "ogg"),
    (b"\x1a\x45\xdf\xa3", "webm"),
    (b"fLaC", "flac"),
    (b"FORM", "aiff"),
    (b"#!AMR", "amr"),
    (b"\xff\xf1", "aac"),
    (b"\xff\xf9", "aac"),
)
_CODEC_MIME = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "opus": "audio/ogg",
    "linear16": "audio/l16",
    "mulaw": "audio/basic",
    "alaw": "audio/basic",
}


def detect_audio(head: bytes) -> str | None:
    for sig, kind in _SIGNATURES:
        if head.startswith(sig):
            return kind
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "mp4"
    return None


@router.post(
    "/transcribe",
    response_model=Envelope[TranscriptionOut],
    summary="Speech-to-text via Sarvam Saaras (audio is not stored; max 30 s per Sarvam REST limit)",
)
async def transcribe(
    request: Request,
    ctx: Auth,
    settings: SettingsDep,
    file: Annotated[UploadFile, File(description="Recorded audio (webm/ogg/wav/mp3/m4a/flac)")],
    language_code: Annotated[
        Literal["te-IN", "hi-IN", "en-IN", "unknown"] | None,
        Form(description="Omit or 'unknown' to auto-detect"),
    ] = None,
):
    request.app.state.rate_limiter.check(f"ai:{ctx.user_id}", settings.RATE_LIMIT_AI_PER_MINUTE)
    audio = await file.read(settings.MAX_AUDIO_UPLOAD_BYTES + 1)
    if len(audio) > settings.MAX_AUDIO_UPLOAD_BYTES:
        raise AppError(
            "PAYLOAD_TOO_LARGE",
            "The audio file is too large.",
            413,
            {"limit_bytes": settings.MAX_AUDIO_UPLOAD_BYTES},
        )
    if len(audio) < 100:
        raise ValidationAppError("The audio recording is empty or too short.")
    kind = detect_audio(audio[:16])
    if kind is None:
        raise ValidationAppError("Unsupported audio format. Use WebM, Ogg, WAV, MP3, M4A or FLAC.")
    content_type = (file.content_type or "application/octet-stream").split(";")[0]
    client = request.app.state.sarvam
    from starlette.concurrency import run_in_threadpool

    result = await run_in_threadpool(
        client.transcribe,
        audio,
        file.filename or f"audio.{kind}",
        content_type,
        None if language_code in (None, "unknown") else language_code,
    )
    del audio
    return ok(
        TranscriptionOut(
            transcript=result.transcript,
            language_code=result.language_code,
            language_probability=result.language_probability,
            model=settings.SARVAM_STT_MODEL,
            request_id=result.request_id,
        )
    )


@router.post(
    "/speak",
    response_model=Envelope[SpeechOut],
    summary="Text-to-speech via Sarvam Bulbul; returns base64 audio",
)
def speak(body: SpeakRequest, request: Request, ctx: Auth, settings: SettingsDep):
    request.app.state.rate_limiter.check(f"ai:{ctx.user_id}", settings.RATE_LIMIT_AI_PER_MINUTE)
    speaker = body.speaker or settings.tts_speaker_for(body.language_code)
    pace = float(body.pace if body.pace is not None else settings.SARVAM_TTS_PACE)
    speech = request.app.state.sarvam.speak(body.text, body.language_code, speaker, pace)
    codec = settings.SARVAM_TTS_CODEC
    return ok(
        SpeechOut(
            audio_base64=base64.b64encode(speech.audio).decode("ascii"),
            mime_type=_CODEC_MIME.get(codec, "application/octet-stream"),
            codec=codec,
            sample_rate=settings.SARVAM_TTS_SAMPLE_RATE,
            model=settings.SARVAM_TTS_MODEL,
            speaker=speaker,
            language_code=body.language_code,
            request_id=speech.request_id,
        )
    )
