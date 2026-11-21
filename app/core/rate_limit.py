"""Rate limiters.

`PostgresRateLimiter` (default, RATE_LIMIT_BACKEND=postgres) keeps counters in PostgreSQL, so every
uvicorn worker and every API container shares one budget per key. The image runs 2 workers by default,
so a per-process limiter would silently allow 2x the configured limit (more with more containers).

`RateLimiter` (RATE_LIMIT_BACKEND=memory) is the original in-process limiter. It is only correct for a
single worker in a single process; see docs/SECURITY.md."""

from __future__ import annotations

import math
import random
import threading
import time
from collections import defaultdict, deque

from sqlalchemy import Engine, text

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


# Upserts the hit into the current fixed window and returns it with the previous window's count and the
# elapsed fraction of the current window, all from the database clock (workers on different hosts agree).
_HIT_SQL = text(
    """
    WITH w AS (
        SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp()) / :win) * :win) AS cur,
               extract(epoch FROM clock_timestamp()) AS now_s
    ), up AS (
        INSERT INTO rate_limit_buckets (key, window_start, hits)
        SELECT :key, w.cur, 1 FROM w
        ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limit_buckets.hits + 1
        RETURNING hits
    )
    SELECT (SELECT hits FROM up) AS cur_hits,
           COALESCE((SELECT b.hits FROM rate_limit_buckets b, w
                     WHERE b.key = :key AND b.window_start = w.cur - make_interval(secs => :win)), 0) AS prev_hits,
           (SELECT (now_s - extract(epoch FROM cur)) / :win FROM w) AS elapsed
    """
)
_CLEANUP_SQL = text(
    "DELETE FROM rate_limit_buckets WHERE window_start < clock_timestamp() - interval '1 hour'"
)


class PostgresRateLimiter:
    """Shared sliding-window limiter (two fixed windows, previous one weighted by the unexpired part).

    Each check is its own short autocommit transaction, independent of the request's transaction, so a
    request that later fails or rolls back still counts. Old buckets are pruned opportunistically."""

    def __init__(self, engine: Engine, cleanup_probability: float = 0.01) -> None:
        self._engine = engine
        self._cleanup_probability = cleanup_probability

    def check(self, key: str, limit: int, window_seconds: float = 60.0) -> None:
        if limit <= 0:
            return
        with self._engine.begin() as conn:
            row = conn.execute(_HIT_SQL, {"key": key, "win": window_seconds}).one()
            if random.random() < self._cleanup_probability:
                conn.execute(_CLEANUP_SQL)
        elapsed = min(max(float(row.elapsed), 0.0), 1.0)
        estimated = row.cur_hits + row.prev_hits * (1.0 - elapsed)
        if estimated > limit:
            raise RateLimitedError(retry_after=max(1, math.ceil(window_seconds * (1.0 - elapsed))))

    def reset(self) -> None:
        with self._engine.begin() as conn:
            conn.execute(text("DELETE FROM rate_limit_buckets"))
