"use client";

/**
 * Invoice creation form, rendered by `app/(app)/invoices/new/page.tsx`.
 *
 * React Hook Form + Zod handle client-side validation; `useCreateInvoice` sends
 * POST /api/v1/invoices and, on success, invalidates every ledger-derived query
 * (`invalidateFinancial`). All money and quantities stay decimal strings end to end: the
 * running total shown here is an exact BigInt estimate for display only, and the backend
 * computes the authoritative invoice total from the submitted items.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { useSession, useToast } from "@/components/providers";
import { Money } from "@/components/ui/finance";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Button, Card } from "@/components/ui/primitives";
import { ApiError, describeError } from "@/lib/api/errors";
import { useCreateInvoice, useCustomers } from "@/lib/api/hooks";
import { addDays, todayIn } from "@/lib/format/dates";
import { estimateLine, isDecimalString, sumMoney } from "@/lib/format/money";

// Inputs are validated as strings (never parsed to floats): unit price is a positive-format decimal with
// at most 12 integer digits and 2 decimal places; quantity allows 3 decimal places and must be > 0.
// `Number(v) > 0` is only a sign/zero check on an already format-validated string.
const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "Up to 2 decimal places");
const qty = z.string().trim().regex(/^\d{1,9}(\.\d{1,3})?$/, "Up to 3 decimal places").refine((v) => Number(v) > 0, "Must be more than 0");

/**
 * Client-side schema mirroring the InvoiceCreate contract. Dates are `YYYY-MM-DD` strings from
 * `<input type="date">`, so the due-date check is a plain string comparison (lexicographic order
 * equals chronological order for that format). The backend re-validates everything.
 */
export const invoiceSchema = z
  .object({
    customer_id: z.string().min(1, "Choose a customer"),
    invoice_date: z.string().min(1, "Required"),
    due_date: z.string().min(1, "Required"),
    notes: z.string().max(4000).optional(),
    items: z
      .array(z.object({ description: z.string().trim().min(1, "Describe the item").max(500), quantity: qty, unit_price: money }))
      .min(1, "Add at least one item"),
  })
  .refine((v) => v.due_date >= v.invoice_date, { path: ["due_date"], message: "Due date cannot be before the invoice date" });
type Values = z.infer<typeof invoiceSchema>;

/**
 * New-invoice form. Optional `?customer=<id>` preselects the customer (used when starting an
 * invoice from a customer page). On success it toasts and navigates to the new invoice.
 */
const FIELD_LABEL: Record<string, string> = {
  customer_id: "Customer",
  invoice_date: "Invoice date",
  due_date: "Due date",
  notes: "Notes",
  items: "Items",
  description: "Description",
  quantity: "Quantity",
  unit_price: "Unit price",
};

/**
 * The server's own message, followed by every validation error it reported, each naming the line and
 * field ("Item 2 – Quantity: …"). Nothing is suppressed, including errors that have no input to attach to.
 */
export function serverErrorSummary(error: unknown): string {
  const base = describeError(error);
  if (!(error instanceof ApiError)) return base;
  const parts = error.fieldErrorsByPath().map(({ path, message }) => {
    const item = /^items\.(\d+)\.(\w+)$/.exec(path);
    const where = item
      ? `Item ${Number(item[1]) + 1} – ${FIELD_LABEL[item[2]] ?? item[2]}`
      : FIELD_LABEL[path] ?? (path || "Request");
    return `${where}: ${message}`;
  });
  return parts.length ? `${base} ${parts.join("; ")}.` : base;
}

export function InvoiceForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { session } = useSession();
  const toast = useToast();
  // "Today" is computed in the business timezone from the session (not the browser's local zone).
  const today = todayIn(session?.business.timezone);
  // The customer picker loads a single page of up to 200 customers; there is no search or paging here.
  const customers = useCustomers({ page_size: 200 });
  const create = useCreateInvoice();
  // Defaults: invoice dated today, due in 15 days, one empty line with quantity 1.
  const form = useForm<Values>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      customer_id: params.get("customer") ?? "",
      invoice_date: today,
      due_date: addDays(today, 15),
      notes: "",
      items: [{ description: "", quantity: "1", unit_price: "" }],
    },
  });
  // The <select> renders before its options arrive; re-apply the requested customer once they exist.
  const preselected = params.get("customer");
  const loadedCustomers = customers.data;
  useEffect(() => {
    if (preselected && loadedCustomers?.items.some((c) => c.id === preselected)) {
      form.resetField("customer_id", { defaultValue: preselected });
    }
  }, [preselected, loadedCustomers, form]);
  // `fields` carries stable ids for React keys; `items` (useWatch) re-renders on every keystroke so the
  // per-line and total estimates stay live.
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "items" });
  const items = useWatch({ control: form.control, name: "items" });
  // Lines whose quantity or price is not yet a valid decimal estimate to null and are skipped by sumMoney,
  // so half-typed input never throws or produces NaN.
  const lines = (items ?? []).map((i) => (i && isDecimalString(i.quantity ?? "") && isDecimalString(i.unit_price ?? "") ? estimateLine(i.quantity, i.unit_price) : null));
  const estimate = sumMoney(lines);
  const errors = form.formState.errors;

  /** Runs only after Zod validation passes. Text is trimmed and empty notes are sent as null. */
  async function onSubmit(v: Values) {
    try {
      // No Idempotency-Key on invoice creation (only payments use one), and mutations are not auto-retried.
      const invoice = await create.mutateAsync({
        customer_id: v.customer_id,
        invoice_date: v.invoice_date,
        due_date: v.due_date,
        notes: v.notes?.trim() || null,
        items: v.items.map((i) => ({ description: i.description.trim(), quantity: i.quantity, unit_price: i.unit_price })),
      });
      // invoice_number and the total are assigned by the backend; the UI only echoes them.
      toast(`Invoice ${invoice.invoice_number} created for ${invoice.customer_name}`);
      router.push(`/invoices/${invoice.id}`);
    } catch (err) {
      // Map each server validation error onto its input, using the full location so line-item errors
      // land on the right line ("items.1.quantity" -> Item 2's Quantity). Every error, mapped or not, is
      // also listed in the summary below together with the server's own message.
      if (err instanceof ApiError) {
        for (const { path, message } of err.fieldErrorsByPath()) {
          const item = /^items\.(\d+)\.(description|quantity|unit_price)$/.exec(path);
          if (item && Number(item[1]) < v.items.length) {
            form.setError(`items.${Number(item[1])}.${item[2] as "description" | "quantity" | "unit_price"}`, { message });
          } else if (["customer_id", "invoice_date", "due_date", "notes"].includes(path)) {
            form.setError(path as keyof Values, { message });
          }
        }
      }
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6 xl:grid-cols-[2fr_1fr]">
      {/* Layout: items card on the left, sticky estimate/submit card on the right on xl screens. noValidate keeps zod as the single source of error messages. */}
      <Card className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Customer" error={errors.customer_id?.message} className="sm:col-span-3">
            {(id, d) => (
              <Select id={id} aria-describedby={d} aria-invalid={!!errors.customer_id} {...form.register("customer_id")}>
                <option value="">{customers.isPending ? "Loading customers…" : "Choose a customer"}</option>
                {customers.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Invoice date" error={errors.invoice_date?.message}>
            {(id, d) => <Input id={id} aria-describedby={d} type="date" {...form.register("invoice_date")} />}
          </Field>
          <Field label="Due date" error={errors.due_date?.message}>
            {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={!!errors.due_date} type="date" {...form.register("due_date")} />}
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Items</legend>
          <div className="space-y-3">
            {fields.map((f, index) => {
              const e = errors.items?.[index];
              return (
                <div key={f.id} className="grid gap-3 rounded-xl bg-white/50 p-3 ring-1 ring-line sm:grid-cols-[3fr_1fr_1.4fr_auto] sm:items-start" data-testid="invoice-item">
                  <Field label={`Item ${index + 1} description`} error={e?.description?.message}>
                    {(id, d) => <Input id={id} aria-describedby={d} {...form.register(`items.${index}.description`)} />}
                  </Field>
                  <Field label="Quantity" error={e?.quantity?.message}>
                    {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" {...form.register(`items.${index}.quantity`)} />}
                  </Field>
                  <Field label="Unit price (₹)" error={e?.unit_price?.message} hint={lines[index] ? <>Line ≈ <Money value={lines[index]} /></> : undefined}>
                    {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" {...form.register(`items.${index}.unit_price`)} />}
                  </Field>
                  {/* Disabled at one line, matching the schema's "at least one item" rule; the icon-only button's aria-label names the line it removes. */}
                  <Button type="button" variant="ghost" size="sm" className="sm:mt-6" onClick={() => remove(index)} disabled={fields.length === 1} aria-label={`Remove item ${index + 1}`}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              );
            })}
          </div>
          {/* Array-level zod errors such as "Add at least one item" are reported on items.root, not on a line. */}
          {errors.items?.root?.message && <p className="mt-2 text-xs text-danger">{errors.items.root.message}</p>}
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => append({ description: "", quantity: "1", unit_price: "" })}>
            <Plus className="size-4" aria-hidden="true" /> Add item
          </Button>
        </fieldset>

        <Field label="Notes (optional)">{(id) => <Textarea id={id} className="min-h-16" {...form.register("notes")} />}</Field>
      </Card>

      <Card className="h-fit space-y-4 xl:sticky xl:top-24">
        {/* Display-only BigInt estimate of the lines that are valid so far; the backend computes the official total on save. */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Estimated total</p>
          <p className="num mt-1 font-display text-3xl font-semibold" data-testid="invoice-estimate"><Money value={estimate} /></p>
          <p className="mt-1 text-xs text-muted">For convenience only. KAIRA calculates the official total from the items when you save.</p>
        </div>
        {/* Shows every failure except a VALIDATION_ERROR with field errors; as only customer_id, invoice_date, due_date and notes are mapped onto inputs, item-only server errors are currently not displayed. */}
        <FormError message={create.error ? serverErrorSummary(create.error) : null} />
        <Button type="submit" size="lg" className="w-full" loading={create.isPending}>Create invoice</Button>
      </Card>
    </form>
  );
}
