"use client";

/**
 * Home dashboard (rendered by app/(app)/dashboard/page.tsx).
 *
 * Read-only summary built from two queries:
 *   - GET /dashboard                               (useDashboard): cash, receivables, bills, payments,
 *     forecast summary, alerts, recent audit activity and the pending-proposal count, all as of `as_of`
 *   - GET /cashflow/forecast?horizon_days=90&granularity=weekly (useForecast): points for the mini chart
 * Every figure is computed by the backend from the ledger; this component only formats and links. Both
 * queries are refreshed by invalidateFinancial() after any financial write elsewhere in the app, and the
 * two load independently, so a forecast failure does not hide the rest of the dashboard.
 */
import { AlertTriangle, ArrowRight, Info, RefreshCw, ShieldAlert } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";

// Maps an alert (InsightOut) to the page that resolves it: the related customer, cash flow, bills or receivables.
import { insightHref } from "@/components/layout/app-shell";
import { useSession } from "@/components/providers";
import { Money, PAYMENT_METHOD_LABEL } from "@/components/ui/finance";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, Skeleton, Stat } from "@/components/ui/primitives";
import { useDashboard, useForecast } from "@/lib/api/hooks";
import { formatDate, formatDateTime, humanize, relativeTime } from "@/lib/format/dates";

// Recharts is client-only and heavy: load the chart lazily with no SSR and show a skeleton meanwhile.
const ForecastChart = dynamic(() => import("@/components/charts/forecast-chart").then((m) => m.ForecastChart), {
  ssr: false,
  loading: () => <Skeleton className="h-56 w-full" />,
});

// Alert severity (InsightOut.severity) -> icon; colour is chosen alongside in the alerts list.
const SEVERITY_ICON = { critical: ShieldAlert, warning: AlertTriangle, info: Info } as const;

/** Greeting, headline stats, cash outlook, alerts, upcoming bills, recent payments and recent activity. */
export function DashboardView() {
  // Session is only used for the first name in the greeting.
  const { session } = useSession();
  const dashboard = useDashboard();
  // Weekly points over 90 days keep the compact chart light. This query key differs from the cash flow
  // page's daily forecast, so the two are cached separately.
  const forecast = useForecast(90, "weekly");
  const d = dashboard.data;

  return (
    <>
      {/* Subtitle: "Figures as of" is the backend's business date (as_of); "updated" is React Query's client fetch time (dataUpdatedAt). Refresh refetches only the dashboard query, not the forecast. */}
      <PageHeader
        title={`Good day${session ? `, ${session.user.name.split(" ")[0]}` : ""}`}
        subtitle={
          d ? (
            <span className="inline-flex items-center gap-2">
              Figures as of {formatDate(d.as_of)} · updated {relativeTime(dashboard.dataUpdatedAt)}
              <button type="button" onClick={() => dashboard.refetch()} aria-label="Refresh dashboard" className="rounded-full p-1 hover:bg-navy/5">
                <RefreshCw className={dashboard.isFetching ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
              </button>
            </span>
          ) : (
            "Your business at a glance"
          )
        }
      />

      {/* GET /dashboard states: error with retry, or skeleton rows on first load. React Query keeps the last data when a refetch fails, so the error can appear above still-visible figures. */}
      {dashboard.isError && <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />}
      {dashboard.isPending && <LoadingBlock label="Loading dashboard" rows={4} />}

      {d && (
        <div className="space-y-6">
          {/* Assistant proposals only link to /actions from here; approval happens there and nothing is recorded until then. */}
          {d.pending_action_count > 0 && (
            <Notice tone="warn" title={`${d.pending_action_count} proposal(s) waiting for approval`}>
              <Link href="/actions" className="font-semibold underline underline-offset-2">Review them</Link> — nothing is recorded until approved.
            </Notice>
          )}

          {/* Headline stats: amounts are backend decimal strings rendered by <Money>; Overdue turns red via an exact string check against "0.00", with no float parsing. */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="dashboard-stats">
            <Stat label="Current cash" value={<Money value={d.cash.current_cash} />} hint={`Actual · opening ${formatDate(d.cash.opening_cash_as_of)}`} href="/cashflow" />
            <Stat
              label="Customers owe you"
              value={<Money value={d.receivables.total_outstanding} />}
              hint={`${d.receivables.open_invoice_count} open invoices · ${d.unpaid_invoice_count} unpaid · ${d.partially_paid_invoice_count} part-paid`}
              href="/receivables"
            />
            <Stat
              label="Overdue"
              tone={d.receivables.total_overdue !== "0.00" ? "danger" : undefined}
              value={<Money value={d.receivables.total_overdue} />}
              hint={`${d.receivables.overdue_invoice_count} overdue invoice(s)`}
              href="/receivables"
            />
            <Stat label="Bills due in 14 days" value={<Money value={d.upcoming_bills_total} />} hint={`${d.upcoming_bills.length} bill(s)`} href="/cashflow#bills" />
          </div>

          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <Card aria-labelledby="fc-title">
              <CardHeader
                id="fc-title"
                title="Cash outlook"
                subtitle="Projected (not guaranteed) - based on due dates, promises and unpaid bills"
                action={<Link href="/cashflow" className="inline-flex items-center gap-1 text-sm font-semibold text-steel">Full forecast <ArrowRight className="size-4" aria-hidden="true" /></Link>}
              />
              {/* 30/60/90-day balances and the lowest point come from the forecast summary in GET /dashboard, not from the chart's points. */}
              <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([["In 30 days", d.forecast.balance_30_days], ["In 60 days", d.forecast.balance_60_days], ["In 90 days", d.forecast.balance_90_days]] as const).map(([label, v]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className="num font-display text-lg font-semibold"><Money value={v} /></dd>
                  </div>
                ))}
                <div>
                  <dt className="text-xs text-muted">Lowest point</dt>
                  <dd className={`num font-display text-lg font-semibold ${d.forecast.has_shortfall ? "text-danger" : ""}`}>
                    <Money value={d.forecast.lowest_balance} />
                    <span className="block text-xs font-normal text-muted">{formatDate(d.forecast.lowest_balance_date)}</span>
                  </dd>
                </div>
              </dl>
              {/* has_shortfall and first_shortfall_date are decided by the backend against the business's shortfall threshold; the danger Notice is announced as an alert. */}
              {d.forecast.has_shortfall && (
                <Notice tone="danger">Cash is projected to fall below your safety line from {formatDate(d.forecast.first_shortfall_date)}.</Notice>
              )}
              {/* Mini chart from the separate weekly forecast query: its failure shows an inline error here only. The dashed line is shortfall_threshold from that response. */}
              {forecast.data ? <ForecastChart points={forecast.data.points} threshold={forecast.data.shortfall_threshold} height={220} compact /> : forecast.isError ? <ErrorState error={forecast.error} /> : <Skeleton className="h-56 w-full" />}
            </Card>

            <Card aria-labelledby="alerts-title">
              <CardHeader id="alerts-title" title="Alerts" subtitle="Generated from your records" />
              {/* Alerts (InsightOut) have no id, so they are keyed by position; each links via insightHref to the page that resolves it. Icons are aria-hidden since the title carries the meaning. */}
              {d.alerts.length === 0 ? (
                <EmptyState title="Nothing needs attention" />
              ) : (
                <ul className="space-y-2" data-testid="dashboard-alerts">
                  {d.alerts.map((a, i) => {
                    const Icon = SEVERITY_ICON[a.severity];
                    return (
                      <li key={i}>
                        <Link href={insightHref(a)} className="flex gap-3 rounded-xl p-3 ring-1 ring-line transition hover:bg-cream">
                          <Icon className={`mt-0.5 size-5 shrink-0 ${a.severity === "critical" ? "text-danger" : a.severity === "warning" ? "text-warn" : "text-steel"}`} aria-hidden="true" />
                          <span>
                            <span className="block text-sm font-semibold">{a.title}</span>
                            <span className="block text-xs text-muted">{a.message}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card aria-labelledby="bills-title">
              <CardHeader id="bills-title" title="Upcoming bills" subtitle="Next 14 days and overdue" />
              {/* The backend selects these bills; each shows its unpaid remainder (outstanding), and a missing description falls back to "Bill". */}
              {d.upcoming_bills.length === 0 ? (
                <EmptyState title="No bills due soon" />
              ) : (
                <ul className="divide-y divide-line">
                  {d.upcoming_bills.map((b) => (
                    <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span>
                        <span className="block text-sm font-semibold">{b.vendor_name}</span>
                        <span className="block text-xs text-muted">
                          {b.description ?? "Bill"} · due {formatDate(b.due_date)} {b.is_overdue && <Badge tone="danger">Overdue</Badge>}
                        </span>
                      </span>
                      <Money value={b.outstanding} className="text-sm font-semibold" />
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card aria-labelledby="pay-title">
              <CardHeader id="pay-title" title="Recent payments" subtitle="Money actually received" />
              {/* Recorded payments link to their customer and invoice; a method code missing from PAYMENT_METHOD_LABEL is shown as-is. */}
              {d.recent_payments.length === 0 ? (
                <EmptyState title="No payments yet" />
              ) : (
                <ul className="divide-y divide-line" data-testid="recent-payments">
                  {d.recent_payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span>
                        <Link href={`/customers/${p.customer_id}`} className="block text-sm font-semibold hover:underline">{p.customer_name}</Link>
                        <span className="block text-xs text-muted">
                          <Link href={`/invoices/${p.invoice_id}`} className="hover:underline">{p.invoice_number}</Link> · {formatDate(p.payment_date)} · {PAYMENT_METHOD_LABEL[p.payment_method] ?? p.payment_method}
                        </span>
                      </span>
                      <Money value={p.amount} className="text-sm font-semibold text-good" />
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card aria-labelledby="act-title">
              <CardHeader id="act-title" title="Recent activity" subtitle="From the audit history" />
              {/* Dotted audit action types are humanised (String.replace swaps only the first "."); "via assistant" marks entries from an approved proposal (source_action_id). */}
              {d.recent_activity.length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <ol className="space-y-2.5">
                  {d.recent_activity.map((a) => (
                    <li key={a.id} className="text-sm">
                      <span className="font-semibold">{humanize(a.action_type.replace(".", " "))}</span>
                      {a.source_action_id && <Badge tone="info" className="ml-1">via assistant</Badge>}
                      <span className="block text-xs text-muted">{formatDateTime(a.created_at)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
