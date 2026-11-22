"""Mandatory end-to-end scenario (spec section 17.3) against PostgreSQL, through the HTTP API
exactly as the frontend calls it (cookies + CSRF). AI extraction uses the deterministic rules
provider; no external provider is involved."""

from datetime import timedelta

from sqlalchemy import func, select

from app.models import AuditLog, CashTransaction, Invoice, Payment, PaymentCommitment
from app.seed import seed_demo
from tests.conftest import TEST_PASSWORD, Api, today

DEMO = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday."


def _snapshot(db):
    db.expire_all()
    return tuple(
        db.scalar(select(func.count()).select_from(m))
        for m in (Invoice, Payment, PaymentCommitment, CashTransaction, AuditLog)
    )


def test_seed_is_idempotent(db):
    seed_demo(db, owner_email="demo@kaira.local", owner_password=TEST_PASSWORD)
    db.commit()
    first = _snapshot(db)
    seed_demo(db, owner_email="demo@kaira.local", owner_password=TEST_PASSWORD)
    db.commit()
    assert _snapshot(db) == first


def test_full_demo_workflow(client, db):
    seed_demo(db, owner_email="demo@kaira.local", owner_password=TEST_PASSWORD)
    db.commit()

    # 1. login + dashboard
    api = Api(client, "demo@kaira.local")
    dash = api.data(api.get("/dashboard"))
    assert dash["cash"]["current_cash"] == "111000.00"  # 85000 + 6000 + 30000 - 10000
    assert dash["receivables"]["total_outstanding"] == "229500.00"
    assert dash["receivables"]["total_overdue"] == "22500.00"

    # 2. create customer + invoice + partial payment, verify balance
    cust = api.customer("Prakash General Stores")
    inv = api.invoice(cust["id"], "9000")
    paid = api.pay(inv["id"], "4000")
    assert paid["invoice"]["outstanding"] == "5000.00"
    rec = api.data(api.get("/receivables", params={"search": "Prakash"}))
    assert rec["items"][0]["outstanding"] == "5000.00"

    # 3. typed business request -> proposal with resolved customer and invoice
    proposal = api.data(api.post("/assistant/extract", {"transcript": DEMO}))["proposal"]
    assert proposal["can_approve"] is True
    ramesh_invoice = proposal["operations"][0]["invoice"]["id"]
    assert proposal["operations"][0]["customer"]["label"] == "Ramesh Kumar"
    assert proposal["operations"][1]["computed"]["remaining_amount"] == "7000.00"

    # 4. approve -> payment in PostgreSQL, audit, cash
    approved = api.data(api.post(f"/actions/{proposal['id']}/approve"))["action"]
    assert approved["status"] == "executed"
    payment = db.scalar(select(Payment).where(Payment.source_action_id == proposal["id"]))
    assert payment is not None and str(payment.amount) == "5000.00"
    cash_row = db.scalar(select(CashTransaction).where(CashTransaction.source_id == payment.id))
    assert cash_row.direction == "inflow" and str(cash_row.amount) == "5000.00"
    audit_types = set(
        db.scalars(select(AuditLog.action_type).where(AuditLog.source_action_id == proposal["id"]))
    )
    assert {"payment.recorded", "commitment.created", "action.approved"} <= audit_types
    assert api.data(api.get(f"/invoices/{ramesh_invoice}"))["outstanding"] == "7000.00"

    # 5. refreshed dashboard / receivables / forecast
    dash2 = api.data(api.get("/dashboard"))
    assert dash2["cash"]["current_cash"] == "120000.00"  # 111000 + 4000 + 5000
    assert dash2["receivables"]["total_outstanding"] == "229500.00"  # -5000 Ramesh +5000 Prakash
    forecast = api.data(api.get("/cashflow/forecast"))
    commit_events = [e for e in forecast["events"] if e["kind"] == "commitment"]
    assert [(e["amount"], e["customer_name"]) for e in commit_events] == [("7000.00", "Ramesh Kumar")]

    # 6. 15-day delay of the major customer: simulation only
    before = _snapshot(db)
    sim = api.data(api.post("/cashflow/simulate", {"largest_customer": True, "delay_days": 15}))
    assert sim["target_label"] == "Sri Venkateswara Enterprises"
    assert sim["simulated_lowest_balance"] < sim["baseline_lowest_balance"] or sim["new_shortfall_dates"]
    assert sim["new_shortfall_dates"], (
        "delaying the major customer should create a shortfall in the demo data"
    )
    assert _snapshot(db) == before
    assert api.data(api.get("/cashflow/forecast"))["points"] == forecast["points"]
    major_due = today() + timedelta(days=12)
    major = api.data(api.get("/invoices", params={"search": "Venkateswara", "sort": "due_date"}))["items"][0]
    assert major["due_date"] == major_due.isoformat()
