"""JSON-safe snapshots of ORM rows for audit before/after data."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import inspect


def json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [json_safe(v) for v in value]
    return value


def snapshot(obj: Any, exclude: set[str] | None = None) -> dict[str, Any]:
    exclude = (exclude or set()) | {"password_hash"}
    mapper = inspect(obj).mapper
    return {
        attr.key: json_safe(getattr(obj, attr.key)) for attr in mapper.column_attrs if attr.key not in exclude
    }
