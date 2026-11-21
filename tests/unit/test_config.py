import pytest

from app.core.config import ConfigurationError, Settings


def make(**kw) -> Settings:
    return Settings(_env_file=None, **kw)


def test_defaults() -> None:
    s = make()
    assert s.APP_NAME == "KAIRA"
    assert s.APP_ENV == "development"
    assert s.API_V1_PREFIX == "/api/v1"
    assert s.DEFAULT_CURRENCY == "INR"
    assert s.DEFAULT_TIMEZONE == "Asia/Kolkata"
    assert "http://localhost:3000" in s.CORS_ORIGINS
    assert s.SARVAM_STT_MODEL == "saaras:v4"
    assert s.SARVAM_TTS_MODEL == "bulbul:v3"
    assert s.extraction_provider == "rules"


def test_development_generates_ephemeral_secret_and_local_database() -> None:
    s = make()
    assert s.JWT_SECRET_KEY and len(s.JWT_SECRET_KEY) >= 32
    assert "127.0.0.1:5432/kaira" in s.DATABASE_URL


def test_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_NAME", "TestKaira")
    monkeypatch.setenv("DEFAULT_TIMEZONE", "UTC")
    monkeypatch.setenv("CORS_ORIGINS", "http://a.test, http://b.test/,")
    s = make()
    assert s.APP_NAME == "TestKaira"
    assert s.DEFAULT_TIMEZONE == "UTC"
    assert s.CORS_ORIGINS == ["http://a.test", "http://b.test"]


def test_invalid_timezone_and_currency_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValueError):
        make(DEFAULT_TIMEZONE="Not/AZone")
    with pytest.raises(ValueError):
        make(DEFAULT_CURRENCY="rupees")


def test_production_requires_secrets_and_secure_cookies() -> None:
    with pytest.raises(ConfigurationError) as exc:
        make(APP_ENV="production")
    message = str(exc.value)
    assert "DATABASE_URL is required" in message
    assert "JWT_SECRET_KEY is required" in message
    assert "COOKIE_SECURE" in message


def test_production_rejects_weak_secret_and_dev_password() -> None:
    with pytest.raises(ConfigurationError) as exc:
        make(
            APP_ENV="production",
            JWT_SECRET_KEY="short",
            COOKIE_SECURE=True,
            DATABASE_URL="postgresql+psycopg://kaira:kaira_dev_password@db/kaira",
        )
    assert "at least 32" in str(exc.value)
    assert "development password" in str(exc.value)


def test_production_valid_configuration() -> None:
    s = make(
        APP_ENV="production",
        JWT_SECRET_KEY="x" * 48,
        COOKIE_SECURE=True,
        COOKIE_SAMESITE="none",
        DATABASE_URL="postgresql+psycopg://u:strong@host/db",
        SARVAM_API_KEY="sk_live",
    )
    assert s.is_production_like
    assert s.extraction_provider == "sarvam"


def test_samesite_none_requires_secure() -> None:
    with pytest.raises(ConfigurationError):
        make(COOKIE_SAMESITE="none")


def test_tts_speaker_selection() -> None:
    s = make(SARVAM_TTS_SPEAKER_TE="kavya", SARVAM_TTS_SPEAKER_HI="priya")
    assert s.tts_speaker_for("te-IN") == "kavya"
    assert s.tts_speaker_for("hi-IN") == "priya"
    assert s.tts_speaker_for("en-IN") == "shubh"
