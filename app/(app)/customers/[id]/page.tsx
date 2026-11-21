"use client";

/**
 * Customer detail for the dynamic segment /customers/[id]. Issues four queries in parallel:
 * - GET /api/v1/customers/{id}: profile, balance totals and the customer's payment commitments.
 * - GET /api/v1/customers/{id}/invoices and /payments (first 200 each, no paging on this screen).
 * - GET /api/v1/audit-logs?entity_type=customer&entity_id={id} (latest 10) for the activity feed.
 * Actions: edit (CustomerFormDialog, PATCH), draft a reminder (ReminderDialog), or start a new invoice for
 * this customer.
 */
import { ArrowLeft, BellRing, FilePlus2, Pencil } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";

import { CustomerFormDialog } from "@/components/customers/customer-form";
import { ReminderDialog } from "@/components/customers/reminder-dialog";
import { CommitmentBadge, DataTable, Money, PAYMENT_METHOD_LABEL, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Button, Card, CardHeader, EmptyState, ErrorState, LinkButton, LoadingBlock, PageHeader, Stat } from "@/components/ui/primitives";
import { useAuditLogs, useCustomer, useCustomerInvoices, useCustomerPayments } from "@/lib/api/hooks";
import { formatDate, formatDateTime, humanize } from "@/lib/format/dates";

/**
 * Client Component page. In this Next.js version route `params` arrive as a Promise; a client page unwraps it
 * with React's use() rather than await.
 */
export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Only the customer query gates the page; the other three render their own sections when they arrive.
  const customer = useCustomer(id);
  const invoices = useCustomerInvoices(id);
  const payments = useCustomerPayments(id);
  const activity = useAuditLogs({ entity_type: "customer", entity_id: id, page_size: 10 });
  const [editing, setEditing] = useState(false);
  const [reminder, setReminder] = useState(false);
  const c = customer.data;

  // Early returns come after every hook call (rules of hooks). A missing or forbidden customer surfaces here
  // as an ApiError with a retry button.
  if (customer.isError) return <ErrorState error={customer.error} onRetry={() => customer.refetch()} />;
  if (!c) return <LoadingBlock label="Loading customer" rows={5} />;

  // Only pending promises are listed; fulfilled, cancelled and broken ones are just counted below the list.
  const upcoming = c.commitments.filter((x) => x.status === "pending");

  // Rendering notes:
  // - "Draft reminder" is disabled when nothing is outstanding.
  // - "New invoice" links to /invoices/new?customer={id}, which InvoiceForm uses to preselect the customer.
  // - The invoices section shows errors but no loading state; the payments and activity sections show neither,
  //   they stay empty until data arrives.
  // - Payments created by approving an assistant proposal carry source_action_id and are marked "via assistant".
  // - Activity entries humanise audit action types (first "." replaced, e.g. "customer.updated").
  // - Saving the edit dialog writes the response into this customer's cache entry and refreshes the list.
  return (
    <>
      <Link href="/customers" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-steel">
        <ArrowLeft className="size-4" aria-hidden="true" /> All customers
      </Link>
      <PageHeader
        title={c.name}
        subtitle={[c.phone, c.email, c.address].filter(Boolean).join(" · ") || "No contact details"}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden="true" /> Edit</Button>
            <Button variant="secondary" onClick={() => setReminder(true)} disabled={c.outstanding === "0.00"}>
              <BellRing className="size-4" aria-hidden="true" /> Draft reminder
            </Button>
            <LinkButton href={`/invoices/new?customer=${c.id}`} variant="primary"><FilePlus2 className="size-4" aria-hidden="true" /> New invoice</LinkButton>
          </>
        }
      />
      {c.notes && <p className="-mt-3 mb-6 text-sm text-muted">{c.notes}</p>}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="customer-stats">
        <Stat label="Outstanding" value={<Money value={c.outstanding} />} hint={`${c.open_invoice_count} open invoice(s)`} />
        <Stat label="Overdue" tone={c.overdue !== "0.00" ? "danger" : undefined} value={<Money value={c.overdue} />} hint={`${c.overdue_invoice_count} overdue invoice(s)`} />
        <Stat label="Total invoiced" value={<Money value={c.total_invoiced} />} />
        <Stat label="Total paid" tone="good" value={<Money value={c.total_paid} />} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card aria-labelledby="inv-title">
            <CardHeader id="inv-title" title="Invoices" />
            {invoices.isError && <ErrorState error={invoices.error} />}
            {invoices.data && invoices.data.items.length === 0 && <EmptyState title="No invoices yet" />}
            {invoices.data && invoices.data.items.length > 0 && (
              <DataTable caption={`Invoices for ${c.name}`}>
                <thead>
                  <tr>
                    <th className={th}>Invoice</th>
                    <th className={th}>Due</th>
                    <th className={thNum}>Total</th>
                    <th className={thNum}>Paid</th>
                    <th className={thNum}>Outstanding</th>
                    <th className={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.data.items.map((i) => (
                    <tr key={i.id}>
                      <td className={td}><Link href={`/invoices/${i.id}`} className="font-semibold hover:underline">{i.invoice_number}</Link></td>
                      <td className={td}>{formatDate(i.due_date)}</td>
                      <td className={tdNum}><Money value={i.total} /></td>
                      <td className={tdNum}><Money value={i.paid} /></td>
                      <td className={tdNum}><Money value={i.outstanding} className="font-semibold" /></td>
                      <td className={td}><PaymentStatusBadge status={i.payment_status} overdue={i.is_overdue} daysOverdue={i.days_overdue} /></td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>

          <Card aria-labelledby="pay-title">
            <CardHeader id="pay-title" title="Payment history" subtitle="Money actually received" />
            {payments.data && payments.data.items.length === 0 && <EmptyState title="No payments recorded" />}
            {payments.data && payments.data.items.length > 0 && (
              <DataTable caption={`Payments from ${c.name}`}>
                <thead>
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>Invoice</th>
                    <th className={th}>Method</th>
                    <th className={thNum}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.data.items.map((p) => (
                    <tr key={p.id}>
                      <td className={td}>{formatDate(p.payment_date)}</td>
                      <td className={td}><Link href={`/invoices/${p.invoice_id}`} className="hover:underline">{p.invoice_number}</Link></td>
                      <td className={td}>{PAYMENT_METHOD_LABEL[p.payment_method] ?? p.payment_method}{p.source_action_id ? " · via assistant" : ""}</td>
                      <td className={tdNum}><Money value={p.amount} className="font-semibold text-good" /></td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card aria-labelledby="com-title">
            <CardHeader id="com-title" title="Payment promises" subtitle="Expected, not yet received" />
            {upcoming.length === 0 ? (
              <EmptyState title="No pending promises" />
            ) : (
              <ul className="space-y-3" data-testid="customer-commitments">
                {upcoming.map((m) => (
                  <li key={m.id} className="rounded-xl p-3 ring-1 ring-line">
                    <p className="flex items-center justify-between gap-2">
                      <Money value={m.amount} className="font-semibold" />
                      <CommitmentBadge status={m.status} />
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Expected {formatDate(m.expected_payment_date)}
                      {m.invoice_number ? ` · ${m.invoice_number}` : " · whole balance"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {c.commitments.length > upcoming.length && (
              <p className="mt-3 text-xs text-muted">{c.commitments.length - upcoming.length} earlier promise(s) fulfilled or cancelled.</p>
            )}
          </Card>
          <Card aria-labelledby="hist-title">
            <CardHeader id="hist-title" title="Activity" />
            {activity.data && activity.data.items.length === 0 && <EmptyState title="No activity" />}
            <ol className="space-y-2">
              {activity.data?.items.map((a) => (
                <li key={a.id} className="text-sm">
                  <span className="font-semibold">{humanize(a.action_type.replace(".", " "))}</span>
                  <span className="block text-xs text-muted">{formatDateTime(a.created_at)}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <CustomerFormDialog open={editing} onClose={() => setEditing(false)} customer={c} />
      <ReminderDialog open={reminder} onClose={() => setReminder(false)} customerId={c.id} />
    </>
  );
}
