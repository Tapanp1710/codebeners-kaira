"""Small in-process sliding-window rate limiter.

Sufficient for a single-instance modular monolith. When the API is scaled horizontally,
put a shared limiter (reverse proxy / gateway) in front; see docs/SECURITY.md."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from app.core.exceptions import RateLimitedError


# Keyed sliding window: each key holds a deque of monotonic timestamps.
# State is in memory only, so a restart resets all counters.
class RateLimiter:
    def __init__(self) -> None:
        # Keys are never removed from this dict, so memory grows with the number of distinct keys.
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window_seconds: float = 60.0) -> None:
        if limit <= 0:
            return
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                # Seconds until the oldest hit leaves the window. Minimum 1, so Retry-After is never 0.
                retry = max(1, int(window_seconds - (now - hits[0])))
                raise RateLimitedError(retry_after=retry)
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
