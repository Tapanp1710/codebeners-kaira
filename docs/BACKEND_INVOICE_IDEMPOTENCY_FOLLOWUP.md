# Backend follow-up: invoice payment idempotency

**For:** the KAIRA backend owner.
**Status:** proposed. Nothing in the backend repository has been changed.
**Backend version reviewed:** `357bc56`: `payment_service.record_customer_payment` and `POST /api/v1/invoices/{id}/payments`.
**Related:** `BACKEND_IDEMPOTENCY_FOLLOWUP.md` covers the same issue for bill payments.

## Summary

Reusing a payment's `Idempotency-Key` with the same amount but a different payment date, method, reference or
**notes** returns success with `replayed: true` and the original details. The caller is told their payment was
recorded with the new details when it was not. The fix is to compare those fields when a key is reused, and to reject
any mismatch with the existing `IDEMPOTENCY_KEY_REUSED` error.

The frontend needs no backend change to be safe. It freezes the whole request body for as long as a key is in use, so
its retries always match exactly. The change protects every other client.

## What the frontend relies on (please keep)

All of these were verified against a real backend:

| Behaviour | Where | Why it matters |
|---|---|---|
| The key is looked up before the void, already-paid and overpayment checks | `record_customer_payment`, around line 70 | A retry still replays after the lost payment has fully paid the invoice. Verified: 201 `replayed: true` on an invoice whose balance is now 0 |
| Keys never expire (unique constraint on `(business_id, idempotency_key)`, no TTL) | `models/invoice.py`, around line 78 | The browser keeps an uncertain attempt until it is resolved, possibly days later |
| Payment, cash inflow and audit entry are written in one transaction | `record_customer_payment` plus `db.commit()` in the endpoint | A lost response never leaves a partial write behind. Verified: 1 / 1 / 1 per invoice after lost-response recovery |
| A key collision between concurrent requests becomes 409 `CONFLICT` | `core/handlers.py`, `IntegrityError` handler | The frontend treats 409 as "outcome unknown" and keeps the same key |
| Replays return the stored payment and the invoice's *current* summary | the endpoint's response builder | The confirmation shows the real remaining balance |

## Gap: replay ignores everything except invoice and amount

```python
# payment_service.record_customer_payment (current)
if existing is not None:
    if existing.invoice_id != invoice.id or existing.amount != amount:
        raise BusinessRuleError("IDEMPOTENCY_KEY_REUSED", ...)
    return PaymentResult(existing, created=False)
```

### Reproduced on a disposable backend (2026-11-22)

All requests used the same key, `inv-probe-1`:

| # | Request | Response | Payment returned |
|---|---|---|---|
| 1 | invoice A: 400.00, 2026-11-20, cash, `R-1`, notes "first" | 201, `replayed: false` | 400.00, 2026-11-20, cash, `R-1`, "first" |
| 2 | invoice A: 400.00, **2026-11-05, cheque, `CHQ-99`, "changed"** | **201, `replayed: true`** | 400.00, 2026-11-20, cash, `R-1`, "first" |
| 3 | invoice A: **401.00**, same details as #1 | 422 `IDEMPOTENCY_KEY_REUSED` | — |
| 4 | **invoice B**: 400.00, same details as #1 | 422 `IDEMPOTENCY_KEY_REUSED` | — |
| 5 | invoice A: body #1, after another payment fully paid the invoice | 201, `replayed: true` | the original #1 |

Request 2 is the problem. The payment date drives the cash position, the ageing and the forecast; the method and
reference are what get reconciled against bank statements; and the notes are the record of what was agreed.

## Required change

Compare every financially relevant field the caller sent, and reject a mismatch:

```python
# payment_service.record_customer_payment, replacing the check inside `if existing is not None:`
mismatch = (
    existing.invoice_id != invoice.id
    or existing.amount != amount
    or existing.payment_method != payment_method
    or (existing.reference or None) != (reference or None)
    or (existing.notes or None) != (notes or None)
    # payment_date may be omitted ("today"): compare only when the caller sent one, so a retry made the next
    # day without a date still replays instead of failing.
    or (payment_date is not None and existing.payment_date != payment_date)
)
if mismatch:
    raise BusinessRuleError(
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used for a payment with different details.",
        {"field_mismatch": True},
    )
return PaymentResult(existing, created=False)
```

Notes on this change:
- **Normalise before comparing**, using the same treatment as the insert path. `amount` is already quantised with
  `q2`. Treat a null reference or notes and an empty one as equal, so a client that sends `null` and one that sends
  `""` aren't rejected against each other.
- **Assistant-executed payments.** `action_service.py` passes `idempotency_key` and `expected_customer_id`, and reuses
  the same operation fields on retry, so it is unaffected. Re-run `tests/api/test_assistant.py`
  (`test_approval_executes_transactionally_and_is_idempotent`) to confirm.
- **Ordering.** In the assistant path, the `INVOICE_CUSTOMER_MISMATCH` check runs before the key lookup. That is fine
  as long as `expected_customer_id` is deterministic for an action, which it is today. Keep the key lookup ahead of
  the void, already-paid and overpayment checks.
- **Alternative: a stored request fingerprint.** A SHA-256 of the canonical request, with `payment_date` kept exactly
  as sent, compared on reuse. It needs a migration and gains little over the column comparison for today's schema.
  `BACKEND_IDEMPOTENCY_FOLLOWUP.md` describes it.

## Tests to add (backend)

`tests/api/test_finance_core.py::test_idempotency_key_prevents_duplicate_payment` already covers replaying the same
body and rejecting a different amount. Add:

1. **Changed details:** same key and amount, but a different `payment_date`, `payment_method`, `reference` or `notes`
   (one test per field) → 422 `IDEMPOTENCY_KEY_REUSED`, with no new rows in `payments`, `cash_transactions` or
   `audit_logs`. This fails today.
2. **Different invoice:** same key on another invoice → 422 `IDEMPOTENCY_KEY_REUSED`. This is the current behaviour,
   pinned by the test.
3. **Omitted date:** same key, no `payment_date` on either request, with the business date moved forward between
   them → replay.
4. **Replay after full payment:** the first request pays the invoice in full, then the same request again → 201
   `replayed: true`, not `INVOICE_ALREADY_PAID`. Also test a full payment made by *another* payment in between,
   as probe 5 above did.
5. **Exactly once:** after a replay, exactly one `payments` row, one `cash_transactions` row (`source_type='payment'`,
   inflow) and one `payment.recorded` audit entry for the key.

## Out of scope for the frontend

**Cross-device recovery.** An uncertain payment saved in one browser is invisible to another browser or device. Doing
that would need a backend capability, for example `GET /payments?idempotency_key=…` returning the payment recorded
under a key, or a 404. With that, any client could resolve an unknown outcome without resending the payment. No such
endpoint exists today, and the frontend doesn't assume one.
