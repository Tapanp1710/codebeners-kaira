"use client";

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

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const invoice = useInvoice(id);
  const payments = useInvoicePayments(id);
  const update = useUpdateInvoice(id);
  const toast = useToast();
  const [paying, setPaying] = useState(false);
  const i = invoice.data;

  if (invoice.isError) return <ErrorState error={invoice.error} onRetry={() => invoice.refetch()} />;
  if (!i) return <LoadingBlock label="Loading invoice" rows={5} />;

  const canPay = i.lifecycle_status === "issued" && i.outstanding !== "0.00";
  const canVoid = i.lifecycle_status === "issued" && i.paid === "0.00";

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
            {canVoid && <Button variant="secondary" onClick={onVoid} loading={update.isPending}><Ban className="size-4" aria-hidden="true" /> Void</Button>}
            {canPay && <Button onClick={() => setPaying(true)} data-testid="record-payment"><IndianRupee className="size-4" aria-hidden="true" /> Record payment</Button>}
          </>
        }
      />
      <FormError message={update.error ? describeError(update.error) : null} />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <PaymentStatusBadge status={i.payment_status} overdue={i.is_overdue} daysOverdue={i.days_overdue} />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-3" data-testid="invoice-totals">
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
      <PaymentDialog invoice={i} open={paying} onClose={() => setPaying(false)} />
    </>
  );
}
