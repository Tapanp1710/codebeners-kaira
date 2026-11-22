# Payment attempts and cross-device recovery

**Status:** implemented on `feat/payment-integrity` (migration `d50345d81159`).
**Audience:** backend and frontend engineers.

## Problem

A payment whose HTTP response is lost has an unknown outcome. Before this change, the only way to recover was the
browser that sent it, because only that browser knew its `Idempotency-Key`. Another browser, another device, or the
same browser after its storage was cleared could not find the payment. A user there could end up paying a second time.

## Decision (DECISIONS.md #20)

The server owns a registry of **payment attempts**. Before any money moves, a client registers the intended payment.
The server freezes the `Idempotency-Key` and the canonical request (and its fingerprint). Executing the attempt runs
the normal payment path with that key, so a retry either records the payment once or replays it.

Any authorised user of the business can list unresolved attempts and resume them from any device.

Alternatives considered:
- **Browser storage only** (the frontend's previous design): it can't reach other devices or survive cleared
  storage.
- **A lookup by idempotency key** (`GET /payments?idempotency_key=`): the client would still have to keep the key,
  which brings back the same device limit.
- **Making the existing payment endpoints asynchronous:** a large change for no extra safety.

The existing `POST /invoices/{id}/payments` and `POST /bills/{id}/payments` endpoints stay as they are. They're still
used by older clients and by the assistant's approval flow, which runs server-side in one transaction.

## Data model: `payment_attempts`

| Column | Notes |
|---|---|
| `id` | Server-owned id; clients act on attempts by this id |
| `business_id` | Every query is scoped to the caller's business |
| `resource_type`, `resource_id` | `invoice` or `bill`, plus its id |
| `idempotency_key` | Server-generated (`pa_` + 128 random bits) unless the client supplies one. Never returned |
| `request_fingerprint`, `request_payload` | The canonical request (`app/services/idempotency.py`) and its SHA-256 |
| `status` | `pending`, `succeeded`, `rejected` or `cancelled` |
| `payment_id` | Set exactly when `succeeded` (CHECK constraint) |
| `failure_code`, `failure_message` | Set when `rejected` |
| `created_by`, `created_at`, `updated_at`, `completed_at` | Who registered it and when |

Constraints enforced by PostgreSQL:
- `UNIQUE (business_id, idempotency_key)`
- `UNIQUE (business_id, resource_type, resource_id) WHERE status = 'pending'`: at most one unresolved payment per
  invoice or bill.

## State machine

```
            execute: recorded or replayed                 terminal
 pending ─────────────────────────────────────────► succeeded
    │      execute: processed 4xx (404/422)
    ├─────────────────────────────────────────────► rejected      terminal, nothing recorded
    │      cancel, only if no payment under the key
    └─────────────────────────────────────────────► cancelled     terminal
```

Rules for these transitions:
- **Terminal states never change.**
- **A `pending` attempt never expires.** Its outcome may be unknown, and backend keys never expire either.
- **Executing a `succeeded` attempt** returns the original payment with `replayed: true`.
- **Executing a `rejected` attempt** returns the same 422 again.
- **Executing a `cancelled` attempt** returns 409.
- **Errors other than 404 or 422 during execution** (database or server failures) leave the attempt `pending`.

## API (`/api/v1/payment-attempts`, cookie session and CSRF as usual; any role, like the payment endpoints)

| Method and path | Result |
|---|---|
| `POST /payment-attempts` | **201**: a new pending attempt.<br>**200**: an existing attempt, either for the same client key with the same request, or for the same request with no key (a lost registration response or another device).<br>**409 `PAYMENT_ATTEMPT_PENDING`** (with `details.attempt_id`): a *different* request while another attempt is pending.<br>**422 `IDEMPOTENCY_KEY_REUSED`**: a client key that is already bound to a different request.<br>If the client key is already on a *recorded* payment with the same request, the attempt is created as `succeeded` and linked to that payment. This is how locally saved browser attempts are migrated. |
| `GET /payment-attempts?status=&resource_type=&resource_id=&page=&page_size=` | A page of attempts, each with `resource_label` (invoice number or vendor) |
| `GET /payment-attempts/{id}` | The attempt, plus `result` once it has `succeeded` |
| `POST /payment-attempts/{id}/execute` | **200** with `result.replayed` false or true.<br>**422**: rejected (the attempt is now `rejected`; nothing was recorded).<br>**409**: cancelled.<br>**Network error or 5xx**: unknown, so GET the attempt or execute again. Either is always safe. |
| `POST /payment-attempts/{id}/cancel` | **200** `cancelled`.<br>**409 `PAYMENT_ATTEMPT_NOT_PENDING`**: already succeeded or rejected.<br>**409 `PAYMENT_ALREADY_RECORDED`**: a payment exists under the key, so the attempt is reconciled to `succeeded`. |

## Transactional guarantees

- **Atomic execution.** Execution locks the attempt row (`SELECT … FOR UPDATE`) and then the invoice or bill row. The
  payment, its cash transaction, the `payment.recorded` / `bill_payment.recorded` audit entry and the attempt's
  transition to `succeeded` commit in **one transaction**. A crash before commit leaves `pending` with nothing
  recorded; a crash after commit leaves `succeeded`.
- **Concurrent executions** serialise on the attempt lock. Exactly one records the payment, and the others replay it.
- **Cancellation is safe.** It holds the attempt lock (so no execution can be in flight) and the invoice or bill lock
  (so a direct payment with the same key that is still in flight finishes first). It cancels only if no payment
  exists under the key.
- **No deadlocks.** Locks are always taken in the same order: attempt, then invoice or bill. Registration takes only
  the invoice or bill lock.
- **Audit trail.** Every transition is audited: `payment_attempt.registered`, `succeeded`, `rejected` and
  `cancelled` (entity `payment_attempt`).

## Verified by

`tests/api/test_payment_attempts.py` (22 tests) and `tests/api/test_payment_idempotency.py` (26 tests) run on real
PostgreSQL. They cover:
- registration, its replay and its conflicts;
- linking a payment that was already recorded;
- recovery from a lost response on another device (separate client and user);
- retry after a server restart (a new app instance);
- a crash before commit;
- replay after a full invoice or bill payment;
- definitive rejection;
- unauthenticated access and access from another business;
- concurrent registrations and retries;
- safe, refused and reconciling cancellation;
- concurrent execute against cancel.
