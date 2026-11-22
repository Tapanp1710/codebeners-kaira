import threading
from datetime import timedelta

from sqlalchemy import func, select

from app.models import AuditLog, CashTransaction, Payment
from tests.conftest import Api, make_business, today


# ----------------------------------------------------------------- customers
def test_customer_crud_search_and_balances(owner):
    c = owner.customer("Ramesh Kumar", phone="9848012345")
    owner.customer("Suresh Babu")
    assert c["outstanding"] == "0.00"
    found = owner.data(owner.get("/customers", params={"search": "rames"}))
    assert [i["name"] for i in found["items"]] == ["Ramesh Kumar"]
    updated = owner.data(owner.patch(f"/customers/{c['id']}", {"notes": "VIP"}))
    assert updated["notes"] == "VIP"
    owner.invoice(c["id"], "1000.00")
    owing = owner.data(owner.get("/customers", params={"with_balance": "true"}))
    assert [i["name"] for i in owing["items"]] == ["Ramesh Kumar"]
    assert owing["items"][0]["outstanding"] == "1000.00"


def test_customer_validation_error_envelope(owner):
    r = owner.post("/customers", {"name": ""})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


# ----------------------------------------------------------------- invoices
def test_invoice_total_from_items_and_sequential_numbers(owner):
    c = owner.customer()
    inv = owner.invoice(
        c["id"],
        items=[
            {"description": "Rice", "quantity": "3", "unit_price": "1250.50"},
            {"description": "Dal", "quantity": "2.5", "unit_price": "100"},
        ],
    )
    assert inv["total"] == "4001.50"
    assert inv["outstanding"] == "4001.50"
    assert inv["payment_status"] == "unpaid"
    assert inv["invoice_number"] == "INV-0001"
    assert [i["line_total"] for i in inv["items"]] == ["3751.50", "250.00"]
    assert owner.invoice(c["id"])["invoice_number"] == "INV-0002"


def test_invoice_due_date_before_invoice_date_rejected(owner):
    c = owner.customer()
    r = owner.post(
        "/invoices",
        {
            "customer_id": c["id"],
            "invoice_date": "2026-11-10",
            "due_date": "2026-11-01",
            "items": [{"description": "x", "unit_price": "10"}],
        },
    )
    assert r.status_code == 422


def test_invoice_rejects_float_like_precision(owner):
    c = owner.customer()
    r = owner.post(
        "/invoices", {"customer_id": c["id"], "items": [{"description": "x", "unit_price": "10.123"}]}
    )
    assert r.status_code == 422


def test_invoice_filters_status_and_overdue(owner):
    c = owner.customer()
    today_ = today()
    overdue = owner.invoice(
        c["id"], "500", invoice_date=today_ - timedelta(days=40), due_date=today_ - timedelta(days=10)
    )
    current = owner.invoice(c["id"], "700")
    owner.pay(current["id"], "200")
    od = owner.data(owner.get("/invoices", params={"status": "overdue"}))
    assert [i["id"] for i in od["items"]] == [overdue["id"]]
    assert od["items"][0]["days_overdue"] >= 9
    pp = owner.data(owner.get("/invoices", params={"status": "partially_paid"}))
    assert [i["id"] for i in pp["items"]] == [current["id"]]


def test_void_invoice_only_without_payments(owner):
    c = owner.customer()
    a = owner.invoice(c["id"], "100")
    assert (
        owner.data(owner.patch(f"/invoices/{a['id']}", {"lifecycle_status": "void"}))["payment_status"]
        == "void"
    )
    b = owner.invoice(c["id"], "100")
    owner.pay(b["id"], "10")
    r = owner.patch(f"/invoices/{b['id']}", {"lifecycle_status": "void"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVOICE_HAS_PAYMENTS"


# ----------------------------------------------------------------- payments
def test_partial_then_full_payment_with_cash_and_audit(owner, db):
    c = owner.customer()
    inv = owner.invoice(c["id"], "10000.00")
    first = owner.pay(inv["id"], "4000")
    assert first["invoice"]["outstanding"] == "6000.00"
    assert first["invoice"]["payment_status"] == "partially_paid"
    second = owner.pay(inv["id"], "6000.00")
    assert second["invoice"]["outstanding"] == "0.00"
    assert second["invoice"]["payment_status"] == "paid"
    cash = db.scalars(select(CashTransaction).where(CashTransaction.direction == "inflow")).all()
    assert sorted(str(c.amount) for c in cash) == ["4000.00", "6000.00"]
    audits = db.scalar(select(func.count()).where(AuditLog.action_type == "payment.recorded"))
    assert audits == 2
    history = owner.data(owner.get(f"/invoices/{inv['id']}/payments"))
    assert history["total"] == 2
    position = owner.data(owner.get("/cashflow/position"))
    assert position["current_cash"] == "60000.00"


def test_overpayment_rejected_and_nothing_written(owner, db):
    c = owner.customer()
    inv = owner.invoice(c["id"], "1000")
    r = owner.pay(inv["id"], "1000.01", status=422)
    assert r.json()["error"]["code"] == "OVERPAYMENT"
    assert db.scalar(select(func.count()).select_from(Payment)) == 0
    assert db.scalar(select(func.count()).select_from(CashTransaction)) == 0
    owner.pay(inv["id"], "1000")
    r = owner.pay(inv["id"], "1", status=422)
    assert r.json()["error"]["code"] == "INVOICE_ALREADY_PAID"


def test_idempotency_key_prevents_duplicate_payment(owner, db):
    c = owner.customer()
    inv = owner.invoice(c["id"], "1000")
    a = owner.pay(inv["id"], "300", headers={"Idempotency-Key": "abc"})
    b = owner.pay(inv["id"], "300", headers={"Idempotency-Key": "abc"})
    assert a["payment"]["id"] == b["payment"]["id"]
    assert b["replayed"] is True
    assert db.scalar(select(func.count()).select_from(Payment)) == 1
    assert db.scalar(select(func.count()).select_from(CashTransaction)) == 1
    r = owner.pay(inv["id"], "999", headers={"Idempotency-Key": "abc"}, status=422)
    assert r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_concurrent_payments_cannot_overpay(owner, db):
    c = owner.customer()
    inv = owner.invoice(c["id"], "1000")
    results = []

    def worker():
        r = owner.client.post(
            f"/api/v1/invoices/{inv['id']}/payments",
            json={"amount": "700"},
            headers={"X-CSRF-Token": owner.csrf},
        )
        results.append(r.status_code)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == [201, 422, 422, 422]
    total = db.scalar(select(func.sum(Payment.amount)))
    assert str(total) == "700.00"


def test_payment_listing_filters(owner):
    a = owner.customer("A One")
    b = owner.customer("B Two")
    ia, ib = owner.invoice(a["id"], "100"), owner.invoice(b["id"], "200")
    owner.pay(ia["id"], "50")
    owner.pay(ib["id"], "60")
    assert owner.data(owner.get("/payments"))["total"] == 2
    only_b = owner.data(owner.get(f"/customers/{b['id']}/payments"))
    assert [p["amount"] for p in only_b["items"]] == ["60.00"]


# ----------------------------------------------------------------- bills
def test_bill_partial_payment_outflow_and_no_cash_effect_when_unpaid(owner, db):
    bill = owner.data(
        owner.post("/bills", {"vendor_name": "Landlord", "amount": "25000", "category": "rent"}), 201
    )
    assert bill["outstanding"] == "25000.00"
    assert db.scalar(select(func.count()).select_from(CashTransaction)) == 0
    assert owner.data(owner.get("/cashflow/position"))["current_cash"] == "50000.00"
    paid = owner.data(owner.post(f"/bills/{bill['id']}/payments", {"amount": "10000"}), 201)
    assert paid["bill"]["outstanding"] == "15000.00"
    assert paid["bill"]["payment_status"] == "partially_paid"
    assert owner.data(owner.get("/cashflow/position"))["current_cash"] == "40000.00"
    r = owner.post(f"/bills/{bill['id']}/payments", {"amount": "15000.01"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "OVERPAYMENT"
    r = owner.patch(f"/bills/{bill['id']}", {"amount": "5000"})
    assert r.json()["error"]["code"] == "AMOUNT_BELOW_PAID"
    detail = owner.data(owner.get(f"/bills/{bill['id']}"))
    assert len(detail["payments"]) == 1


def test_bill_overdue_filter(owner):
    today_ = today()
    owner.post(
        "/bills",
        {
            "vendor_name": "Old",
            "amount": "100",
            "bill_date": (today_ - timedelta(days=20)).isoformat(),
            "due_date": (today_ - timedelta(days=5)).isoformat(),
        },
    )
    owner.post("/bills", {"vendor_name": "New", "amount": "100"})
    od = owner.data(owner.get("/bills", params={"status": "overdue"}))
    assert [b["vendor_name"] for b in od["items"]] == ["Old"]
    assert od["items"][0]["is_overdue"] is True


# ----------------------------------------------------------------- commitments
def test_commitments_cannot_exceed_outstanding(owner):
    c = owner.customer()
    inv = owner.invoice(c["id"], "1000")
    when = (today() + timedelta(days=5)).isoformat()
    ok = owner.post(
        "/payment-commitments",
        {"customer_id": c["id"], "invoice_id": inv["id"], "amount": "600", "expected_payment_date": when},
    )
    assert ok.status_code == 201
    r = owner.post(
        "/payment-commitments",
        {"customer_id": c["id"], "invoice_id": inv["id"], "amount": "401", "expected_payment_date": when},
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "COMMITMENT_EXCEEDS_OUTSTANDING"
    # customer-level commitments are capped by total outstanding too
    r = owner.post(
        "/payment-commitments", {"customer_id": c["id"], "amount": "401", "expected_payment_date": when}
    )
    assert r.status_code == 422


def test_commitment_fulfilled_when_invoice_paid(owner):
    c = owner.customer()
    inv = owner.invoice(c["id"], "1000")
    cm = owner.data(
        owner.post(
            "/payment-commitments",
            {
                "customer_id": c["id"],
                "invoice_id": inv["id"],
                "amount": "1000",
                "expected_payment_date": (today() + timedelta(days=3)).isoformat(),
            },
        ),
        201,
    )
    owner.pay(inv["id"], "1000")
    listed = owner.data(owner.get("/payment-commitments", params={"customer_id": c["id"]}))
    assert listed["items"][0]["id"] == cm["id"]
    assert listed["items"][0]["status"] == "fulfilled"


def test_commitment_rejects_invoice_of_other_customer(owner):
    a, b = owner.customer("A"), owner.customer("B")
    inv = owner.invoice(a["id"], "100")
    r = owner.post(
        "/payment-commitments",
        {
            "customer_id": b["id"],
            "invoice_id": inv["id"],
            "amount": "10",
            "expected_payment_date": today().isoformat(),
        },
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVOICE_CUSTOMER_MISMATCH"


# ----------------------------------------------------------------- receivables
def test_receivables_reconcile_with_invoices(owner):
    today_ = today()
    a, b = owner.customer("Alpha"), owner.customer("Beta")
    i1 = owner.invoice(
        a["id"], "1000", invoice_date=today_ - timedelta(days=60), due_date=today_ - timedelta(days=45)
    )
    owner.invoice(a["id"], "500")
    i3 = owner.invoice(
        b["id"], "2000", invoice_date=today_ - timedelta(days=20), due_date=today_ - timedelta(days=5)
    )
    owner.pay(i1["id"], "250")
    owner.pay(i3["id"], "2000")
    summary = owner.data(owner.get("/receivables/summary"))
    assert summary["total_outstanding"] == "1250.00"
    assert summary["total_overdue"] == "750.00"
    assert summary["ageing"]["31_60"] == "750.00"
    assert summary["ageing"]["current"] == "500.00"
    assert summary["partially_paid_invoice_count"] == 1
    rows = owner.data(owner.get("/receivables", params={"status": "overdue"}))
    assert [r["invoice_number"] for r in rows["items"]] == [i1["invoice_number"]]
    assert rows["items"][0]["ageing_bucket"] == "31_60"
    listed_total = sum(float(r["outstanding"]) for r in owner.data(owner.get("/receivables"))["items"])
    assert f"{listed_total:.2f}" == summary["total_outstanding"]


# ----------------------------------------------------------------- isolation
def test_cross_business_access_is_blocked(owner, db, client):
    c = owner.customer("Private Customer")
    inv = owner.invoice(c["id"], "999")
    bill = owner.data(owner.post("/bills", {"vendor_name": "V", "amount": "10"}), 201)

    from fastapi.testclient import TestClient

    _, other_user = make_business(db, name="Other Biz")
    with TestClient(client.app) as other_client:
        other = Api(other_client, other_user.email)
        assert other.get(f"/customers/{c['id']}").status_code == 404
        assert other.get(f"/invoices/{inv['id']}").status_code == 404
        assert other.get(f"/bills/{bill['id']}").status_code == 404
        assert other.pay(inv["id"], "1", status=404).status_code == 404
        assert other.patch(f"/customers/{c['id']}", {"notes": "x"}).status_code == 404
        assert other.data(other.get("/customers"))["total"] == 0
        assert other.data(other.get("/receivables/summary"))["total_outstanding"] == "0.00"
        assert other.data(other.get("/audit-logs"))["total"] == 1  # only its own login
        r = other.post(
            "/invoices", {"customer_id": c["id"], "items": [{"description": "x", "unit_price": "1"}]}
        )
        assert r.status_code == 404
