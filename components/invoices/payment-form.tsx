"use client";

/**
 * "Record payment" modal for a single invoice, opened from `app/(app)/invoices/[id]/page.tsx`.
 *
 * Sends POST /api/v1/invoices/{id}/payments via `useRecordPayment`, which attaches an
 * `Idempotency-Key` header and invalidates all ledger-derived queries on success. Uses plain
 * controlled state rather than React Hook Form because there is a single validated field (amount).
 * Amounts are decimal strings compared with exact BigInt helpers; the backend remains the
 * authority on overpayment and on the resulting balance/status.
 */
import { useState, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import { Money, PAYMENT_METHOD_LABEL } from "@/components/ui/finance";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Button, Notice } from "@/components/ui/primitives";
import { ApiError, describeError } from "@/lib/api/errors";
import { newIdempotencyKey, useRecordPayment } from "@/lib/api/hooks";
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

/**
 * Payment dialog. Stays mounted while the invoice page is open; `open` toggles visibility.
 * After a successful write it switches to a confirmation view built from the server response
 * (new outstanding balance and payment status), not from local arithmetic.
 */
export function PaymentDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const record = useRecordPayment(invoice.id);
  const [amount, setAmount] = useState("");
  // Defaults to today in the business timezone; not reset on close, so it persists between openings.
  const [date, setDate] = useState(() => todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  // Amount errors are shown only after blur, submit or "Pay full balance", not while the field is pristine.
  const [touched, setTouched] = useState(false);
  // One key per submission attempt; kept across retries so a retry can never double-record.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [confirmed, setConfirmed] = useState<Schemas["PaymentRecordedOut"] | null>(null);
  // `invoice.outstanding` comes from the parent's invoice query, so after invalidation it reflects the
  // refreshed balance for the next payment.
  const amountError = touched ? validatePaymentAmount(amount, invoice.outstanding) : null;

  /**
   * Clears the entry fields, confirmation and mutation error, then tells the parent to hide the dialog.
   * Wired to Cancel, Done, the close button and Esc (via Dialog's onCancel/onClose).
   */
  function close() {
    setConfirmed(null);
    setAmount("");
    setReference("");
    setNotes("");
    setTouched(false);
    record.reset();
    onClose();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    // Invalid input never reaches the network; the inline error is already visible via `touched`.
    if (validatePaymentAmount(amount, invoice.outstanding)) return;
    try {
      // Optional text fields are trimmed and sent as null when empty; amount stays a string.
      const result = await record.mutateAsync({
        idempotencyKey,
        body: { amount: amount.trim(), payment_date: date, payment_method: method, reference: reference.trim() || null, notes: notes.trim() || null },
      });
      setConfirmed(result);
      // Success consumes the key; any further payment from this dialog is a new submission.
      setIdempotencyKey(newIdempotencyKey());
      toast(`Payment of ${formatMoney(result.payment.amount)} recorded`);
    } catch (err) {
      // Business-rule rejections are final for this key's content; let the next attempt use a new key.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) setIdempotencyKey(newIdempotencyKey());
      // Network errors, timeouts (status 0) and 5xx keep the key: the server may have recorded the payment
      // before the failure, and resubmitting with the same key lets it replay instead of duplicating.
      // The message itself is shown from `record.error` by the FormError below.
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
          {/* Entry view: noValidate, so the amount is checked only by validatePaymentAmount (exact string comparison against outstanding). */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount (₹)" error={amountError ?? undefined}>
              {(id, d) => (
                <Input id={id} aria-describedby={d} aria-invalid={!!amountError} inputMode="decimal" autoFocus value={amount}
                  onChange={(e) => setAmount(e.target.value)} onBlur={() => setTouched(true)} />
              )}
            </Field>
            <Field label="Payment date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label="Method">
              {(id) => (
                <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                  {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reference (optional)" hint="UPI ref, cheque no.">{(id, d) => <Input id={id} aria-describedby={d} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
          </div>
          <Field label="Notes (optional)">{(id) => <Textarea id={id} className="min-h-16" value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
          {/* Copies the outstanding string verbatim (no float round-trip) and marks the field touched so validation shows at once. */}
          <button type="button" className="text-sm font-semibold text-steel underline underline-offset-2" onClick={() => { setAmount(invoice.outstanding); setTouched(true); }}>
            Pay full balance (<Money value={invoice.outstanding} />)
          </button>
          {/* Network/timeout errors and API rejections (including the backend's own overpayment check) show here; close() clears them via record.reset(). */}
          <FormError message={record.error ? describeError(record.error) : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
            <Button type="submit" loading={record.isPending}>Record payment</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
