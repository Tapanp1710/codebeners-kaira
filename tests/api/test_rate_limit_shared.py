"""Shared (PostgreSQL) rate limiting: one budget per key across app instances and OS processes."""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app.core.exceptions import RateLimitedError
from app.core.rate_limit import PostgresRateLimiter
from app.main import create_app
from tests.conftest import TEST_PASSWORD

ROOT = Path(__file__).resolve().parents[2]


def test_limit_is_enforced_with_retry_after(app):
    limiter = PostgresRateLimiter(app.state.engine)
    for _ in range(3):
        limiter.check("t:basic", 3)
    with pytest.raises(RateLimitedError) as exc:
        limiter.check("t:basic", 3)
    assert exc.value.details["retry_after_seconds"] >= 1
    limiter.check("t:other-key", 3)  # keys are independent


def test_two_engines_share_one_budget(app, database_url):
    """Two app instances (separate engines/connection pools), like two uvicorn workers."""
    other_engine = create_engine(database_url)
    try:
        a, b = PostgresRateLimiter(app.state.engine), PostgresRateLimiter(other_engine)
        accepted = 0
        for i in range(10):
            try:
                (a if i % 2 else b).check("t:shared", 5)
                accepted += 1
            except RateLimitedError:
                pass
        assert accepted == 5
    finally:
        other_engine.dispose()


WORKER = textwrap.dedent(
    """
    import sys
    from sqlalchemy import create_engine
    from app.core.exceptions import RateLimitedError
    from app.core.rate_limit import PostgresRateLimiter

    engine = create_engine(sys.argv[1])
    limiter = PostgresRateLimiter(engine, cleanup_probability=0)
    ok = 0
    for _ in range(int(sys.argv[2])):
        try:
            limiter.check("t:processes", int(sys.argv[3]), window_seconds=3600)
            ok += 1
        except RateLimitedError:
            pass
    print(ok)
    """
)


def test_limit_holds_across_os_processes(app, database_url):
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", WORKER, database_url, "12", "15"],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(3)
    ]
    accepted = []
    for p in procs:
        out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err
        accepted.append(int(out.strip()))
    # 36 attempts from three processes against a budget of 15: exactly 15 get through in total.
    assert sum(accepted) == 15, accepted


def test_login_limit_is_shared_between_workers(settings, db, owner):
    """Two app instances stand in for two uvicorn workers serving the same deployment."""
    s = settings.model_copy(update={"RATE_LIMIT_LOGIN_PER_MINUTE": 4})
    w1, w2 = create_app(s), create_app(s)
    try:
        with TestClient(w1) as c1, TestClient(w2) as c2:
            codes = []
            for i in range(8):
                c = c1 if i % 2 else c2
                r = c.post(
                    "/api/v1/auth/login", json={"email": owner.user.email, "password": "wrong-password"}
                )
                codes.append(r.status_code)
            # The `owner` fixture's own login (through a third app instance) already used 1 of the 4.
            # Per-process limiters would have allowed 4 more per worker; the shared budget allows 3.
            assert codes == [401, 401, 401] + [429] * 5, codes
            r = c1.post("/api/v1/auth/login", json={"email": owner.user.email, "password": TEST_PASSWORD})
            assert r.status_code == 429
    finally:
        w1.state.engine.dispose()
        w2.state.engine.dispose()


def test_payment_attempt_writes_are_rate_limited_per_user(settings, db, owner):
    s = settings.model_copy(update={"RATE_LIMIT_PAYMENT_PER_MINUTE": 3})
    w = create_app(s)
    try:
        with TestClient(w) as c:
            from tests.conftest import Api

            api = Api(c, owner.user.email)
            inv = api.invoice(api.customer()["id"], "1000.00")
            body = {"resource_type": "invoice", "resource_id": inv["id"], "amount": "10.00"}
            codes = [api.post("/payment-attempts", body).status_code for _ in range(4)]
            assert codes == [201, 200, 200, 429], codes
            r = api.post("/payment-attempts", body)
            assert r.status_code == 429 and r.headers.get("retry-after")
    finally:
        w.state.engine.dispose()
