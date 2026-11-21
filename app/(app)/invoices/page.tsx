"use client";

/**
 * Invoice list (second tab of "Customers & Invoices"). Paginated GET /api/v1/invoices with search, status and
 * invoice-date range filters, 25 per page. Paid/outstanding amounts are computed by the backend from recorded
 * payments. New invoices are created on /invoices/new.
 */
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { SectionTabs } from "@/components/customers/section-tabs";
import { DataTable, Money, PaymentStatusBadge, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Field, Input, Select } from "@/components/ui/form";
import { Pager } from "@/components/ui/pager";
import { Card, EmptyState, ErrorState, LinkButton, LoadingBlock, PageHeader } from "@/components/ui/primitives";
import { useDebounced } from "@/hooks/use-debounced";
import { useInvoices } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format/dates";

// Backend status filter values. "open" means still owed (unpaid or partially paid); "void" is the lifecycle
// state of a voided invoice; "" sends no filter.
type Status = "" | "open" | "unpaid" | "partially_paid" | "paid" | "overdue" | "void";

/** Client page: filters are local state and become query parameters; empty values are omitted. */
export default function InvoicesPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("");
  // YYYY-MM-DD strings straight from the date inputs, applied to the invoice date (not the due date).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  // Search text is debounced (300 ms); the other filters apply immediately.
  const q = useDebounced(search);
  const invoices = useInvoices({
    search: q || undefined,
    status: status || undefined,
    date_from: from || undefined,
    date_to: to || undefined,
    page,
    page_size: 25,
  });
  const data = invoices.data;
  // Every filter change returns to page 1 so the page number cannot point past the new result set.
  const reset = () => setPage(1);

  return (
    <>
      <PageHeader
        title="Customers & Invoices"
        subtitle="Every invoice, with balances calculated by KAIRA"
        actions={<LinkButton href="/invoices/new" variant="primary"><Plus className="size-4" aria-hidden="true" /> New invoice</LinkButton>}
      />
      {/* Tabs shared with /customers; "Invoices" is highlighted here and on /invoices/{id}. */}
      <SectionTabs />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          {/* Field generates the id that ties each visible label to its control. Every filter handler calls reset() so the page stays in range. */}
          <Field label="Search">
            {(id) => (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <Input id={id} className="pl-9" placeholder="Invoice number or customer" value={search} onChange={(e) => { setSearch(e.target.value); reset(); }} />
              </div>
            )}
          </Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => { setStatus(e.target.value as Status); reset(); }}>
                <option value="">All</option>
                <option value="open">Open (owed)</option>
                <option value="overdue">Overdue</option>
                <option value="unpaid">Unpaid</option>
                <option value="partially_paid">Partially paid</option>
                <option value="paid">Paid</option>
                <option value="void">Void</option>
              </Select>
            )}
          </Field>
          {/* Date inputs give YYYY-MM-DD (or "" when cleared), sent unchanged; there is no client check that "from" is before "to", the backend decides. */}
          <Field label="Invoice date from">{(id) => <Input id={id} type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />}</Field>
          <Field label="Invoice date to">{(id) => <Input id={id} type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />}</Field>
        </div>

        {/* Error (with retry), first-load and empty states come from the query; with no placeholderData, a new filter or page shows the loading block until it arrives. */}
        {invoices.isError && <ErrorState error={invoices.error} onRetry={() => invoices.refetch()} />}
        {invoices.isPending && <LoadingBlock label="Loading invoices" />}
        {data && data.items.length === 0 && <EmptyState title="No invoices match these filters" />}
        {data && data.items.length > 0 && (
          <>
            <DataTable caption="Invoices">
              <thead>
                <tr>
                  <th className={th}>Invoice</th>
                  <th className={th}>Customer</th>
                  <th className={th}>Date</th>
                  <th className={th}>Due</th>
                  <th className={thNum}>Total</th>
                  <th className={thNum}>Paid</th>
                  <th className={thNum}>Outstanding</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody data-testid="invoice-rows">
                {data.items.map((i) => (
                  <tr key={i.id} className="hover:bg-cream/60">
                    {/* Rows are not clickable here (unlike the customer list); the invoice number and customer name are separate links. */}
                    <td className={td}><Link href={`/invoices/${i.id}`} className="font-semibold hover:underline">{i.invoice_number}</Link></td>
                    <td className={td}><Link href={`/customers/${i.customer_id}`} className="hover:underline">{i.customer_name}</Link></td>
                    <td className={td}>{formatDate(i.invoice_date)}</td>
                    <td className={td}>{formatDate(i.due_date)}</td>
                    <td className={tdNum}><Money value={i.total} /></td>
                    <td className={tdNum}><Money value={i.paid} /></td>
                    <td className={tdNum}><Money value={i.outstanding} className="font-semibold" /></td>
                    {/* Combines payment_status with the backend's is_overdue / days_overdue flags; overdue is never computed from dates in the browser. */}
                    <td className={td}><PaymentStatusBadge status={i.payment_status} overdue={i.is_overdue} daysOverdue={i.days_overdue} /></td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            {/* total and page_size come from the response, so the page count follows what the backend actually applied. */}
            <Pager page={page} total={data.total} pageSize={data.page_size} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
