"use client";

/**
 * Bills & expenses panel on the Cash flow page (app/(app)/cashflow/page.tsx, anchored at #bills so the
 * dashboard and alerts can deep-link to it).
 *
 * Bills are payables. An unpaid bill is a PROJECTED outflow that feeds the cash forecast; paying it
 * records an ACTUAL outflow that reduces current cash. Endpoints (via lib/api/hooks.ts):
 *   - GET  /bills?status=&page_size=100          useBills
 *   - POST /bills                                useCreateBill
 *   - POST /bills/{id}/payments + Idempotency-Key usePayBill
 * Both writes call invalidateFinancial(), so the forecast, dashboard, insights and audit views refetch.
 * Money is handled as decimal strings throughout; comparisons use exact BigInt helpers, never floats.
 */
import { Plus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, Money, PAYMENT_METHOD_LABEL, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { newIdempotencyKey, useBills, useCreateBill, usePayBill } from "@/lib/api/hooks";
import {
  clearBillPaymentAttempt,
  isDefinitiveRejection,
  loadBillPaymentAttempt,
  saveBillPaymentAttempt,
  type BillPaymentAttempt,
} from "@/lib/api/payment-attempt";
import type { Bill, PaymentMethod } from "@/lib/api/types";
import { addDays, formatDate, todayIn } from "@/lib/format/dates";
import { compareMoney, formatMoney, isValidAmount } from "@/lib/format/money";

/** Dialog that creates a bill (POST /bills). Stays mounted while closed, so its fields persist between openings. */
function NewBillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  // "Today" in the business's timezone (falls back to Asia/Kolkata), not the browser's, so a late-night
  // entry does not land on the wrong calendar date.
  const today = todayIn(session?.business.timezone);
  const create = useCreateBill();
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("general");
  const [amount, setAmount] = useState("");
  const [billDate, setBillDate] = useState(today);
  // Default payment term of 15 days; addDays works in UTC on the calendar date, so no DST/timezone drift.
  const [dueDate, setDueDate] = useState(addDays(today, 15));
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // Client-side checks for quick feedback only; the backend validates again. Dates are YYYY-MM-DD
    // strings, so plain string comparison orders them correctly.
    if (!vendor.trim()) return setError("Enter the vendor name.");
    if (!isValidAmount(amount)) return setError("Enter a positive amount with up to 2 decimals.");
    if (dueDate < billDate) return setError("Due date cannot be before the bill date.");
    try {
      // Empty description becomes null and an empty category falls back to "general"; amount is sent as
      // the typed decimal string.
      await create.mutateAsync({ vendor_name: vendor.trim(), description: description.trim() || null, category: category.trim() || "general", amount, bill_date: billDate, due_date: dueDate });
      toast("Bill added");
      onClose();
    } catch (err) {
      setError(describeError(err));
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Add a bill" description="Unpaid bills are expected outflows, not money spent yet.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor">{(id) => <Input id={id} value={vendor} onChange={(e) => setVendor(e.target.value)} autoFocus />}</Field>
          <Field label="Amount (₹)">{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Description">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Field label="Category">{(id) => <Input id={id} value={category} onChange={(e) => setCategory(e.target.value)} />}</Field>
          <Field label="Bill date">{(id) => <Input id={id} type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />}</Field>
          <Field label="Due date">{(id) => <Input id={id} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}</Field>
        </div>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Add bill</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Dialog that records a payment against one bill (POST /bills/{id}/payments). Mounted only while a bill
 * is selected.
 *
 * Idempotency: the first submit freezes the Idempotency-Key and the exact request body into an attempt
 * (lib/api/payment-attempt.ts), saved to sessionStorage before the request is sent. The attempt is released
 * only when the backend confirms an outcome: success (recorded or replayed) or a definitive 4xx rejection.
 * After a network error, timeout or 5xx the outcome is unknown, so the fields lock and "Retry payment"
 * resends the same key and body; the backend then records the payment once or replays the original.
 * Reopening the dialog (including after a reload) restores a pending attempt for this bill.
 */
function PayBillDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const pay = usePayBill(bill.id);
  const userId = session?.user.id ?? "anonymous";
  // An attempt whose outcome is still unknown (restored from sessionStorage on mount, if any).
  const [attempt, setAttempt] = useState<BillPaymentAttempt | null>(() => loadBillPaymentAttempt(userId, bill.id));
  // Pre-filled with the pending attempt's values, otherwise the full remaining balance (a decimal string).
  const [amount, setAmount] = useState(() => (attempt ? String(attempt.body.amount) : bill.outstanding));
  const [date, setDate] = useState(() => attempt?.body.payment_date ?? todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>(() => attempt?.body.payment_method ?? "bank_transfer");
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Synchronous guard against a second submit (double click, Enter) before `pay.isPending` re-renders.
  const inFlight = useRef(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setError(null);
    setConfirmDiscard(false);
    let current = attempt;
    if (!current) {
      if (!isValidAmount(amount)) return setError("Enter a positive amount with up to 2 decimals.");
      // Overpayment guard using exact decimal comparison against the outstanding shown in the dialog.
      if (compareMoney(amount, bill.outstanding) > 0) return setError(`Cannot exceed the remaining ${formatMoney(bill.outstanding)}.`);
      current = { key: newIdempotencyKey(), billId: bill.id, body: { amount, payment_date: date, payment_method: method }, startedAt: new Date().toISOString() };
      saveBillPaymentAttempt(userId, current);
      setAttempt(current);
    }
    // A retry skips the client-side checks on purpose: the body was validated when the attempt was created,
    // and if the first request was recorded the bill's outstanding is now lower, which would wrongly block
    // the retry that the backend would answer with a replay.
    inFlight.current = true;
    try {
      const result = await pay.mutateAsync({ idempotencyKey: current.key, body: current.body });
      clearBillPaymentAttempt(userId, bill.id);
      // The confirmation uses the server's recorded amount and new outstanding, not the typed value.
      toast(
        result.replayed
          ? `This payment to ${bill.vendor_name} had already been recorded; no duplicate was created. Remaining ${formatMoney(result.bill.outstanding)}.`
          : `Paid ${formatMoney(result.payment.amount)} to ${bill.vendor_name}. Remaining ${formatMoney(result.bill.outstanding)}.`,
      );
      onClose();
    } catch (err) {
      // Only a processed rejection proves nothing was recorded; then the fields unlock for correction and the
      // next submit creates a new attempt. Anything else keeps the attempt (same key, same body) for retry.
      if (isDefinitiveRejection(err)) {
        clearBillPaymentAttempt(userId, bill.id);
        setAttempt(null);
      }
      setError(describeError(err));
    } finally {
      inFlight.current = false;
    }
  }

  function discardAttempt() {
    clearBillPaymentAttempt(userId, bill.id);
    setAttempt(null);
    setConfirmDiscard(false);
    setError(null);
  }

  const locked = attempt !== null;
  return (
    <Dialog open onClose={onClose} title={`Pay ${bill.vendor_name}`} description={<>Remaining <Money value={bill.outstanding} className="font-semibold text-ink" /> · this records actual cash going out.</>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {locked && !pay.isPending && (
          <Notice tone="warn" title="Payment not confirmed">
            We couldn&apos;t confirm whether this payment of <Money value={String(attempt.body.amount)} /> was recorded. Retrying sends the same payment, so it can&apos;t be recorded twice.
          </Notice>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Amount (₹)">{(id) => <Input id={id} inputMode="decimal" value={amount} disabled={locked} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Date">{(id) => <Input id={id} type="date" value={date} disabled={locked} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Method">
            {(id) => (
              <Select id={id} value={method} disabled={locked} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <FormError message={error} />
        {confirmDiscard && (
          <Notice tone="danger" title="Discard this attempt?">
            If the first request was recorded, a new payment would pay this bill twice. Discard only after checking the bill&apos;s payments.
          </Notice>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {locked && !pay.isPending && (
            <Button type="button" variant="ghost" onClick={confirmDiscard ? discardAttempt : () => setConfirmDiscard(true)}>
              {confirmDiscard ? "Discard anyway" : "Discard attempt"}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={pay.isPending}>{locked ? "Retry payment" : "Record bill payment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Filterable bill list with "Add bill" and per-row "Pay" actions. */
export function BillsPanel() {
  // "" means "All": the status param is omitted. The filter is part of the query key, so each filter
  // value is cached separately. Only the first 100 bills are shown (no pager).
  const [status, setStatus] = useState<"open" | "overdue" | "paid" | "">("open");
  const bills = useBills({ status: status || undefined, page_size: 100 });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Bill | null>(null);
  // The Pay button is hidden when outstanding is exactly "0.00" (the API's 2-dp string form). Overdue
  // flags and days overdue come from the backend; the client does not compute them.
  return (
    <Card id="bills" aria-labelledby="bills-title">
      <CardHeader
        id="bills-title"
        title="Bills & expenses"
        subtitle="Unpaid bills are projected outflows; paying one records an actual outflow"
        action={
          <div className="flex gap-2">
            <label>
              <span className="sr-only">Bill status</span>
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-8 py-0">
                <option value="open">Unpaid</option>
                <option value="overdue">Overdue</option>
                <option value="paid">Paid</option>
                <option value="">All</option>
              </Select>
            </label>
            <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden="true" /> Add bill</Button>
          </div>
        }
      />
      {bills.isError && <ErrorState error={bills.error} onRetry={() => bills.refetch()} />}
      {bills.isPending && <LoadingBlock rows={2} />}
      {bills.data && bills.data.items.length === 0 && <EmptyState title="No bills here" />}
      {bills.data && bills.data.items.length > 0 && (
        <DataTable caption="Bills">
          <thead>
            <tr>
              <th className={th}>Vendor</th>
              <th className={th}>Due</th>
              <th className={thNum}>Amount</th>
              <th className={thNum}>Remaining</th>
              <th className={th}>Status</th>
              <th className={th}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {bills.data.items.map((b) => (
              <tr key={b.id}>
                <td className={td}>
                  <span className="font-semibold">{b.vendor_name}</span>
                  <span className="block text-xs text-muted">{[b.description, b.category].filter(Boolean).join(" · ")}</span>
                </td>
                <td className={td}>{formatDate(b.due_date)}</td>
                <td className={tdNum}><Money value={b.amount} /></td>
                <td className={tdNum}><Money value={b.outstanding} className="font-semibold" /></td>
                <td className={td}><PaymentStatusBadge status={b.payment_status} overdue={b.is_overdue} daysOverdue={b.days_overdue} /></td>
                <td className={td}>{b.outstanding !== "0.00" && <Button size="sm" variant="secondary" onClick={() => setPaying(b)}>Pay</Button>}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <NewBillDialog open={adding} onClose={() => setAdding(false)} />
      {paying && <PayBillDialog bill={paying} onClose={() => setPaying(null)} />}
    </Card>
  );
}
