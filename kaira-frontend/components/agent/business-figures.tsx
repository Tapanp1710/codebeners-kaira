"use client";

/**
 * Supporting business figures beside the conversation: current cash, what customers owe and what is overdue,
 * straight from GET /dashboard (useDashboard). The figures refresh with every other ledger view whenever the
 * agent (or a manual screen) changes the books. No value is shown that the backend did not return.
 */
import Link from "next/link";
import { memo } from "react";

import { Money } from "@/components/ui/finance";
import { ErrorState, Skeleton, cn } from "@/components/ui/primitives";
import { useDashboard } from "@/lib/api/hooks";
import { formatDate } from "@/lib/format/dates";

/** Memoised (no props): it re-renders only when the dashboard query changes, not on agent updates. */
export const BusinessFigures = memo(function BusinessFigures() {
  const dashboard = useDashboard();
  const d = dashboard.data;
  if (dashboard.isError && !d) return <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />;
  if (!d) {
    return (
      <div role="status" aria-label="Loading business figures" className="grid gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  const overdue = Number(d.receivables.total_overdue) > 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const rows = [
    { label: "Current cash", value: d.cash.current_cash, hint: "Actual", href: "/cashflow", danger: false },
    {
      label: "Customers owe you",
      value: d.receivables.total_outstanding,
      hint: plural(d.receivables.open_invoice_count, "open invoice"),
      href: "/receivables",
      danger: false,
    },
    {
      label: "Overdue",
      value: d.receivables.total_overdue,
      hint: plural(d.receivables.overdue_invoice_count, "overdue invoice"),
      href: "/receivables",
      danger: overdue,
    },
  ];
  return (
    <div data-testid="agent-figures">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-1">
        {rows.map((r) => (
          <li key={r.label}>
            <Link href={r.href} className="block rounded-xl bg-white/60 px-4 py-3 ring-1 ring-line/80 transition hover:ring-steel/40">
              <span className="block text-xs font-semibold uppercase tracking-wider text-muted">{r.label}</span>
              <span className={cn("num mt-1 block font-display text-xl font-semibold", r.danger ? "text-danger" : "text-ink")}>
                <Money value={r.value} />
              </span>
              <span className="block text-xs text-muted">{r.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Figures as of {formatDate(d.as_of)}, from your books.</p>
    </div>
  );
});
