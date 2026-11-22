"""Structured logging with request correlation IDs. Secrets are never logged."""

from __future__ import annotations

import contextvars
import json
import logging
import re
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


# WebSocket tickets are bearer credentials carried in the query string (/agent/live?ticket=<jwt>), and uvicorn
# logs the full path with its query ('"WebSocket /api/v1/agent/live?ticket=..." [accepted]', access lines). This
# filter rewrites such records before any handler formats them.
_SECRET_QUERY = re.compile(r"((?:^|[?&;\s\"'])(?:ticket|token|access_token)=)[^&\s\"'#]+", re.IGNORECASE)
REDACTED = "[REDACTED]"
# Loggers that carry request paths: uvicorn's own loggers do not propagate to the root handler by default, so the
# filter is attached to them directly as well as to KAIRA's handler.
_PATH_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn")


def redact_secrets(text: str) -> str:
    return _SECRET_QUERY.sub(lambda m: m.group(1) + REDACTED, text)


def _redact_arg(value):
    if isinstance(value, str):
        return redact_secrets(value)
    if isinstance(value, tuple):
        return tuple(_redact_arg(v) for v in value)
    return value


class RedactSecretsFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_secrets(record.msg)
        if isinstance(record.args, tuple):
            # uvicorn's AccessFormatter unpacks args, so they are rewritten in place, never dropped.
            record.args = tuple(_redact_arg(a) for a in record.args)
        elif isinstance(record.args, dict):
            record.args = {k: _redact_arg(v) for k, v in record.args.items()}
        path = getattr(record, "path", None)
        if isinstance(path, str):
            record.path = redact_secrets(path)
        return True


def install_redaction() -> None:
    """Idempotent: attaches one RedactSecretsFilter to each uvicorn logger."""
    for name in _PATH_LOGGERS:
        lg = logging.getLogger(name)
        if not any(isinstance(f, RedactSecretsFilter) for f in lg.filters):
            lg.addFilter(RedactSecretsFilter())


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
    handler.addFilter(RedactSecretsFilter())
    handler.setFormatter(_JsonFormatter() if fmt == "json" else logging.Formatter(_TEXT_FORMAT))
    handler._kaira = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    install_redaction()
    # httpx logs full URLs at INFO; keep provider traffic quiet.
    logging.getLogger("httpx").setLevel(logging.WARNING)
