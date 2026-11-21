"use client";

/**
 * Receivables screen: money customers owe the business. Two independent queries feed it:
 * - GET /api/v1/receivables/summary: whole-business totals, ageing buckets and per-customer balances. It is
 *   NOT affected by the filters on this page.
 * - GET /api/v1/receivables: the paginated, filterable list of open invoices (25 per page).
 * Payments received and payment promises (commitments) are shown separately: a promise is expected money and
 * never reduces the outstanding balance. The bell icon opens ReminderDialog, which drafts a reminder through
 * POST /api/v1/assistant/reminder.
 */
import { BellRing, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ReminderDialog } from "@/components/customers/reminder-dialog";
import { PendingPaymentBadge, usePendingIds } from "@/components/payments/pending-payments";
import { AGEING_LABEL, DataTable, Money, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Field, Input, Select } from "@/components/ui/form";
import { Pager } from "@/components/ui/pager";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Stat } from "@/components/ui/primitives";
import { useDebounced } from "@/hooks/use-debounced";
import { useReceivables, useReceivablesSummary } from "@/lib/api/hooks";
import type { paths } from "@/lib/api/types";
import { formatDate } from "@/lib/format/dates";

// Filter types come from the generated OpenAPI schema, so status/ageing/sort values stay in step with the
// backend contract.
type Query = NonNullable<paths["/api/v1/receivables"]["get"]["parameters"]["query"]>;

/** Client page holding all filter state locally; every change produces a new receivables query. */
export default function ReceivablesPage() {
  // Invoices with an unconfirmed payment (server registry), flagged beside their status.
  const pendingInvoices = usePendingIds("invoice");
  const summary = useReceivablesSummary();
  const [search, setSearch] = useState("");
  // "" means "no filter" and is converted to undefined below so the parameter is omitted from the request.
  const [status, setStatus] = useState<Query["status"] | "">("");
  const [ageing, setAgeing] = useState<Query["ageing"] | "">("");
  // A leading "-" means descending (backend convention); the default shows the most overdue invoices first.
  const [sort, setSort] = useState<NonNullable<Query["sort"]>>("-days_overdue");
  // Set by clicking a name in the "By customer" table (click again to clear), not by a dropdown.
  const [customerId, setCustomerId] = useState("");
  const [page, setPage] = useState(1);
  // Target of the reminder dialog; null = closed. The dialog is only mounted while set, so it starts fresh.
  const [remind, setRemind] = useState<{ customer: string; invoice?: string } | null>(null);
  // 300 ms debounce: typing does not fire one request per keystroke. The page is reset to 1 immediately.
  const q = useDebounced(search);
  // Every filter change except sort also resets the page to 1 in its handler; changing sort keeps the page.
  const rows = useReceivables({
    search: q || undefined,
    status: status || undefined,
    ageing: ageing || undefined,
    customer_id: customerId || undefined,
    sort,
    page,
    page_size: 25,
  });
  const s = summary.data;

  return (
    <>
      <PageHeader title="Receivables" subtitle="Money customers owe you - received payments and promises are shown separately" />
      {/* Summary section (GET /receivables/summary): absent until loaded (no skeleton), with its own error and retry; the invoice list below loads and fails independently. */}
      {summary.isError && <ErrorState error={summary.error} onRetry={() => summary.refetch()} />}
      {s && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="receivables-summary">
            {/* "Overdue" emphasis compares the API's 2-decimal string with "0.00"; no float conversion is involved. */}
            <Stat label="Total owed to you" value={<Money value={s.total_outstanding} />} hint={`${s.open_invoice_count} open invoices`} />
            <Stat label="Overdue" tone={s.total_overdue !== "0.00" ? "danger" : undefined} value={<Money value={s.total_overdue} />} hint={`${s.overdue_invoice_count} overdue`} />
            <Stat label="Not yet due" value={<Money value={s.total_current} />} hint={`${s.unpaid_invoice_count} unpaid · ${s.partially_paid_invoice_count} part-paid`} />
            <Stat label="Promised (not received)" value={<Money value={s.pending_commitments_total} />} hint={<>Due in 7 days: <Money value={s.commitments_due_next_7_days} /></>} />
          </div>

          <div className="mb-6 grid gap-6 xl:grid-cols-[1fr_2fr]">
            <Card aria-labelledby="age-title">
              <CardHeader id="age-title" title="Ageing" subtitle="Outstanding by days overdue" />
              {/* Each bucket toggles the same `ageing` filter as the dropdown below (click the active one to clear it); aria-pressed exposes the toggle state. */}
              <ul className="space-y-2">
                {(Object.keys(AGEING_LABEL) as NonNullable<Query["ageing"]>[]).map((k) => (
                  <li key={k}>
                    <button type="button" onClick={() => { setAgeing(ageing === k ? "" : k); setPage(1); }} aria-pressed={ageing === k}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm ring-1 ${ageing === k ? "bg-navy text-cream ring-navy" : "ring-line hover:bg-cream"}`}>
                      <span>{AGEING_LABEL[k]}</span>
                      <Money value={s.ageing[k]} className="font-semibold" />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            <Card aria-labelledby="cust-title">
              <CardHeader id="cust-title" title="By customer" subtitle="Select a customer to filter the invoice list" />
              {s.customers.length === 0 ? (
                <EmptyState title="Nobody owes you money" />
              ) : (
                <DataTable caption="Balances by customer">
                  <thead>
                    <tr>
                      <th className={th}>Customer</th>
                      <th className={thNum}>Owes</th>
                      <th className={thNum}>Overdue</th>
                      <th className={thNum}>Promised</th>
                      <th className={th}>Oldest overdue</th>
                    </tr>
                  </thead>
                  <tbody data-testid="receivables-customers">
                    {s.customers.map((c) => (
                      <tr key={c.customer_id} className={customerId === c.customer_id ? "bg-cream" : ""}>
                        {/* The name button filters the invoice list to this customer (row highlighted while active); the link below it opens the customer page instead. */}
                        <td className={td}>
                          <button type="button" className="text-left font-semibold hover:underline" onClick={() => { setCustomerId(customerId === c.customer_id ? "" : c.customer_id); setPage(1); }} aria-pressed={customerId === c.customer_id}>
                            {c.customer_name}
                          </button>
                          <Link href={`/customers/${c.customer_id}`} className="block text-xs text-steel hover:underline">Open customer</Link>
                        </td>
                        <td className={tdNum}><Money value={c.outstanding} className="font-semibold" /></td>
                        <td className={tdNum}><Money value={c.overdue} className={c.overdue !== "0.00" ? "text-danger" : "text-muted"} /></td>
                        <td className={tdNum}><Money value={c.pending_commitments} className="text-steel" /></td>
                        <td className={td}>{c.max_days_overdue > 0 ? `${c.max_days_overdue} days` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              )}
            </Card>
          </div>
        </>
      )}

      {/* Open-invoice list (GET /receivables, 25 per page), driven by the filters below and the customer picked in "By customer". */}
      <Card aria-labelledby="ri-title">
        <CardHeader id="ri-title" title="Open invoices" subtitle={customerId ? "Filtered to one customer" : "All customers"} />
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">
            {(id) => (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <Input id={id} className="pl-9" placeholder="Customer or invoice" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
              </div>
            )}
          </Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} value={status ?? ""} onChange={(e) => { setStatus(e.target.value as Query["status"]); setPage(1); }}>
                <option value="">All open</option>
                <option value="overdue">Overdue</option>
                <option value="current">Not yet due</option>
                <option value="unpaid">Unpaid</option>
                <option value="partially_paid">Partially paid</option>
              </Select>
            )}
          </Field>
          <Field label="Ageing">
            {(id) => (
              <Select id={id} value={ageing ?? ""} onChange={(e) => { setAgeing(e.target.value as Query["ageing"]); setPage(1); }}>
                <option value="">Any</option>
                {Object.entries(AGEING_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Sort">
            {(id) => (
              <Select id={id} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="-days_overdue">Most overdue first</option>
                <option value="due_date">Due date (earliest)</option>
                <option value="-due_date">Due date (latest)</option>
                <option value="-outstanding">Largest balance</option>
                <option value="customer">Customer A–Z</option>
              </Select>
            )}
          </Field>
        </div>
        {/* No placeholderData: each filter/page combination is a new query key, so the table gives way to the loading block until that page arrives. */}
        {rows.isError && <ErrorState error={rows.error} onRetry={() => rows.refetch()} />}
        {rows.isPending && <LoadingBlock label="Loading receivables" />}
        {rows.data && rows.data.items.length === 0 && <EmptyState title="No open invoices match" />}
        {rows.data && rows.data.items.length > 0 && (
          <>
            <DataTable caption="Open invoices">
              <thead>
                <tr>
                  <th className={th}>Invoice</th>
                  <th className={th}>Customer</th>
                  <th className={th}>Due</th>
                  <th className={thNum}>Total</th>
                  <th className={thNum}>Received</th>
                  <th className={thNum}>Outstanding</th>
                  <th className={th}>Promised (expected)</th>
                  <th className={th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody data-testid="receivable-rows">
                {rows.data.items.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>
                      <Link href={`/invoices/${r.id}`} className="font-semibold hover:underline">{r.invoice_number}</Link>
                      <span className="mt-1 block">
                        <PaymentStatusBadge status={r.payment_status} overdue={r.is_overdue} daysOverdue={r.days_overdue} />
                        {pendingInvoices.has(r.id) && <Link href={`/invoices/${r.id}`} className="ml-1 inline-block"><PendingPaymentBadge /></Link>}
                      </span>
                    </td>
                    <td className={td}><Link href={`/customers/${r.customer_id}`} className="hover:underline">{r.customer_name}</Link></td>
                    <td className={td}>
                      {formatDate(r.due_date)}
                      <span className="block text-xs text-muted">{AGEING_LABEL[r.ageing_bucket]}</span>
                    </td>
                    <td className={tdNum}><Money value={r.total} /></td>
                    <td className={tdNum}><Money value={r.paid} className="text-good" /></td>
                    <td className={tdNum}><Money value={r.outstanding} className="font-semibold" /></td>
                    <td className={td}>
                      {/* Promises are listed next to the balance, never subtracted from it: a promise is expected money, not money received. */}
                      {r.commitments.length === 0 ? (
                        <span className="text-xs text-muted">No promise</span>
                      ) : (
                        r.commitments.map((c) => (
                          <span key={c.id} className="block text-xs">
                            <Badge tone="info"><Money value={c.amount} /></Badge> by {formatDate(c.expected_payment_date)}
                          </span>
                        ))
                      )}
                    </td>
                    <td className={td}>
                      {/* Icon-only button, so aria-label names both customer and invoice; the reminder is scoped to this invoice. */}
                      <button type="button" className="rounded-full p-1.5 text-steel hover:bg-navy/5" aria-label={`Draft reminder for ${r.customer_name}, ${r.invoice_number}`} onClick={() => setRemind({ customer: r.customer_id, invoice: r.id })}>
                        <BellRing className="size-4" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <Pager page={page} total={rows.data.total} pageSize={rows.data.page_size} onPage={setPage} />
          </>
        )}
      </Card>
      {/* Mounted only while a target is set, so language, tone and any previous draft start fresh for each reminder. */}
      {remind && <ReminderDialog open onClose={() => setRemind(null)} customerId={remind.customer} invoiceId={remind.invoice} />}
    </>
  );
}
