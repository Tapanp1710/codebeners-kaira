from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RateLimitBucket(Base):
    """Hit counter for one rate-limit key in one fixed window (app/core/rate_limit.py).

    Shared by every worker and container, so a limit means the same thing however the API is scaled.
    Rows older than an hour are pruned opportunistically; the table holds no business data."""

    __tablename__ = "rate_limit_buckets"

    key: Mapped[str] = mapped_column(String(400), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True, index=True)
    hits: Mapped[int] = mapped_column(Integer, default=0)
