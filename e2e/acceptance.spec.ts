/**
 * Final integration acceptance (frontend prompt, section 23) against the SEEDED demo business.
 * It records a real ₹5,000 payment for "Ramesh Kumar" on the backend, so it is opt-in:
 *   RUN_ACCEPTANCE=1 E2E_EMAIL=... E2E_PASSWORD=... npx playwright test e2e/acceptance.spec.ts
 * Expected values are computed from the state read at the start - nothing is hard-coded.
 */
import { expect, test } from "@playwright/test";

import { apiGet, login } from "./helpers";

const DEMO = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday.";
const cents = (v: string) => BigInt(v.replace(".", "").replace(/^(-?)0+(?=\d)/, "$1"));
const money = (c: bigint) => `${c < BigInt(0) ? "-" : ""}${(c < BigInt(0) ? -c : c) / BigInt(100)}.${String((c < BigInt(0) ? -c : c) % BigInt(100)).padStart(2, "0")}`;
const inr = (v: string) => {
  const [w, f] = v.split(".");
  const g = w.length > 3 ? `${w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${w.slice(-3)}` : w;
  return `₹${g}.${f}`;
};

type Dashboard = { cash: { current_cash: string }; receivables: { total_outstanding: string } };
type Customer = { id: string; name: string; outstanding: string; commitments: { status: string; amount: string; expected_payment_date: string }[] };

test.skip(process.env.RUN_ACCEPTANCE !== "1", "Opt-in: records a real payment on the seeded demo data (set RUN_ACCEPTANCE=1).");

test("KAIRA end-to-end acceptance: Ramesh pays 5,000 and promises the rest; simulation changes nothing", async ({ page, context }) => {
  // 1. Authentication: HttpOnly cookies, CSRF enforced
  await login(page, "/dashboard");
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "kaira_access")?.httpOnly).toBe(true);
  expect(cookies.find((c) => c.name === "kaira_refresh")?.httpOnly).toBe(true);
  expect((await page.request.post("/api/backend/api/v1/customers", { data: { name: "x" } })).status()).toBe(403);

  // 2. Dashboard with real metrics
  const dash0 = await apiGet<Dashboard>(page.request, "/dashboard");
  await expect(page.getByTestId("dashboard-stats")).toContainText(inr(dash0.cash.current_cash));
  await expect(page.getByTestId("dashboard-stats")).toContainText(inr(dash0.receivables.total_outstanding));

  // 3. Customers -> Ramesh -> invoice and outstanding balance
  await page.getByRole("link", { name: "Customers & Invoices" }).first().click();
  await page.getByPlaceholder("Search by name, phone or email").fill("Ramesh");
  await page.getByTestId("customer-rows").getByRole("link", { name: "Ramesh Kumar" }).click();
  await expect(page.locator("main h1")).toHaveText("Ramesh Kumar");
  const customerId = page.url().split("/").pop()!;
  const ramesh0 = await apiGet<Customer>(page.request, `/customers/${customerId}`);
  test.skip(cents(ramesh0.outstanding) <= BigInt(500000), `Ramesh owes ${ramesh0.outstanding}; the demo needs more than 5000.00 outstanding.`);
  await expect(page.getByTestId("customer-stats")).toContainText(inr(ramesh0.outstanding));
  const remaining = money(cents(ramesh0.outstanding) - BigInt(500000));

  // 4-5. Typed request (voice needs the Sarvam key) -> extraction shown in full
  await page.getByTestId("assistant-launcher").click();
  const panel = page.getByRole("dialog", { name: "KAIRA assistant" });
  await panel.getByTestId("assistant-input").fill(DEMO);
  await panel.getByTestId("assistant-submit").click();
  const card = panel.getByTestId("proposal-card");
  await expect(card).toHaveAttribute("data-status", "pending");
  await expect(card.getByTestId("proposal-transcript")).toContainText(DEMO);
  const ops = card.getByTestId("proposal-operation");
  await expect(ops.nth(0).getByTestId("operation-intent")).toHaveText("Record customer payment");
  await expect(ops.nth(0).getByTestId("resolution-customer")).toContainText("Ramesh Kumar");
  await expect(ops.nth(0).getByTestId("resolution-invoice")).toContainText("INV-");
  await expect(ops.nth(0)).toContainText("₹5,000.00");
  await expect(ops.nth(1).getByTestId("operation-intent")).toHaveText("Record payment promise");
  await expect(ops.nth(1).getByTestId("computed-remaining_amount")).toHaveText(inr(remaining));
  await expect(ops.nth(1)).toContainText("Promised date");
  await expect(card).toContainText("Confidence:");
  await expect(card).toContainText("found in transcript");
  await page.screenshot({ path: "test-results/acceptance-proposal.png", fullPage: true });

  // 6. Owner approval
  await card.getByRole("button", { name: /approve/i }).click();
  await expect(card).toHaveAttribute("data-status", "executed");
  await expect(card.getByTestId("proposal-result")).toContainText("Recorded payment of 5000.00");

  // 7. Verify actual backend changes
  const ramesh1 = await apiGet<Customer>(page.request, `/customers/${customerId}`);
  expect(ramesh1.outstanding).toBe(remaining);
  const promise = ramesh1.commitments.find((c) => c.status === "pending");
  expect(promise?.amount).toBe(remaining);
  const payments = await apiGet<{ items: { amount: string; source_action_id: string | null; invoice_id: string }[] }>(page.request, `/customers/${customerId}/payments`);
  const payment = payments.items.find((p) => p.source_action_id && p.amount === "5000.00");
  expect(payment).toBeTruthy();
  const audit = await apiGet<{ items: { action_type: string }[] }>(page.request, `/audit-logs?source_action_id=${payment!.source_action_id}`);
  expect(audit.items.map((a) => a.action_type)).toEqual(expect.arrayContaining(["payment.recorded", "commitment.created", "action.approved"]));
  const dash1 = await apiGet<Dashboard>(page.request, "/dashboard");
  expect(dash1.cash.current_cash).toBe(money(cents(dash0.cash.current_cash) + BigInt(500000))); // cash inflow
  expect(dash1.receivables.total_outstanding).toBe(money(cents(dash0.receivables.total_outstanding) - BigInt(500000)));
  const rec = await apiGet<{ items: { customer_name: string; outstanding: string }[] }>(page.request, `/receivables?customer_id=${customerId}`);
  expect(rec.items.reduce((s, r) => s + cents(r.outstanding), BigInt(0))).toBe(cents(remaining));

  // 8. Dashboard refresh in the UI
  await page.keyboard.press("Escape");
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-stats")).toContainText(inr(dash1.cash.current_cash));
  await expect(page.getByTestId("recent-payments")).toContainText("Ramesh Kumar");

  // 9. Cash-flow forecast 30/60/90
  await page.getByRole("link", { name: "Cash-Flow Forecast" }).first().click();
  for (const d of ["In 30 days", "In 60 days", "In 90 days"]) await expect(page.getByTestId("forecast-milestones")).toContainText(d);
  await expect(page.getByTestId("forecast-events")).toContainText("Ramesh Kumar promised payment");

  // 10. What-if: major customer 15 days late; nothing changes
  const forecastBefore = await apiGet<{ points: unknown[] }>(page.request, "/cashflow/forecast?horizon_days=90");
  const dashBefore = await apiGet<Dashboard>(page.request, "/dashboard");
  await page.getByRole("link", { name: "What-If Analysis" }).first().click();
  await page.getByTestId("delay-days").fill("15");
  await page.getByTestId("run-simulation").click();
  const result = page.getByTestId("simulation-result");
  await expect(result).toContainText("Hypothetical scenario");
  await expect(result).toContainText("Sri Venkateswara Enterprises");
  await expect(page.getByTestId("simulation-comparison")).toContainText("90 days");
  await page.screenshot({ path: "test-results/acceptance-simulation.png", fullPage: true });
  expect((await apiGet<{ points: unknown[] }>(page.request, "/cashflow/forecast?horizon_days=90")).points).toEqual(forecastBefore.points);
  expect(await apiGet<Dashboard>(page.request, "/dashboard")).toMatchObject({
    cash: { current_cash: dashBefore.cash.current_cash },
    receivables: { total_outstanding: dashBefore.receivables.total_outstanding },
  });

  // 11. Logout and protected routes
  await page.getByRole("button", { name: /Demo Owner|Owner/ }).first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await page.goto("/receivables");
  await expect(page).toHaveURL(/\/login\?next=%2Freceivables/);
  expect((await page.request.get("/api/backend/api/v1/dashboard")).status()).toBe(401);
});
