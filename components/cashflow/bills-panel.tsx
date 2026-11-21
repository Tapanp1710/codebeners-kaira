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
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, Money, PAYMENT_METHOD_LABEL, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { invalidateFinancial, newIdempotencyKey, useBills, useCreateBill, usePayBill } from "@/lib/api/hooks";
import {
  confirmBillPaymentAttempt,
  createBillPaymentAttempt,
  isDefinitiveRejection,
  listPendingBillIds,
  loadBillPaymentAttempt,
  loadBillPaymentDone,
  rejectBillPaymentAttempt,
  subscribeBillPaymentAttempts,
  withBillPaymentLock,
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
 * (lib/api/payment-attempt.ts), saved to localStorage before the request is sent. The attempt is released
 * only when the backend confirms an outcome: success (recorded or replayed) or a definitive 4xx rejection.
 * After a network error, timeout or 5xx the outcome is unknown, so the fields lock and "Retry payment"
 * resends the same key and body; the backend then records the payment once or replays the original.
 * An uncertain attempt cannot be discarded. Closing the dialog keeps it; reopening the bill (after a
 * reload, a closed tab or a browser restart, or from another tab) restores it.
 *
 * Cross-tab: submits for a bill run under a per-bill Web Lock and re-read storage inside it, so a tab never
 * creates a second attempt next to a pending one and never resends an attempt another tab already resolved.
 * Changes from other tabs are followed live (adopt a new pending attempt, close on confirmation).
 */
function PayBillDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const pay = usePayBill(bill.id);
  const businessId = session?.business.id ?? "unknown";
  const userId = session?.user.id ?? "unknown";
  // Completion markers newer than this were written while the dialog was open, i.e. by another tab.
  const [openedAt] = useState(() => Date.now());
  // An attempt whose outcome is still unknown (restored from storage on mount, if any).
  const [attempt, setAttemptState] = useState<BillPaymentAttempt | null>(() => loadBillPaymentAttempt(businessId, bill.id));
  // Mirrors `attempt` synchronously for the storage listener and the locked submit path.
  const attemptRef = useRef(attempt);
  // Pre-filled with the pending attempt's values, otherwise the full remaining balance (a decimal string).
  const [amount, setAmount] = useState(() => (attempt ? String(attempt.body.amount) : bill.outstanding));
  const [date, setDate] = useState(() => attempt?.body.payment_date ?? todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>(() => attempt?.body.payment_method ?? "bank_transfer");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard against a second submit (double click, Enter) before `submitting` re-renders.
  const inFlight = useRef(false);

  function setAttempt(a: BillPaymentAttempt | null) {
    attemptRef.current = a;
    setAttemptState(a);
  }

  /** Shows a pending attempt (possibly created by another tab) with its frozen values. */
  function adopt(a: BillPaymentAttempt) {
    setAttempt(a);
    setAmount(String(a.body.amount));
    setDate(a.body.payment_date ?? todayIn(session?.business.timezone));
    setMethod(a.body.payment_method);
  }

  /**
   * Reconciles this dialog with storage after the attempt it shows was changed elsewhere. Returns true when
   * the dialog closed because the payment was confirmed.
   */
  function syncFromStorage(): boolean {
    const stored = loadBillPaymentAttempt(businessId, bill.id);
    const shown = attemptRef.current;
    if (stored && stored.key !== shown?.key) {
      adopt(stored);
      setError(null);
      return false;
    }
    if (!stored && shown) {
      if (loadBillPaymentDone(businessId, bill.id)?.key === shown.key) {
        toast(`This payment to ${bill.vendor_name} was confirmed in another tab; it was recorded once.`);
        invalidateFinancial(qc);
        onClose();
        return true;
      }
      // Released elsewhere after a definitive rejection: nothing was recorded, so the form unlocks.
      setAttempt(null);
      setError("The pending payment was rejected by the server in another tab. Review the details and submit again.");
    }
    return false;
  }

  // Follow attempt changes from other tabs while open. Our own writes happen while `inFlight` is set and
  // are handled by onSubmit, so they are ignored here.
  useEffect(
    () =>
      subscribeBillPaymentAttempts(() => {
        if (!inFlight.current) syncFromStorage();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribing per render is unnecessary; the listener reads refs and storage.
    [businessId, bill.id],
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await withBillPaymentLock(businessId, bill.id, async () => {
        // Re-read inside the lock: another tab may have created, confirmed or released an attempt meanwhile.
        const stored = loadBillPaymentAttempt(businessId, bill.id);
        const shown = attemptRef.current;
        let current: BillPaymentAttempt;
        if (shown) {
          if (stored?.key !== shown.key) {
            syncFromStorage();
            return;
          }
          // A retry skips the client-side checks on purpose: the body was validated when the attempt was
          // created, and if the first request was recorded the bill's outstanding is now lower, which would
          // wrongly block the retry that the backend would answer with a replay.
          current = stored;
        } else {
          if (stored) {
            adopt(stored);
            setError("A payment for this bill is already awaiting confirmation. Retry it before making a new payment.");
            return;
          }
          const done = loadBillPaymentDone(businessId, bill.id);
          if (done && done.at > openedAt) {
            setError("A payment for this bill was just recorded in another tab. Close this and check the updated balance before paying again.");
            return;
          }
          if (!isValidAmount(amount)) return setError("Enter a positive amount with up to 2 decimals.");
          // Overpayment guard using exact decimal comparison against the outstanding shown in the dialog.
          if (compareMoney(amount, bill.outstanding) > 0) return setError(`Cannot exceed the remaining ${formatMoney(bill.outstanding)}.`);
          const created = createBillPaymentAttempt({
            key: newIdempotencyKey(),
            businessId,
            billId: bill.id,
            userId,
            body: { amount, payment_date: date, payment_method: method },
          });
          if (!created.created) {
            adopt(created.attempt);
            setError("A payment for this bill is already awaiting confirmation. Retry it before making a new payment.");
            return;
          }
          current = created.attempt;
          setAttempt(current);
        }
        try {
          const result = await pay.mutateAsync({ idempotencyKey: current.key, body: current.body });
          confirmBillPaymentAttempt(businessId, bill.id, current.key);
          // The confirmation uses the server's recorded amount and new outstanding, not the typed value.
          toast(
            result.replayed
              ? `This payment to ${bill.vendor_name} had already been recorded; no duplicate was created. Remaining ${formatMoney(result.bill.outstanding)}.`
              : `Paid ${formatMoney(result.payment.amount)} to ${bill.vendor_name}. Remaining ${formatMoney(result.bill.outstanding)}.`,
          );
          onClose();
        } catch (err) {
          // Only a processed rejection proves nothing was recorded; then the fields unlock for correction and
          // the next submit creates a new attempt. Anything else keeps the attempt (same key, same body).
          if (isDefinitiveRejection(err)) {
            rejectBillPaymentAttempt(businessId, bill.id, current.key);
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

  const locked = attempt !== null;
  return (
    <Dialog open onClose={onClose} title={`Pay ${bill.vendor_name}`} description={<>Remaining <Money value={bill.outstanding} className="font-semibold text-ink" /> · this records actual cash going out.</>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {locked && !submitting && (
          <Notice tone="warn" title="Payment not confirmed">
            We couldn&apos;t confirm whether this payment of <Money value={String(attempt.body.amount)} /> was recorded. It is saved on this device, so you can close this and retry later. Retrying sends exactly the same payment, so it can&apos;t be recorded twice.
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
        <div className="flex justify-end gap-2">
          {/* Closing never deletes a pending attempt; it stays saved until the backend confirms an outcome. */}
          <Button type="button" variant="ghost" onClick={onClose}>{locked ? "Close" : "Cancel"}</Button>
          <Button type="submit" loading={submitting}>{locked ? "Retry payment" : "Record bill payment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Bill ids with a pending payment attempt for this business; updates on changes from any tab. */
function usePendingBillPayments(businessId: string): Set<string> {
  const snapshot = useSyncExternalStore(
    subscribeBillPaymentAttempts,
    () => listPendingBillIds(businessId).join(","),
    () => "",
  );
  return new Set(snapshot ? snapshot.split(",") : []);
}

/** Filterable bill list with "Add bill" and per-row "Pay" actions. */
export function BillsPanel() {
  const { session } = useSession();
  const qc = useQueryClient();
  // "" means "All": the status param is omitted. The filter is part of the query key, so each filter
  // value is cached separately. Only the first 100 bills are shown (no pager).
  const [status, setStatus] = useState<"open" | "overdue" | "paid" | "">("open");
  const bills = useBills({ status: status || undefined, page_size: 100 });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Bill | null>(null);
  const pending = usePendingBillPayments(session?.business.id ?? "unknown");
  // A pending payment whose bill is not in the current list (e.g. the lost payment cleared it, so it left
  // the "Unpaid" filter) must still be reachable.
  const pendingHidden = bills.data ? [...pending].filter((id) => !bills.data.items.some((b) => b.id === id)).length : 0;
  // Another tab confirmed or released a payment: this tab's cached balances are stale.
  useEffect(() => subscribeBillPaymentAttempts((remote) => { if (remote) invalidateFinancial(qc); }), [qc]);
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
      {pendingHidden > 0 && status !== "" && (
        <Notice tone="warn" title="Bill payment awaiting confirmation">
          {pendingHidden === 1 ? "A bill payment" : `${pendingHidden} bill payments`} could not be confirmed and {pendingHidden === 1 ? "is" : "are"} not in this list.{" "}
          <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setStatus("")}>Show all bills</button>
        </Notice>
      )}
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
                {/* A pending attempt is always resumable, even when the bill now shows nothing outstanding. */}
                <td className={td}>
                  {pending.has(b.id) ? (
                    <Button size="sm" variant="secondary" onClick={() => setPaying(b)}>Resolve payment</Button>
                  ) : (
                    b.outstanding !== "0.00" && <Button size="sm" variant="secondary" onClick={() => setPaying(b)}>Pay</Button>
                  )}
                </td>
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
