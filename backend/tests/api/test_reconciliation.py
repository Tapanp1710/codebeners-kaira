"""Payment-attempt execution leases and reconciliation (real PostgreSQL).

A "crash" is a session that does work and is rolled back or closed before COMMIT; a "crash between the
payment commit and the attempt update" is a payment committed under the attempt's key while the attempt row
is left pending (what a lost response or a dead process would leave behind if the two were not atomic, and
what a direct payment reusing the key does leave behind). "Restart" is a fresh OS process running the CLI.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text

from app.core.config import BACKEND_ROOT
from app.db.dependencies import AuthContext
from app.models import AuditLog, BillPayment, Business, CashTransaction, Payment, PaymentAttempt, User
from app.services import payment_attempt_service as pas
from app.services import payment_service
from tests.conftest import Api, make_business, today

OLD = timedelta(minutes=30)


# ------------------------------------------------------------------ helpers


def attempt_body(resource_type, resource_id, **over):
    b = {
        "resource_type": resource_type,
        "resource_id": resource_id,
        "amount": "400.00",
        "payment_date": (today() - timedelta(days=1)).isoformat(),
        "payment_method": "upi",
        "reference": "UPI-1",
    }
    if resource_type == "invoice":
        b["notes"] = "counter"
    b.update(over)
    return b


def register(api, body, status=201):
    return api.data(api.post("/payment-attempts", body), status)


def counts(db):
    db.expire_all()
    return (
        db.scalar(select(func.count()).select_from(Payment)),
        db.scalar(select(func.count()).select_from(BillPayment)),
        db.scalar(select(func.count()).select_from(CashTransaction)),
    )


def audit_rows(db, action, attempt_id=None):
    db.expire_all()
    q = select(AuditLog).where(AuditLog.action_type == action)
    if attempt_id is not None:
        q = q.where(AuditLog.entity_id == attempt_id)
    return list(db.scalars(q))


def row(db, attempt_id) -> PaymentAttempt:
    db.expire_all()
    return db.get(PaymentAttempt, attempt_id)


def backdate(app, attempt_id, minutes=120):
    with app.state.engine.begin() as conn:
        conn.execute(
            text("UPDATE payment_attempts SET created_at = now() - make_interval(mins => :m) WHERE id = :id"),
            {"m": minutes, "id": attempt_id},
        )


def expire_lease(app, attempt_id):
    with app.state.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE payment_attempts SET execution_started_at = now() - interval '10 minutes', "
                "lease_expires_at = now() - interval '8 minutes' WHERE id = :id"
            ),
            {"id": attempt_id},
        )


def ctx_for(session, user_id) -> AuthContext:
    user = session.get(User, user_id)
    return AuthContext(
        user_id=user.id,
        business_id=user.business_id,
        role=user.role,
        csrf="",
        user=user,
        business=session.get(Business, user.business_id),
    )


def crash_during_execute(app, owner, attempt_id):
    """execute() commits its lease, then the process dies before the payment transaction commits."""
    session = app.state.session_factory()
    try:
        pas.execute(session, ctx_for(session, owner.user.id), attempt_id)
        session.rollback()
    finally:
        session.close()


def commit_payment_under_key(app, owner, attempt_id):
    """The payment for the attempt's exact request commits under its key; the attempt row is not updated."""
    session = app.state.session_factory()
    try:
        a = session.get(PaymentAttempt, attempt_id)
        p = a.request_payload
        kw = dict(
            amount=Decimal(p["amount"]),
            payment_date=date.fromisoformat(p["payment_date"]),
            payment_method=p["payment_method"],
            reference=p["reference"],
            idempotency_key=a.idempotency_key,
        )
        ctx = ctx_for(session, owner.user.id)
        if a.resource_type == "invoice":
            pid = payment_service.record_customer_payment(
                session, ctx, invoice_id=a.resource_id, notes=p["notes"], **kw
            ).payment.id
        else:
            pid = payment_service.record_bill_payment(session, ctx, bill_id=a.resource_id, **kw)[0].id
        session.commit()
        return pid
    finally:
        session.close()


def reconcile(app, **kw):
    kw.setdefault("older_than", OLD)
    return pas.reconcile_pending(app.state.session_factory, **kw)


def run_concurrently(*calls):
    results: list = [None] * len(calls)
    errors: list = []
    barrier = threading.Barrier(len(calls))

    def worker(i, fn):
        barrier.wait()
        try:
            results[i] = fn()
        except BaseException as e:  # surfaced by the assertion below
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i, fn)) for i, fn in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not errors, errors
    assert not any(t.is_alive() for t in threads), "a worker hung"
    return results


@pytest.fixture
def invoice(owner):
    return owner.invoice(owner.customer()["id"], "1000.00")


@pytest.fixture
def bill(owner):
    return owner.data(owner.post("/bills", {"vendor_name": "Sharma Rentals", "amount": "1000.00"}), 201)


# ------------------------------------------------------------------ execution lease


def test_execute_commits_a_lease_before_any_money_moves(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    assert row(db, a["id"]).execution_started_at is None and row(db, a["id"]).lease_owner is None

    crash_during_execute(app, owner, a["id"])
    r = row(db, a["id"])
    assert r.status == "pending" and counts(db) == (0, 0, 0)
    assert r.execution_started_by == owner.user.id and r.lease_owner.startswith("exec_")
    assert r.execution_started_at < r.lease_expires_at
    assert len(audit_rows(db, "payment_attempt.execution_started", r.id)) == 1

    done = owner.data(owner.post(f"/payment-attempts/{a['id']}/execute"))
    assert done["status"] == "succeeded" and done["result"]["replayed"] is False
    r = row(db, a["id"])
    assert r.lease_owner is None and r.lease_expires_at is None  # terminal attempts hold no lease
    assert r.execution_started_at is not None  # who/when is kept
    assert counts(db) == (1, 0, 1)


def test_rejected_execution_releases_its_lease(owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"], amount="5000.00"))
    assert owner.post(f"/payment-attempts/{a['id']}/execute").status_code == 422
    r = row(db, a["id"])
    assert r.status == "rejected" and r.lease_owner is None and r.execution_started_at is not None


# ------------------------------------------------------------------ reconciliation outcomes


@pytest.mark.parametrize("kind", ["invoice", "bill"])
def test_payment_committed_but_attempt_not_updated_is_linked(app, owner, db, kind, request):
    resource = request.getfixturevalue(kind)
    a = register(owner, attempt_body(kind, resource["id"]))
    crash_during_execute(app, owner, a["id"])  # lease still live: proof by key wins anyway
    pid = commit_payment_under_key(app, owner, a["id"])
    backdate(app, a["id"])
    before = counts(db)

    report = reconcile(app)
    assert [(i.attempt_id, i.outcome, i.reason, i.payment_id) for i in report.items] == [
        (row(db, a["id"]).id, "succeeded", "payment_found_under_key", pid)
    ]
    r = row(db, a["id"])
    assert r.status == "succeeded" and r.payment_id == pid and r.lease_owner is None
    assert counts(db) == before  # linking never records money
    (audit,) = audit_rows(db, "payment_attempt.succeeded", r.id)
    assert audit.user_id is None and audit.after_data["via"] == "reconciler"
    assert audit.after_data["payment_id"] == str(pid)

    # Idempotent: a second run finds nothing, and executing now replays the linked payment.
    assert reconcile(app).items == []
    again = owner.data(owner.post(f"/payment-attempts/{a['id']}/execute"))
    assert again["result"]["replayed"] is True and again["payment_id"] == str(pid)
    assert counts(db) == before
    assert len(audit_rows(db, "payment_attempt.succeeded", r.id)) == 1


def test_never_executed_attempt_is_cancelled_and_cannot_execute(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    backdate(app, a["id"])
    (item,) = reconcile(app).items
    assert (item.outcome, item.reason) == ("cancelled", "never_executed")
    r = row(db, a["id"])
    assert r.status == "cancelled" and r.completed_at is not None and r.last_reconciled_at is not None
    (audit,) = audit_rows(db, "payment_attempt.cancelled", r.id)
    assert audit.user_id is None and audit.after_data["reason"] == "never_executed"

    assert reconcile(app).items == []  # idempotent
    assert owner.post(f"/payment-attempts/{a['id']}/execute").status_code == 409
    assert counts(db) == (0, 0, 0)
    register(owner, attempt_body("invoice", invoice["id"]))  # the invoice is free again


def test_recent_attempts_are_not_touched(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    assert reconcile(app).items == []
    assert row(db, a["id"]).status == "pending" and row(db, a["id"]).last_reconciled_at is None


def test_live_lease_keeps_attempt_pending_until_it_expires(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    crash_during_execute(app, owner, a["id"])
    backdate(app, a["id"])

    (item,) = reconcile(app).items
    assert (item.outcome, item.reason) == ("left_pending", "execution_lease_active")
    r = row(db, a["id"])
    assert r.status == "pending" and r.lease_owner is not None and r.last_reconciled_at is not None
    assert audit_rows(db, "payment_attempt.cancelled") == []

    # The lease ran out and the key lookup (under both locks) proves nothing was recorded.
    expire_lease(app, a["id"])
    (item,) = reconcile(app).items
    assert (item.outcome, item.reason) == ("cancelled", "lease_expired_no_payment")
    assert row(db, a["id"]).lease_owner is None and counts(db) == (0, 0, 0)


def test_expired_lease_alone_is_not_proof_when_a_payment_exists(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    crash_during_execute(app, owner, a["id"])
    pid = commit_payment_under_key(app, owner, a["id"])
    expire_lease(app, a["id"])
    backdate(app, a["id"])
    (item,) = reconcile(app).items
    assert (item.outcome, item.payment_id) == ("succeeded", pid)
    assert row(db, a["id"]).status == "succeeded" and counts(db) == (1, 0, 1)


def test_key_bound_to_a_different_payment_stays_pending(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"], idempotency_key="shared-key-9"))
    # An older client reused the key on the direct endpoint for a different amount.
    owner.data(
        owner.post(
            f"/invoices/{invoice['id']}/payments",
            {"amount": "300.00", "payment_method": "upi"},
            {"Idempotency-Key": "shared-key-9"},
        ),
        201,
    )
    backdate(app, a["id"])
    (item,) = reconcile(app).items
    assert (item.outcome, item.reason) == ("left_pending", "key_bound_to_different_payment")
    assert row(db, a["id"]).status == "pending" and counts(db) == (1, 0, 1)


def test_dry_run_decides_but_changes_nothing(app, owner, db):
    cust = owner.customer()["id"]
    inv1, inv2 = owner.invoice(cust, "1000.00"), owner.invoice(cust, "1000.00")
    a1 = register(owner, attempt_body("invoice", inv1["id"]))
    a2 = register(owner, attempt_body("invoice", inv2["id"]))
    commit_payment_under_key(app, owner, a1["id"])
    backdate(app, a1["id"])
    backdate(app, a2["id"], minutes=100)
    audits_before = len(audit_rows(db, "payment_attempt.succeeded")) + len(
        audit_rows(db, "payment_attempt.cancelled")
    )

    report = reconcile(app, dry_run=True)
    assert report.dry_run and sorted(i.outcome for i in report.items) == ["cancelled", "succeeded"]
    for aid in (a1["id"], a2["id"]):
        r = row(db, aid)
        assert r.status == "pending" and r.last_reconciled_at is None
    after = len(audit_rows(db, "payment_attempt.succeeded")) + len(
        audit_rows(db, "payment_attempt.cancelled")
    )
    assert after == audits_before


def test_business_filter_and_isolation(app, db, owner, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    _, other_user = make_business(db, name="Other Co")
    with TestClient(app) as c:
        other = Api(c, other_user.email)
        inv = other.invoice(other.customer()["id"], "1000.00")
        b = register(other, attempt_body("invoice", inv["id"]))
    backdate(app, a["id"])
    backdate(app, b["id"])
    (item,) = reconcile(app, business_id=owner.business.id).items
    assert str(item.attempt_id) == a["id"]
    assert row(db, b["id"]).status == "pending"


# ------------------------------------------------------------------ concurrency


def test_two_workers_reconcile_each_attempt_exactly_once(app, owner, db):
    cust = owner.customer()["id"]
    ids, paid = [], set()
    for n in range(8):
        inv = owner.invoice(cust, "1000.00")
        a = register(owner, attempt_body("invoice", inv["id"]))
        if n % 2 == 0:
            commit_payment_under_key(app, owner, a["id"])
            paid.add(a["id"])
        backdate(app, a["id"], minutes=200 - n)
        ids.append(a["id"])
    before = counts(db)

    r1, r2 = run_concurrently(lambda: reconcile(app), lambda: reconcile(app))
    handled = [str(i.attempt_id) for i in r1.items + r2.items if i.outcome != "skipped"]
    assert sorted(handled) == sorted(ids)  # every attempt exactly once across both workers
    for aid in ids:
        assert row(db, aid).status == ("succeeded" if aid in paid else "cancelled")
        assert len(audit_rows(db, "payment_attempt.succeeded", row(db, aid).id)) == (aid in paid)
        assert len(audit_rows(db, "payment_attempt.cancelled", row(db, aid).id)) == (aid not in paid)
    assert counts(db) == before  # no payment or cash movement duplicated or created


def test_reconciler_skips_an_attempt_locked_by_an_execution(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    backdate(app, a["id"])
    holder = app.state.session_factory()
    try:
        # An execution's payment transaction holds this lock from start to COMMIT.
        holder.execute(text("SELECT id FROM payment_attempts WHERE id = :id FOR UPDATE"), {"id": a["id"]})
        (report,) = run_concurrently(lambda: reconcile(app))  # returns at once: SKIP LOCKED
        assert report.items == []
    finally:
        holder.rollback()
        holder.close()
    (item,) = reconcile(app).items
    assert item.outcome == "cancelled"


def test_concurrent_execute_and_reconcile_never_lose_or_duplicate_a_payment(app, owner, db, invoice):
    outcomes = []
    for _ in range(6):
        a = register(owner, attempt_body("invoice", invoice["id"], amount="10.00"))
        backdate(app, a["id"])
        ex, rep = run_concurrently(
            lambda aid=a["id"]: owner.post(f"/payment-attempts/{aid}/execute"),
            lambda: reconcile(app, older_than=timedelta(minutes=1)),
        )
        r = row(db, a["id"])
        under_key = db.scalar(
            select(func.count()).select_from(Payment).where(Payment.idempotency_key == r.idempotency_key)
        )
        if r.status == "succeeded":
            assert ex.status_code == 200 and under_key == 1
        else:
            assert r.status == "cancelled" and ex.status_code == 409 and under_key == 0
            assert [i.outcome for i in rep.items] == ["cancelled"]
        outcomes.append(r.status)
    db.expire_all()
    succeeded = db.scalar(
        select(func.count()).select_from(PaymentAttempt).where(PaymentAttempt.status == "succeeded")
    )
    pays, _, cash = counts(db)
    assert pays == succeeded == cash
    assert audit_rows(db, "payment.recorded").__len__() == succeeded


# ------------------------------------------------------------------ restart (fresh process via the CLI)


def run_cli(database_url, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("DATABASE_URL", "TEST_DATABASE_URL"))}
    env.update(
        DATABASE_URL=database_url,
        APP_ENV="test",
        JWT_SECRET_KEY="cli-test-secret-key-that-is-long-enough-123",
        LOG_LEVEL="WARNING",
    )
    return subprocess.run(
        [sys.executable, "-m", "app.cli", "reconcile-payment-attempts", *args],
        cwd=BACKEND_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_cli_after_restart_dry_run_then_apply_then_idempotent(app, owner, db, database_url):
    cust = owner.customer()["id"]
    inv1, inv2 = owner.invoice(cust, "1000.00"), owner.invoice(cust, "1000.00")
    a1 = register(owner, attempt_body("invoice", inv1["id"]))
    a2 = register(owner, attempt_body("invoice", inv2["id"]))
    crash_during_execute(app, owner, a1["id"])
    pid = commit_payment_under_key(app, owner, a1["id"])  # the process died after this commit
    backdate(app, a1["id"])
    backdate(app, a2["id"])
    app.state.engine.dispose()  # nothing of the old process survives

    dry = run_cli(database_url, "--dry-run", "--older-than-minutes", "5")
    assert dry.returncode == 0, dry.stderr
    assert "Dry run, nothing changed: succeeded=1, cancelled=1" in dry.stdout
    assert row(db, a1["id"]).status == "pending"

    done = run_cli(database_url, "--older-than-minutes", "5", "--json")
    assert done.returncode == 0, done.stderr
    out = json.loads(done.stdout)
    by_id = {i["attempt_id"]: i for i in out["items"]}
    assert by_id[a1["id"]]["outcome"] == "succeeded" and by_id[a1["id"]]["payment_id"] == str(pid)
    assert by_id[a2["id"]]["outcome"] == "cancelled"
    assert row(db, a1["id"]).status == "succeeded" and row(db, a2["id"]).status == "cancelled"
    assert counts(db) == (1, 0, 1)
    r1 = row(db, a1["id"])
    assert r1.idempotency_key not in done.stdout + dry.stdout  # keys are never printed

    again = run_cli(database_url, "--older-than-minutes", "5", "--json")
    assert again.returncode == 0 and json.loads(again.stdout)["items"] == []


def test_cli_rejects_bad_arguments(database_url):
    assert run_cli(database_url, "--older-than-minutes", "0").returncode == 2
    assert run_cli(database_url, "--business-id", "not-a-uuid").returncode == 2
