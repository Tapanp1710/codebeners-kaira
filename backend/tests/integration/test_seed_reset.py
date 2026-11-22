"""Demo seed reproducibility: idempotent re-runs, and a development-only reset that re-anchors dates."""

from __future__ import annotations

import argparse
import types
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app import cli, seed
from app.models import (
    AuditLog,
    Bill,
    Business,
    CashTransaction,
    Customer,
    Invoice,
    Payment,
    PaymentCommitment,
    User,
)
from tests.conftest import TEST_PASSWORD, make_business, today

EMAIL = "demo@kaira.local"
MODELS = (Business, User, Customer, Invoice, Payment, PaymentCommitment, Bill, CashTransaction, AuditLog)


def snapshot(db):
    db.expire_all()
    return tuple(db.scalar(select(func.count()).select_from(m)) for m in MODELS)


def ramesh_dates(db):
    inv = db.scalar(select(Invoice).where(Invoice.notes == "[seed:ramesh-1]"))
    commit = db.scalar(select(PaymentCommitment).where(PaymentCommitment.notes == "[seed:ramesh-commit]"))
    return inv.due_date, commit.expected_payment_date


def test_seed_is_repeatable(db):
    seed.seed_demo(db, owner_email=EMAIL, owner_password=TEST_PASSWORD)
    db.commit()
    first = snapshot(db)
    for _ in range(3):
        seed.seed_demo(db, owner_email=EMAIL, owner_password=TEST_PASSWORD)
        db.commit()
        assert snapshot(db) == first


def test_reset_reanchors_dates_and_touches_nothing_else(db, monkeypatch):
    other, _ = make_business(db, name="Real Customer Co")
    # A seed made ten days ago: its scenario dates have drifted.
    monkeypatch.setattr(seed, "business_today", lambda tz: today() - timedelta(days=10))
    seed.seed_demo(db, owner_email=EMAIL, owner_password=TEST_PASSWORD)
    db.commit()
    assert ramesh_dates(db) == (today(), today() - timedelta(days=5))  # "due in 10 days" is due today
    fresh_counts = snapshot(db)
    monkeypatch.undo()

    assert seed.reset_demo(db, owner_email=EMAIL) is True
    seed.seed_demo(db, owner_email=EMAIL, owner_password=TEST_PASSWORD)
    db.commit()
    assert ramesh_dates(db) == (today() + timedelta(days=10), today() + timedelta(days=5))
    assert snapshot(db) == fresh_counts
    assert db.get(Business, other.id) is not None
    # Still idempotent after a reset.
    seed.seed_demo(db, owner_email=EMAIL, owner_password=TEST_PASSWORD)
    db.commit()
    assert snapshot(db) == fresh_counts


def test_reset_without_demo_data_is_a_no_op(db):
    assert seed.reset_demo(db, owner_email=EMAIL) is False


def test_reset_refuses_a_non_demo_business(db):
    _, user = make_business(db, name="Real Customer Co", email="owner@real.example")
    with pytest.raises(ValueError):
        seed.reset_demo(db, owner_email="owner@real.example")


def test_cli_refuses_reset_in_production(monkeypatch, capsys):
    monkeypatch.setattr(cli, "_settings", lambda: types.SimpleNamespace(is_production_like=True))
    code = cli.cmd_seed(argparse.Namespace(force=True, reset=True))
    assert code == 2
    assert "Refusing to reset" in capsys.readouterr().err
