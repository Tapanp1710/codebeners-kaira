"""Idempotent development seed. Running it repeatedly never duplicates records.

Creates one demo business, its owner, customers (Ramesh with partial payment and a
commitment, an overdue customer, a major customer), bills (one partially paid, others
unpaid) and consistent cash movements. Dates are relative to the day the seed first runs, so the
scenarios (due soon, overdue, upcoming commitment) drift as days pass. `reset_demo` (CLI:
`python -m app.cli seed --reset`, development/test only) deletes the demo business so the next seed is
anchored to today again.
Every money movement goes through the same services as the API (cash + audit rows)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models import Bill, Business, Customer, Invoice, PaymentCommitment, User
from app.services import (
    bill_service,
    commitment_service,
    customer_service,
    invoice_service,
    payment_service,
)
from app.utils.dates import business_today

logger = logging.getLogger(__name__)
DEMO_BUSINESS_NAME = "KAIRA Demo Traders"


@dataclass
class _Actor:
    business_id: object
    user_id: object
    business: Business


def _customer(db: Session, actor: _Actor, name: str, **data) -> Customer:
    existing = db.scalar(
        select(Customer).where(Customer.business_id == actor.business_id, Customer.name == name)
    )
    return existing or customer_service.create(db, actor, {"name": name, **data})


def _invoice(db, actor, customer, tag: str, invoice_date: date, due_date: date, items) -> Invoice:
    marker = f"[seed:{tag}]"
    existing = db.scalar(
        select(Invoice).where(Invoice.business_id == actor.business_id, Invoice.notes == marker)
    )
    return existing or invoice_service.create_invoice(
        db,
        actor,
        customer_id=customer.id,
        items=items,
        invoice_date=invoice_date,
        due_date=due_date,
        notes=marker,
    )


def _pay(db, actor, invoice, tag: str, amount: str, when: date, method: str) -> None:
    payment_service.record_customer_payment(
        db,
        actor,
        invoice_id=invoice.id,
        amount=Decimal(amount),
        payment_date=when,
        payment_method=method,
        idempotency_key=f"seed:{tag}",
    )


def _bill(db, actor, tag: str, **data) -> Bill:
    marker = f"[seed:{tag}]"
    existing = db.scalar(select(Bill).where(Bill.business_id == actor.business_id, Bill.notes == marker))
    return existing or bill_service.create_bill(db, actor, {**data, "notes": marker})


# Children before parents, so RESTRICT foreign keys (payments -> invoices, invoices -> customers, ...)
# are never hit. Every table here is scoped by business_id; refresh tokens and invoice items follow
# their users / invoices through ON DELETE CASCADE.
_RESET_ORDER = (
    "payment_attempts",
    "audit_logs",
    "cash_transactions",
    "payments",
    "bill_payments",
    "payment_commitments",
    "proposed_actions",
    "conversations",
    "invoices",
    "bills",
    "customers",
    "users",
)


def reset_demo(db: Session, *, owner_email: str) -> bool:
    """Deletes the demo business (and only it) so the next seed starts from today's dates.

    Development/test only; the CLI refuses it in staging/production. Matches the business by BOTH the demo
    owner's email and DEMO_BUSINESS_NAME, so a real business can never be selected. Returns False when
    there is no demo business to reset."""
    owner = db.scalar(select(User).where(User.email == owner_email.lower()))
    if owner is None:
        return False
    business = db.get(Business, owner.business_id)
    if business is None or business.name != DEMO_BUSINESS_NAME:
        raise ValueError(
            f"Refusing to reset: {owner_email} does not belong to the demo business '{DEMO_BUSINESS_NAME}'."
        )
    for table in _RESET_ORDER:
        db.execute(text(f"DELETE FROM {table} WHERE business_id = :b"), {"b": business.id})
    db.execute(text("DELETE FROM businesses WHERE id = :b"), {"b": business.id})
    db.flush()
    logger.info("Demo business %s reset", business.id)
    return True


def seed_demo(db: Session, *, owner_email: str, owner_password: str, timezone: str = "Asia/Kolkata") -> dict:
    owner = db.scalar(select(User).where(User.email == owner_email.lower()))
    created = owner is None
    today = business_today(timezone)
    if owner is None:
        business = Business(
            name=DEMO_BUSINESS_NAME,
            business_type="Wholesale & retail trading",
            currency="INR",
            timezone=timezone,
            opening_cash_balance=Decimal("85000.00"),
            opening_cash_as_of=today - timedelta(days=60),
            overdue_collection_delay_days=30,
            low_cash_threshold=Decimal("10000.00"),
        )
        db.add(business)
        db.flush()
        owner = User(
            business_id=business.id,
            name="Demo Owner",
            email=owner_email.lower(),
            password_hash=hash_password(owner_password),
            role="owner",
        )
        db.add(owner)
        db.flush()
    business = db.get(Business, owner.business_id)
    actor = _Actor(business.id, owner.id, business)
    # Anchor all relative dates to the business's opening date so re-runs stay consistent.
    base = business.opening_cash_as_of + timedelta(days=60)

    ramesh = _customer(db, actor, "Ramesh Kumar", phone="9848012345", notes="Regular customer, pays by UPI")
    lakshmi = _customer(db, actor, "Lakshmi Stores", phone="9000011111", address="Kothapet, Hyderabad")
    major = _customer(
        db, actor, "Sri Venkateswara Enterprises", phone="9123456780", email="accounts@sve.example"
    )
    anjali = _customer(db, actor, "Anjali Textiles", phone="9988776655")

    inv_r = _invoice(
        db,
        actor,
        ramesh,
        "ramesh-1",
        base - timedelta(days=20),
        base + timedelta(days=10),
        [
            {
                "description": "Basmati rice 25kg bags",
                "quantity": Decimal("6"),
                "unit_price": Decimal("2000.00"),
            },
            {"description": "Toor dal 10kg", "quantity": Decimal("4"), "unit_price": Decimal("1500.00")},
        ],
    )  # 18,000
    _pay(db, actor, inv_r, "ramesh-1-p1", "6000.00", base - timedelta(days=10), "upi")
    if not db.scalar(select(PaymentCommitment.id).where(PaymentCommitment.notes == "[seed:ramesh-commit]")):
        commitment_service.create_commitment(
            db,
            actor,
            customer_id=ramesh.id,
            invoice_id=inv_r.id,
            amount=Decimal("4000.00"),
            expected_payment_date=base + timedelta(days=5),
            notes="[seed:ramesh-commit]",
        )

    _invoice(
        db,
        actor,
        lakshmi,
        "lakshmi-1",
        base - timedelta(days=50),
        base - timedelta(days=20),
        [
            {
                "description": "Sunflower oil 15L tins",
                "quantity": Decimal("9"),
                "unit_price": Decimal("2500.00"),
            },
        ],
    )  # 22,500 overdue

    _invoice(
        db,
        actor,
        major,
        "major-1",
        base - timedelta(days=15),
        base + timedelta(days=12),
        [
            {
                "description": "Bulk FMCG supply - November",
                "quantity": Decimal("1"),
                "unit_price": Decimal("150000.00"),
            },
        ],
    )
    _invoice(
        db,
        actor,
        major,
        "major-2",
        base - timedelta(days=2),
        base + timedelta(days=40),
        [
            {
                "description": "Festive season stock",
                "quantity": Decimal("1"),
                "unit_price": Decimal("45000.00"),
            },
        ],
    )

    inv_a = _invoice(
        db,
        actor,
        anjali,
        "anjali-1",
        base - timedelta(days=40),
        base - timedelta(days=25),
        [
            {
                "description": "Packaging material",
                "quantity": Decimal("100"),
                "unit_price": Decimal("300.00"),
            },
        ],
    )  # 30,000 paid in full
    _pay(db, actor, inv_a, "anjali-1-p1", "30000.00", base - timedelta(days=28), "bank_transfer")

    rent = _bill(
        db,
        actor,
        "rent",
        vendor_name="Shop landlord",
        description="Shop rent - December",
        category="rent",
        amount=Decimal("25000.00"),
        bill_date=base - timedelta(days=5),
        due_date=base + timedelta(days=3),
    )
    payment_service.record_bill_payment(
        db,
        actor,
        bill_id=rent.id,
        amount=Decimal("10000.00"),
        payment_date=base - timedelta(days=4),
        payment_method="bank_transfer",
        idempotency_key="seed:rent-p1",
    )
    _bill(
        db,
        actor,
        "electricity",
        vendor_name="TSSPDCL",
        description="Electricity bill",
        category="utilities",
        amount=Decimal("4800.00"),
        bill_date=base - timedelta(days=8),
        due_date=base + timedelta(days=6),
    )
    _bill(
        db,
        actor,
        "stock",
        vendor_name="Godavari Wholesale Suppliers",
        description="Stock purchase",
        category="inventory",
        amount=Decimal("95000.00"),
        bill_date=base - timedelta(days=6),
        due_date=base + timedelta(days=14),
    )
    _bill(
        db,
        actor,
        "salaries",
        vendor_name="Staff salaries",
        description="December salaries",
        category="payroll",
        amount=Decimal("60000.00"),
        bill_date=base,
        due_date=base + timedelta(days=20),
    )
    db.flush()
    return {
        "business_id": str(business.id),
        "owner_email": owner.email,
        "created_owner": created,
        "today": today.isoformat(),
    }
