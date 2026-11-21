import type { Metadata } from "next";
import { Suspense } from "react";

import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "New invoice" };

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
