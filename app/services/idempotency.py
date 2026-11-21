"""Canonical request fingerprints for idempotent payment requests.

One `Idempotency-Key` stands for exactly one validated payment request. The fingerprint is a SHA-256 over
a canonical JSON form of every field that affects the financial operation:

    v, business_id, operation, target_id, amount, payment_date, payment_method, reference, notes

Canonicalisation rules (applied to validated values):
- amount: quantised to 2 places and rendered as a plain decimal string ("400" and "400.00" are equal).
- payment_date: ISO date exactly as sent, or null when omitted. An omitted date means "today when
  processed", so a retry on a later day without a date must still match the original request.
- payment_method: the validated enum value.
- reference / notes: null, "" and whitespace-only are the same (no value); any other text is kept
  exactly, so meaningful differences (including case) produce a different fingerprint.
- Serialisation: sorted keys, no whitespace, UTF-8.

Rows recorded before fingerprints existed have `request_fingerprint IS NULL`. Whether their original
request carried a date cannot be reconstructed, so they are not backfilled; `legacy_mismatch` compares
their stored columns strictly instead (date compared only when the retry sends one).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date
from decimal import Decimal
from typing import Literal

from app.utils.money import money_str, q2

Operation = Literal["invoice_payment", "bill_payment"]
FINGERPRINT_VERSION = 1


def clean_text(value: str | None) -> str | None:
    """No value for None, "" or whitespace-only; otherwise the exact text."""
    if value is None or value.strip() == "":
        return None
    return value


def canonical_payment(
    *,
    business_id: uuid.UUID,
    operation: Operation,
    target_id: uuid.UUID,
    amount: Decimal,
    payment_date: date | None,
    payment_method: str,
    reference: str | None,
    notes: str | None,
) -> dict:
    return {
        "v": FINGERPRINT_VERSION,
        "business_id": str(business_id),
        "operation": operation,
        "target_id": str(target_id),
        "amount": money_str(q2(amount)),
        "payment_date": payment_date.isoformat() if payment_date else None,
        "payment_method": payment_method,
        "reference": clean_text(reference),
        "notes": clean_text(notes),
    }


def fingerprint(canonical: dict) -> str:
    raw = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def legacy_mismatch(
    existing,
    *,
    target_matches: bool,
    amount: Decimal,
    payment_date: date | None,
    payment_method: str,
    reference: str | None,
    notes: str | None,
) -> bool:
    """Strict comparison for a payment stored without a fingerprint (see module docstring)."""
    return (
        not target_matches
        or existing.amount != q2(amount)
        or existing.payment_method != payment_method
        or clean_text(existing.reference) != clean_text(reference)
        or clean_text(getattr(existing, "notes", None)) != clean_text(notes)
        or (payment_date is not None and existing.payment_date != payment_date)
    )
