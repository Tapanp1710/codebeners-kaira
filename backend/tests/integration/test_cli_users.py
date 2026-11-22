"""`create-user`: operator-created accounts (no e-mail service, so no self-service invitations)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app import cli
from app.models import AuditLog, User
from tests.conftest import make_business


@pytest.fixture
def run(app, monkeypatch):
    monkeypatch.setattr(cli, "_session", app.state.session_factory)
    monkeypatch.setenv("KAIRA_USER_PASSWORD", "staff-password-123")
    return lambda *args: cli.main(["create-user", *args])


def test_creates_staff_in_the_owners_business_and_audits_it(run, db, client):
    business, owner = make_business(db)
    assert run("--owner-email", owner.email, "--email", "Staff@Example.com", "--name", "Counter Staff") == 0
    db.expire_all()
    staff = db.scalar(select(User).where(User.email == "staff@example.com"))
    assert staff.business_id == business.id and staff.role == "staff"
    assert db.scalar(
        select(AuditLog).where(AuditLog.action_type == "user.created", AuditLog.entity_id == staff.id)
    )
    # The new account can sign in with the password from KAIRA_USER_PASSWORD.
    r = client.post(
        "/api/v1/auth/login", json={"email": "staff@example.com", "password": "staff-password-123"}
    )
    assert r.status_code == 200 and r.json()["data"]["user"]["role"] == "staff"
    # Idempotent for the same business.
    assert run("--owner-email", owner.email, "--email", "staff@example.com", "--name", "x") == 0


def test_refuses_unknown_owner_other_business_and_short_password(run, db, monkeypatch):
    _, owner = make_business(db)
    _, other_owner = make_business(db, name="Other")
    assert run("--owner-email", "nobody@example.com", "--email", "a@example.com", "--name", "A") == 2
    # A staff e-mail cannot be used to pick the business.
    run("--owner-email", owner.email, "--email", "s1@example.com", "--name", "S1")
    assert run("--owner-email", "s1@example.com", "--email", "b@example.com", "--name", "B") == 2
    # An e-mail already used in another business is never moved.
    assert run("--owner-email", other_owner.email, "--email", "s1@example.com", "--name", "S1") == 2
    monkeypatch.setenv("KAIRA_USER_PASSWORD", "short")
    assert run("--owner-email", owner.email, "--email", "c@example.com", "--name", "C") == 2
