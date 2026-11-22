/**
 * New-invoice route. Server Component wrapper that sets the page title and renders the client InvoiceForm.
 * The form submits POST /api/v1/invoices (useCreateInvoice, which refreshes every ledger-derived query on
 * success). As the subtitle says, the backend assigns the invoice number and computes the authoritative total;
 * the form only shows an exact on-screen estimate.
 */
import type { Metadata } from "next";
import { Suspense } from "react";

import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "New invoice" };

/**
 * InvoiceForm reads `?customer=<id>` (set by the customer detail page's "New invoice" button) with
 * useSearchParams to preselect the customer, hence the Suspense boundary Next.js requires around it.
 */
export default function NewInvoicePage() {
  return (
    <>
      <PageHeader title="New invoice" subtitle="KAIRA numbers the invoice and calculates the final total." />
      <Suspense fallback={null}>
        <InvoiceForm />
      </Suspense>
    </>
  );
}
