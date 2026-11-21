from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select

from app.models import AuditLog, CashTransaction, Invoice, Payment, PaymentCommitment
from tests.conftest import today


def _forecast(owner, horizon=90):
    return owner.data(owner.get("/cashflow/forecast", params={"horizon_days": horizon}))


def _balance_on(fc, d):
    return next(p["balance"] for p in fc["points"] if p["date"] == d.isoformat())


def test_forecast_uses_due_dates_and_remaining_balances(owner):
    t = today()
    c = owner.customer()
    inv = owner.invoice(c["id"], "10000", due_date=t + timedelta(days=10))
    owner.pay(inv["id"], "4000")  # cash 54000, remaining 6000 expected on day 10
    bill = owner.data(
        owner.post(
            "/bills", {"vendor_name": "V", "amount": "3000", "due_date": (t + timedelta(days=5)).isoformat()}
        ),
        201,
    )
    owner.post(f"/bills/{bill['id']}/payments", {"amount": "1000"})  # cash 53000, remaining 2000
    fc = _forecast(owner)
    assert fc["current_cash"] == "53000.00"
    assert fc["opening_cash"] == "50000.00"
    assert fc["expected_inflows"] == "6000.00"
    assert fc["expected_outflows"] == "2000.00"
    assert _balance_on(fc, t + timedelta(days=4)) == "53000.00"
    assert _balance_on(fc, t + timedelta(days=5)) == "51000.00"
    assert _balance_on(fc, t + timedelta(days=10)) == "57000.00"
    assert fc["balance_30_days"] == fc["balance_60_days"] == fc["balance_90_days"] == "57000.00"
    assert fc["lowest_balance"] == "51000.00"
    assert fc["value_type"] == "projected"
    assert len(fc["points"]) == 91


def test_commitment_moves_timing_without_double_counting(owner):
    t = today()
    c = owner.customer()
    inv = owner.invoice(c["id"], "10000", due_date=t + timedelta(days=30))
    owner.post(
        "/payment-commitments",
        {
            "customer_id": c["id"],
            "invoice_id": inv["id"],
            "amount": "4000",
            "expected_payment_date": (t + timedelta(days=7)).isoformat(),
        },
    )
    fc = _forecast(owner)
    assert fc["expected_inflows"] == "10000.00"  # not 14000
    kinds = sorted((e["kind"], e["amount"], e["date"]) for e in fc["events"])
    assert kinds == [
        ("commitment", "4000.00", (t + timedelta(days=7)).isoformat()),
        ("invoice_due", "6000.00", (t + timedelta(days=30)).isoformat()),
    ]


def test_commitment_capped_after_partial_payment(owner):
    t = today()
    c = owner.customer()
    inv = owner.invoice(c["id"], "10000", due_date=t + timedelta(days=30))
    owner.post(
        "/payment-commitments",
        {
            "customer_id": c["id"],
            "invoice_id": inv["id"],
            "amount": "8000",
            "expected_payment_date": (t + timedelta(days=7)).isoformat(),
        },
    )
    owner.pay(inv["id"], "5000")
    fc = _forecast(owner)
    assert fc["expected_inflows"] == "5000.00"
    assert [e["amount"] for e in fc["events"]] == ["5000.00"]


def test_customer_level_commitment_allocated_once(owner):
    t = today()
    c = owner.customer()
    owner.invoice(c["id"], "3000", due_date=t + timedelta(days=10))
    owner.invoice(c["id"], "2000", due_date=t + timedelta(days=20))
    owner.post(
        "/payment-commitments",
        {
            "customer_id": c["id"],
            "amount": "4000",
            "expected_payment_date": (t + timedelta(days=3)).isoformat(),
        },
    )
    fc = _forecast(owner)
    assert fc["expected_inflows"] == "5000.00"
    assert sorted(e["amount"] for e in fc["events"]) == ["1000.00", "4000.00"]


def test_overdue_invoice_uses_collection_assumption(owner):
    t = today()
    c = owner.customer()
    owner.invoice(c["id"], "2500", invoice_date=t - timedelta(days=40), due_date=t - timedelta(days=10))
    fc = _forecast(owner)
    ev = fc["events"][0]
    assert ev["kind"] == "overdue_assumption"
    assert ev["date"] == (t + timedelta(days=30)).isoformat()
    assert _balance_on(fc, t) == "50000.00"  # not collected today
    owner.patch("/business/settings", {"overdue_collection_delay_days": 5})
    assert _forecast(owner)["events"][0]["date"] == (t + timedelta(days=5)).isoformat()


def test_shortfall_detected_with_lowest_point(owner):
    t = today()
    owner.post(
        "/bills", {"vendor_name": "Big", "amount": "70000", "due_date": (t + timedelta(days=8)).isoformat()}
    )
    c = owner.customer()
    owner.invoice(c["id"], "40000", due_date=t + timedelta(days=20))
    fc = _forecast(owner)
    assert fc["lowest_balance"] == "-20000.00"
    assert fc["lowest_balance_date"] == (t + timedelta(days=8)).isoformat()
    sf = fc["shortfalls"][0]
    assert sf["start"] == (t + timedelta(days=8)).isoformat()
    assert sf["end"] == (t + timedelta(days=19)).isoformat()
    assert fc["warnings"]


def test_forecast_weekly_granularity_and_horizon(owner):
    fc = owner.data(owner.get("/cashflow/forecast", params={"horizon_days": 30, "granularity": "weekly"}))
    assert fc["balance_60_days"] is None
    assert len(fc["points"]) == 5
    assert owner.get("/cashflow/forecast", params={"horizon_days": 0}).status_code == 422


def _counts(db):
    return tuple(
        db.scalar(select(func.count()).select_from(m))
        for m in (Invoice, Payment, PaymentCommitment, CashTransaction, AuditLog)
    )


def test_simulation_delays_largest_customer_without_mutation(owner, db):
    t = today()
    small, big = owner.customer("Small"), owner.customer("Big Buyer")
    owner.invoice(small["id"], "1000", due_date=t + timedelta(days=5))
    big_inv = owner.invoice(big["id"], "60000", due_date=t + timedelta(days=10))
    owner.post(
        "/bills", {"vendor_name": "Rent", "amount": "80000", "due_date": (t + timedelta(days=15)).isoformat()}
    )
    before = _counts(db)
    baseline = _forecast(owner)

    sim = owner.data(owner.post("/cashflow/simulate", {"largest_customer": True, "delay_days": 15}))
    assert sim["is_simulation"] is True
    assert sim["target_label"] == "Big Buyer"
    assert sim["shifted_inflows"][0]["simulated_date"] == (t + timedelta(days=25)).isoformat()
    assert sim["baseline_lowest_balance"] == baseline["lowest_balance"] == "31000.00"
    assert sim["simulated_lowest_balance"] == "-29000.00"
    assert sim["lowest_balance_difference"] == "-60000.00"
    assert sim["new_shortfall_dates"][0] == (t + timedelta(days=15)).isoformat()
    assert "no records were changed" in sim["explanation"]

    # actual records untouched
    db.expire_all()
    assert _counts(db) == before
    assert _forecast(owner)["points"] == baseline["points"]
    detail = owner.data(owner.get(f"/invoices/{big_inv['id']}"))
    assert detail["due_date"] == (t + timedelta(days=10)).isoformat()
    assert detail["outstanding"] == "60000.00"


def test_simulation_by_invoice_and_validation(owner):
    t = today()
    c = owner.customer()
    inv = owner.invoice(c["id"], "5000", due_date=t + timedelta(days=5))
    sim = owner.data(owner.post("/cashflow/simulate", {"invoice_id": inv["id"], "delay_days": 10}))
    assert sim["target_type"] == "invoice"
    r = owner.post("/cashflow/simulate", {"delay_days": 10})
    assert r.status_code == 422
    r = owner.post("/cashflow/simulate", {"customer_id": c["id"], "invoice_id": inv["id"], "delay_days": 10})
    assert r.status_code == 422


def test_dashboard_reflects_real_data(owner):
    t = today()
    c = owner.customer()
    inv = owner.invoice(c["id"], "8000", invoice_date=t - timedelta(days=30), due_date=t - timedelta(days=3))
    owner.pay(inv["id"], "3000")
    owner.post(
        "/bills", {"vendor_name": "Power", "amount": "1200", "due_date": (t + timedelta(days=2)).isoformat()}
    )
    d = owner.data(owner.get("/dashboard"))
    assert d["cash"]["current_cash"] == "53000.00"
    assert d["receivables"]["total_outstanding"] == "5000.00"
    assert d["receivables"]["total_overdue"] == "5000.00"
    assert d["partially_paid_invoice_count"] == 1
    assert d["upcoming_bills_total"] == "1200.00"
    assert d["recent_payments"][0]["amount"] == "3000.00"
    assert any(a["type"] == "overdue_receivables" for a in d["alerts"])
    assert d["recent_activity"]
    insights = owner.data(owner.get("/insights"))
    assert {i["type"] for i in insights} >= {"overdue_receivables", "bills_due"}


def test_opening_cash_excludes_movements_before_opening_date(owner, db):
    t = today()
    c = owner.customer()
    inv = owner.invoice(c["id"], "1000", invoice_date=t - timedelta(days=60), due_date=t - timedelta(days=50))
    r = owner.post(
        f"/invoices/{inv['id']}/payments",
        {"amount": "400", "payment_date": (t - timedelta(days=45)).isoformat()},
    )
    assert r.status_code == 201
    # opening_cash_as_of is today-30: the older payment is already part of the opening balance
    assert owner.data(owner.get("/cashflow/position"))["current_cash"] == "50000.00"
    assert Decimal(owner.data(owner.get(f"/invoices/{inv['id']}"))["outstanding"]) == Decimal("600")
