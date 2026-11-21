"use client";

import { AlertTriangle, ArrowRight, Info, RefreshCw, ShieldAlert } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";

import { insightHref } from "@/components/layout/app-shell";
import { useSession } from "@/components/providers";
import { Money, PAYMENT_METHOD_LABEL } from "@/components/ui/finance";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, Skeleton, Stat } from "@/components/ui/primitives";
import { useDashboard, useForecast } from "@/lib/api/hooks";
import { formatDate, formatDateTime, humanize, relativeTime } from "@/lib/format/dates";

const ForecastChart = dynamic(() => import("@/components/charts/forecast-chart").then((m) => m.ForecastChart), {
  ssr: false,
  loading: () => <Skeleton className="h-56 w-full" />,
});

const SEVERITY_ICON = { critical: ShieldAlert, warning: AlertTriangle, info: Info } as const;

export function DashboardView() {
  const { session } = useSession();
  const dashboard = useDashboard();
  const forecast = useForecast(90, "weekly");
  const d = dashboard.data;

  return (
    <>
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

      {dashboard.isError && <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />}
      {dashboard.isPending && <LoadingBlock label="Loading dashboard" rows={4} />}

      {d && (
        <div className="space-y-6">
          {d.pending_action_count > 0 && (
            <Notice tone="warn" title={`${d.pending_action_count} proposal(s) waiting for approval`}>
              <Link href="/actions" className="font-semibold underline underline-offset-2">Review them</Link> — nothing is recorded until approved.
            </Notice>
          )}

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
              {d.forecast.has_shortfall && (
                <Notice tone="danger">Cash is projected to fall below your safety line from {formatDate(d.forecast.first_shortfall_date)}.</Notice>
              )}
              {forecast.data ? <ForecastChart points={forecast.data.points} threshold={forecast.data.shortfall_threshold} height={220} compact /> : forecast.isError ? <ErrorState error={forecast.error} /> : <Skeleton className="h-56 w-full" />}
            </Card>

            <Card aria-labelledby="alerts-title">
              <CardHeader id="alerts-title" title="Alerts" subtitle="Generated from your records" />
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
