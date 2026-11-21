from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo


def business_today(timezone: str) -> date:
    """Today's calendar date in the business's timezone (default Asia/Kolkata)."""
    return datetime.now(UTC).astimezone(ZoneInfo(timezone)).date()
