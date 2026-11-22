"""Central, validated application configuration.

Every supported environment variable is declared here and documented in
``.env.example`` and the README ("Environment variables"). Startup fails with a readable
explanation when a setting required for security or core operation is missing.
Optional voice/AI settings never prevent the API from starting.
"""

from __future__ import annotations

import functools
import logging
import re
import secrets
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import PrivateAttr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Resolves to the backend/ folder (two levels up); used to locate .env and Alembic files.
BACKEND_ROOT = Path(__file__).resolve().parents[2]
logger = logging.getLogger(__name__)

# Dev-only fallback when DATABASE_URL is unset. Staging/production require an explicit URL.
DEV_DATABASE_URL = "postgresql+psycopg://kaira:kaira_dev_password@127.0.0.1:5432/kaira"
SECURE_ENVS = {"staging", "production"}
# Speaker-name format per Bulbul model (pattern, example). Models not listed are not checked.
TTS_SPEAKER_FORMATS = {
    "bulbul:v3": (r"[a-z]+", "shubh"),
    "bulbul:v4-flash": (r"[a-z]+_[a-z]+_[a-z_]+", "aparna_hi_customer"),
}


class ConfigurationError(RuntimeError):
    """Raised when the environment is not configured safely enough to start."""


# Pydantic settings model: each field is read from the environment or backend/.env by name.
# Defaults here are the values used when nothing is set.
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_ROOT / ".env", extra="ignore")
    # Not an env var. True when JWT_SECRET_KEY was generated at startup; get_settings logs it.
    _ephemeral_secret: bool = PrivateAttr(default=False)

    # --- application -----------------------------------------------------------------
    APP_NAME: str = "KAIRA"
    APP_ENV: Literal["development", "test", "staging", "production"] = "development"
    DEBUG: bool = False
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: Literal["json", "text"] = "json"
    API_V1_PREFIX: str = "/api/v1"
    RUN_MIGRATIONS_ON_START: bool = False

    # --- database --------------------------------------------------------------------
    DATABASE_URL: str | None = None
    DATABASE_POOL_SIZE: int = 5
    DATABASE_MAX_OVERFLOW: int = 10
    DATABASE_POOL_TIMEOUT: int = 30

    # --- business defaults -------------------------------------------------------------
    DEFAULT_CURRENCY: str = "INR"
    DEFAULT_TIMEZONE: str = "Asia/Kolkata"
    DEFAULT_OVERDUE_COLLECTION_DELAY_DAYS: int = 30

    # --- authentication ----------------------------------------------------------------
    JWT_SECRET_KEY: str | None = None
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    COOKIE_SECURE: bool = False
    COOKIE_SAMESITE: Literal["lax", "strict", "none"] = "lax"
    COOKIE_DOMAIN: str | None = None

    # --- CORS --------------------------------------------------------------------------
    FRONTEND_ORIGIN: str = "http://localhost:3000"
    # NoDecode stops pydantic-settings from parsing this value as JSON; _split_origins handles
    # comma-separated text instead.
    CORS_ORIGINS: Annotated[list[str], NoDecode] = ["http://localhost:3000"]

    # --- request protection -------------------------------------------------------------
    MAX_REQUEST_BYTES: int = 1_000_000
    MAX_AUDIO_UPLOAD_BYTES: int = 5_000_000
    RATE_LIMIT_LOGIN_PER_MINUTE: int = 10
    RATE_LIMIT_AI_PER_MINUTE: int = 30
    # Per user: payment-attempt register/execute/cancel and action approval. Generous; it stops runaway
    # clients and scripted abuse, not normal use.
    RATE_LIMIT_PAYMENT_PER_MINUTE: int = 60
    # postgres: counters shared by all workers/containers. memory: per-process, single-worker only.
    RATE_LIMIT_BACKEND: Literal["postgres", "memory"] = "postgres"

    # --- Sarvam AI ------------------------------------------------------------------------
    SARVAM_API_KEY: str | None = None
    SARVAM_BASE_URL: str = "https://api.sarvam.ai"
    SARVAM_STT_MODEL: str = "saaras:v4"
    SARVAM_STT_MODE: str = "transcribe"
    SARVAM_LLM_MODEL: str = "sarvam-105b"
    SARVAM_LLM_REASONING_EFFORT: str | None = "low"
    SARVAM_LLM_MAX_TOKENS: int = 4096
    # bulbul:v4-flash persona IDs, each checked against Sarvam's voice catalog (2026-11-22). Hindi and
    # English are the docs' rank-1 customer-care picks; Telugu has four voices and no ranking, so the
    # conversational one was chosen. Not yet auditioned live: change them in .env after listening.
    SARVAM_TTS_MODEL: str = "bulbul:v4-flash"
    SARVAM_TTS_SPEAKER_TE: str = "kavitha_te_conversation"
    SARVAM_TTS_SPEAKER_HI: str = "aparna_hi_customer"
    SARVAM_TTS_SPEAKER_EN: str = "aparna_en_companion"
    SARVAM_TTS_PACE: Decimal = Decimal("1.0")
    SARVAM_TTS_SAMPLE_RATE: int = 22050
    SARVAM_TTS_CODEC: str = "wav"
    SARVAM_TIMEOUT_SECONDS: float = 60.0
    SARVAM_MAX_RETRIES: int = 2
    # auto: Sarvam LLM when SARVAM_API_KEY is set, otherwise deterministic rules.
    AI_EXTRACTION_PROVIDER: Literal["auto", "sarvam", "rules"] = "auto"

    # --- live voice agent -------------------------------------------------------------------
    # Realtime STT (wss .../speech-to-text-realtime/ws) and streaming TTS (wss .../text-to-speech/ws),
    # verified against docs.sarvam.ai on 2026-11-22. The WebSocket base is derived from SARVAM_BASE_URL.
    AGENT_STT_LANGUAGE: str = "auto"  # auto-detect; te-IN / hi-IN / en-IN pin one language
    AGENT_STT_STREAM_TYPE: Literal["fast", "balanced"] = "fast"
    AGENT_VAD_THRESHOLD: float = 0.3
    AGENT_VAD_SILENCE_MS: int = 900
    AGENT_VAD_PREFIX_PADDING_MS: int = 300
    AGENT_VAD_MIN_SPEECH_MS: int = 250
    AGENT_TTS_SAMPLE_RATE: int = 22050  # linear16 PCM to the browser (8000/16000/22050/24000)
    AGENT_MAX_TOOL_STEPS: int = 6
    AGENT_TURN_TIMEOUT_SECONDS: float = 60.0
    AGENT_HISTORY_MESSAGES: int = 16
    AGENT_TICKET_TTL_SECONDS: int = 60
    AGENT_MAX_SESSION_MINUTES: int = 120
    # auto: clear, complete, owner-issued instructions execute without a confirmation step;
    # confirm: every write waits for a spoken/typed "yes". Staff writes always wait for the owner.
    AGENT_AUTONOMY: Literal["auto", "confirm"] = "auto"
    # Where browsers open the live WebSocket. Next.js route handlers cannot proxy WebSockets, so the
    # browser connects to the backend directly with a short-lived single-use ticket (no cookies needed).
    AGENT_PUBLIC_WS_URL: str = "ws://127.0.0.1:8000/api/v1/agent/live"

    # --- demo seed ---------------------------------------------------------------------
    DEMO_OWNER_EMAIL: str = "demo@kaira.local"
    DEMO_OWNER_PASSWORD: str | None = None

    # ----------------------------------------------------------------------------------
    # Field validators run while Settings() is constructed. A failed check is raised as a
    # pydantic ValidationError, so startup stops with the message.
    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip().rstrip("/") for item in value.split(",") if item.strip()]
        return value

    @field_validator("DEFAULT_CURRENCY")
    @classmethod
    def _validate_currency(cls, value: str) -> str:
        if len(value) != 3 or not value.isascii() or not value.isalpha() or not value.isupper():
            raise ValueError("DEFAULT_CURRENCY must be a 3-letter uppercase ISO code")
        return value

    @field_validator("DEFAULT_TIMEZONE")
    @classmethod
    def _validate_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except Exception as exc:
            raise ValueError(f"DEFAULT_TIMEZONE is not a valid IANA timezone: {value}") from exc
        return value

    @field_validator("SARVAM_TTS_PACE")
    @classmethod
    def _validate_pace(cls, value: Decimal) -> Decimal:
        if not Decimal("0.5") <= value <= Decimal("2.0"):
            raise ValueError("SARVAM_TTS_PACE must be between 0.5 and 2.0 (Sarvam limit)")
        return value

    @field_validator(
        "JWT_SECRET_KEY",
        "SARVAM_API_KEY",
        "DATABASE_URL",
        "DEMO_OWNER_PASSWORD",
        "COOKIE_DOMAIN",
        mode="before",
    )
    @classmethod
    def _blank_to_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    # Cross-field rules run after all fields are parsed. In staging/production every problem is
    # collected and raised together, so the operator sees the full list at once.
    @model_validator(mode="after")
    def _apply_environment_rules(self) -> Settings:
        problems: list[str] = []
        secure = self.APP_ENV in SECURE_ENVS

        if self.DATABASE_URL is None:
            if secure:
                problems.append(
                    "DATABASE_URL is required. It is the PostgreSQL connection string, e.g. "
                    "postgresql+psycopg://USER:PASSWORD@HOST:5432/DBNAME. Set it in .env."
                )
            else:
                self.DATABASE_URL = DEV_DATABASE_URL

        if self.JWT_SECRET_KEY is None:
            if secure:
                problems.append(
                    "JWT_SECRET_KEY is required. It signs login sessions. Generate one with: "
                    'python -c "import secrets; print(secrets.token_urlsafe(48))"'
                )
            else:
                # Ephemeral development secret: sessions end when the process restarts.
                self.JWT_SECRET_KEY = secrets.token_urlsafe(48)
                self._ephemeral_secret = True
        elif secure and len(self.JWT_SECRET_KEY) < 32:
            problems.append("JWT_SECRET_KEY must be at least 32 characters in staging/production.")

        if secure and not self.COOKIE_SECURE:
            problems.append(
                "COOKIE_SECURE must be true in staging/production so session cookies are only "
                "sent over HTTPS."
            )
        if self.COOKIE_SAMESITE == "none" and not self.COOKIE_SECURE:
            problems.append("COOKIE_SAMESITE=none requires COOKIE_SECURE=true (browser rule).")
        if secure and "kaira_dev_password" in (self.DATABASE_URL or ""):
            problems.append("DATABASE_URL uses the development password. Supply real production credentials.")

        # Sarvam rejects (400) a speaker that does not belong to the requested model. v3 speakers are
        # plain names ("shubh"); v4-flash personas are <name>_<language>_<style> ("aparna_hi_customer").
        # Catching a mismatch here beats discovering it on the first spoken reply.
        speaker_format = TTS_SPEAKER_FORMATS.get(self.SARVAM_TTS_MODEL)
        if speaker_format is not None:
            pattern, example = speaker_format
            for name in ("SARVAM_TTS_SPEAKER_TE", "SARVAM_TTS_SPEAKER_HI", "SARVAM_TTS_SPEAKER_EN"):
                if not re.fullmatch(pattern, getattr(self, name)):
                    problems.append(
                        f"{name}={getattr(self, name)!r} is not a {self.SARVAM_TTS_MODEL} speaker "
                        f"(expected a name like {example!r}). A speaker must belong to SARVAM_TTS_MODEL."
                    )

        if problems:
            raise ConfigurationError("KAIRA configuration is invalid:\n  - " + "\n  - ".join(problems))
        return self

    # ----------------------------------------------------------------------------------
    @property
    def is_production_like(self) -> bool:
        return self.APP_ENV in SECURE_ENVS

    @property
    def sarvam_configured(self) -> bool:
        return bool(self.SARVAM_API_KEY)

    @property
    # "auto" is resolved from whether SARVAM_API_KEY is set. No network check is made.
    def extraction_provider(self) -> str:
        if self.AI_EXTRACTION_PROVIDER == "auto":
            return "sarvam" if self.sarvam_configured else "rules"
        return self.AI_EXTRACTION_PROVIDER

    # Speaker is picked by language prefix (te, hi). Any other language, including en, uses the
    # English speaker.
    def tts_speaker_for(self, language_code: str) -> str:
        prefix = language_code.split("-")[0].lower()
        return {
            "te": self.SARVAM_TTS_SPEAKER_TE,
            "hi": self.SARVAM_TTS_SPEAKER_HI,
        }.get(prefix, self.SARVAM_TTS_SPEAKER_EN)


# Cached per process. Changing environment variables after the first call has no effect until
# get_settings.cache_clear() is called.
@functools.lru_cache
def get_settings() -> Settings:
    settings = Settings()
    # Logged once per process. The secret value itself is never logged.
    if getattr(settings, "_ephemeral_secret", False):
        logger.warning(
            "JWT_SECRET_KEY is not set; using an ephemeral development secret. "
            "Run scripts/setup to generate a persistent one."
        )
    return settings
