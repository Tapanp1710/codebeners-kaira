"""Server-side payment attempts: register, inspect, execute (retry) and safely cancel.

Why: a payment whose response was lost must be recoverable from any authorised device, not only from the
browser that sent it. An attempt freezes the Idempotency-Key and the canonical request *before* money
moves; executing it runs the normal payment path with that key, so a retry either records the payment once
or replays it (app/services/payment_service.py, app/services/idempotency.py).

Guarantees (PostgreSQL-enforced where possible):
- One attempt per (business, Idempotency-Key): unique constraint.
- At most one pending attempt per invoice/bill: partial unique index; a second registration with a
  different request gets 409 PAYMENT_ATTEMPT_PENDING with the existing attempt's id.
- Execution and the pending -> succeeded transition commit in one transaction with the payment, the cash
  transaction and the audit entry. A crash before commit leaves the attempt pending with nothing recorded.
- Concurrent executions of one attempt serialise on its row lock (SELECT ... FOR UPDATE); the second sees
  `succeeded` and returns the original result.
- Cancellation is allowed only for a pending attempt while holding its row lock and the invoice/bill row
  lock, and only when no payment exists under its key. Otherwise the attempt stays recoverable.
- Pending attempts never expire on their own. Execution first commits an execution lease (who, when, until
  when) in a short transaction of its own, so other workers can see an execution may be in flight.
- Reconciliation (`reconcile_pending`, CLI `reconcile-payment-attempts`) resolves stale pending attempts only
  from proof found while holding the attempt row lock and the invoice/bill row lock: a matching payment under
  the key -> succeeded and linked; no payment under the key and no live lease -> cancelled; anything else
  stays pending. Elapsed time alone never cancels anything.
- Direct payments (POST /invoices/{id}/payments, /bills/{id}/payments and every other caller of
  payment_service.record_*_payment) respect attempts, under the same invoice/bill row lock: while an attempt
  for the invoice/bill is pending they are refused with 409 PAYMENT_ATTEMPT_PENDING unless they carry that
  attempt's own key and exact request, in which case they record (or replay) the payment once and mark the
  attempt succeeded; a key belonging to a cancelled attempt is refused (409 PAYMENT_ATTEMPT_CANCELLED), one
  belonging to a rejected attempt gets that attempt's rejection. See `lock_for_direct_payment`,
  `guard_direct_payment` and `link_direct_payment`.

Lock order everywhere is attempt row, then invoice/bill row (registration takes only the invoice/bill row).
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.exceptions import AppError, ConflictError, NotFoundError, ValidationAppError
from app.db.base import utcnow
from app.models import Bill, Invoice, PaymentAttempt
from app.schemas.payment_attempts import PaymentAttemptCreate
from app.services import audit_service, idempotency, payment_service
from app.utils.money import ZERO, q2

# Errors from the payment path that mean "processed and refused; nothing was recorded".
DEFINITIVE_STATUS_CODES = (404, 422)

# How long an execution claims an attempt. The payment itself commits in milliseconds and holds the attempt
# row lock throughout, so this only has to cover the gap between the claim commit and that lock.
EXECUTION_LEASE = timedelta(minutes=2)


@dataclass
class Registration:
    attempt: PaymentAttempt
    created: bool


@dataclass
class Outcome:
    attempt: PaymentAttempt
    replayed: bool = False
    error: AppError | None = None


def _model(resource_type: str):
    return Invoice if resource_type == "invoice" else Bill


def _lock_resource(
    db: Session, business_id: uuid.UUID, resource_type: str, resource_id: uuid.UUID, *, required: bool = True
):
    model = _model(resource_type)
    row = db.scalar(
        select(model).where(model.id == resource_id, model.business_id == business_id).with_for_update()
    )
    if row is None and required:
        raise NotFoundError(f"{resource_type.capitalize()} not found.")
    return row


def _db_now(db: Session) -> datetime:
    # Database time, so leases mean the same thing to every worker regardless of host clocks.
    return db.scalar(select(func.now()))


def _canonical(actor, data: PaymentAttemptCreate) -> tuple[dict, str]:
    amount = q2(data.amount)
    if amount <= ZERO:
        raise ValidationAppError("Payment amount must be greater than zero.")
    payment_service.check_method(data.payment_method)
    if data.resource_type == "bill" and idempotency.clean_text(data.notes) is not None:
        raise ValidationAppError("Bill payments do not take notes.")
    canonical = idempotency.canonical_payment(
        business_id=actor.business_id,
        operation="invoice_payment" if data.resource_type == "invoice" else "bill_payment",
        target_id=data.resource_id,
        amount=amount,
        payment_date=data.payment_date,
        payment_method=data.payment_method,
        reference=data.reference,
        notes=data.notes,
    )
    return canonical, idempotency.fingerprint(canonical)


def _recorded_under_key(db: Session, attempt: PaymentAttempt):
    if attempt.resource_type == "invoice":
        return payment_service.payment_by_key(db, attempt.business_id, attempt.idempotency_key)
    return payment_service.bill_payment_by_key(db, attempt.business_id, attempt.idempotency_key)


def _matches(recorded, attempt: PaymentAttempt) -> bool:
    """Does a payment recorded under the attempt's key correspond to the attempt's exact request?"""
    p = attempt.request_payload
    if recorded.request_fingerprint is not None:
        return recorded.request_fingerprint == attempt.request_fingerprint
    target = recorded.invoice_id if attempt.resource_type == "invoice" else recorded.bill_id
    return not idempotency.legacy_mismatch(
        recorded,
        target_matches=target == attempt.resource_id,
        amount=Decimal(p["amount"]),
        payment_date=date.fromisoformat(p["payment_date"]) if p["payment_date"] else None,
        payment_method=p["payment_method"],
        reference=p["reference"],
        notes=p["notes"],
    )


def _audit(db: Session, actor, attempt: PaymentAttempt, action: str, extra: dict | None = None) -> None:
    """actor=None records a system action (the reconciler)."""
    after = {
        "status": attempt.status,
        "resource_type": attempt.resource_type,
        "resource_id": str(attempt.resource_id),
        "payment_id": str(attempt.payment_id) if attempt.payment_id else None,
        "failure_code": attempt.failure_code,
    }
    after.update(extra or {})
    audit_service.record(
        db,
        business_id=attempt.business_id,
        user_id=actor.user_id if actor is not None else None,
        action_type=f"payment_attempt.{action}",
        entity_type="payment_attempt",
        entity_id=attempt.id,
        after=after,
    )


def _release_lease(attempt: PaymentAttempt) -> None:
    attempt.lease_owner = None
    attempt.lease_expires_at = None


def _succeed(attempt: PaymentAttempt, payment_id: uuid.UUID) -> None:
    attempt.status = "succeeded"
    attempt.payment_id = payment_id
    attempt.completed_at = utcnow()
    _release_lease(attempt)


def _cancel(attempt: PaymentAttempt) -> None:
    attempt.status = "cancelled"
    attempt.completed_at = utcnow()
    _release_lease(attempt)


def register(db: Session, actor, data: PaymentAttemptCreate) -> Registration:
    canonical, fp = _canonical(actor, data)
    # Serialises registrations, executions and direct payments for this invoice/bill.
    _lock_resource(db, actor.business_id, data.resource_type, data.resource_id)

    if data.idempotency_key:
        existing = db.scalar(
            select(PaymentAttempt).where(
                PaymentAttempt.business_id == actor.business_id,
                PaymentAttempt.idempotency_key == data.idempotency_key,
            )
        )
        if existing is not None:
            if existing.request_fingerprint != fp:
                raise payment_service.key_reused_error()
            return Registration(existing, created=False)

    pending = db.scalar(
        select(PaymentAttempt).where(
            PaymentAttempt.business_id == actor.business_id,
            PaymentAttempt.resource_type == data.resource_type,
            PaymentAttempt.resource_id == data.resource_id,
            PaymentAttempt.status == "pending",
        )
    )
    if pending is not None:
        # The same intended payment registered again without a key (another device, or a lost
        # registration response): hand back the existing attempt.
        if data.idempotency_key is None and pending.request_fingerprint == fp:
            return Registration(pending, created=False)
        raise ConflictError(
            f"Another payment for this {data.resource_type} is awaiting confirmation. Resolve it first.",
            {"attempt_id": str(pending.id)},
            code="PAYMENT_ATTEMPT_PENDING",
        )

    attempt = PaymentAttempt(
        business_id=actor.business_id,
        resource_type=data.resource_type,
        resource_id=data.resource_id,
        idempotency_key=data.idempotency_key or f"pa_{secrets.token_hex(16)}",
        request_fingerprint=fp,
        request_payload=canonical,
        status="pending",
        created_by=actor.user_id,
    )
    # A client may register a payment it already sent with its own key (for example one saved in the
    # browser before this registry existed). Link it to what was recorded, or refuse a mismatch.
    linked = False
    if data.idempotency_key:
        recorded = _recorded_under_key(db, attempt)
        if recorded is not None:
            if not _matches(recorded, attempt):
                raise payment_service.key_reused_error()
            _succeed(attempt, recorded.id)
            linked = True
    try:
        with db.begin_nested():
            db.add(attempt)
            db.flush()
    except IntegrityError:
        # Same client key registered concurrently for another invoice/bill (different row lock).
        existing = db.scalar(
            select(PaymentAttempt).where(
                PaymentAttempt.business_id == actor.business_id,
                PaymentAttempt.idempotency_key == attempt.idempotency_key,
            )
        )
        if existing is None:
            raise
        if existing.request_fingerprint != fp:
            raise payment_service.key_reused_error() from None
        return Registration(existing, created=False)
    _audit(db, actor, attempt, "registered", {"linked_existing_payment": linked})
    return Registration(attempt, created=True)


def get(db: Session, business_id: uuid.UUID, attempt_id: uuid.UUID, *, lock: bool = False) -> PaymentAttempt:
    q = select(PaymentAttempt).where(
        PaymentAttempt.id == attempt_id, PaymentAttempt.business_id == business_id
    )
    # populate_existing: a locked read must see the committed row, not a stale identity-map copy.
    attempt = db.scalar(q.with_for_update().execution_options(populate_existing=True) if lock else q)
    if attempt is None:
        raise NotFoundError("Payment attempt not found.")
    return attempt


def list_attempts(
    db: Session,
    business_id: uuid.UUID,
    *,
    status: str | None = None,
    resource_type: str | None = None,
    resource_id: uuid.UUID | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[PaymentAttempt], int]:
    q = select(PaymentAttempt).where(PaymentAttempt.business_id == business_id)
    if status:
        q = q.where(PaymentAttempt.status == status)
    if resource_type:
        q = q.where(PaymentAttempt.resource_type == resource_type)
    if resource_id:
        q = q.where(PaymentAttempt.resource_id == resource_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(
        q.order_by(PaymentAttempt.created_at.desc(), PaymentAttempt.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return list(rows), total


def _terminal_outcome(attempt: PaymentAttempt) -> Outcome | None:
    if attempt.status == "succeeded":
        return Outcome(attempt, replayed=True)
    if attempt.status == "rejected":
        return Outcome(
            attempt,
            error=AppError(attempt.failure_code or "PAYMENT_REJECTED", attempt.failure_message or "", 422),
        )
    if attempt.status == "cancelled":
        raise ConflictError("This payment attempt was cancelled.", code="PAYMENT_ATTEMPT_CANCELLED")
    return None


def _claim(db: Session, actor, attempt: PaymentAttempt, lease: timedelta) -> None:
    """Records who is executing and until when. The caller holds the attempt row lock and commits."""
    now = _db_now(db)
    attempt.execution_started_at = now
    attempt.execution_started_by = actor.user_id
    attempt.lease_owner = f"exec_{secrets.token_hex(12)}"
    # Never shorten a lease another execution may still rely on.
    expires = now + lease
    if attempt.lease_expires_at is not None and attempt.lease_expires_at > expires:
        expires = attempt.lease_expires_at
    attempt.lease_expires_at = expires
    _audit(db, actor, attempt, "execution_started", {"lease_expires_at": expires.isoformat()})


def execute(db: Session, actor, attempt_id: uuid.UUID, *, lease: timedelta = EXECUTION_LEASE) -> Outcome:
    """Runs (or re-runs) the frozen request with the attempt's key.

    Two transactions: (1) under the attempt lock, claim an execution lease and COMMIT it, so reconcilers can
    see an execution may be in flight; (2) re-lock the attempt, re-check it is still pending, and record the
    payment and the attempt's transition together. The caller commits (2), then raises `error`. A crash
    during (2) rolls back everything except the lease, which simply expires; the reconciler then proves
    from the key whether anything was recorded."""
    attempt = get(db, actor.business_id, attempt_id, lock=True)
    terminal = _terminal_outcome(attempt)
    if terminal is not None:
        return terminal
    _claim(db, actor, attempt, lease)
    db.commit()

    attempt = get(db, actor.business_id, attempt_id, lock=True)
    terminal = _terminal_outcome(attempt)  # resolved by someone else in between
    if terminal is not None:
        return terminal

    p = attempt.request_payload
    kwargs = dict(
        amount=Decimal(p["amount"]),
        payment_date=date.fromisoformat(p["payment_date"]) if p["payment_date"] else None,
        payment_method=p["payment_method"],
        reference=p["reference"],
        idempotency_key=attempt.idempotency_key,
    )
    # attempt_guard=False: this execution already holds the attempt and drives its transition itself. The
    # payment path still refuses a key bound to a different request (422 IDEMPOTENCY_KEY_REUSED -> rejected)
    # and replays a matching payment already recorded under the key (-> succeeded, replayed).
    try:
        with db.begin_nested():
            if attempt.resource_type == "invoice":
                res = payment_service.record_customer_payment(
                    db, actor, invoice_id=attempt.resource_id, notes=p["notes"], attempt_guard=False, **kwargs
                )
                payment_id, created = res.payment.id, res.created
            else:
                bp, created = payment_service.record_bill_payment(
                    db, actor, bill_id=attempt.resource_id, attempt_guard=False, **kwargs
                )
                payment_id = bp.id
    except AppError as e:
        if e.status_code not in DEFINITIVE_STATUS_CODES:
            raise
        attempt.status = "rejected"
        attempt.failure_code = e.code
        attempt.failure_message = e.message
        attempt.completed_at = utcnow()
        _release_lease(attempt)
        _audit(db, actor, attempt, "rejected")
        return Outcome(attempt, error=e)
    _succeed(attempt, payment_id)
    _audit(db, actor, attempt, "succeeded", {"replayed": not created})
    return Outcome(attempt, replayed=not created)


def cancel(db: Session, actor, attempt_id: uuid.UUID) -> Outcome:
    """Cancels a pending attempt only when no payment can exist under its key. Caller commits."""
    attempt = get(db, actor.business_id, attempt_id, lock=True)
    if attempt.status == "cancelled":
        return Outcome(attempt)
    if attempt.status != "pending":
        raise ConflictError(
            f"This payment attempt is already {attempt.status}.",
            {"status": attempt.status},
            code="PAYMENT_ATTEMPT_NOT_PENDING",
        )
    # Holding the attempt lock excludes a concurrent execution; the invoice/bill lock waits out any direct
    # payment with the same key that is still in flight.
    _lock_resource(db, actor.business_id, attempt.resource_type, attempt.resource_id)
    recorded = _recorded_under_key(db, attempt)
    if recorded is not None:
        if _matches(recorded, attempt):
            _succeed(attempt, recorded.id)
            _audit(db, actor, attempt, "succeeded", {"reconciled_on_cancel": True})
        return Outcome(
            attempt,
            error=ConflictError(
                "A payment was already recorded for this attempt, so it cannot be cancelled.",
                {"attempt_id": str(attempt.id)},
                code="PAYMENT_ALREADY_RECORDED",
            ),
        )
    _cancel(attempt)
    _audit(db, actor, attempt, "cancelled")
    return Outcome(attempt)


# --------------------------------------------------------------------------------------- direct payments


def lock_for_direct_payment(db: Session, business_id: uuid.UUID, key: str | None) -> PaymentAttempt | None:
    """Locks the attempt registered under `key`, if any. The direct payment path calls this *before* it takes
    the invoice/bill row lock, keeping the attempt -> invoice/bill lock order used everywhere else."""
    if not key:
        return None
    return db.scalar(
        select(PaymentAttempt)
        .where(PaymentAttempt.business_id == business_id, PaymentAttempt.idempotency_key == key)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def guard_direct_payment(
    db: Session,
    *,
    business_id: uuid.UUID,
    resource_type: str,
    resource_id: uuid.UUID,
    attempt: PaymentAttempt | None,
    fingerprint: str,
) -> None:
    """Raises unless a direct payment may record now. The caller holds the invoice/bill row lock (and the lock
    on `attempt`, the attempt registered under the request's key, if any) and has already ruled out an exact
    replay of a payment recorded under the key.

    - The key belongs to an attempt: the request behaves as that attempt. Cancelled -> 409
      PAYMENT_ATTEMPT_CANCELLED; a different request -> 422 IDEMPOTENCY_KEY_REUSED; rejected -> its rejection;
      pending -> may record (the caller then links the payment with `link_direct_payment`).
    - Otherwise any pending attempt for this invoice/bill blocks it: 409 PAYMENT_ATTEMPT_PENDING with the
      attempt id, so the pending payment is retried or cancelled first and can never be recorded twice."""
    if attempt is not None:
        if attempt.status == "cancelled":
            raise ConflictError(
                "This payment was cancelled, so it cannot be recorded with the same key. Start a new payment.",
                {"attempt_id": str(attempt.id)},
                code="PAYMENT_ATTEMPT_CANCELLED",
            )
        if attempt.request_fingerprint != fingerprint:
            raise payment_service.key_reused_error()
        if attempt.status == "rejected":
            raise AppError(attempt.failure_code or "PAYMENT_REJECTED", attempt.failure_message or "", 422)
        if attempt.status != "pending":
            # succeeded always links the payment recorded under the key, which the replay check finds first.
            raise ConflictError(
                "A payment was already recorded for this attempt.",
                {"attempt_id": str(attempt.id)},
                code="PAYMENT_ALREADY_RECORDED",
            )
        return
    pending = db.scalar(
        select(PaymentAttempt).where(
            PaymentAttempt.business_id == business_id,
            PaymentAttempt.resource_type == resource_type,
            PaymentAttempt.resource_id == resource_id,
            PaymentAttempt.status == "pending",
        )
    )
    if pending is not None:
        raise ConflictError(
            f"Another payment for this {resource_type} is awaiting confirmation. "
            "Retry or cancel it under pending payments first.",
            {"attempt_id": str(pending.id)},
            code="PAYMENT_ATTEMPT_PENDING",
        )


def link_direct_payment(db: Session, actor, attempt: PaymentAttempt | None, recorded) -> None:
    """A direct payment recorded (or replayed) under a pending attempt's key settles that attempt, using the
    reconciler's proof rule: only a payment matching the attempt's exact request is linked."""
    if attempt is None or attempt.status != "pending" or not _matches(recorded, attempt):
        return
    _succeed(attempt, recorded.id)
    _audit(db, actor, attempt, "succeeded", {"via": "direct_payment"})


# ---------------------------------------------------------------------------------------- reconciliation

RECONCILE_SUCCEEDED = "succeeded"  # a matching payment exists under the key: linked
RECONCILE_CANCELLED = "cancelled"  # proven never recorded and no live execution: cancelled
RECONCILE_PENDING = "left_pending"  # not provable either way (live lease, key conflict): untouched
RECONCILE_SKIPPED = "skipped"  # no longer pending or no longer old enough once locked


@dataclass
class ReconcileItem:
    attempt_id: uuid.UUID
    business_id: uuid.UUID
    resource_type: str
    resource_id: uuid.UUID
    outcome: str
    reason: str
    payment_id: uuid.UUID | None = None


@dataclass
class ReconcileReport:
    dry_run: bool
    items: list[ReconcileItem] = field(default_factory=list)

    def count(self, outcome: str) -> int:
        return sum(1 for i in self.items if i.outcome == outcome)


def reconcile_locked(
    db: Session, attempt: PaymentAttempt, *, now: datetime, cutoff: datetime, dry_run: bool, worker: str
) -> ReconcileItem:
    """Decides (and unless dry_run applies) one attempt. The caller holds the attempt row lock and commits.

    Proof rules. Holding the attempt lock excludes any execution's payment transaction (it holds the same
    lock from start to commit). Taking the invoice/bill lock waits out any direct payment with the same key
    that is still in flight. Only then is the lookup by key conclusive:
      - a payment under the key with the attempt's request -> succeeded, linked to that payment;
      - a payment under the key with another request       -> left pending (needs a human);
      - no payment, and no execution lease still running    -> cancelled (it can never execute after this);
      - no payment, but a live lease                        -> left pending (an execution may be about to run).
    """

    def item(outcome: str, reason: str, payment_id: uuid.UUID | None = None) -> ReconcileItem:
        return ReconcileItem(
            attempt.id,
            attempt.business_id,
            attempt.resource_type,
            attempt.resource_id,
            outcome,
            reason,
            payment_id,
        )

    if attempt.status != "pending":
        return item(RECONCILE_SKIPPED, f"already_{attempt.status}", attempt.payment_id)
    if attempt.created_at > cutoff:
        return item(RECONCILE_SKIPPED, "too_recent")

    _lock_resource(db, attempt.business_id, attempt.resource_type, attempt.resource_id, required=False)
    recorded = _recorded_under_key(db, attempt)
    extra = {"via": "reconciler", "worker": worker}
    if recorded is not None:
        if not _matches(recorded, attempt):
            if not dry_run:
                attempt.last_reconciled_at = now
            return item(RECONCILE_PENDING, "key_bound_to_different_payment")
        if not dry_run:
            attempt.last_reconciled_at = now
            _succeed(attempt, recorded.id)
            _audit(db, None, attempt, "succeeded", {**extra, "reason": "payment_found_under_key"})
        return item(RECONCILE_SUCCEEDED, "payment_found_under_key", recorded.id)

    if attempt.lease_expires_at is not None and attempt.lease_expires_at > now:
        if not dry_run:
            attempt.last_reconciled_at = now
        return item(RECONCILE_PENDING, "execution_lease_active")

    reason = "never_executed" if attempt.execution_started_at is None else "lease_expired_no_payment"
    if not dry_run:
        attempt.last_reconciled_at = now
        _cancel(attempt)
        _audit(db, None, attempt, "cancelled", {**extra, "reason": reason})
    return item(RECONCILE_CANCELLED, reason)


def reconcile_pending(
    session_factory: Callable[[], Session],
    *,
    older_than: timedelta,
    dry_run: bool = False,
    limit: int = 500,
    business_id: uuid.UUID | None = None,
) -> ReconcileReport:
    """Batch worker: reconciles pending attempts registered more than `older_than` ago, oldest first.

    Each attempt is handled in its own short transaction, claimed with SELECT ... FOR UPDATE SKIP LOCKED, so
    any number of workers (or a worker and live executions) can run at once: a row being executed or
    reconciled elsewhere is skipped, never waited on, and never handled twice. Nothing is held across
    attempts and all state is in the database, so a crashed or restarted worker just runs again.
    A dry run takes the same locks and makes the same decisions, then rolls back."""
    if older_than < timedelta(0):
        raise ValueError("older_than must not be negative")
    if limit < 1:
        raise ValueError("limit must be at least 1")
    report = ReconcileReport(dry_run=dry_run)
    worker = f"recon_{secrets.token_hex(6)}"
    seen: list[uuid.UUID] = []
    while len(report.items) < limit:
        db = session_factory()
        try:
            now = _db_now(db)
            cutoff = now - older_than
            q = select(PaymentAttempt).where(
                PaymentAttempt.status == "pending", PaymentAttempt.created_at <= cutoff
            )
            if business_id is not None:
                q = q.where(PaymentAttempt.business_id == business_id)
            if seen:
                q = q.where(PaymentAttempt.id.not_in(seen))
            attempt = db.scalar(
                q.order_by(PaymentAttempt.created_at, PaymentAttempt.id)
                .limit(1)
                .with_for_update(skip_locked=True)
                .execution_options(populate_existing=True)
            )
            if attempt is None:
                db.rollback()
                break
            seen.append(attempt.id)
            result = reconcile_locked(db, attempt, now=now, cutoff=cutoff, dry_run=dry_run, worker=worker)
            if dry_run:
                db.rollback()
            else:
                db.commit()
            report.items.append(result)
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()
    return report
