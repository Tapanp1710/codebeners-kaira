"use client";

/**
 * "Record payment" modal for a single invoice, opened from `app/(app)/invoices/[id]/page.tsx`.
 *
 * Sends POST /api/v1/invoices/{id}/payments via `useRecordPayment`, which attaches an
 * `Idempotency-Key` header and invalidates all ledger-derived queries on success. Uses plain
 * controlled state rather than React Hook Form because there is a single validated field (amount).
 * Amounts are decimal strings compared with exact BigInt helpers; the backend remains the
 * authority on overpayment and on the resulting balance/status.
 *
 * Idempotency and recovery follow the bill-payment design (lib/api/payment-attempt.ts): the first submit
 * freezes the key and exact body into an attempt saved to localStorage before sending; it is released only
 * on a confirmed outcome (recorded or replayed) or a processed 4xx rejection. Network errors, timeouts,
 * 5xx and 401/408/409/429 keep it, lock the fields and offer "Retry payment" with the same key and body.
 * The attempt survives closing the dialog, leaving the page, reloads, closed tabs and browser restarts, and
 * is shared by all tabs (per-invoice Web Lock + BroadcastChannel). It cannot be discarded.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import { Money, PAYMENT_METHOD_LABEL } from "@/components/ui/finance";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Button, Notice } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { invalidateFinancial, newIdempotencyKey, useRecordPayment } from "@/lib/api/hooks";
import {
  confirmInvoicePaymentAttempt,
  createInvoicePaymentAttempt,
  isDefinitiveRejection,
  listPendingInvoiceIds,
  loadInvoicePaymentAttempt,
  loadInvoicePaymentDone,
  rejectInvoicePaymentAttempt,
  subscribeInvoicePaymentAttempts,
  withInvoicePaymentLock,
  type InvoicePaymentAttempt,
} from "@/lib/api/payment-attempt";
import type { Invoice, PaymentMethod, Schemas } from "@/lib/api/types";
import { formatMoney, compareMoney, isValidAmount } from "@/lib/format/money";
import { todayIn } from "@/lib/format/dates";

/**
 * Client-side pre-check only; the backend rejects overpayment authoritatively.
 * Returns an error message, or null when `amount` is a positive string with at most 2 decimals that
 * does not exceed `outstanding` (both compared exactly, never as floats). Exported for unit tests.
 */
export function validatePaymentAmount(amount: string, outstanding: string): string | null {
  if (!amount.trim()) return "Enter an amount";
  if (!isValidAmount(amount)) return "Enter a positive amount with up to 2 decimal places";
  if (compareMoney(amount, outstanding) > 0) return `Cannot exceed the outstanding ${formatMoney(outstanding)}`;
  return null;
}

/** True while this business has an unresolved payment attempt for the invoice; follows changes from any tab. */
export function useInvoicePaymentPending(invoiceId: string): boolean {
  const { session } = useSession();
  const businessId = session?.business.id ?? "unknown";
  return useSyncExternalStore(
    subscribeInvoicePaymentAttempts,
    () => listPendingInvoiceIds(businessId).includes(invoiceId),
    () => false,
  );
}

const PENDING_ELSEWHERE = "A payment for this invoice is already awaiting confirmation. Retry it before recording a new payment.";

/**
 * Payment dialog. Stays mounted while the invoice page is open; `open` toggles visibility.
 * After a successful write it switches to a confirmation view built from the server response
 * (new outstanding balance and payment status), not from local arithmetic.
 */
export function PaymentDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const record = useRecordPayment(invoice.id);
  const businessId = session?.business.id ?? "unknown";
  const userId = session?.user.id ?? "unknown";
  // An attempt whose outcome is still unknown (restored from storage on mount, if any).
  const [attempt, setAttemptState] = useState<InvoicePaymentAttempt | null>(() => loadInvoicePaymentAttempt(businessId, invoice.id));
  // Mirrors `attempt` synchronously for the storage listener and the locked submit path.
  const attemptRef = useRef(attempt);
  // Pre-filled from a pending attempt's frozen body, otherwise blank.
  const [amount, setAmount] = useState(() => (attempt ? String(attempt.body.amount) : ""));
  // Defaults to today in the business timezone; not reset on close, so it persists between openings.
  const [date, setDate] = useState(() => attempt?.body.payment_date ?? todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>(() => attempt?.body.payment_method ?? "cash");
  const [reference, setReference] = useState(() => attempt?.body.reference ?? "");
  const [notes, setNotes] = useState(() => attempt?.body.notes ?? "");
  // Amount errors are shown only after blur, submit or "Pay full balance", not while the field is pristine.
  const [touched, setTouched] = useState(false);
  const [confirmed, setConfirmed] = useState<Schemas["PaymentRecordedOut"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard against a second submit (double click, Enter) before `submitting` re-renders.
  const inFlight = useRef(false);
  // Completion markers newer than this were written while the dialog was open, i.e. by another tab.
  const openedAt = useRef(0);
  const locked = attempt !== null;
  // A retry is not re-validated against the (possibly already reduced) outstanding; see onSubmit.
  const amountError = touched && !locked ? validatePaymentAmount(amount, invoice.outstanding) : null;

  function setAttempt(a: InvoicePaymentAttempt | null) {
    attemptRef.current = a;
    setAttemptState(a);
  }

  /** Shows a pending attempt (possibly created by another tab or an earlier session) with its frozen values. */
  function adopt(a: InvoicePaymentAttempt) {
    setAttempt(a);
    setAmount(String(a.body.amount));
    setDate(a.body.payment_date ?? todayIn(session?.business.timezone));
    setMethod(a.body.payment_method);
    setReference(a.body.reference ?? "");
    setNotes(a.body.notes ?? "");
    setTouched(false);
  }

  function resetEntry() {
    setAmount("");
    setReference("");
    setNotes("");
    setTouched(false);
  }

  /**
   * Clears the entry fields, confirmation and errors, then tells the parent to hide the dialog. A pending
   * attempt is NOT touched: it stays saved and is shown again on the next opening.
   * Wired to Cancel/Close, Done, the close button and Esc (via Dialog's onCancel/onClose).
   */
  function close() {
    setConfirmed(null);
    if (!attemptRef.current) resetEntry();
    setError(null);
    record.reset();
    onClose();
  }

  /** Reconciles the dialog with storage after the attempt was changed elsewhere (another tab or session). */
  function syncFromStorage(isOpen: boolean) {
    const stored = loadInvoicePaymentAttempt(businessId, invoice.id);
    const shown = attemptRef.current;
    if (stored && stored.key !== shown?.key) {
      adopt(stored);
      setError(null);
      return;
    }
    if (!stored && shown) {
      const confirmedElsewhere = loadInvoicePaymentDone(businessId, invoice.id)?.key === shown.key;
      setAttempt(null);
      resetEntry();
      if (!isOpen) return;
      if (confirmedElsewhere) {
        toast(`This payment on ${invoice.invoice_number} was confirmed in another tab; it was recorded once.`);
        invalidateFinancial(qc);
        close();
      } else {
        // Released elsewhere after a definitive rejection: nothing was recorded, so the form unlocks.
        setError("The pending payment was rejected by the server in another tab. Review the details and submit again.");
      }
    }
  }

  // Re-check storage on every opening: the attempt may have been created, confirmed or released while the
  // dialog was hidden (this dialog stays mounted for the life of the invoice page).
  useEffect(() => {
    if (!open) return;
    openedAt.current = Date.now();
    if (!inFlight.current) syncFromStorage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per opening; reads refs and storage.
  }, [open]);

  // Follow changes from other tabs while mounted. Our own writes happen while `inFlight` is set and are
  // handled by onSubmit, so they are ignored here. Remote changes also mean cached balances are stale.
  useEffect(
    () =>
      subscribeInvoicePaymentAttempts((remote) => {
        if (remote) invalidateFinancial(qc);
        if (!inFlight.current) syncFromStorage(open);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribe only when the target or visibility changes.
    [businessId, invoice.id, open],
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    if (!attemptRef.current) {
      setTouched(true);
      // Invalid input never reaches the network; the inline error is already visible via `touched`.
      if (validatePaymentAmount(amount, invoice.outstanding)) return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await withInvoicePaymentLock(businessId, invoice.id, async () => {
        // Re-read inside the lock: another tab may have created, confirmed or released an attempt meanwhile.
        const stored = loadInvoicePaymentAttempt(businessId, invoice.id);
        const shown = attemptRef.current;
        let current: InvoicePaymentAttempt;
        if (shown) {
          if (stored?.key !== shown.key) {
            syncFromStorage(true);
            return;
          }
          // A retry skips the client-side amount check on purpose: if the first request was recorded, the
          // invoice's outstanding is now lower and the check would block the retry the backend would replay.
          current = stored;
        } else {
          if (stored) {
            adopt(stored);
            setError(PENDING_ELSEWHERE);
            return;
          }
          const done = loadInvoicePaymentDone(businessId, invoice.id);
          if (done && done.at > openedAt.current) {
            setError("A payment for this invoice was just recorded in another tab. Close this and check the updated balance before paying again.");
            return;
          }
          // Optional text fields are trimmed and sent as null when empty; amount stays a string.
          const created = createInvoicePaymentAttempt({
            key: newIdempotencyKey(),
            businessId,
            invoiceId: invoice.id,
            userId,
            body: { amount: amount.trim(), payment_date: date, payment_method: method, reference: reference.trim() || null, notes: notes.trim() || null },
          });
          if (!created.created) {
            adopt(created.attempt);
            setError(PENDING_ELSEWHERE);
            return;
          }
          current = created.attempt;
          setAttempt(current);
        }
        try {
          const result = await record.mutateAsync({ idempotencyKey: current.key, body: current.body });
          confirmInvoicePaymentAttempt(businessId, invoice.id, current.key);
          setAttempt(null);
          resetEntry();
          setConfirmed(result);
          toast(
            result.replayed
              ? `This payment of ${formatMoney(result.payment.amount)} had already been recorded; no duplicate was created.`
              : `Payment of ${formatMoney(result.payment.amount)} recorded`,
          );
        } catch (err) {
          // Only a processed rejection proves nothing was recorded; then the fields unlock for correction and
          // the next submit creates a new attempt. Anything else keeps the attempt (same key, same body).
          if (isDefinitiveRejection(err)) {
            rejectInvoicePaymentAttempt(businessId, invoice.id, current.key);
            setAttempt(null);
          }
          setError(describeError(err));
        }
      });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title={`Record payment · ${invoice.invoice_number}`} description={<>Outstanding now <Money value={invoice.outstanding} className="font-semibold text-ink" /></>}>
      {confirmed ? (
        <div className="space-y-4" data-testid="payment-confirmed">
          {/* Confirmation view built from the server response (new outstanding and payment_status); `replayed` is set when the key matched an already-recorded payment. */}
          <Notice tone="good" title="Payment recorded">
            <Money value={confirmed.payment.amount} /> received on {confirmed.payment.payment_date}. Outstanding balance is now{" "}
            <Money value={confirmed.invoice.outstanding} className="font-semibold" /> ({confirmed.invoice.payment_status.replace("_", " ")}).
            {confirmed.replayed && " (This payment had already been recorded; no duplicate was created.)"}
          </Notice>
          <div className="flex justify-end"><Button onClick={close}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {locked && !submitting && (
            <Notice tone="warn" title="Payment not confirmed">
              We couldn&apos;t confirm whether this payment of <Money value={String(attempt.body.amount)} /> was recorded. It is saved on this device, so you can close this and retry later. Retrying sends exactly the same payment, so it can&apos;t be recorded twice.
            </Notice>
          )}
          {/* Entry view: noValidate, so the amount is checked only by validatePaymentAmount (exact string comparison against outstanding). Every field locks while a payment is unconfirmed. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount (₹)" error={amountError ?? undefined}>
              {(id, d) => (
                <Input id={id} aria-describedby={d} aria-invalid={!!amountError} inputMode="decimal" autoFocus value={amount} disabled={locked}
                  onChange={(e) => setAmount(e.target.value)} onBlur={() => setTouched(true)} />
              )}
            </Field>
            <Field label="Payment date">{(id) => <Input id={id} type="date" value={date} disabled={locked} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label="Method">
              {(id) => (
                <Select id={id} value={method} disabled={locked} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                  {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reference (optional)" hint="UPI ref, cheque no.">{(id, d) => <Input id={id} aria-describedby={d} value={reference} disabled={locked} onChange={(e) => setReference(e.target.value)} />}</Field>
          </div>
          <Field label="Notes (optional)">{(id) => <Textarea id={id} className="min-h-16" value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} />}</Field>
          {/* Copies the outstanding string verbatim (no float round-trip) and marks the field touched so validation shows at once. Hidden while a payment is unconfirmed. */}
          {!locked && (
            <button type="button" className="text-sm font-semibold text-steel underline underline-offset-2" onClick={() => { setAmount(invoice.outstanding); setTouched(true); }}>
              Pay full balance (<Money value={invoice.outstanding} />)
            </button>
          )}
          {/* Network/timeout errors and API rejections (including the backend's own overpayment check) show here; close() clears them. */}
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            {/* Closing never deletes a pending attempt; it stays saved until the backend confirms an outcome. */}
            <Button type="button" variant="ghost" onClick={close}>{locked ? "Close" : "Cancel"}</Button>
            <Button type="submit" loading={submitting}>{locked ? "Retry payment" : "Record payment"}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
