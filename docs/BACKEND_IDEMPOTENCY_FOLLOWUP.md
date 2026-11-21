# Backend follow-up: payment idempotency fingerprint

**For:** the KAIRA backend owner.
**Status:** proposed. Nothing in the backend repository has been changed.
**Backend version reviewed:** `357bc56` (`app/services/payment_service.py`).

## Summary

A payment request can be retried with the same `Idempotency-Key` but different details. If only the payment date,
method, reference or notes changed, the backend silently returns the original payment as a successful replay. The
caller believes the payment was recorded with the new details when it was not.

The fix is to compare all of the payment's financially relevant fields when a key is reused, and to reject a mismatch
with the existing `IDEMPOTENCY_KEY_REUSED` error.

The KAIRA frontend does not depend on this change and is not affected by it. It freezes the whole request body for as
long as a key is in use, so its retries always match exactly.

## Current behaviour

`record_payment` (invoices, around line 70) and `record_bill_payment` (bills, around line 214) both look up an existing
payment with the same business and `Idempotency-Key`. They compare only two things:

| Endpoint | Fields compared on reuse | Fields not compared |
|---|---|---|
| `POST /invoices/{id}/payments` | `invoice_id`, `amount` | `payment_date`, `payment_method`, `reference`, `notes` |
| `POST /bills/{id}/payments` | `bill_id`, `amount` | `payment_date`, `payment_method`, `reference` |

If both match, the stored payment is returned with `replayed: true` and status 201. If either differs, the response is
422 `IDEMPOTENCY_KEY_REUSED`.

### Reproduced on a disposable backend (2026-11-22)

All three requests used the same key, `probe-key-1`, against one bill:

| # | Request body | Response | What the response says was stored |
|---|---|---|---|
| 1 | 400.00, 2026-11-20, cash, `R-1` | 201, `replayed: false` | 400.00, 2026-11-20, cash, `R-1` |
| 2 | 400.00, **2026-11-05, cheque, `CHQ-99`** | **201, `replayed: true`** | 400.00, 2026-11-20, cash, `R-1` |
| 3 | **401.00**, 2026-11-20, cash, `R-1` | 422 `IDEMPOTENCY_KEY_REUSED` | — |

Request 2 is the problem. The caller asked for a cheque payment dated 5 November and got a success response, but the
ledger holds a cash payment dated 20 November. Payment date drives the cash position and the forecast, and method and
reference are what get reconciled against bank statements. These are financially relevant fields.

## Proposed change

### Option A (recommended): compare the stored columns, no migration needed

When a key is reused, compare every field that was supplied in the request. Reject with the existing error if any of
them differ.

```python
# record_bill_payment, inside `if existing is not None:`
mismatch = (
    existing.bill_id != bill.id
    or existing.amount != amount
    or existing.payment_method != payment_method
    or (existing.reference or None) != (reference or None)
    # payment_date may be omitted ("today"): compare only when the caller sent one, so a retry made
    # the next day without a date still replays instead of failing.
    or (payment_date is not None and existing.payment_date != payment_date)
)
if mismatch:
    raise BusinessRuleError(
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used for a payment with different details.",
        {"field_mismatch": True},
    )
return existing, False
```

Make the same change in `record_payment`, and also compare `notes` there, because invoice payments store notes.

Two details to get right:
- **Normalise before comparing.** `amount` is already quantised with `q2`. Treat a null reference and an empty
  reference (and the same for notes) as equal, using whatever stripping the create path already applies.
- **Assistant-executed actions.** `action_service.py` derives its own keys and passes the same fields when it retries,
  so it is unaffected. The existing `tests/api/test_assistant.py` idempotency test should still be run to confirm.

### Option B: store a request fingerprint

Add a `request_fingerprint` column (a SHA-256 of the canonical request fields, keeping `payment_date` exactly as sent)
and compare it when a key is reused. Existing rows would have a null fingerprint and fall back to Option A's check.

This is stricter, and it extends to fields that aren't stored as columns. It needs an Alembic migration, and gains
little over Option A for today's schema.

## Tests to add (backend)

`tests/api/test_finance_core.py` has an idempotency test for invoice payments only. There is none for bill payments.
Add:

1. **Bill payment replay:** pay a bill twice with the same key and body. Expect `replayed: true`, the same payment id,
   and exactly one row each in `bill_payments`, `cash_transactions` and `audit_logs` (`bill_payment.recorded`).
2. **Changed amount:** same key, different amount → 422 `IDEMPOTENCY_KEY_REUSED`. This is the current behaviour, now
   covered for bills.
3. **Changed details:** same key with a different `payment_date`, `payment_method` or `reference` (and, for invoices,
   `notes`) → 422 `IDEMPOTENCY_KEY_REUSED`, with no new rows. This test fails today.
4. **Omitted date:** same key, `payment_date` omitted on both requests, with the business date moved forward between
   them → still a replay. This guards the "compare only when sent" rule.
5. **Replay after full payment:** the first request pays the bill in full and the retry uses the same key. Expect a
   replay, not `BILL_ALREADY_PAID`. This works today because the key lookup runs before the balance check; the test
   pins that ordering.

## Related observations (no change required)

- **Keys never expire.** There is a unique constraint on `(business_id, idempotency_key)` and no TTL. The frontend
  relies on this: an uncertain attempt saved in the browser can be retried days later and still replay. Please treat
  "keys do not expire" as part of the contract, or tell the frontend before adding expiry.
- **Concurrent requests with the same key.**
  - For the same bill or invoice, the `SELECT … FOR UPDATE` row lock serialises them and the second one replays.
  - For different bills or invoices, both can pass the lookup. The second insert then hits the unique constraint and
    becomes 409 `CONFLICT` through the generic `IntegrityError` handler.
  - The frontend treats 409 as "outcome unknown" and keeps its attempt, which is safe. Mapping this case to
    `IDEMPOTENCY_KEY_REUSED` would be more precise.
- **Replay status code.** Replays return 201, the same as a new payment. Clients must read `replayed`. The frontend
  does, and shows "already recorded; no duplicate was created".
