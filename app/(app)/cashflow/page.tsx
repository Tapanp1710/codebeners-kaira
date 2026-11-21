"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useState } from "react";

import { BillsPanel } from "@/components/cashflow/bills-panel";
import { useSession } from "@/components/providers";
import { DataTable, Money, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Select } from "@/components/ui/form";
import { Badge, Card, CardHeader, ErrorState, LoadingBlock, Notice, PageHeader, Skeleton, Stat } from "@/components/ui/primitives";
import { useForecast } from "@/lib/api/hooks";
import type { Forecast } from "@/lib/api/types";
import { formatDate } from "@/lib/format/dates";

const ForecastChart = dynamic(() => import("@/components/charts/forecast-chart").then((m) => m.ForecastChart), {
  ssr: false,
  loading: () => <Skeleton className="h-80 w-full" />,
});

const EVENT_LABEL: Record<Forecast["events"][number]["kind"], { label: string; tone: "good" | "warn" | "danger" | "info" | "neutral" }> = {
  invoice_due: { label: "Invoice due", tone: "good" },
  commitment: { label: "Promised by customer", tone: "info" },
  overdue_assumption: { label: "Overdue - assumed later", tone: "warn" },
  missed_commitment: { label: "Missed promise - assumed later", tone: "warn" },
  bill_due: { label: "Bill due", tone: "neutral" },
  overdue_bill: { label: "Overdue bill - assumed today", tone: "danger" },
};

export default function CashflowPage() {
  const { isOwner } = useSession();
  const [horizon, setHorizon] = useState(90);
  const [granularity, setGranularity] = useState<"daily" | "weekly">("daily");
  const forecast = useForecast(horizon, granularity);
  const f = forecast.data;

  return (
    <>
      <PageHeader
        title="Cash-Flow Forecast"
        subtitle="Projected from what you are owed and what you owe - a planning estimate, not a guarantee"
        actions={
          <div className="flex gap-2">
            <label>
              <span className="sr-only">Horizon</span>
              <Select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
                <option value={30}>Next 30 days</option>
                <option value={60}>Next 60 days</option>
                <option value={90}>Next 90 days</option>
                <option value={180}>Next 180 days</option>
              </Select>
            </label>
            <label>
              <span className="sr-only">Granularity</span>
              <Select value={granularity} onChange={(e) => setGranularity(e.target.value as "daily" | "weekly")}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
            </label>
          </div>
        }
      />
      {forecast.isError && <ErrorState error={forecast.error} onRetry={() => forecast.refetch()} />}
      {forecast.isPending && <LoadingBlock rows={5} label="Loading forecast" />}
      {f && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="forecast-stats">
            <Stat label="Current cash (actual)" value={<Money value={f.current_cash} />} hint={<>Opening <Money value={f.opening_cash} /></>} />
            <Stat label={`Expected in · ${horizon}d`} tone="good" value={<Money value={f.expected_inflows} />} hint="From invoices and promises" />
            <Stat label={`Expected out · ${horizon}d`} tone="warn" value={<Money value={f.expected_outflows} />} hint="Unpaid bills" />
            <Stat label="Lowest projected" tone={f.shortfalls.length ? "danger" : undefined} value={<Money value={f.lowest_balance} />} hint={`on ${formatDate(f.lowest_balance_date)}`} />
          </div>

          <Card aria-labelledby="ms-title">
            <CardHeader id="ms-title" title="Projected balance" subtitle={<>Solid area = projected cash · dashed line = your safety threshold (<Money value={f.shortfall_threshold} />)</>} />
            <dl className="mb-4 grid gap-3 sm:grid-cols-3" data-testid="forecast-milestones">
              {f.milestones.map((m) => (
                <div key={m.days} className="rounded-xl bg-cream/60 p-3">
                  <dt className="text-xs text-muted">In {m.days} days · {formatDate(m.date)}</dt>
                  <dd className="num font-display text-xl font-semibold"><Money value={m.balance} /></dd>
                </div>
              ))}
            </dl>
            {f.warnings.length > 0 && (
              <div className="mb-4 space-y-2">
                {f.warnings.map((w, i) => (
                  <Notice key={i} tone="danger">{w}</Notice>
                ))}
              </div>
            )}
            <ForecastChart points={f.points} threshold={f.shortfall_threshold} />
          </Card>

          <Card aria-labelledby="ev-title">
            <CardHeader id="ev-title" title="What drives the projection" subtitle={`${f.events.length} expected movements in this period`} />
            <DataTable caption="Expected cash movements">
              <thead>
                <tr>
                  <th className={th}>Expected</th>
                  <th className={th}>Item</th>
                  <th className={th}>Basis</th>
                  <th className={thNum}>In</th>
                  <th className={thNum}>Out</th>
                </tr>
              </thead>
              <tbody data-testid="forecast-events">
                {f.events.map((e, i) => (
                  <tr key={i}>
                    <td className={td}>
                      {formatDate(e.date)}
                      {e.original_date && e.original_date !== e.date && <span className="block text-xs text-muted">originally {formatDate(e.original_date)}</span>}
                    </td>
                    <td className={td}>
                      {e.invoice_id ? <Link href={`/invoices/${e.invoice_id}`} className="hover:underline">{e.label}</Link> : e.label}
                    </td>
                    <td className={td}><Badge tone={EVENT_LABEL[e.kind].tone}>{EVENT_LABEL[e.kind].label}</Badge></td>
                    <td className={tdNum}>{e.direction === "inflow" ? <Money value={e.amount} className="text-good" /> : ""}</td>
                    <td className={tdNum}>{e.direction === "outflow" ? <Money value={e.amount} className="text-warn" /> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            {(f.beyond_horizon_inflows !== "0.00" || f.beyond_horizon_outflows !== "0.00") && (
              <p className="mt-3 text-xs text-muted">
                Beyond this period: <Money value={f.beyond_horizon_inflows} /> expected in, <Money value={f.beyond_horizon_outflows} /> expected out.
              </p>
            )}
          </Card>

          <BillsPanel />

          <Card aria-labelledby="as-title">
            <CardHeader id="as-title" title="Assumptions" subtitle="How KAIRA builds this projection" />
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
              {f.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
            {isOwner && (
              <p className="mt-3 text-sm">
                The overdue collection delay and safety threshold are configurable in <Link href="/settings" className="font-semibold text-steel underline">business settings</Link>.
              </p>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
