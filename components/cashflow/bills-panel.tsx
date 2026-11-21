"use client";

import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useSession, useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, Money, PAYMENT_METHOD_LABEL, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/primitives";
import { ApiError, describeError } from "@/lib/api/errors";
import { newIdempotencyKey, useBills, useCreateBill, usePayBill } from "@/lib/api/hooks";
import type { Bill, PaymentMethod } from "@/lib/api/types";
import { addDays, formatDate, todayIn } from "@/lib/format/dates";
import { compareMoney, formatMoney, isValidAmount } from "@/lib/format/money";

function NewBillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const today = todayIn(session?.business.timezone);
  const create = useCreateBill();
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("general");
  const [amount, setAmount] = useState("");
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDays(today, 15));
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!vendor.trim()) return setError("Enter the vendor name.");
    if (!isValidAmount(amount)) return setError("Enter a positive amount with up to 2 decimals.");
    if (dueDate < billDate) return setError("Due date cannot be before the bill date.");
    try {
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

function PayBillDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const pay = usePayBill(bill.id);
  const [amount, setAmount] = useState(bill.outstanding);
  const [date, setDate] = useState(todayIn(session?.business.timezone));
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [key, setKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidAmount(amount)) return setError("Enter a positive amount with up to 2 decimals.");
    if (compareMoney(amount, bill.outstanding) > 0) return setError(`Cannot exceed the remaining ${formatMoney(bill.outstanding)}.`);
    try {
      const result = await pay.mutateAsync({ idempotencyKey: key, body: { amount, payment_date: date, payment_method: method } });
      toast(`Paid ${formatMoney(result.payment.amount)} to ${bill.vendor_name}. Remaining ${formatMoney(result.bill.outstanding)}.`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) setKey(newIdempotencyKey());
      setError(describeError(err));
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Pay ${bill.vendor_name}`} description={<>Remaining <Money value={bill.outstanding} className="font-semibold text-ink" /> · this records actual cash going out.</>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Amount (₹)">{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Method">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={pay.isPending}>Record bill payment</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function BillsPanel() {
  const [status, setStatus] = useState<"open" | "overdue" | "paid" | "">("open");
  const bills = useBills({ status: status || undefined, page_size: 100 });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Bill | null>(null);
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
