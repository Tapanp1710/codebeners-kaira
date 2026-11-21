"use client";

/**
 * Invoice detail for /invoices/[id]. Reads GET /api/v1/invoices/{id} (items, totals, status) and
 * GET /api/v1/invoices/{id}/payments (first 200). Two writes are offered:
 * - Void: PATCH /api/v1/invoices/{id} with lifecycle_status "void".
 * - Record payment: PaymentDialog, which POSTs /api/v1/invoices/{id}/payments with an Idempotency-Key created
 *   once per submission so a retry cannot record the payment twice.
 * Both writes invalidate every ledger-derived query (invoice, customer, receivables, forecast, dashboard...).
 */
import { ArrowLeft, Ban, IndianRupee } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";

import { useToast } from "@/components/providers";
import { PaymentDialog } from "@/components/invoices/payment-form";
import { DataTable, Money, PAYMENT_METHOD_LABEL, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { FormError } from "@/components/ui/form";
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Stat } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { useInvoice, useInvoicePayments, useUpdateInvoice } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format/dates";

/** Client Component page; the route `params` Promise is unwrapped with React's use(). */
export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const invoice = useInvoice(id);
  const payments = useInvoicePayments(id);
  // Used only for voiding. Its error is rendered under the header, so onVoid does not handle it itself.
  const update = useUpdateInvoice(id);
  const toast = useToast();
  const [paying, setPaying] = useState(false);
  const i = invoice.data;

  // Early returns sit after all hooks. Not-found or forbidden invoices surface as an ApiError with retry.
  if (invoice.isError) return <ErrorState error={invoice.error} onRetry={() => invoice.refetch()} />;
  if (!i) return <LoadingBlock label="Loading invoice" rows={5} />;

  // Payments only on issued (not void) invoices with something left to pay. Amounts are compared as the API's
  // 2-decimal strings, never as floats.
  const canPay = i.lifecycle_status === "issued" && i.outstanding !== "0.00";
  // Voiding is only offered while nothing has been paid, so no recorded payment is left on a void invoice.
  const canVoid = i.lifecycle_status === "issued" && i.paid === "0.00";

  /**
   * Asks for a browser confirmation, then PATCHes the lifecycle status. The non-null assertions are needed
   * because TypeScript does not carry the `!i` early-return narrowing into this nested function. Failures are
   * swallowed here on purpose: update.error is already displayed through FormError.
   */
  async function onVoid() {
    if (!window.confirm(`Void ${i!.invoice_number}? It will no longer count as money owed.`)) return;
    try {
      await update.mutateAsync({ lifecycle_status: "void" });
      toast(`${i!.invoice_number} voided`, "info");
    } catch {
      /* shown below */
    }
  }

  return (
    <>
      <Link href="/invoices" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-steel">
        <ArrowLeft className="size-4" aria-hidden="true" /> All invoices
      </Link>
      <PageHeader
        title={i.invoice_number}
        subtitle={
          <>
            <Link href={`/customers/${i.customer_id}`} className="font-semibold hover:underline">{i.customer_name}</Link> · issued {formatDate(i.invoice_date)} · due {formatDate(i.due_date)}
          </>
        }
        actions={
          <>
            {/* Each action renders only when canVoid / canPay allow it; Void shows a spinner while its PATCH is pending. */}
            {canVoid && <Button variant="secondary" onClick={onVoid} loading={update.isPending}><Ban className="size-4" aria-hidden="true" /> Void</Button>}
            {canPay && <Button onClick={() => setPaying(true)} data-testid="record-payment"><IndianRupee className="size-4" aria-hidden="true" /> Record payment</Button>}
          </>
        }
      />
      {/* Void failures land here (onVoid swallows them on purpose); the error stays until the next void attempt. */}
      <FormError message={update.error ? describeError(update.error) : null} />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {/* Payment status plus a separate "Overdue" badge driven by the backend's is_overdue / days_overdue. */}
        <PaymentStatusBadge status={i.payment_status} overdue={i.is_overdue} daysOverdue={i.days_overdue} />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-3" data-testid="invoice-totals">
        {/* Total, paid and outstanding are the backend's decimal strings; paid is derived server-side from recorded payments. */}
        <Stat label="Invoice total" value={<Money value={i.total} />} />
        <Stat label="Paid" tone="good" value={<Money value={i.paid} />} />
        <Stat label="Outstanding" tone={i.is_overdue ? "danger" : undefined} value={<Money value={i.outstanding} />} hint={i.is_overdue ? `${i.days_overdue} days overdue` : `Due ${formatDate(i.due_date)}`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card aria-labelledby="items-title">
          <CardHeader id="items-title" title="Items" />
          <DataTable caption="Invoice items">
            <thead>
              <tr>
                <th className={th}>Description</th>
                <th className={thNum}>Qty</th>
                <th className={thNum}>Unit price</th>
                <th className={thNum}>Line total</th>
              </tr>
            </thead>
            <tbody>
              {i.items.map((it) => (
                <tr key={it.id}>
                  <td className={td}>{it.description}</td>
                  <td className={tdNum}>{it.quantity}</td>
                  <td className={tdNum}><Money value={it.unit_price} /></td>
                  <td className={tdNum}><Money value={it.line_total} /></td>
                </tr>
              ))}
              {/* The total row repeats the backend's invoice total; line totals are never summed in the browser. */}
              <tr>
                <td className={td} colSpan={3}><span className="font-semibold">Total</span></td>
                <td className={tdNum}><Money value={i.total} className="font-semibold" /></td>
              </tr>
            </tbody>
          </DataTable>
          {i.notes && <p className="mt-4 text-sm text-muted">{i.notes}</p>}
        </Card>

        <Card aria-labelledby="ph-title">
          <CardHeader id="ph-title" title="Payment history" />
          {/* First 200 payments; no loading or error state of its own, so the list stays empty until data arrives. */}
          {payments.data && payments.data.items.length === 0 && <EmptyState title="No payments yet" />}
          <ul className="divide-y divide-line" data-testid="invoice-payments">
            {payments.data?.items.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <span>
                  <span className="block text-sm font-semibold">{formatDate(p.payment_date)}</span>
                  <span className="block text-xs text-muted">
                    {PAYMENT_METHOD_LABEL[p.payment_method] ?? p.payment_method}
                    {p.reference ? ` · ${p.reference}` : ""}
                    {p.source_action_id ? " · via assistant" : ""}
                  </span>
                </span>
                <Money value={p.amount} className="font-semibold text-good" />
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {/* Always mounted and toggled with `open`; it validates the amount against this invoice's outstanding and reuses one Idempotency-Key per submission. */}
      <PaymentDialog invoice={i} open={paying} onClose={() => setPaying(false)} />
    </>
  );
}
