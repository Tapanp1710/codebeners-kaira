"use client";

/**
 * Pending-payment visibility across the app. The data comes from the backend's payment-attempt registry
 * (GET /payment-attempts?status=pending), so it is the same on every device and does not depend on which
 * page of a list is loaded. Used by the dashboard, the invoice list and receivables; the invoice page and the
 * bills panel also merge in this browser's not-yet-registered local records.
 */
import Link from "next/link";

import { Money } from "@/components/ui/finance";
import { Badge, Notice } from "@/components/ui/primitives";
import { usePendingPaymentAttempts } from "@/lib/api/hooks";

/** Ids of invoices or bills with a pending attempt on the server. */
export function usePendingIds(kind: "invoice" | "bill"): Set<string> {
  const pending = usePendingPaymentAttempts();
  return new Set((pending.data?.items ?? []).filter((a) => a.resource_type === kind).map((a) => a.resource_id));
}

export function PendingPaymentBadge() {
  return <Badge tone="warn">Payment pending</Badge>;
}

/** Dashboard alert: every unconfirmed payment of the business, each linking to where it can be resolved. */
export function PendingPaymentsAlert() {
  const pending = usePendingPaymentAttempts();
  const items = pending.data?.items ?? [];
  if (items.length === 0) return null;
  const total = pending.data?.total ?? items.length;
  return (
    <Notice tone="warn" title={`${total} payment${total === 1 ? "" : "s"} awaiting confirmation`}>
      These payments could not be confirmed. Open each one and retry it; a retry can never record it twice.
      <ul className="mt-2 space-y-1">
        {items.map((a) => (
          <li key={a.id}>
            <Link
              className="font-semibold underline underline-offset-2"
              href={a.resource_type === "invoice" ? `/invoices/${a.resource_id}` : "/cashflow#bills"}
            >
              {a.resource_type === "invoice" ? `Invoice ${a.resource_label}` : `Bill: ${a.resource_label}`}
            </Link>{" "}
            · <Money value={a.request.amount} />
          </li>
        ))}
      </ul>
    </Notice>
  );
}
