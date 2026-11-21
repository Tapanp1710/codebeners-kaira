"use client";

/**
 * What-if analysis: "what if this customer/invoice pays N days late?". Sends POST /api/v1/cashflow/simulate
 * and compares the backend's simulated projection against the baseline forecast. Simulations are read-only on
 * the server: no invoices, promises, payments or balances change, and useSimulation invalidates nothing.
 * Customer and invoice pickers are filled from GET /customers and GET /invoices.
 */
import { FlaskConical, RotateCcw } from "lucide-react";
import dynamic from "next/dynamic";
import { useState, type FormEvent } from "react";

import { DataTable, Money, td, tdNum, th, thNum } from "@/components/ui/finance";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { Badge, Button, Card, CardHeader, Notice, PageHeader, Skeleton, Stat } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { useCustomers, useInvoices, useSimulation } from "@/lib/api/hooks";
import type { Schemas } from "@/lib/api/types";
import { formatDate } from "@/lib/format/dates";

// Same client-only, code-split Recharts module as the cash-flow page, with a fixed-height skeleton.
const SimulationChart = dynamic(() => import("@/components/charts/forecast-chart").then((m) => m.SimulationChart), {
  ssr: false,
  loading: () => <Skeleton className="h-80 w-full" />,
});

// Who pays late: the largest-balance customer (resolved by the backend), a chosen customer, or one invoice.
type Target = "largest" | "customer" | "invoice";

/** Client page: form state on the left, the last simulation result on the right. */
export default function ScenariosPage() {
  const [target, setTarget] = useState<Target>("largest");
  const [customerId, setCustomerId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  // Kept as text for the number input; validated below (1–365 days, unlike settings which allow 0).
  const [delay, setDelay] = useState("15");
  const [horizon, setHorizon] = useState(90);
  // Only customers with a balance, largest first, capped at the first 200 (no paging in the picker).
  const customers = useCustomers({ with_balance: true, sort: "outstanding", page_size: 200 });
  // Fetched only in "invoice" mode (enabled flag). Open invoices, optionally narrowed to the chosen customer,
  // again capped at 200.
  const invoices = useInvoices({ status: "open", customer_id: customerId || undefined, page_size: 200 }, target === "invoice");
  // A mutation used as an on-demand read: the result lives in mutation state, not the query cache, and stays
  // visible until the next run or reset(). "Back to baseline" just calls sim.reset(); there is nothing to undo
  // on the server.
  const sim = useSimulation();
  const result = sim.data;
  const delayDays = Number(delay);
  const delayValid = Number.isInteger(delayDays) && delayDays >= 1 && delayDays <= 365;

  /**
   * Builds the SimulationRequest: `largest_customer` is true only in "largest" mode, and customer_id /
   * invoice_id are added only for their own mode, so the backend never receives conflicting targets.
   */
  function onRun(e: FormEvent) {
    e.preventDefault();
    if (!delayValid) return;
    const body: Schemas["SimulationRequest"] = { delay_days: delayDays, horizon_days: horizon, largest_customer: target === "largest" };
    if (target === "customer") body.customer_id = customerId;
    if (target === "invoice") body.invoice_id = invoiceId;
    sim.mutate(body);
  }

  // The submit button is disabled until the chosen mode has its target. Changing the customer clears the
  // selected invoice (see its onChange), so an invoice from another customer cannot be submitted.
  const canRun = delayValid && (target === "largest" || (target === "customer" && customerId) || (target === "invoice" && invoiceId));

  return (
    <>
      <PageHeader title="What-If Analysis" subtitle="Test a delayed payment against your projected cash. Simulations never change your records." />
      <div className="grid gap-6 xl:grid-cols-[22rem_1fr]">
        <Card className="h-fit">
          <CardHeader title="Scenario" subtitle="“What if my major customer pays 15 days late?”" />
          <form onSubmit={onRun} className="space-y-4" noValidate>
            {/* noValidate: the 1–365 delay range is enforced by delayValid and shown through Field's error (linked via aria-describedby), not by browser popups. */}
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Who pays late</legend>
              {([
                ["largest", "My biggest customer (largest balance)"],
                ["customer", "A specific customer"],
                ["invoice", "A specific invoice"],
              ] as const).map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="target" value={v} checked={target === v} onChange={() => setTarget(v)} className="accent-steel" /> {l}
                </label>
              ))}
            </fieldset>
            {/* Picker labels show the raw decimal `outstanding` string, not formatted money; while GET /customers loads the list is just empty. */}
            {target !== "largest" && (
              <Field label="Customer">
                {(id) => (
                  <Select id={id} value={customerId} onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(""); }}>
                    <option value="">{target === "invoice" ? "Any customer" : "Choose a customer"}</option>
                    {customers.data?.items.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} · owes {c.outstanding}</option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {target === "invoice" && (
              <Field label="Invoice">
                {(id) => (
                  <Select id={id} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                    <option value="">Choose an open invoice</option>
                    {invoices.data?.items.map((i) => (
                      <option key={i.id} value={i.id}>{i.invoice_number} · {i.customer_name} · {i.outstanding}</option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="Delay (days)" error={!delayValid ? "Between 1 and 365 days" : undefined}>
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={365} value={delay} onChange={(e) => setDelay(e.target.value)} data-testid="delay-days" />}
            </Field>
            <Field label="Look ahead">
              {(id) => (
                <Select id={id} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                  <option value={180}>180 days</option>
                </Select>
              )}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" loading={sim.isPending} disabled={!canRun} data-testid="run-simulation">
                <FlaskConical className="size-4" aria-hidden="true" /> Run simulation
              </Button>
              {result && (
                <Button type="button" variant="ghost" onClick={() => sim.reset()}>
                  <RotateCcw className="size-4" aria-hidden="true" /> Back to baseline
                </Button>
              )}
            </div>
            {/* POST /cashflow/simulate failures, via describeError(); the next run or "Back to baseline" clears it. */}
            <FormError message={sim.error ? describeError(sim.error) : null} />
          </form>
        </Card>

        <div className="space-y-6">
          {/* Three states: a prompt before any run, a skeleton while the request is pending, then the last result (kept after form edits until reset). */}
          {!result && !sim.isPending && (
            <Card>
              <p className="font-display text-lg font-semibold">No scenario running</p>
              <p className="mt-1 text-sm text-muted">Your real forecast is unchanged. Choose who pays late and run a simulation to compare.</p>
            </Card>
          )}
          {sim.isPending && <Skeleton className="h-96 w-full" />}
          {result && (
            <div className="space-y-6" data-testid="simulation-result">
              {/* Uses the server's echoed target_label and delay_days, not the form values, because the form may have been edited since the run. */}
              <Notice tone="sim" title="Hypothetical scenario">
                If <strong>{result.target_label}</strong> pays <strong>{result.delay_days} days late</strong>. No invoices, promises, payments or balances were changed.
              </Notice>
              <div className="grid gap-4 sm:grid-cols-3">
                {/* The sign of the difference is read from the decimal string's leading "-", never by parsing it to a number. */}
                <Stat label="Lowest - baseline" value={<Money value={result.baseline_lowest_balance} />} hint={formatDate(result.baseline_lowest_balance_date)} />
                <Stat label="Lowest - simulated" tone={result.simulated_shortfalls.length ? "danger" : undefined} value={<Money value={result.simulated_lowest_balance} />} hint={formatDate(result.simulated_lowest_balance_date)} />
                <Stat label="Difference" tone={result.lowest_balance_difference.startsWith("-") ? "danger" : "good"} value={<Money value={result.lowest_balance_difference} signed />} hint="Simulated minus baseline" />
              </div>
              <Card>
                <CardHeader title="Impact" subtitle={<><Badge tone="info">Baseline = projected</Badge> <Badge tone="sim">Simulated = hypothetical</Badge></>} />
                <p className="mb-4 text-sm leading-relaxed" data-testid="simulation-explanation">{result.explanation}</p>
                {/* The first and last entries are shown as the range, relying on the backend returning new_shortfall_dates in date order. */}
                {result.new_shortfall_dates.length > 0 && (
                  <Notice tone="danger" title="New cash shortfall">
                    Cash would fall below your threshold on {result.new_shortfall_dates.length} day(s), from {formatDate(result.new_shortfall_dates[0])} to{" "}
                    {formatDate(result.new_shortfall_dates[result.new_shortfall_dates.length - 1])}.
                  </Notice>
                )}
                <div className="mt-4">
                  <SimulationChart points={result.points} />
                </div>
              </Card>
              <Card>
                <CardHeader title="Side by side" />
                <DataTable caption="Baseline versus simulated balances">
                  <thead>
                    <tr>
                      <th className={th}>After</th>
                      <th className={thNum}>Baseline</th>
                      <th className={thNum}>Simulated</th>
                      <th className={thNum}>Difference</th>
                    </tr>
                  </thead>
                  <tbody data-testid="simulation-comparison">
                    {result.comparison.map((c) => (
                      <tr key={c.days}>
                        {/* Simulated figures use the dedicated "sim" colour so they never read as actual or projected values. */}
                        <td className={td}>{c.days} days · {formatDate(c.date)}</td>
                        <td className={tdNum}><Money value={c.baseline_balance} /></td>
                        <td className={tdNum}><Money value={c.simulated_balance} className="text-sim" /></td>
                        <td className={tdNum}><Money value={c.difference} signed className={c.difference.startsWith("-") ? "text-danger" : ""} /></td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                <h3 className="mt-5 mb-2 text-sm font-semibold">Payments moved</h3>
                <ul className="space-y-1 text-sm">
                  {/* Index keys: shifted inflows carry no id and the whole list is replaced with each new result. */}
                  {result.shifted_inflows.map((s, i) => (
                    <li key={i}>
                      {s.label}: <Money value={s.amount} className="font-semibold" /> from {formatDate(s.baseline_date)} → <span className="text-sim">{formatDate(s.simulated_date)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <p><span className="font-semibold">Baseline shortfalls:</span> {result.baseline_shortfalls.length ? result.baseline_shortfalls.map((s) => `${formatDate(s.start)}–${formatDate(s.end)}`).join(", ") : "none"}</p>
                  <p><span className="font-semibold">Simulated shortfalls:</span> {result.simulated_shortfalls.length ? result.simulated_shortfalls.map((s) => `${formatDate(s.start)}–${formatDate(s.end)}`).join(", ") : "none"}</p>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
