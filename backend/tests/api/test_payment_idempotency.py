"""Idempotency-Key request fingerprints for invoice and bill payments (real PostgreSQL).

One key stands for exactly one validated request: an identical retry replays the original, any change to
a financially relevant field is 422 IDEMPOTENCY_KEY_REUSED with no new rows.
"""

from __future__ import annotations

import threading
from datetime import timedelta

import pytest
from sqlalchemy import func, select, text

from app.models import AuditLog, BillPayment, CashTransaction, Payment
from tests.conftest import today


def counts(db, model, audit_action: str) -> tuple[int, int, int]:
    db.expire_all()
    return (
        db.scalar(select(func.count()).select_from(model)),
        db.scalar(select(func.count()).select_from(CashTransaction)),
        db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action_type == audit_action)),
    )


def body(**over):
    b = {
        "amount": "400.00",
        "payment_date": (today() - timedelta(days=1)).isoformat(),
        "payment_method": "cash",
        "reference": "R-1",
        "notes": "first",
    }
    b.update(over)
    return b


@pytest.fixture
def invoice(owner):
    c = owner.customer()
    return owner.invoice(c["id"], "1000.00")


@pytest.fixture
def bill(owner):
    return owner.data(owner.post("/bills", {"vendor_name": "Sharma Rentals", "amount": "1000.00"}), 201)


def pay_invoice(owner, invoice_id, key, payload):
    return owner.post(f"/invoices/{invoice_id}/payments", payload, {"Idempotency-Key": key})


def pay_bill(owner, bill_id, key, payload):
    payload = {k: v for k, v in payload.items() if k != "notes"}
    return owner.post(f"/bills/{bill_id}/payments", payload, {"Idempotency-Key": key})


# ------------------------------------------------------------------ invoice payments


def test_invoice_exact_replay_returns_original_once(owner, db, invoice):
    a = owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)
    b = owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)
    assert b["replayed"] is True and a["replayed"] is False
    assert a["payment"]["id"] == b["payment"]["id"]
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)
    stored = db.scalar(select(Payment))
    assert stored.request_fingerprint and len(stored.request_fingerprint) == 64


@pytest.mark.parametrize(
    "change",
    [
        {"payment_date": (today() - timedelta(days=9)).isoformat()},
        {"payment_method": "cheque"},
        {"reference": "CHQ-99"},
        {"reference": "r-1"},  # case is meaningful
        {"notes": "changed"},
        {"notes": None},
        {"amount": "401.00"},
    ],
)
def test_invoice_changed_details_with_same_key_are_rejected(owner, db, invoice, change):
    owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)
    r = pay_invoice(owner, invoice["id"], "k1", body(**change))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_invoice_same_key_on_another_invoice_is_rejected(owner, db, invoice):
    other = owner.invoice(invoice["customer_id"], "500.00")
    owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)
    r = pay_invoice(owner, other["id"], "k1", body())
    assert r.status_code == 422 and r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_invoice_canonicalisation_amount_and_blank_text(owner, db, invoice):
    owner.data(pay_invoice(owner, invoice["id"], "k1", body(amount="400", reference="", notes="   ")), 201)
    # "400" == "400.00"; "" / whitespace / null are all "no value".
    r = owner.data(
        pay_invoice(owner, invoice["id"], "k1", body(amount="400.00", reference=None, notes=None)), 201
    )
    assert r["replayed"] is True
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_invoice_omitted_date_replays_without_date(owner, db, invoice):
    payload = body()
    del payload["payment_date"]
    owner.data(pay_invoice(owner, invoice["id"], "k1", payload), 201)
    assert owner.data(pay_invoice(owner, invoice["id"], "k1", payload), 201)["replayed"] is True
    # Sending an explicit date for a request that originally omitted it is a different request.
    r = pay_invoice(owner, invoice["id"], "k1", body(payment_date=today().isoformat()))
    assert r.status_code == 422


def test_invoice_replay_after_full_payment(owner, db, invoice):
    owner.data(pay_invoice(owner, invoice["id"], "k1", body(amount="1000.00")), 201)
    r = owner.data(pay_invoice(owner, invoice["id"], "k1", body(amount="1000.00")), 201)
    assert r["replayed"] is True and r["invoice"]["outstanding"] == "0.00"
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_invoice_rejected_request_records_nothing_and_key_stays_usable(owner, db, invoice):
    r = pay_invoice(owner, invoice["id"], "k1", body(amount="5000.00"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "OVERPAYMENT"
    assert counts(db, Payment, "payment.recorded") == (0, 0, 0)
    owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_invoice_legacy_row_without_fingerprint_uses_strict_comparison(owner, db, invoice):
    owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)
    db.execute(text("UPDATE payments SET request_fingerprint = NULL"))
    db.commit()
    assert owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)["replayed"] is True
    for change in (
        {"payment_method": "upi"},
        {"reference": "X"},
        {"notes": "x"},
        {"payment_date": today().isoformat()},
    ):
        r = pay_invoice(owner, invoice["id"], "k1", body(**change))
        assert r.status_code == 422, change
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


# ------------------------------------------------------------------ bill payments


def test_bill_exact_replay_returns_original_once(owner, db, bill):
    a = owner.data(pay_bill(owner, bill["id"], "b1", body()), 201)
    b = owner.data(pay_bill(owner, bill["id"], "b1", body()), 201)
    assert b["replayed"] is True and a["payment"]["id"] == b["payment"]["id"]
    assert counts(db, BillPayment, "bill_payment.recorded") == (1, 1, 1)


@pytest.mark.parametrize(
    "change",
    [
        {"payment_date": (today() - timedelta(days=9)).isoformat()},
        {"payment_method": "cheque"},
        {"reference": "CHQ-99"},
        {"amount": "401.00"},
    ],
)
def test_bill_changed_details_with_same_key_are_rejected(owner, db, bill, change):
    owner.data(pay_bill(owner, bill["id"], "b1", body()), 201)
    r = pay_bill(owner, bill["id"], "b1", body(**change))
    assert r.status_code == 422 and r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert counts(db, BillPayment, "bill_payment.recorded") == (1, 1, 1)


def test_bill_replay_after_full_payment(owner, db, bill):
    owner.data(pay_bill(owner, bill["id"], "b1", body(amount="1000.00")), 201)
    r = owner.data(pay_bill(owner, bill["id"], "b1", body(amount="1000.00")), 201)
    assert r["replayed"] is True and r["bill"]["outstanding"] == "0.00"
    assert counts(db, BillPayment, "bill_payment.recorded") == (1, 1, 1)


def test_bill_legacy_row_without_fingerprint_uses_strict_comparison(owner, db, bill):
    owner.data(pay_bill(owner, bill["id"], "b1", body()), 201)
    db.execute(text("UPDATE bill_payments SET request_fingerprint = NULL"))
    db.commit()
    assert owner.data(pay_bill(owner, bill["id"], "b1", body()), 201)["replayed"] is True
    assert pay_bill(owner, bill["id"], "b1", body(payment_method="upi")).status_code == 422
    assert counts(db, BillPayment, "bill_payment.recorded") == (1, 1, 1)


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


def test_concurrent_exact_requests_record_once(owner, db, invoice):
    rs = run_concurrently(*[lambda: pay_invoice(owner, invoice["id"], "k1", body()) for _ in range(4)])
    assert sorted(r.status_code for r in rs) == [201, 201, 201, 201]
    assert sorted(r.json()["data"]["replayed"] for r in rs) == [False, True, True, True]
    assert len({r.json()["data"]["payment"]["id"] for r in rs}) == 1
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_concurrent_conflicting_payloads_record_exactly_one(owner, db, invoice):
    rs = run_concurrently(
        lambda: pay_invoice(owner, invoice["id"], "k1", body(payment_method="cash")),
        lambda: pay_invoice(owner, invoice["id"], "k1", body(payment_method="upi")),
    )
    assert sorted(r.status_code for r in rs) == [201, 422]
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_concurrent_same_key_on_two_invoices_is_a_conflict_not_a_500(owner, db, invoice):
    other = owner.invoice(invoice["customer_id"], "1000.00")
    rs = run_concurrently(
        lambda: pay_invoice(owner, invoice["id"], "k1", body()),
        lambda: pay_invoice(owner, other["id"], "k1", body()),
    )
    assert sorted(r.status_code for r in rs) == [201, 422], [r.text for r in rs]
    loser = next(r for r in rs if r.status_code == 422)
    assert loser.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert counts(db, Payment, "payment.recorded") == (1, 1, 1)


def test_concurrent_bill_exact_requests_record_once(owner, db, bill):
    rs = run_concurrently(*[lambda: pay_bill(owner, bill["id"], "b1", body()) for _ in range(4)])
    assert all(r.status_code == 201 for r in rs)
    assert counts(db, BillPayment, "bill_payment.recorded") == (1, 1, 1)


def test_different_keys_are_different_payments(owner, db, invoice):
    owner.data(pay_invoice(owner, invoice["id"], "k1", body()), 201)
    owner.data(pay_invoice(owner, invoice["id"], "k2", body()), 201)
    assert counts(db, Payment, "payment.recorded") == (2, 2, 2)
