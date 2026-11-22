"use client";

/**
 * Bills & expenses panel on the Cash flow page (app/(app)/cashflow/page.tsx, anchored at #bills so the
 * dashboard and alerts can deep-link to it).
 *
 * Bills are payables. An unpaid bill is a PROJECTED outflow that feeds the cash forecast; paying it
 * records an ACTUAL outflow that reduces current cash. Endpoints (via lib/api/hooks.ts):
 *   - GET  /bills?status=&page_size=100          useBills
 *   - POST /bills                                useCreateBill
 *   - POST /payment-attempts, then /payment-attempts/{id}/execute   lib/payments (server-side recovery)
 * Both writes call invalidateFinancial(), so the forecast, dashboard, insights and audit views refetch.
 * Money is handled as decimal strings throughout; comparisons use exact BigInt helpers, never floats.
 */
import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, Money, PAYMENT_METHOD_LABEL, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { Pager } from "@/components/ui/pager";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice } from "@/components/ui/primitives";
import { api, unwrap } from "@/lib/api/client";
import { describeError } from "@/lib/api/errors";
import { invalidateFinancial, useBills, useCreateBill, usePendingPaymentAttempts } from "@/lib/api/hooks";
import { listPendingBillIds, subscribeBillPaymentAttempts } from "@/lib/api/payment-attempt";
import { usePaymentAttempt } from "@/lib/payments/use-payment-attempt";
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
 * Dialog that records a payment against one bill through the server-side payment-attempt registry
 * (lib/payments: register, then execute). Mounted only while a bill is selected.
 *
 * Recovery: an unconfirmed payment (from this browser, another tab or another device) is shown with its
 * frozen details and a "Retry payment" button that resends the same attempt; it is never discarded and never
 * gets a new key. Closing keeps it. A retry skips the client-side balance check, because a payment that was
 * already recorded lowers the outstanding balance and the backend answers the retry with a replay.
 */
function PayBillDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const [amount, setAmount] = useState(bill.outstanding);
  const [date, setDate] = useState(() => todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const attempt = usePaymentAttempt("bill", bill.id, {
    open: true,
    onDone: (a) => {
      const r = a.result?.bill_payment;
      if (r) {
        toast(
          r.replayed
            ? `This payment to ${bill.vendor_name} had already been recorded; no duplicate was created. Remaining ${formatMoney(r.bill.outstanding)}.`
            : `Paid ${formatMoney(r.payment.amount)} to ${bill.vendor_name}. Remaining ${formatMoney(r.bill.outstanding)}.`,
        );
      }
      onClose();
    },
    onConfirmedElsewhere: () => {
      toast(`This payment to ${bill.vendor_name} was confirmed in another tab; it was recorded once.`);
      onClose();
    },
  });
  const pending = attempt.pending;
  const locked = attempt.locked;
  // Frozen values while a payment is unconfirmed; otherwise what the user is typing.
  const shown = pending
    ? { amount: pending.body.amount, date: pending.body.payment_date ?? date, method: pending.body.payment_method as PaymentMethod }
    : { amount, date, method };

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (locked) {
      void attempt.retry();
      return;
    }
    if (!isValidAmount(amount)) return attempt.setError("Enter a positive amount with up to 2 decimals.");
    // Overpayment guard using exact decimal comparison against the outstanding shown in the dialog.
    if (compareMoney(amount, bill.outstanding) > 0) return attempt.setError(`Cannot exceed the remaining ${formatMoney(bill.outstanding)}.`);
    void attempt.submit({ amount, payment_date: date, payment_method: method });
  }

  return (
    <Dialog open onClose={onClose} title={`Pay ${bill.vendor_name}`} description={<>Remaining <Money value={bill.outstanding} className="font-semibold text-ink" /> · this records actual cash going out.</>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {locked && !attempt.submitting && (
          <Notice tone="warn" title="Payment not confirmed">
            We couldn&apos;t confirm whether this payment of <Money value={shown.amount} /> was recorded. It is saved on the server, so you can close this and retry later from any device. Retrying sends exactly the same payment, so it can&apos;t be recorded twice.
          </Notice>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Amount (₹)">{(id) => <Input id={id} inputMode="decimal" value={shown.amount} disabled={locked} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Date">{(id) => <Input id={id} type="date" value={shown.date} disabled={locked} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Method">
            {(id) => (
              <Select id={id} value={shown.method} disabled={locked} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <FormError message={attempt.error} />
        <div className="flex justify-end gap-2">
          {/* Closing never deletes a pending attempt; it stays on the server until an outcome is confirmed. */}
          <Button type="button" variant="ghost" onClick={onClose}>{locked ? "Close" : "Cancel"}</Button>
          <Button type="submit" loading={attempt.submitting}>{locked ? "Retry payment" : "Record bill payment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Bill ids with an unconfirmed payment: the server's pending attempts (any device, any page of the list)
 * plus this browser's local records that may not have reached the server yet.
 */
function usePendingBills(businessId: string) {
  const server = usePendingPaymentAttempts();
  const local = useSyncExternalStore(subscribeBillPaymentAttempts, () => listPendingBillIds(businessId).join(","), () => "");
  const items = (server.data?.items ?? []).filter((a) => a.resource_type === "bill");
  const ids = new Set([...items.map((a) => a.resource_id), ...(local ? local.split(",") : [])]);
  const labels = new Map(items.map((a) => [a.resource_id, a.resource_label]));
  return { ids, labels };
}

const BILLS_PAGE_SIZE = 25;

/** Filterable, paginated bill list with "Add bill" and per-row "Pay" / "Resolve payment" actions. */
export function BillsPanel() {
  const { session } = useSession();
  const qc = useQueryClient();
  // "" means "All": the status param is omitted. Filter and page are part of the query key.
  const [status, setStatus] = useState<"open" | "overdue" | "paid" | "">("open");
  const [page, setPage] = useState(1);
  const bills = useBills({ status: status || undefined, page, page_size: BILLS_PAGE_SIZE });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Bill | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const pending = usePendingBills(session?.business.id ?? "unknown");
  // Unconfirmed payments on bills that are not on this page or in this filter must still be reachable.
  const hidden = bills.data ? [...pending.ids].filter((id) => !bills.data.items.some((b) => b.id === id)) : [];
  // Another tab confirmed or released a payment: this tab's cached balances are stale.
  useEffect(() => subscribeBillPaymentAttempts((remote) => { if (remote) void invalidateFinancial(qc); }), [qc]);

  /** Opens the payment dialog for a bill that is not on the current page (fetched by id). */
  async function openById(id: string) {
    setOpening(id);
    try {
      setPaying(await unwrap(api.GET("/api/v1/bills/{bill_id}", { params: { path: { bill_id: id } } })));
    } finally {
      setOpening(null);
    }
  }

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
              <Select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }} className="h-8 py-0">
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
      {hidden.length > 0 && (
        <Notice tone="warn" title="Bill payment awaiting confirmation">
          {hidden.length === 1 ? "A bill payment" : `${hidden.length} bill payments`} could not be confirmed and {hidden.length === 1 ? "is" : "are"} not in this list.
          <span className="mt-2 flex flex-wrap gap-2">
            {hidden.map((id) => (
              <Button key={id} size="sm" variant="secondary" loading={opening === id} onClick={() => void openById(id)}>
                Resolve {pending.labels.get(id) ?? "payment"}
              </Button>
            ))}
          </span>
        </Notice>
      )}
      {bills.isError && <ErrorState error={bills.error} onRetry={() => bills.refetch()} />}
      {bills.isPending && <LoadingBlock rows={2} />}
      {bills.data && bills.data.items.length === 0 && <EmptyState title="No bills here" />}
      {bills.data && bills.data.items.length > 0 && (
        <>
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
                    {pending.ids.has(b.id) ? (
                      <Button size="sm" variant="secondary" onClick={() => setPaying(b)}>Resolve payment</Button>
                    ) : (
                      b.outstanding !== "0.00" && <Button size="sm" variant="secondary" onClick={() => setPaying(b)}>Pay</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <Pager page={page} total={bills.data.total} pageSize={BILLS_PAGE_SIZE} onPage={setPage} />
        </>
      )}
      <NewBillDialog open={adding} onClose={() => setAdding(false)} />
      {paying && <PayBillDialog bill={paying} onClose={() => setPaying(null)} />}
    </Card>
  );
}
