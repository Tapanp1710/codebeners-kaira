"use client";

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

/** Client-side pre-check only; the backend rejects overpayment authoritatively. */
export function validatePaymentAmount(amount: string, outstanding: string): string | null {
  if (!amount.trim()) return "Enter an amount";
  if (!isValidAmount(amount)) return "Enter a positive amount with up to 2 decimal places";
  if (compareMoney(amount, outstanding) > 0) return `Cannot exceed the outstanding ${formatMoney(outstanding)}`;
  return null;
}

export function PaymentDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const record = useRecordPayment(invoice.id);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [touched, setTouched] = useState(false);
  // One key per submission attempt; kept across retries so a retry can never double-record.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [confirmed, setConfirmed] = useState<Schemas["PaymentRecordedOut"] | null>(null);
  const amountError = touched ? validatePaymentAmount(amount, invoice.outstanding) : null;

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
    if (validatePaymentAmount(amount, invoice.outstanding)) return;
    try {
      const result = await record.mutateAsync({
        idempotencyKey,
        body: { amount: amount.trim(), payment_date: date, payment_method: method, reference: reference.trim() || null, notes: notes.trim() || null },
      });
      setConfirmed(result);
      setIdempotencyKey(newIdempotencyKey());
      toast(`Payment of ${formatMoney(result.payment.amount)} recorded`);
    } catch (err) {
      // Business-rule rejections are final for this key's content; let the next attempt use a new key.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) setIdempotencyKey(newIdempotencyKey());
    }
  }

  return (
    <Dialog open={open} onClose={close} title={`Record payment · ${invoice.invoice_number}`} description={<>Outstanding now <Money value={invoice.outstanding} className="font-semibold text-ink" /></>}>
      {confirmed ? (
        <div className="space-y-4" data-testid="payment-confirmed">
          <Notice tone="good" title="Payment recorded">
            <Money value={confirmed.payment.amount} /> received on {confirmed.payment.payment_date}. Outstanding balance is now{" "}
            <Money value={confirmed.invoice.outstanding} className="font-semibold" /> ({confirmed.invoice.payment_status.replace("_", " ")}).
            {confirmed.replayed && " (This payment had already been recorded; no duplicate was created.)"}
          </Notice>
          <div className="flex justify-end"><Button onClick={close}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
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
          <button type="button" className="text-sm font-semibold text-steel underline underline-offset-2" onClick={() => { setAmount(invoice.outstanding); setTouched(true); }}>
            Pay full balance (<Money value={invoice.outstanding} />)
          </button>
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
