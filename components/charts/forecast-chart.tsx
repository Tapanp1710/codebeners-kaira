"use client";

/**
 * Recharts visualisations for the cash forecast and the what-if simulation.
 *
 * Pure presentational components: they receive points from the API (GET /cashflow/forecast via
 * useForecast, POST /cashflow/simulate via useSimulation) and fetch nothing themselves. Consumers load
 * this module with next/dynamic and `ssr: false` (dashboard-view.tsx, app/(app)/cashflow/page.tsx,
 * app/(app)/scenarios/page.tsx), keeping Recharts out of the server render and the initial bundle.
 *
 * Money rule: API values are decimal strings. They are converted to JS numbers with chartNumber() ONLY
 * for plot geometry; tooltips and the table read the original strings from `raw` and format them exactly.
 */
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { DataTable, td, tdNum, th, thNum } from "@/components/ui/finance";
import type { Schemas } from "@/lib/api/types";
import { formatDate, formatShortDate } from "@/lib/format/dates";
import { chartNumber, formatMoney, formatMoneyCompact } from "@/lib/format/money";

// Literal hex values because Recharts takes colours as SVG attributes, not Tailwind classes. They match
// the theme (steel balance, sage inflow) and use a separate "simulated" colour so hypothetical values
// never look like projected ones.
const COLORS = { balance: "#415a77", inflow: "#778d7a", outflow: "#b07a5f", threshold: "#9e3f2a", simulated: "#6b5a8e" };

// { date: "YYYY-MM-DD", inflow, outflow, balance } with money as decimal strings; outflow is positive.
type Point = Schemas["ForecastPointOut"];

/**
 * Projected balance (area) with expected inflows/outflows (bars). Numbers are converted only for chart
 * geometry; every label and tooltip shows the backend's exact decimal string.
 *
 * @param points    one ForecastPointOut per day or week (granularity is chosen by the caller's query)
 * @param threshold the business's shortfall threshold (decimal string); drawn as a dashed reference line
 * @param height    plot height in px
 * @param compact   dashboard mode: hides legend, inflow/outflow bars and the table alternative
 */
export function ForecastChart({ points, threshold, height = 320, compact }: { points: Point[]; threshold?: string; height?: number; compact?: boolean }) {
  // Outflow is negated so its bars hang below the zero line; `raw` keeps the untouched API point for
  // the tooltip.
  const data = points.map((p) => ({
    date: p.date,
    balance: chartNumber(p.balance),
    inflow: chartNumber(p.inflow),
    outflow: -chartNumber(p.outflow),
    raw: p,
  }));
  // Accessibility: the SVG plot is aria-hidden; screen readers get the sr-only figcaption and (outside
  // compact mode) the "View as table" data table. The table lists only dates with a non-zero inflow or
  // outflow, plus the first and last point, to keep a 90-day daily series readable.
  // Rendering: axis ticks use compact ₹K/L/Cr labels (display only); the tooltip maps each series name
  // back to the exact string on `raw`, so outflow shows as the positive amount the API sent. The balance
  // is a stepAfter area, holding each value until the next point.
  return (
    <figure>
      <div style={{ height }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e2dbc6" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatShortDate} tick={{ fill: "#55606f", fontSize: 11 }} minTickGap={24} />
            <YAxis tickFormatter={formatMoneyCompact} tick={{ fill: "#55606f", fontSize: 11 }} width={64} />
            <Tooltip
              contentStyle={{ borderRadius: 12, border: "1px solid #e2dbc6", background: "#fbf9f1" }}
              labelFormatter={(l) => formatDate(String(l))}
              formatter={(_v, name, item) => {
                const raw = (item?.payload as { raw: Point }).raw;
                const map: Record<string, string> = { balance: raw.balance, inflow: raw.inflow, outflow: raw.outflow };
                const label = { balance: "Projected balance", inflow: "Expected in", outflow: "Expected out" }[String(name)] ?? String(name);
                return [formatMoney(map[String(name)]), label];
              }}
            />
            {!compact && (
              <Legend
                formatter={(v) => ({ balance: "Projected balance", inflow: "Expected inflow", outflow: "Expected outflow" })[String(v)] ?? v}
              />
            )}
            {!compact && <Bar dataKey="inflow" fill={COLORS.inflow} barSize={6} radius={[3, 3, 0, 0]} />}
            {!compact && <Bar dataKey="outflow" fill={COLORS.outflow} barSize={6} radius={[0, 0, 3, 3]} />}
            <Area type="stepAfter" dataKey="balance" stroke={COLORS.balance} strokeWidth={2} fill={COLORS.balance} fillOpacity={0.12} />
            {threshold !== undefined && (
              <ReferenceLine y={chartNumber(threshold)} stroke={COLORS.threshold} strokeDasharray="4 4" label={{ value: "Shortfall line", fill: COLORS.threshold, fontSize: 11, position: "insideBottomRight" }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">
        Projected cash from {formatDate(points[0]?.date)} to {formatDate(points[points.length - 1]?.date)}. A table of the same data follows.
      </figcaption>
      {!compact && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold text-steel">View as table</summary>
          <div className="mt-3 max-h-80 overflow-y-auto">
            <DataTable caption="Projected cash by date">
              <thead>
                <tr>
                  <th className={th}>Date</th>
                  <th className={thNum}>Expected in</th>
                  <th className={thNum}>Expected out</th>
                  <th className={thNum}>Projected balance</th>
                </tr>
              </thead>
              <tbody>
                {points
                  .filter((p) => p.inflow !== "0.00" || p.outflow !== "0.00" || p === points[0] || p === points[points.length - 1])
                  .map((p) => (
                    <tr key={p.date}>
                      <td className={td}>{formatDate(p.date)}</td>
                      <td className={tdNum}>{formatMoney(p.inflow)}</td>
                      <td className={tdNum}>{formatMoney(p.outflow)}</td>
                      <td className={tdNum}>{formatMoney(p.balance)}</td>
                    </tr>
                  ))}
              </tbody>
            </DataTable>
          </div>
        </details>
      )}
    </figure>
  );
}

/**
 * Baseline vs simulated balance for the Scenarios page. The simulated series is dashed and uses the
 * distinct "simulated" colour so hypothetical numbers are never confused with the projection. There is
 * no table here: the scenarios page renders its own comparison table. The only current caller does not
 * pass `threshold`.
 */
export function SimulationChart({ points, threshold }: { points: Schemas["SimulationPointOut"][]; threshold?: string }) {
  // Same pattern as ForecastChart: numbers for geometry, `raw` strings for the tooltip.
  const data = points.map((p) => ({ date: p.date, baseline: chartNumber(p.baseline_balance), simulated: chartNumber(p.simulated_balance), raw: p }));
  // Both series are stepAfter lines without dots; the tooltip labels each value as "projected" or
  // "hypothetical" so the two are never read as the same kind of figure.
  return (
    <figure>
      <div style={{ height: 320 }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e2dbc6" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatShortDate} tick={{ fill: "#55606f", fontSize: 11 }} minTickGap={24} />
            <YAxis tickFormatter={formatMoneyCompact} tick={{ fill: "#55606f", fontSize: 11 }} width={64} />
            <Tooltip
              contentStyle={{ borderRadius: 12, border: "1px solid #e2dbc6", background: "#fbf9f1" }}
              labelFormatter={(l) => formatDate(String(l))}
              formatter={(_v, name, item) => {
                const raw = (item?.payload as { raw: Schemas["SimulationPointOut"] }).raw;
                return name === "baseline"
                  ? [formatMoney(raw.baseline_balance), "Baseline (projected)"]
                  : [formatMoney(raw.simulated_balance), "Simulated (hypothetical)"];
              }}
            />
            <Legend formatter={(v) => (v === "baseline" ? "Baseline (projected)" : "Simulated (hypothetical)")} />
            <Line type="stepAfter" dataKey="baseline" stroke={COLORS.balance} strokeWidth={2} dot={false} />
            <Line type="stepAfter" dataKey="simulated" stroke={COLORS.simulated} strokeWidth={2} strokeDasharray="6 4" dot={false} />
            {threshold !== undefined && <ReferenceLine y={chartNumber(threshold)} stroke={COLORS.threshold} strokeDasharray="4 4" />}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">Baseline versus simulated projected cash. The comparison table above lists the key values.</figcaption>
    </figure>
  );
}
