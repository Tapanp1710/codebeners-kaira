"use client";

/**
 * Customer list (first tab of "Customers & Invoices"; SectionTabs links to /invoices). Loads a paginated
 * GET /api/v1/customers with search, balance filter and sort; balances (outstanding, overdue, promised) come
 * precomputed from the backend. "New customer" opens CustomerFormDialog (POST /api/v1/customers, which
 * invalidates the customers queries) and navigates to the new customer's page on save.
 */
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { CustomerFormDialog } from "@/components/customers/customer-form";
import { SectionTabs } from "@/components/customers/section-tabs";
import { DataTable, Money, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Input, Select } from "@/components/ui/form";
import { Pager } from "@/components/ui/pager";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/primitives";
import { useDebounced } from "@/hooks/use-debounced";
import { useCustomers } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format/dates";

// Mirrors the backend's accepted `sort` values for /customers.
type Sort = "name" | "outstanding" | "overdue" | "recent";

/** Client page: filter/sort/page are local state; each combination is its own React Query cache entry. */
export default function CustomersPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  // Tri-state select value: "" = all (param omitted), "true" = owes money, "false" = settled.
  const [balance, setBalance] = useState<"" | "true" | "false">("");
  const [sort, setSort] = useState<Sort>("name");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  // 300 ms debounce before the search reaches the API; the page resets to 1 as soon as the text changes.
  const q = useDebounced(search);
  const customers = useCustomers({
    search: q || undefined,
    with_balance: balance === "" ? undefined : balance === "true",
    sort,
    page,
    page_size: 25,
  });
  const data = customers.data;

  return (
    <>
      <PageHeader
        title="Customers & Invoices"
        subtitle="Who you sell to, what they owe, and their history"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden="true" /> New customer
          </Button>
        }
      />
      <SectionTabs />
      <Card>
        {/* Filter bar: each control is wrapped in a <label> whose sr-only text gives it an accessible name without a visible label. */}
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <label className="relative">
            <span className="sr-only">Search customers</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input className="pl-9" placeholder="Search by name, phone or email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </label>
          <label>
            <span className="sr-only">Balance filter</span>
            <Select value={balance} onChange={(e) => { setBalance(e.target.value as typeof balance); setPage(1); }}>
              <option value="">All customers</option>
              <option value="true">Owes money</option>
              <option value="false">Settled</option>
            </Select>
          </label>
          {/* Changing the sort keeps the current page; search and the balance filter reset it to 1. */}
          <label>
            <span className="sr-only">Sort</span>
            <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="name">Sort: name</option>
              <option value="outstanding">Sort: amount owed</option>
              <option value="overdue">Sort: overdue</option>
              <option value="recent">Sort: newest</option>
            </Select>
          </label>
        </div>

        {/* No placeholderData: each filter/sort/page combination is a new query key, so the table gives way to the loading block while it loads. */}
        {customers.isError && <ErrorState error={customers.error} onRetry={() => customers.refetch()} />}
        {customers.isPending && <LoadingBlock label="Loading customers" />}
        {/* Uses the debounced query, so the message matches the search actually sent; the "add first customer" action appears only without a search. */}
        {data && data.items.length === 0 && (
          <EmptyState title={q ? "No customers match your search" : "No customers yet"} action={!q && <Button onClick={() => setCreating(true)}>Add your first customer</Button>} />
        )}
        {data && data.items.length > 0 && (
          <>
            <DataTable caption="Customers">
              <thead>
                <tr>
                  <th className={th}>Customer</th>
                  <th className={th}>Contact</th>
                  <th className={thNum}>Owes</th>
                  <th className={thNum}>Overdue</th>
                  <th className={th}>Status</th>
                  <th className={th}>Since</th>
                </tr>
              </thead>
              <tbody data-testid="customer-rows">
                {data.items.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-cream/60" onClick={() => router.push(`/customers/${c.id}`)}>
                    {/* The row click is a mouse convenience; the name Link is the keyboard/screen-reader path and stops propagation so one click does not navigate twice. */}
                    <td className={td}>
                      <Link href={`/customers/${c.id}`} className="font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                      <span className="block text-xs text-muted">{c.open_invoice_count} open invoice(s)</span>
                    </td>
                    <td className={td}>
                      <span className="block">{c.phone ?? "—"}</span>
                      <span className="block text-xs text-muted">{c.email ?? ""}</span>
                    </td>
                    <td className={tdNum}><Money value={c.outstanding} className="font-semibold" /></td>
                    <td className={tdNum}><Money value={c.overdue} className={c.overdue !== "0.00" ? "font-semibold text-danger" : "text-muted"} /></td>
                    <td className={td}>
                      {/* Badge priority Overdue > Owes > Settled, from string comparisons with "0.00"; "Promised" is added when pending commitments exist. */}
                      {c.overdue !== "0.00" ? (
                        <Badge tone="danger">Overdue</Badge>
                      ) : c.outstanding !== "0.00" ? (
                        <Badge tone="warn">Owes</Badge>
                      ) : (
                        <Badge tone="good">Settled</Badge>
                      )}
                      {c.pending_commitments !== "0.00" && <Badge tone="info" className="ml-1">Promised</Badge>}
                    </td>
                    {/* "Since" shows the date part of the UTC created_at timestamp as-is, without timezone conversion. */}
                    <td className={td}>{formatDate(c.created_at.slice(0, 10))}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            {/* total and page_size come from the response; with a single page Pager shows only the total count. */}
            <Pager page={page} total={data.total} pageSize={data.page_size} onPage={setPage} />
          </>
        )}
      </Card>
      {/* Create mode (no customer prop): POST /customers invalidates only customer lists, then onSaved opens the new customer's page. */}
      <CustomerFormDialog open={creating} onClose={() => setCreating(false)} onSaved={(id) => router.push(`/customers/${id}`)} />
    </>
  );
}
