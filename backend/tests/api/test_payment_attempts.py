"""Server-side payment attempts: registration, cross-device recovery, retry, cancellation (real PostgreSQL).

"Devices" are separate TestClient instances with separate cookie jars and logins. A "server restart" is a
brand-new application instance (new engine, new process state) over the same database.
"""

from __future__ import annotations

import threading
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.dependencies import AuthContext
from app.main import create_app
from app.models import AuditLog, BillPayment, Business, CashTransaction, Payment, PaymentAttempt, User
from app.services import payment_attempt_service, payment_service
from tests.conftest import Api, add_user, make_business, today


def money_rows(db, model) -> tuple[int, int]:
    db.expire_all()
    return (
        db.scalar(select(func.count()).select_from(model)),
        db.scalar(select(func.count()).select_from(CashTransaction)),
    )


def audits(db, action: str) -> int:
    db.expire_all()
    return db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action_type == action))


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


@pytest.fixture
def invoice(owner):
    return owner.invoice(owner.customer()["id"], "1000.00")


@pytest.fixture
def bill(owner):
    return owner.data(owner.post("/bills", {"vendor_name": "Sharma Rentals", "amount": "1000.00"}), 201)


@pytest.fixture
def device_b(app, db, owner):
    """A second device: its own client and cookies, a different user of the same business."""
    staff = add_user(db, owner.business, role="staff")
    with TestClient(app) as c:
        yield Api(c, staff.email)


def register(api, body, status=201):
    return api.data(api.post("/payment-attempts", body), status)


def record_direct_bypassing_attempts(app, owner, invoice_id, body, key):
    """Commits a direct invoice payment the way the endpoint did before it checked payment attempts."""
    session = app.state.session_factory()
    try:
        user = session.get(User, owner.user.id)
        ctx = AuthContext(
            user_id=user.id,
            business_id=user.business_id,
            role=user.role,
            csrf="",
            user=user,
            business=session.get(Business, user.business_id),
        )
        payment_service.record_customer_payment(
            session,
            ctx,
            invoice_id=invoice_id,
            amount=Decimal(body["amount"]),
            payment_date=date.fromisoformat(body["payment_date"]),
            payment_method=body["payment_method"],
            reference=body["reference"],
            notes=body["notes"],
            idempotency_key=key,
            attempt_guard=False,
        )
        session.commit()
    finally:
        session.close()


def execute(api, attempt_id, status=200):
    r = api.post(f"/payment-attempts/{attempt_id}/execute")
    return api.data(r, status) if status == 200 else r


# ------------------------------------------------------------------ registration


def test_register_invoice_attempt_persists_frozen_request(owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    assert a["status"] == "pending" and a["resource_label"] == invoice["invoice_number"]
    assert a["request"] == {
        "amount": "400.00",
        "payment_date": (today() - timedelta(days=1)).isoformat(),
        "payment_method": "upi",
        "reference": "UPI-1",
        "notes": "counter",
    }
    assert "idempotency_key" not in a and a["result"] is None
    row = db.get(PaymentAttempt, a["id"])
    assert row.idempotency_key.startswith("pa_") and len(row.request_fingerprint) == 64
    assert money_rows(db, Payment) == (0, 0)  # registering moves no money
    assert audits(db, "payment_attempt.registered") == 1


def test_register_bill_attempt_and_bill_notes_are_refused(owner, db, bill):
    a = register(owner, attempt_body("bill", bill["id"]))
    assert a["resource_label"] == "Sharma Rentals" and a["request"]["notes"] is None
    r = owner.post("/payment-attempts", attempt_body("bill", bill["id"], notes="x"))
    assert r.status_code == 422


def test_exact_registration_replay_returns_the_same_attempt(owner, device_b, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    # Lost registration response, or another device registering the same intended payment.
    again = register(device_b, attempt_body("invoice", invoice["id"]), status=200)
    assert again["id"] == a["id"]
    # A different request (here with its own client key) cannot start a second payment beside the pending one.
    r = owner.post(
        "/payment-attempts",
        attempt_body("invoice", invoice["id"], idempotency_key="client-key-1", amount="10.00"),
    )
    assert r.status_code == 409 and r.json()["error"]["details"]["attempt_id"] == a["id"]


def test_conflicting_registration_is_refused_with_the_pending_attempt_id(owner, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    r = owner.post("/payment-attempts", attempt_body("invoice", invoice["id"], amount="500.00"))
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "PAYMENT_ATTEMPT_PENDING" and err["details"]["attempt_id"] == a["id"]


def test_client_key_replay_and_key_conflict(owner, invoice):
    body = attempt_body("invoice", invoice["id"], idempotency_key="client-key-1")
    a = register(owner, body)
    assert register(owner, body, status=200)["id"] == a["id"]
    r = owner.post("/payment-attempts", {**body, "payment_method": "cash"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_registering_a_key_already_used_by_a_recorded_payment_links_it(owner, db, invoice):
    # A browser sent the payment with its own key before the registry existed; the response was lost.
    direct = {
        k: v
        for k, v in attempt_body("invoice", invoice["id"]).items()
        if k not in ("resource_type", "resource_id")
    }
    owner.data(
        owner.post(f"/invoices/{invoice['id']}/payments", direct, {"Idempotency-Key": "legacy-key-1"}), 201
    )
    a = register(owner, attempt_body("invoice", invoice["id"], idempotency_key="legacy-key-1"))
    assert a["status"] == "succeeded" and a["result"]["replayed"] is True
    assert money_rows(db, Payment) == (1, 1)
    # A mismatching request under that key is refused, never linked.
    r = owner.post(
        "/payment-attempts", attempt_body("invoice", invoice["id"], idempotency_key="legacy-key-2")
    )
    assert r.status_code == 201  # different key: a new pending attempt is fine
    owner.data(owner.post(f"/payment-attempts/{r.json()['data']['id']}/cancel"))
    bad = owner.post(
        "/payment-attempts",
        attempt_body("invoice", invoice["id"], idempotency_key="legacy-key-1", amount="1.00"),
    )
    assert bad.status_code == 422


# ------------------------------------------------------------------ execution and recovery


def test_execute_records_once_and_retries_replay(owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    first = execute(owner, a["id"])
    assert first["status"] == "succeeded" and first["result"]["replayed"] is False
    assert first["result"]["invoice_payment"]["invoice"]["outstanding"] == "600.00"
    again = execute(owner, a["id"])
    assert again["result"]["replayed"] is True
    assert (
        again["result"]["invoice_payment"]["payment"]["id"]
        == first["result"]["invoice_payment"]["payment"]["id"]
    )
    assert money_rows(db, Payment) == (1, 1)
    assert audits(db, "payment.recorded") == 1
    assert audits(db, "payment_attempt.succeeded") == 1  # the replay is not a second transition


def test_lost_response_is_recovered_from_another_device(owner, device_b, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    execute(owner, a["id"])  # device A never sees this response
    pending = device_b.data(device_b.get("/payment-attempts", params={"resource_id": invoice["id"]}))
    assert pending["total"] == 1 and pending["items"][0]["status"] == "succeeded"
    detail = device_b.data(device_b.get(f"/payment-attempts/{a['id']}"))
    assert detail["result"]["invoice_payment"]["payment"]["amount"] == "400.00"
    retried = execute(device_b, a["id"])
    assert retried["result"]["replayed"] is True
    assert money_rows(db, Payment) == (1, 1)


def test_unexecuted_attempt_is_found_and_executed_by_another_device(owner, device_b, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    listing = device_b.data(device_b.get("/payment-attempts", params={"status": "pending"}))
    assert [i["id"] for i in listing["items"]] == [a["id"]]
    done = execute(device_b, a["id"])
    assert done["result"]["replayed"] is False
    assert money_rows(db, Payment) == (1, 1)


def test_retry_after_server_restart(settings, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    execute(owner, a["id"])
    restarted = create_app(settings)
    try:
        with TestClient(restarted) as c:
            api = Api(c, owner.user.email)
            again = execute(api, a["id"])
            assert again["status"] == "succeeded" and again["result"]["replayed"] is True
    finally:
        restarted.state.engine.dispose()
    assert money_rows(db, Payment) == (1, 1)


def test_crash_before_commit_leaves_attempt_pending_and_retry_records_once(app, owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    session = app.state.session_factory()
    try:
        from app.db.dependencies import AuthContext
        from app.models import Business, User

        user = session.get(User, owner.user.id)
        ctx = AuthContext(
            user_id=user.id,
            business_id=user.business_id,
            role=user.role,
            csrf="",
            user=user,
            business=session.get(Business, user.business_id),
        )
        payment_attempt_service.execute(session, ctx, a["id"])
        session.rollback()  # the process dies before COMMIT
    finally:
        session.close()
    assert owner.data(owner.get(f"/payment-attempts/{a['id']}"))["status"] == "pending"
    assert money_rows(db, Payment) == (0, 0)
    assert execute(owner, a["id"])["result"]["replayed"] is False
    assert money_rows(db, Payment) == (1, 1)


def test_retry_after_full_invoice_payment(owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"], amount="1000.00"))
    execute(owner, a["id"])
    again = execute(owner, a["id"])
    assert again["result"]["replayed"] is True
    assert again["result"]["invoice_payment"]["invoice"]["outstanding"] == "0.00"
    assert money_rows(db, Payment) == (1, 1)


def test_retry_after_full_bill_payment(owner, device_b, db, bill):
    a = register(owner, attempt_body("bill", bill["id"], amount="1000.00"))
    execute(owner, a["id"])
    again = execute(device_b, a["id"])
    assert again["result"]["replayed"] is True
    assert again["result"]["bill_payment"]["bill"]["outstanding"] == "0.00"
    assert money_rows(db, BillPayment) == (1, 1)
    assert audits(db, "bill_payment.recorded") == 1


def test_definitive_rejection_is_recorded_and_frees_the_invoice(owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"], amount="5000.00"))
    r = execute(owner, a["id"], status=422)
    assert r.json()["error"]["code"] == "OVERPAYMENT"
    detail = owner.data(owner.get(f"/payment-attempts/{a['id']}"))
    assert detail["status"] == "rejected" and detail["failure_code"] == "OVERPAYMENT"
    assert execute(owner, a["id"], status=422).json()["error"]["code"] == "OVERPAYMENT"
    assert money_rows(db, Payment) == (0, 0)
    # Nothing is pending any more, so a corrected payment can be registered.
    register(owner, attempt_body("invoice", invoice["id"], amount="1000.00"))


# ------------------------------------------------------------------ isolation and authorisation


def test_unauthenticated_access_is_refused(client, owner, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    with TestClient(client.app) as anon:
        assert anon.get(f"/api/v1/payment-attempts/{a['id']}").status_code == 401
        assert anon.get("/api/v1/payment-attempts").status_code == 401


def test_other_business_cannot_see_or_touch_attempts(app, db, owner, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    _, other_user = make_business(db, name="Other Co")
    with TestClient(app) as c:
        other = Api(c, other_user.email)
        assert other.get(f"/payment-attempts/{a['id']}").status_code == 404
        assert other.post(f"/payment-attempts/{a['id']}/execute").status_code == 404
        assert other.post(f"/payment-attempts/{a['id']}/cancel").status_code == 404
        assert other.data(other.get("/payment-attempts"))["total"] == 0
        # Nor register against another business's invoice.
        assert other.post("/payment-attempts", attempt_body("invoice", invoice["id"])).status_code == 404
    assert money_rows(db, Payment) == (0, 0)


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


def test_concurrent_registrations_leave_one_pending_attempt(owner, db, invoice):
    rs = run_concurrently(
        lambda: owner.post("/payment-attempts", attempt_body("invoice", invoice["id"], amount="100.00")),
        lambda: owner.post("/payment-attempts", attempt_body("invoice", invoice["id"], amount="200.00")),
        lambda: owner.post("/payment-attempts", attempt_body("invoice", invoice["id"], amount="300.00")),
    )
    assert sorted(r.status_code for r in rs) == [201, 409, 409]
    db.expire_all()
    assert (
        db.scalar(select(func.count()).select_from(PaymentAttempt).where(PaymentAttempt.status == "pending"))
        == 1
    )


def test_concurrent_retries_record_exactly_once(owner, device_b, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    rs = run_concurrently(
        *[lambda api=api: api.post(f"/payment-attempts/{a['id']}/execute") for api in (owner, device_b) * 2]
    )
    assert all(r.status_code == 200 for r in rs), [r.text for r in rs]
    assert sorted(r.json()["data"]["result"]["replayed"] for r in rs) == [False, True, True, True]
    assert money_rows(db, Payment) == (1, 1)
    assert audits(db, "payment.recorded") == 1


# ------------------------------------------------------------------ cancellation


def test_safe_cancellation_of_an_unexecuted_attempt(owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    c = owner.data(owner.post(f"/payment-attempts/{a['id']}/cancel"))
    assert c["status"] == "cancelled"
    assert owner.post(f"/payment-attempts/{a['id']}/execute").status_code == 409
    assert money_rows(db, Payment) == (0, 0)
    assert audits(db, "payment_attempt.cancelled") == 1


def test_cancellation_is_refused_once_a_payment_exists(owner, db, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    execute(owner, a["id"])
    r = owner.post(f"/payment-attempts/{a['id']}/cancel")
    assert r.status_code == 409 and r.json()["error"]["code"] == "PAYMENT_ATTEMPT_NOT_PENDING"


def test_cancellation_reconciles_a_payment_recorded_under_the_key(app, owner, db, invoice):
    body = attempt_body("invoice", invoice["id"], idempotency_key="shared-key-1")
    a = register(owner, body)
    # The same key was also used on the direct endpoint and that payment committed, before the direct path
    # settled attempts itself (it now links the attempt at once): fabricated with attempt_guard=False.
    record_direct_bypassing_attempts(app, owner, invoice["id"], body, "shared-key-1")
    r = owner.post(f"/payment-attempts/{a['id']}/cancel")
    assert r.status_code == 409 and r.json()["error"]["code"] == "PAYMENT_ALREADY_RECORDED"
    assert owner.data(owner.get(f"/payment-attempts/{a['id']}"))["status"] == "succeeded"
    assert money_rows(db, Payment) == (1, 1)


def test_concurrent_execute_and_cancel_never_lose_a_payment(owner, db, invoice):
    for _ in range(3):
        a = register(owner, attempt_body("invoice", invoice["id"], amount="10.00"))
        ex, ca = run_concurrently(
            lambda aid=a["id"]: owner.post(f"/payment-attempts/{aid}/execute"),
            lambda aid=a["id"]: owner.post(f"/payment-attempts/{aid}/cancel"),
        )
        final = owner.data(owner.get(f"/payment-attempts/{a['id']}"))
        db.expire_all()
        paid = db.scalar(select(func.count()).select_from(Payment).where(Payment.id == final["payment_id"]))
        if final["status"] == "succeeded":
            assert ex.status_code == 200 and ca.status_code == 409 and paid == 1
        else:
            assert final["status"] == "cancelled" and ex.status_code == 409 and ca.status_code == 200
    db.expire_all()
    succeeded = db.scalar(
        select(func.count()).select_from(PaymentAttempt).where(PaymentAttempt.status == "succeeded")
    )
    assert money_rows(db, Payment)[0] == succeeded


def test_csrf_is_required_for_attempt_writes(owner, invoice):
    a = register(owner, attempt_body("invoice", invoice["id"]))
    c = owner.client
    for path, body in (
        ("/api/v1/payment-attempts", attempt_body("invoice", invoice["id"])),
        (f"/api/v1/payment-attempts/{a['id']}/execute", None),
        (f"/api/v1/payment-attempts/{a['id']}/cancel", None),
    ):
        r = c.post(path, json=body)  # cookie session, no X-CSRF-Token header
        assert r.status_code == 403 and r.json()["error"]["code"] == "CSRF_FAILED", path
    assert owner.data(owner.get(f"/payment-attempts/{a['id']}"))["status"] == "pending"
