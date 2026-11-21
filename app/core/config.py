from __future__ import annotations

import functools
from pathlib import Path
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_ROOT / ".env", extra="ignore")

    APP_NAME: str = "KAIRA"
    APP_ENV: str = "development"
    DEBUG: bool = False
    API_V1_PREFIX: str = "/api/v1"
    CORS_ORIGINS: Annotated[list[str], NoDecode] = ["http://localhost:3000"]
    DEFAULT_CURRENCY: str = "INR"
    DEFAULT_TIMEZONE: str = "Asia/Kolkata"

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
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


@functools.lru_cache
def get_settings() -> Settings:
    return Settings()
