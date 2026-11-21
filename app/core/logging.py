"""Structured logging with request correlation IDs. Secrets are never logged."""

from __future__ import annotations

import contextvars
import json
import logging
from datetime import UTC, datetime

# Per-request correlation ID. middleware.RequestContextMiddleware sets and resets it;
# the filter below copies it onto each log record.
request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)

_TEXT_FORMAT = "%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"


# Adds request_id to every record, including those logged outside a request ('-' if unset).
class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get() or "-"
        return True


# One JSON object per line. Only method, path, status and duration_ms are copied from extra=;
# any other extra fields are dropped.
class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", None),
        }
        for key in ("method", "path", "status", "duration_ms"):
            if hasattr(record, key):
                entry[key] = getattr(record, key)
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


# Idempotent: replaces only handlers previously marked with _kaira. Sets the root logger level,
# so it affects every logger in the process.
def configure_logging(level: str = "INFO", fmt: str = "json") -> None:
    root = logging.getLogger()
    root.setLevel(level.upper())
    for handler in list(root.handlers):
        if getattr(handler, "_kaira", False):
            root.removeHandler(handler)
    handler = logging.StreamHandler()
    handler.addFilter(_RequestIdFilter())
    handler.setFormatter(_JsonFormatter() if fmt == "json" else logging.Formatter(_TEXT_FORMAT))
    handler._kaira = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    # httpx logs full URLs at INFO; keep provider traffic quiet.
    logging.getLogger("httpx").setLevel(logging.WARNING)
