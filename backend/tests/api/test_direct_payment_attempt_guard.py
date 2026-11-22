"""Direct payments (POST /invoices/{id}/payments, /bills/{id}/payments) versus payment attempts (real PostgreSQL).

The direct path takes the same invoice/bill row lock as attempt execution and, under it, refuses to record
while an attempt for that invoice/bill is pending, unless the request is that attempt itself (its key and
exact request), and never records under a cancelled attempt's key.
"""

from __future__ import annotations

import threading
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.models import AuditLog, BillPayment, CashTransaction, Payment, PaymentAttempt
from tests.conftest import today


def money_rows(db, model) -> tuple[int, int]:
    db.expire_all()
    return (
        db.scalar(select(func.count()).select_from(model)),
        db.scalar(select(func.count()).select_from(CashTransaction)),
    )


def audit_rows(db, action: str) -> list[AuditLog]:
    db.expire_all()
    return list(db.scalars(select(AuditLog).where(AuditLog.action_type == action)))


def status_of(db, attempt_id) -> PaymentAttempt:
    db.expire_all()
    return db.get(PaymentAttempt, attempt_id)


REQUEST = {
    "amount": "400.00",
    "payment_date": (today() - timedelta(days=1)).isoformat(),
    "payment_method": "upi",
    "reference": "UPI-1",
}


def direct_body(kind: str, **over) -> dict:
    b = dict(REQUEST)
    if kind == "invoice":
        b["notes"] = "counter"
    b.update(over)
    return b


def attempt_body(kind: str, resource_id: str, **over) -> dict:
    return {"resource_type": kind, "resource_id": resource_id, **direct_body(kind), **over}


def pay_direct(api, kind: str, resource_id: str, body: dict, key: str | None):
    path = f"/invoices/{resource_id}/payments" if kind == "invoice" else f"/bills/{resource_id}/payments"
    return api.post(path, body, {"Idempotency-Key": key} if key else None)


@pytest.fixture
def invoice(owner):
    return owner.invoice(owner.customer()["id"], "1000.00")


@pytest.fixture
def bill(owner):
    return owner.data(owner.post("/bills", {"vendor_name": "Sharma Rentals", "amount": "1000.00"}), 201)


MODEL = {"invoice": Payment, "bill": BillPayment}
RECORDED = {"invoice": "payment.recorded", "bill": "bill_payment.recorded"}


# ------------------------------------------------------------------ scenario (a): lost execute response


@pytest.mark.parametrize("kind", ["invoice", "bill"])
def test_direct_payment_is_refused_while_an_attempt_is_pending_and_retry_records_once(
    owner, db, kind, request
):
    resource = request.getfixturevalue(kind)
    a = owner.data(owner.post("/payment-attempts", attempt_body(kind, resource["id"])), 201)
    # The execute response is lost, so the attempt stays pending; the user re-enters the payment directly
    # with a fresh key.
    r = pay_direct(owner, kind, resource["id"], direct_body(kind), "fresh-key-1")
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "PAYMENT_ATTEMPT_PENDING" and err["details"]["attempt_id"] == a["id"]
    # Without a key it is refused just the same.
    r = pay_direct(owner, kind, resource["id"], direct_body(kind), None)
    assert r.status_code == 409 and r.json()["error"]["code"] == "PAYMENT_ATTEMPT_PENDING"
    assert money_rows(db, MODEL[kind]) == (0, 0)

    # Pending payments -> Retry records exactly one payment.
    done = owner.data(owner.post(f"/payment-attempts/{a['id']}/execute"))
    assert done["status"] == "succeeded" and done["result"]["replayed"] is False
    assert money_rows(db, MODEL[kind]) == (1, 1)
    assert len(audit_rows(db, RECORDED[kind])) == 1
    assert len(audit_rows(db, "payment_attempt.succeeded")) == 1

    # Once nothing is pending the direct path works again (a genuinely new payment).
    owner.data(
        pay_direct(owner, kind, resource["id"], direct_body(kind, amount="100.00"), "fresh-key-2"), 201
    )
    assert money_rows(db, MODEL[kind]) == (2, 2)


def test_lost_execute_with_a_live_lease_still_blocks_the_direct_path(app, owner, db, invoice):
    from tests.api.test_reconciliation import crash_during_execute

    a = owner.data(owner.post("/payment-attempts", attempt_body("invoice", invoice["id"])), 201)
    crash_during_execute(app, owner, a["id"])  # lease committed, payment rolled back
    r = pay_direct(owner, "invoice", invoice["id"], direct_body("invoice"), "fresh-key-1")
    assert r.status_code == 409 and r.json()["error"]["code"] == "PAYMENT_ATTEMPT_PENDING"
    owner.data(owner.post(f"/payment-attempts/{a['id']}/execute"))
    assert money_rows(db, Payment) == (1, 1)


@pytest.mark.parametrize("kind", ["invoice", "bill"])
def test_direct_retry_with_the_attempts_own_key_records_once_and_settles_it(owner, db, kind, request):
    resource = request.getfixturevalue(kind)
    a = owner.data(
        owner.post("/payment-attempts", attempt_body(kind, resource["id"], idempotency_key="own-key-1")), 201
    )
    first = owner.data(pay_direct(owner, kind, resource["id"], direct_body(kind), "own-key-1"), 201)
    assert first["replayed"] is False
    row = status_of(db, a["id"])
    assert row.status == "succeeded" and str(row.payment_id) == first["payment"]["id"]
    assert row.lease_owner is None
    (settled,) = audit_rows(db, "payment_attempt.succeeded")
    assert settled.after_data["via"] == "direct_payment"
    assert settled.after_data["payment_id"] == first["payment"]["id"]

    # The attempt's Retry and a repeated direct request both replay; nothing is recorded twice.
    again = owner.data(owner.post(f"/payment-attempts/{a['id']}/execute"))
    assert again["result"]["replayed"] is True and again["payment_id"] == first["payment"]["id"]
    assert (
        owner.data(pay_direct(owner, kind, resource["id"], direct_body(kind), "own-key-1"), 201)["replayed"]
        is True
    )
    assert money_rows(db, MODEL[kind]) == (1, 1)
    assert len(audit_rows(db, RECORDED[kind])) == 1
    assert len(audit_rows(db, "payment_attempt.succeeded")) == 1


def test_attempts_own_key_with_a_different_request_is_refused(owner, db, invoice):
    a = owner.data(
        owner.post("/payment-attempts", attempt_body("invoice", invoice["id"], idempotency_key="own-key-1")),
        201,
    )
    r = pay_direct(owner, "invoice", invoice["id"], direct_body("invoice", amount="300.00"), "own-key-1")
    assert r.status_code == 422 and r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert money_rows(db, Payment) == (0, 0)
    assert status_of(db, a["id"]).status == "pending"


def test_exact_replay_of_an_earlier_direct_payment_still_replays_beside_a_pending_attempt(owner, db, invoice):
    owner.data(pay_direct(owner, "invoice", invoice["id"], direct_body("invoice"), "early-key"), 201)
    a = owner.data(
        owner.post("/payment-attempts", attempt_body("invoice", invoice["id"], amount="100.00")), 201
    )
    replay = owner.data(pay_direct(owner, "invoice", invoice["id"], direct_body("invoice"), "early-key"), 201)
    assert replay["replayed"] is True
    assert money_rows(db, Payment) == (1, 1)
    assert status_of(db, a["id"]).status == "pending"  # an unrelated payment never settles the attempt


# ------------------------------------------------------------------ scenario (b): cancelled attempt's key


@pytest.mark.parametrize("kind", ["invoice", "bill"])
def test_direct_payment_with_a_cancelled_attempts_key_is_refused(owner, db, kind, request):
    resource = request.getfixturevalue(kind)
    a = owner.data(
        owner.post("/payment-attempts", attempt_body(kind, resource["id"], idempotency_key="old-tab-key")),
        201,
    )
    assert owner.data(owner.post(f"/payment-attempts/{a['id']}/cancel"))["status"] == "cancelled"
    # An old tab retries the direct endpoint with the key it still holds.
    r = pay_direct(owner, kind, resource["id"], direct_body(kind), "old-tab-key")
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "PAYMENT_ATTEMPT_CANCELLED" and err["details"]["attempt_id"] == a["id"]
    assert money_rows(db, MODEL[kind]) == (0, 0)
    assert len(audit_rows(db, RECORDED[kind])) == 0
    row = status_of(db, a["id"])
    assert row.status == "cancelled" and row.payment_id is None
    assert len(audit_rows(db, "payment_attempt.cancelled")) == 1
    assert len(audit_rows(db, "payment_attempt.succeeded")) == 0

    # A new payment with a new key is fine: nothing is pending.
    owner.data(pay_direct(owner, kind, resource["id"], direct_body(kind), "new-key"), 201)
    assert money_rows(db, MODEL[kind]) == (1, 1)
    assert status_of(db, a["id"]).status == "cancelled"


def test_rejected_attempts_key_returns_the_rejection_on_the_direct_path(owner, db, invoice):
    a = owner.data(
        owner.post(
            "/payment-attempts",
            attempt_body("invoice", invoice["id"], idempotency_key="big-amount-key", amount="5000.00"),
        ),
        201,
    )
    assert owner.post(f"/payment-attempts/{a['id']}/execute").status_code == 422
    r = pay_direct(
        owner, "invoice", invoice["id"], direct_body("invoice", amount="5000.00"), "big-amount-key"
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "OVERPAYMENT"
    assert money_rows(db, Payment) == (0, 0)
    assert status_of(db, a["id"]).status == "rejected"


# ------------------------------------------------------------------ concurrency


def run_concurrently(*calls):
    results: list = [None] * len(calls)
    barrier = threading.Barrier(len(calls))

    def worker(i, fn):
        barrier.wait()
        results[i] = fn()

    threads = [threading.Thread(target=worker, args=(i, fn)) for i, fn in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_concurrent_retry_and_direct_payment_with_the_attempts_key_record_once(owner, db, invoice):
    for n in range(3):
        key = f"race-key-{n}"
        a = owner.data(
            owner.post(
                "/payment-attempts",
                attempt_body("invoice", invoice["id"], idempotency_key=key, amount="10.00"),
            ),
            201,
        )
        ex, direct = run_concurrently(
            lambda aid=a["id"]: owner.post(f"/payment-attempts/{aid}/execute"),
            lambda k=key: pay_direct(
                owner, "invoice", invoice["id"], direct_body("invoice", amount="10.00"), k
            ),
        )
        assert ex.status_code == 200 and direct.status_code == 201, (ex.text, direct.text)
        assert sorted([ex.json()["data"]["result"]["replayed"], direct.json()["data"]["replayed"]]) == [
            False,
            True,
        ]
        row = status_of(db, a["id"])
        assert row.status == "succeeded" and str(row.payment_id) == direct.json()["data"]["payment"]["id"]
    assert money_rows(db, Payment) == (3, 3)
    assert len(audit_rows(db, "payment.recorded")) == 3
    assert len(audit_rows(db, "payment_attempt.succeeded")) == 3
