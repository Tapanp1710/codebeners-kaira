"use client";

/**
 * "Record payment" modal for a single invoice, opened from `app/(app)/invoices/[id]/page.tsx`.
 *
 * Payments go through the server-side payment-attempt registry (backend API 1.1.0; lib/payments): the
 * attempt (key + frozen request) is registered before any money moves, then executed. Amounts are decimal
 * strings compared with exact BigInt helpers; the backend remains the authority on overpayment and on the
 * resulting balance/status.
 *
 * Recovery: an unconfirmed payment is found from this browser's local record or from the server (any
 * device, cleared storage), shown with its frozen details (amount, date, method, reference, notes) and
 * retried with the same attempt. It is never discarded and never gets a new key; closing the dialog keeps it.
 */
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import { Money, PAYMENT_METHOD_LABEL } from "@/components/ui/finance";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Button, Notice } from "@/components/ui/primitives";
import { listPendingInvoiceIds, subscribeInvoicePaymentAttempts } from "@/lib/api/payment-attempt";
import type { Invoice, PaymentMethod, Schemas } from "@/lib/api/types";
import { formatMoney, compareMoney, isValidAmount } from "@/lib/format/money";
import { todayIn } from "@/lib/format/dates";
import { usePaymentAttempt, useServerPending } from "@/lib/payments/use-payment-attempt";

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

/** True while the invoice has an unconfirmed payment: on the server (any device) or saved in this browser. */
export function useInvoicePaymentPending(invoiceId: string): boolean {
  const { session } = useSession();
  const businessId = session?.business.id ?? "unknown";
  const server = useServerPending("invoice", invoiceId);
  const local = useSyncExternalStore(
    subscribeInvoicePaymentAttempts,
    () => listPendingInvoiceIds(businessId).includes(invoiceId),
    () => false,
  );
  return local || (server.data?.items.length ?? 0) > 0;
}

/**
 * Payment dialog. Stays mounted while the invoice page is open; `open` toggles visibility.
 * After a successful write it switches to a confirmation view built from the server response
 * (new outstanding balance and payment status), not from local arithmetic.
 */
export function PaymentDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  // Defaults to today in the business timezone; not reset on close, so it persists between openings.
  const [date, setDate] = useState(() => todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  // Amount errors are shown only after blur, submit or "Pay full balance", not while the field is pristine.
  const [touched, setTouched] = useState(false);
  const [confirmed, setConfirmed] = useState<Schemas["PaymentRecordedOut"] | null>(null);

  function resetEntry() {
    setAmount("");
    setReference("");
    setNotes("");
    setTouched(false);
  }

  /** Clears entry fields, confirmation and errors, then hides the dialog. A pending attempt is NOT touched. */
  function close() {
    setConfirmed(null);
    if (!attempt.locked) resetEntry();
    attempt.setError(null);
    onClose();
  }

  const attempt = usePaymentAttempt("invoice", invoice.id, {
    open,
    onDone: (a) => {
      const r = a.result?.invoice_payment;
      resetEntry();
      if (!r) return;
      setConfirmed(r);
      toast(
        r.replayed
          ? `This payment of ${formatMoney(r.payment.amount)} had already been recorded; no duplicate was created.`
          : `Payment of ${formatMoney(r.payment.amount)} recorded`,
      );
    },
    onConfirmedElsewhere: () => {
      if (!open) return;
      toast(`This payment on ${invoice.invoice_number} was confirmed in another tab; it was recorded once.`);
      close();
    },
  });
  const pending = attempt.pending;
  const locked = attempt.locked;
  // Frozen values while a payment is unconfirmed; otherwise what the user is typing.
  const shown = pending
    ? {
        amount: pending.body.amount,
        date: pending.body.payment_date ?? date,
        method: pending.body.payment_method as PaymentMethod,
        reference: pending.body.reference ?? "",
        notes: pending.body.notes ?? "",
      }
    : { amount, date, method, reference, notes };
  // A retry is not re-validated against the (possibly already reduced) outstanding; see lib/payments.
  const amountError = touched && !locked ? validatePaymentAmount(amount, invoice.outstanding) : null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked) {
      void attempt.retry();
      return;
    }
    setTouched(true);
    // Invalid input never reaches the network; the inline error is already visible via `touched`.
    if (validatePaymentAmount(amount, invoice.outstanding)) return;
    // Optional text fields are trimmed and sent as null when empty; amount stays a string.
    void attempt.submit({
      amount: amount.trim(),
      payment_date: date,
      payment_method: method,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
    });
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
          {locked && !attempt.submitting && (
            <Notice tone="warn" title="Payment not confirmed">
              We couldn&apos;t confirm whether this payment of <Money value={shown.amount} /> was recorded. It is saved on the server, so you can close this and retry later from any device. Retrying sends exactly the same payment, so it can&apos;t be recorded twice.
            </Notice>
          )}
          {/* Entry view: noValidate, so the amount is checked only by validatePaymentAmount (exact string comparison against outstanding). Every field locks while a payment is unconfirmed. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount (₹)" error={amountError ?? undefined}>
              {(id, d) => (
                <Input id={id} aria-describedby={d} aria-invalid={!!amountError} inputMode="decimal" autoFocus value={shown.amount} disabled={locked}
                  onChange={(e) => setAmount(e.target.value)} onBlur={() => setTouched(true)} />
              )}
            </Field>
            <Field label="Payment date">{(id) => <Input id={id} type="date" value={shown.date} disabled={locked} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label="Method">
              {(id) => (
                <Select id={id} value={shown.method} disabled={locked} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                  {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reference (optional)" hint="UPI ref, cheque no.">{(id, d) => <Input id={id} aria-describedby={d} value={shown.reference} disabled={locked} onChange={(e) => setReference(e.target.value)} />}</Field>
          </div>
          <Field label="Notes (optional)">{(id) => <Textarea id={id} className="min-h-16" value={shown.notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} />}</Field>
          {/* Copies the outstanding string verbatim (no float round-trip) and marks the field touched so validation shows at once. Hidden while a payment is unconfirmed. */}
          {!locked && (
            <button type="button" className="text-sm font-semibold text-steel underline underline-offset-2" onClick={() => { setAmount(invoice.outstanding); setTouched(true); }}>
              Pay full balance (<Money value={invoice.outstanding} />)
            </button>
          )}
          {/* Network/timeout errors and API rejections (including the backend's own overpayment check) show here; close() clears them. */}
          <FormError message={attempt.error} />
          <div className="flex justify-end gap-2">
            {/* Closing never deletes a pending attempt; it stays on the server until an outcome is confirmed. */}
            <Button type="button" variant="ghost" onClick={close}>{locked ? "Close" : "Cancel"}</Button>
            <Button type="submit" loading={attempt.submitting}>{locked ? "Retry payment" : "Record payment"}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
