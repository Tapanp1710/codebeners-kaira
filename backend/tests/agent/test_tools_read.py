"""Read tools of the live agent against PostgreSQL with the seeded demo business.

No LLM is involved here (tools are called directly through the orchestrator's execution path); nothing is
mocked except that no provider is configured. Expected figures come from app/seed.py:
Ramesh Kumar 18,000 - 6,000 paid = 12,000 on INV-0001 (promise 4,000), Lakshmi Stores 22,500 overdue,
Sri Venkateswara Enterprises 150,000 + 45,000, Anjali Textiles paid in full; bills rent 25,000 (10,000 paid),
electricity 4,800, stock 95,000, salaries 60,000; opening cash 85,000 -> current cash 111,000."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select

from app.models import AgentToolExecution, Payment
from tests.agent.conftest import counts
from tests.conftest import today


def test_get_customer_exact_decimal_strings(demo):
    r = demo.tool("get_customer", {"customer_name": "Ramesh"})
    assert r["customer_id"] == str(demo.ramesh.id)
    assert r["customer"] == "Ramesh Kumar"
    assert r["outstanding"] == "12000.00"
    assert r["overdue"] == "0.00"
    assert r["oldest_days_overdue"] == 0
    [inv] = r["open_invoices"]
    assert inv["invoice_number"] == demo.inv_ramesh.invoice_number
    assert (inv["total"], inv["paid"], inv["outstanding"]) == ("18000.00", "6000.00", "12000.00")
    assert inv["status"] == "partially_paid"
    assert [p["amount"] for p in r["recent_payments"]] == ["6000.00"]
    assert [p["amount"] for p in r["pending_promises"]] == ["4000.00"]
    # every money value is an exact 2-decimal string, never a float
    for v in (r["outstanding"], r["overdue"], inv["total"]):
        assert isinstance(v, str) and Decimal(v).as_tuple().exponent == -2


def test_get_customer_by_id_and_overdue_customer(demo):
    r = demo.tool("get_customer", {"customer_id": str(demo.lakshmi.id)})
    assert r["outstanding"] == "22500.00"
    assert r["overdue"] == "22500.00"
    assert r["oldest_days_overdue"] == 20


def test_get_customer_unknown_name_needs_clarification(demo):
    r = demo.tool("get_customer", {"customer_name": "Zubair Electricals"})
    assert r["status"] == "needs_clarification"
    assert "outstanding" not in r


def test_receivables_overview_totals(demo):
    r = demo.tool("receivables_overview", {})
    assert r["total_outstanding"] == "229500.00"
    assert r["total_overdue"] == "22500.00"
    assert r["open_invoices"] == 4
    assert r["overdue_invoices"] == 1
    assert r["pending_promises_total"] == "4000.00"
    assert [(d["name"], d["outstanding"]) for d in r["top_debtors"]] == [
        ("Sri Venkateswara Enterprises", "195000.00"),
        ("Lakshmi Stores", "22500.00"),
        ("Ramesh Kumar", "12000.00"),
    ]
    assert sum(Decimal(v) for v in r["ageing"].values()) == Decimal("229500.00")


def test_list_payments_total_is_sql_sum_not_page_sum(demo):
    api = demo.api()
    major_inv = api.data(api.get("/invoices", params={"customer_id": str(demo.major.id)}))["items"]
    target = next(i for i in major_inv if i["outstanding"] == "150000.00")
    for _ in range(25):
        api.pay(target["id"], "100.33")
    r = demo.tool("list_payments", {"date_from": today().isoformat(), "date_to": today().isoformat()})
    assert r["count"] == 25
    assert len(r["payments"]) == 20  # one page only
    assert r["total_received"] == "2508.25"  # 25 x 100.33 exactly, not the 20 listed (2006.60)
    # whole period, one customer
    r = demo.tool(
        "list_payments",
        {"customer_name": "Ramesh Kumar", "date_from": (today() - timedelta(days=30)).isoformat()},
    )
    assert (r["count"], r["total_received"]) == (1, "6000.00")
    # a window that excludes Anjali's payment (28 days ago) but includes Ramesh's (10 days ago)
    r = demo.tool("list_payments", {"date_from": (today() - timedelta(days=15)).isoformat()})
    assert r["total_received"] == "8508.25"


def test_business_summary_money_in_and_out(demo):
    r = demo.tool(
        "business_summary",
        {
            "period": "custom",
            "date_from": (today() - timedelta(days=30)).isoformat(),
            "date_to": today().isoformat(),
        },
    )
    assert r["money_in"] == "36000.00"  # 6,000 (Ramesh) + 30,000 (Anjali)
    assert r["money_out"] == "10000.00"  # rent part-payment
    assert r["net"] == "26000.00"
    assert r["current_cash"] == "111000.00"
    r = demo.tool("business_summary", {"period": "today"})
    assert (r["money_in"], r["money_out"]) == ("0.00", "0.00")
    assert r["from"] == r["to"] == today().isoformat()


def test_cash_forecast_is_consistent(demo):
    r = demo.tool("cash_forecast", {"horizon_days": 90})
    assert r["current_cash"] == "111000.00"
    assert r["horizon_days"] == 90
    assert r["expected_outflows"] == "174800.00"  # 15,000 + 4,800 + 95,000 + 60,000 unpaid bills
    assert Decimal(r["balance_at_end"]) == Decimal(r["current_cash"]) + Decimal(
        r["expected_inflows"]
    ) - Decimal(r["expected_outflows"])
    assert Decimal(r["lowest_balance"]) <= Decimal(r["current_cash"])
    assert set(r["milestones"]) >= {"in_30_days", "in_60_days", "in_90_days"}


def test_simulate_late_payment_changes_nothing(demo, db):
    before = counts(db)
    r = demo.tool("simulate_late_payment", {"largest_customer": True, "delay_days": 30})
    assert r["hypothetical"] is True
    assert "Sri Venkateswara" in r["target"]
    assert Decimal(r["simulated_lowest"]) <= Decimal(r["baseline_lowest"])
    r2 = demo.tool("simulate_late_payment", {"customer_name": "Ramesh", "delay_days": 45})
    assert r2["hypothetical"] is True and "Ramesh" in r2["target"]
    assert counts(db) == before  # no business row of any kind was written
    # only the tool execution records exist
    assert db.scalar(select(func.count()).select_from(AgentToolExecution)) == 2


def test_list_bills_due_window(demo):
    r = demo.tool("list_bills", {"due_within_days": 7})
    assert sorted((b["vendor"], b["outstanding"]) for b in r["bills"]) == [
        ("Shop landlord", "15000.00"),
        ("TSSPDCL", "4800.00"),
    ]
    assert (r["count"], r["outstanding_sum"]) == (2, "19800.00")
    r = demo.tool("list_bills", {"due_within_days": 30})
    assert (r["count"], r["outstanding_sum"]) == (4, "174800.00")
    r = demo.tool("list_bills", {"due_within_days": 0})
    assert r["count"] == 0


def test_invoice_status(demo):
    r = demo.tool("invoice_status", {"invoice_number": demo.inv_ramesh.invoice_number.lower()})
    assert r["invoice_number"] == demo.inv_ramesh.invoice_number
    assert (r["total"], r["paid"], r["outstanding"], r["status"]) == (
        "18000.00",
        "6000.00",
        "12000.00",
        "partially_paid",
    )
    r = demo.tool("invoice_status", {"invoice_number": "INV-9999"})
    assert r["status"] == "needs_clarification"


def test_read_tools_never_write_payments(demo, db):
    before = db.scalar(select(func.count()).select_from(Payment))
    for name, args in [
        ("find_customers", {"query": "Ram"}),
        ("list_invoices", {"status": "open"}),
        ("list_promises", {}),
        ("recent_activity", {}),
        ("pending_confirmations", {}),
    ]:
        r = demo.tool(name, args)
        assert r.get("status") != "error", (name, r)
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Payment)) == before
