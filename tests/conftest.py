"""Test fixtures. Tests run against a real PostgreSQL database (``kaira_test``).

TEST_DATABASE_URL overrides the default (DATABASE_URL with the database renamed to
kaira_test). The schema is rebuilt from Alembic migrations once per session, and every
table is truncated before each test. A safety check refuses any database whose name does
not end in ``_test``."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import hash_password
from app.db.base import Base
from app.main import create_app
from app.models import Business, User
from app.utils.dates import business_today

TEST_PASSWORD = "correct-horse-battery"


def today() -> date:
    """Business-local today (Asia/Kolkata), independent of the machine timezone."""
    return business_today("Asia/Kolkata")


def _test_db_url() -> str:
    explicit = os.environ.get("TEST_DATABASE_URL")
    if explicit:
        return explicit
    base = Settings(_env_file=None, DATABASE_URL=os.environ.get("DATABASE_URL") or None).DATABASE_URL
    return make_url(base).set(database="kaira_test").render_as_string(hide_password=False)


@pytest.fixture(scope="session")
def database_url() -> str:
    url = _test_db_url()
    name = make_url(url).database or ""
    if not name.endswith("_test"):
        raise RuntimeError(f"Refusing to run tests against non-test database '{name}'.")
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()
    from app.db.migrations import upgrade_to_head

    upgrade_to_head(url)
    return url


@pytest.fixture
def settings(database_url: str) -> Settings:
    return Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL=database_url,
        JWT_SECRET_KEY="test-secret-key-that-is-long-enough-for-hs256",
        LOG_LEVEL="WARNING",
        LOG_FORMAT="text",
        RATE_LIMIT_LOGIN_PER_MINUTE=1000,
        RATE_LIMIT_AI_PER_MINUTE=1000,
        RATE_LIMIT_PAYMENT_PER_MINUTE=1000,
        AI_EXTRACTION_PROVIDER="rules",
        SARVAM_API_KEY=None,
        SARVAM_MAX_RETRIES=0,
    )


@pytest.fixture
def app(settings: Settings):
    application = create_app(settings)
    tables = ", ".join(t.name for t in reversed(Base.metadata.sorted_tables))
    with application.state.engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    yield application
    application.state.engine.dispose()


@pytest.fixture
def client(app) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(app) -> Iterator[Session]:
    session = app.state.session_factory()
    yield session
    session.close()


def make_business(
    db: Session, *, name="Test Traders", email=None, role="owner", opening="50000.00", threshold="0.00"
) -> tuple[Business, User]:
    today = business_today("Asia/Kolkata")
    business = Business(
        name=name,
        currency="INR",
        timezone="Asia/Kolkata",
        opening_cash_balance=Decimal(opening),
        opening_cash_as_of=today - timedelta(days=30),
        overdue_collection_delay_days=30,
        low_cash_threshold=Decimal(threshold),
    )
    db.add(business)
    db.flush()
    user = User(
        business_id=business.id,
        name=f"{name} {role}",
        email=email or f"{uuid.uuid4().hex[:8]}@example.com",
        password_hash=hash_password(TEST_PASSWORD),
        role=role,
    )
    db.add(user)
    db.commit()
    return business, user


def add_user(db: Session, business: Business, role: str = "staff") -> User:
    user = User(
        business_id=business.id,
        name=f"{role} user",
        email=f"{uuid.uuid4().hex[:8]}@example.com",
        password_hash=hash_password(TEST_PASSWORD),
        role=role,
    )
    db.add(user)
    db.commit()
    return user


class Api:
    """Logged-in browser-like client: cookies + CSRF header, envelope-aware helpers."""

    def __init__(self, client: TestClient, email: str, prefix: str = "/api/v1") -> None:
        self.client = client
        self.prefix = prefix
        r = client.post(f"{prefix}/auth/login", json={"email": email, "password": TEST_PASSWORD})
        assert r.status_code == 200, r.text
        self.session = r.json()["data"]
        self.csrf = self.session["csrf_token"]

    def _h(self, extra=None):
        h = {"X-CSRF-Token": self.csrf}
        h.update(extra or {})
        return h

    def get(self, path, **kw):
        return self.client.get(self.prefix + path, **kw)

    def post(self, path, json=None, headers=None, **kw):
        return self.client.post(self.prefix + path, json=json, headers=self._h(headers), **kw)

    def patch(self, path, json=None, headers=None):
        return self.client.patch(self.prefix + path, json=json, headers=self._h(headers))

    def data(self, response, status=200):
        assert response.status_code == status, response.text
        body = response.json()
        assert body["success"] is True and body["error"] is None
        return body["data"]

    # convenience builders
    def customer(self, name="Ramesh Kumar", **extra):
        return self.data(self.post("/customers", {"name": name, **extra}), 201)

    def invoice(self, customer_id, amount="10000.00", *, invoice_date=None, due_date=None, items=None):
        today_ = today()
        body = {
            "customer_id": customer_id,
            "items": items or [{"description": "Goods", "quantity": "1", "unit_price": amount}],
            "invoice_date": (invoice_date or today_ - timedelta(days=1)).isoformat(),
            "due_date": (due_date or today_ + timedelta(days=14)).isoformat(),
        }
        return self.data(self.post("/invoices", body), 201)

    def pay(self, invoice_id, amount, headers=None, status=201):
        r = self.post(
            f"/invoices/{invoice_id}/payments", {"amount": amount, "payment_method": "upi"}, headers
        )
        return self.data(r, status) if status in (200, 201) else r


@pytest.fixture
def owner(db, client) -> Api:
    business, user = make_business(db)
    api = Api(client, user.email)
    api.business, api.user = business, user
    return api
