import pytest

from app.core.config import ConfigurationError, Settings


def make(**kw) -> Settings:
    return Settings(_env_file=None, **kw)


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests describe defaults and validation, so they must not see the runner's environment.

    CI sets APP_ENV, DATABASE_URL and JWT_SECRET_KEY at job level, which made the default and production
    tests fail there while passing locally. Every variable Settings reads is removed; tests that need one
    set it themselves (see test_env_overrides)."""
    for name in Settings.model_fields:
        monkeypatch.delenv(name, raising=False)


def test_defaults() -> None:
    s = make()
    assert s.APP_NAME == "KAIRA"
    assert s.APP_ENV == "development"
    assert s.API_V1_PREFIX == "/api/v1"
    assert s.DEFAULT_CURRENCY == "INR"
    assert s.DEFAULT_TIMEZONE == "Asia/Kolkata"
    assert "http://localhost:3000" in s.CORS_ORIGINS
    assert s.SARVAM_STT_MODEL == "saaras:v4"
    assert s.SARVAM_TTS_MODEL == "bulbul:v4-flash"
    assert s.tts_speaker_for("te-IN") == "kavitha_te_conversation"
    assert s.tts_speaker_for("hi-IN") == "aparna_hi_customer"
    assert s.tts_speaker_for("en-IN") == "aparna_en_companion"
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
    s = make(
        SARVAM_TTS_MODEL="bulbul:v3",
        SARVAM_TTS_SPEAKER_TE="kavya",
        SARVAM_TTS_SPEAKER_HI="priya",
        SARVAM_TTS_SPEAKER_EN="shubh",
    )
    assert s.tts_speaker_for("te-IN") == "kavya"
    assert s.tts_speaker_for("hi-IN") == "priya"
    assert s.tts_speaker_for("en-IN") == "shubh"


def test_tts_speaker_must_belong_to_model() -> None:
    # A v3 name with v4-flash (Sarvam would answer 400 on every spoken reply) stops startup instead.
    with pytest.raises(ConfigurationError) as exc:
        make(SARVAM_TTS_MODEL="bulbul:v4-flash", SARVAM_TTS_SPEAKER_HI="shubh")
    assert "SARVAM_TTS_SPEAKER_HI" in str(exc.value) and "bulbul:v4-flash" in str(exc.value)
    with pytest.raises(ConfigurationError) as exc:
        make(SARVAM_TTS_MODEL="bulbul:v3")  # the v4-flash default personas are not v3 speakers
    assert "SARVAM_TTS_SPEAKER_TE" in str(exc.value)
