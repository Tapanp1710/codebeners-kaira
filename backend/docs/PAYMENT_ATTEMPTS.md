# Payment attempts and cross-device recovery

**Status:** implemented on `feat/payment-integrity` (migration `d50345d81159`); execution lease and
reconciliation added by migration `b3f1c7a9e2d4`.
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
| `execution_started_at`, `execution_started_by` | When and by whom the latest execution started (kept after completion) |
| `lease_owner`, `lease_expires_at` | The live execution lease: an opaque random token (never a secret) and its expiry, in database time. Cleared on any terminal state |
| `last_reconciled_at` | When the reconciler last examined it |

Constraints enforced by PostgreSQL:
- `UNIQUE (business_id, idempotency_key)`
- `UNIQUE (business_id, resource_type, resource_id) WHERE status = 'pending'`: at most one unresolved payment per
  invoice or bill.
- Lease checks: owner and expiry are set together; a lease implies `execution_started_at` and expires after it;
  only `pending` attempts hold a lease.

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
- **A `pending` attempt never expires on a timer.** Its outcome may be unknown, and backend keys never expire
  either. Only the reconciler (below) resolves a stale attempt, and only from proof.
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

## Execution lease and reconciliation

**Execution** runs in two transactions:
1. Lock the attempt row, record `execution_started_at/by`, a fresh `lease_owner` and `lease_expires_at`
   (now + 2 minutes, never shortened), audit `payment_attempt.execution_started`, and **commit**. No money has moved.
2. Lock the attempt row again, re-check it is still `pending` (it may have been resolved in between), then record
   the payment and the attempt's terminal state together as before. The lease is cleared in the same commit.

A crash during (2) rolls everything back except the lease, which then simply expires.

**Reconciliation** (`python -m app.cli reconcile-payment-attempts`) handles pending attempts registered more than
`--older-than-minutes` ago (default 30, minimum 1), oldest first, at most `--limit` (default 500) per run,
optionally for one `--business-id`. Each attempt gets its own short transaction:
1. `SELECT … FOR UPDATE SKIP LOCKED` claims one attempt. A row that an execution, a cancel or another worker is
   holding is skipped, never waited on and never handled twice.
2. It re-checks that the attempt is still pending and still old enough, then takes the invoice or bill lock. That
   waits out any direct payment with the same key that is still in flight. Lock order stays attempt, then resource.
3. Only now is the lookup by key conclusive:

| Found under the key, under both locks | Result | Audit |
|---|---|---|
| A payment with the attempt's request (fingerprint, or legacy field match) | `succeeded`, linked to that payment. Nothing new is recorded | `payment_attempt.succeeded`, `via: reconciler`, `reason: payment_found_under_key` |
| A payment with a *different* request | stays `pending` (`key_bound_to_different_payment`); needs a person | none |
| No payment, and a lease that has not expired | stays `pending` (`execution_lease_active`) | none |
| No payment, and no execution started or the lease expired | `cancelled` (`never_executed` / `lease_expired_no_payment`) | `payment_attempt.cancelled`, `via: reconciler` |

Elapsed time alone never cancels anything: the expired lease only says no execution should still be about to
run, and the key lookup inside the locked transaction is the proof that nothing was recorded. After a cancel, the
attempt can never execute (`409`). Reconciler audit rows have no `user_id` (a system action). `last_reconciled_at`
is updated on every attempt examined, including those left pending.

`--dry-run` takes the same locks, makes the same decisions and rolls back. `--json` prints a machine-readable
report. Output never contains idempotency keys or request bodies. Any number of workers can run at once, and a
crashed or restarted worker simply runs again: all state is in the database, and every outcome is idempotent.

Not covered: a client that reuses a cancelled attempt's own key on the direct `POST /invoices/{id}/payments`
endpoint would still record a payment there, as with a manual cancel. Server-generated keys are never returned,
so only client-supplied keys can do this.

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

`tests/api/test_reconciliation.py` (16 tests, real PostgreSQL) covers the lease committed before money moves and
released on completion or rejection; a payment committed while the attempt stayed pending (invoice and bill),
linked without new money; cancellation of never-executed attempts; recent attempts left alone; a live lease
keeping an attempt pending until it expires; an expired lease with a payment present (linked, not cancelled); a
key bound to a different payment; dry run; business filter; two concurrent workers handling every attempt exactly
once; a worker skipping a row locked by an execution; execute racing reconcile; and the CLI run in a fresh process
(dry run, apply, idempotent rerun, argument errors).
