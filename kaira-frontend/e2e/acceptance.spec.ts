/**
 * Final integration acceptance (frontend prompt, section 23) against the SEEDED demo business.
 * It records a real ₹5,000 payment for "Ramesh Kumar" on the backend, so it is opt-in:
 *   RUN_ACCEPTANCE=1 E2E_EMAIL=... E2E_PASSWORD=... npx playwright test e2e/acceptance.spec.ts
 * Expected values are computed from the state read at the start - nothing is hard-coded.
 */
import { expect, test } from "@playwright/test";

import { apiGet, askKaira, LIVE_AGENT, login, settleLatestWrite } from "./helpers";

const DEMO = "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday.";
// Exact money helpers: "1234.50" <-> integer paise as BigInt, so expected values never pass through floats.
const cents = (v: string) => BigInt(v.replace(".", "").replace(/^(-?)0+(?=\d)/, "$1"));
const money = (c: bigint) => `${c < BigInt(0) ? "-" : ""}${(c < BigInt(0) ? -c : c) / BigInt(100)}.${String((c < BigInt(0) ? -c : c) % BigInt(100)).padStart(2, "0")}`;
// Formats a decimal string with Indian grouping, as the UI does, for text assertions.
const inr = (v: string) => {
  const [w, f] = v.split(".");
  const g = w.length > 3 ? `${w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${w.slice(-3)}` : w;
  return `₹${g}.${f}`;
};

type Dashboard = { cash: { current_cash: string }; receivables: { total_outstanding: string } };
type Customer = { id: string; name: string; outstanding: string; commitments: { id: string; status: string; amount: string; expected_payment_date: string }[] };

// Skipped unless RUN_ACCEPTANCE=1, because the test permanently changes the seeded demo data.
test.skip(process.env.RUN_ACCEPTANCE !== "1", "Opt-in: records a real payment on the seeded demo data (set RUN_ACCEPTANCE=1).");
// The whole story is driven by KAIRA's typed path, which needs the live agent LLM (no key in CI).
test.skip(!LIVE_AGENT, "Needs the live agent LLM (backend with SARVAM_API_KEY); set E2E_LIVE_AGENT=1.");

test("KAIRA end-to-end acceptance: Ramesh pays 5,000 and promises the rest; simulation changes nothing", async ({ page, context }) => {
  // 1. Authentication: HttpOnly cookies, CSRF enforced
  await login(page, "/dashboard");
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "kaira_access")?.httpOnly).toBe(true);
  expect(cookies.find((c) => c.name === "kaira_refresh")?.httpOnly).toBe(true);
  // A raw POST without X-CSRF-Token must be refused even though the session cookies are valid.
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
  // A previous acceptance run may have consumed the balance; skip rather than fail if 5,000.00 cannot be paid.
  test.skip(cents(ramesh0.outstanding) <= BigInt(500000), `Ramesh owes ${ramesh0.outstanding}; the demo needs more than 5000.00 outstanding.`);
  await expect(page.getByTestId("customer-stats")).toContainText(inr(ramesh0.outstanding));
  const remaining = money(cents(ramesh0.outstanding) - BigInt(500000));
  type Payments = { items: { id: string; amount: string; source_action_id: string | null; invoice_id: string }[] };
  const paymentsBefore = await apiGet<Payments>(page.request, `/customers/${customerId}/payments?page_size=100`);
  const pendingBefore = ramesh0.commitments.filter((c) => c.status === "pending").map((c) => c.id);

  // 4-6. Typed request to KAIRA on the agent home (the voice agent's typed path; live voice needs the Sarvam key).
  // The server's autonomy policy either executes it at once (owner, every value evidenced) or stores a proposal
  // that the owner approves on the Approvals page; settleLatestWrite handles both and fails on anything else.
  const reply = await askKaira(page, DEMO);
  expect(reply).toMatch(/5,000|5000/);
  const writes = page.locator('[data-testid="activity-item"][data-kind="write"]');
  await expect(writes.first()).toBeVisible();
  await expect(page.getByTestId("transcript-entry").filter({ hasText: DEMO }).last()).toBeVisible();
  // Full-page screenshots are kept under test-results/ as visual evidence of the acceptance run.
  await page.screenshot({ path: "test-results/acceptance-agent.png", fullPage: true });
  const path = await settleLatestWrite(page, "Ramesh Kumar");
  test.info().annotations.push({ type: "agent-path", description: path });

  // 7. Verify actual backend changes
  const ramesh1 = await apiGet<Customer>(page.request, `/customers/${customerId}`);
  expect(ramesh1.outstanding).toBe(remaining);
  // Exactly one new promise, pending, for exactly the remaining balance. (A new promise for the same balance
  // supersedes earlier pending ones - commitment_service._cancel_pending - which is checked in the audit below.)
  const newPromises = ramesh1.commitments.filter((c) => !ramesh0.commitments.some((o) => o.id === c.id));
  expect(newPromises.map((c) => [c.status, c.amount])).toEqual([["pending", remaining]]);
  const superseded = ramesh1.commitments.filter((c) => pendingBefore.includes(c.id) && c.status !== "pending");
  expect(superseded.every((c) => c.status === "cancelled")).toBe(true);
  // The payment must be traceable to the approved action (source_action_id) and present in the audit log.
  const payments = await apiGet<Payments>(page.request, `/customers/${customerId}/payments?page_size=100`);
  // Exactly once: this run added exactly one payment, of 5,000.00, made by KAIRA (source_action_id set).
  const known = new Set(paymentsBefore.items.map((p) => p.id));
  const added = payments.items.filter((p) => !known.has(p.id));
  expect(added.map((p) => p.amount)).toEqual(["5000.00"]);
  const payment = added[0];
  expect(payment.source_action_id).toBeTruthy();
  const audit = await apiGet<{ items: { action_type: string }[] }>(page.request, `/audit-logs?source_action_id=${payment.source_action_id}`);
  const types = audit.items.map((a) => a.action_type);
  expect(types).toEqual(expect.arrayContaining(["payment.recorded", "commitment.created"]));
  // One audit row per write, never a duplicate.
  expect(types.filter((t) => t === "payment.recorded")).toHaveLength(1);
  expect(types.filter((t) => t === "commitment.created")).toHaveLength(1);
  // Every earlier promise that the new one replaced is audited as superseded by the same action.
  expect(types.filter((t) => t === "commitment.superseded")).toHaveLength(superseded.length);
  const dash1 = await apiGet<Dashboard>(page.request, "/dashboard");
  // Dashboard totals move by exactly 5,000.00: cash up, receivables down.
  expect(dash1.cash.current_cash).toBe(money(cents(dash0.cash.current_cash) + BigInt(500000))); // cash inflow
  expect(dash1.receivables.total_outstanding).toBe(money(cents(dash0.receivables.total_outstanding) - BigInt(500000)));
  const rec = await apiGet<{ items: { customer_name: string; outstanding: string }[] }>(page.request, `/receivables?customer_id=${customerId}`);
  // Summed over all of Ramesh's open invoices: whichever invoice the payment landed on, the total must equal `remaining`.
  expect(rec.items.reduce((s, r) => s + cents(r.outstanding), BigInt(0))).toBe(cents(remaining));

  // 8. Dashboard refresh in the UI
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-stats")).toContainText(inr(dash1.cash.current_cash));
  await expect(page.getByTestId("recent-payments")).toContainText("Ramesh Kumar");

  // 9. Cash-flow forecast 30/60/90
  await page.getByRole("link", { name: "Cash-Flow Forecast" }).first().click();
  for (const d of ["In 30 days", "In 60 days", "In 90 days"]) await expect(page.getByTestId("forecast-milestones")).toContainText(d);
  // The commitment created by the approval in step 6 must now feed the forecast as an expected inflow.
  await expect(page.getByTestId("forecast-events")).toContainText("Ramesh Kumar promised payment");

  // 10. What-if: major customer 15 days late; nothing changes
  // Snapshot before the simulation so its read-only promise can be checked afterwards.
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
  // The simulation must not write anything: forecast points and dashboard totals are unchanged.
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
  // After logout the API itself refuses access (401), not just the UI routes.
  expect((await page.request.get("/api/backend/api/v1/dashboard")).status()).toBe(401);
});
