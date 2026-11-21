import pytest

from app.core.config import Settings


def make() -> Settings:
    return Settings(_env_file=None)


def test_default_app_name() -> None:
    assert make().APP_NAME == "KAIRA"


def test_default_environment() -> None:
    assert make().APP_ENV == "development"


def test_default_api_prefix() -> None:
    assert make().API_V1_PREFIX == "/api/v1"


def test_default_currency_is_inr() -> None:
    assert make().DEFAULT_CURRENCY == "INR"


def test_default_timezone_is_kolkata() -> None:
    assert make().DEFAULT_TIMEZONE == "Asia/Kolkata"


def test_default_cors_allows_frontend_dev_origin() -> None:
    assert "http://localhost:3000" in make().CORS_ORIGINS


def test_env_overrides_app_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_NAME", "TestKaira")
    assert make().APP_NAME == "TestKaira"


def test_env_overrides_api_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_V1_PREFIX", "/api/v2")
    assert make().API_V1_PREFIX == "/api/v2"


def test_env_overrides_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEFAULT_TIMEZONE", "UTC")
    assert make().DEFAULT_TIMEZONE == "UTC"


def test_cors_origins_comma_separated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "http://a.test, http://b.test,")
    assert make().CORS_ORIGINS == ["http://a.test", "http://b.test"]


def test_invalid_timezone_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEFAULT_TIMEZONE", "Not/AZone")
    with pytest.raises(ValueError):
        make()


def test_invalid_currency_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEFAULT_CURRENCY", "rupees")
    with pytest.raises(ValueError):
        make()
