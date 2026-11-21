/**
 * End-to-end workflows against a real KAIRA backend through the production build (see
 * playwright.config.ts). Tests that write data create their own uniquely named customer, so the
 * suite can be re-run against the same backend without clean-up or seed data.
 */
import { expect, test, type Page } from "@playwright/test";

import { apiGet, EMAIL, login, PASSWORD, uniqueName } from "./helpers";

type Customer = { id: string; outstanding: string; commitments: { status: string; amount: string }[] };

/** Creates a customer and an 18,000.00 invoice through the UI (not the API) and returns both ids. */
async function createCustomerWithInvoice(page: Page, name: string, total = "18000") {
  await page.goto("/customers");
  await page.getByRole("button", { name: "New customer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Phone").fill("9876543210");
  await dialog.getByRole("button", { name: "Add customer" }).click();
  // Backend ids are UUIDs; the URL change confirms the create succeeded.
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(page.locator("main h1")).toHaveText(name);
  const customerId = page.url().split("/").pop()!;

  await page.getByRole("link", { name: "New invoice" }).click();
  await page.waitForURL(/\/invoices\/new/);
  // Arriving from the customer page pre-selects that customer on the invoice form.
  await expect(page.getByLabel("Customer")).toHaveValue(customerId);
  await page.getByLabel("Item 1 description").fill("Basmati rice bags");
  await page.getByLabel("Quantity").fill("6");
  // With the default total, 18000 / 6 = 3000 exactly, so the unit price carries no rounding.
  await page.getByLabel("Unit price (₹)").fill(String(Number(total) / 6));
  await expect(page.getByTestId("invoice-estimate")).toContainText("₹18,000.00");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("invoice-totals")).toContainText("₹18,000.00");
  return { customerId, invoiceId: page.url().split("/").pop()! };
}

// Auth: cookie session through the proxy, invisible to page JavaScript, with CSRF enforced by the backend.
test.describe("authentication", () => {
  test("protected routes redirect to login; bad password is rejected; logout ends the session", async ({ page }) => {
    await page.goto("/receivables");
    await expect(page).toHaveURL(/\/login\?next=%2Freceivables/);
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(`${PASSWORD}-wrong`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect e-mail or password")).toBeVisible();

    await login(page, "/receivables");
    const cookies = await page.context().cookies();
    const access = cookies.find((c) => c.name === "kaira_access")!;
    const refresh = cookies.find((c) => c.name === "kaira_refresh")!;
    expect(access.httpOnly && refresh.httpOnly).toBe(true);
    // Refresh cookie scoped to the proxied auth path (rewritten by lib/server/proxy.ts).
    expect(refresh.path).toBe("/api/backend/api/v1/auth");
    expect(await page.evaluate(() => document.cookie)).not.toContain("kaira_"); // invisible to JS

    await page.getByRole("button", { name: /Demo Owner|Owner/ }).first().click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  // Keeps only the refresh cookie to simulate an expired access token: navigation must recover without a login prompt.
  test("an expired access cookie is renewed silently; a lost session returns to login", async ({ page, context }) => {
    await login(page, "/dashboard");
    const refresh = (await context.cookies()).find((c) => c.name === "kaira_refresh")!;
    await context.clearCookies();
    await context.addCookies([refresh]); // access token "expired", refresh still valid
    await page.goto("/customers");
    // Without an access cookie, proxy.ts sends the browser to /login, which silently refreshes and returns
    // here; the extended timeout covers that redirect and refresh chain.
    await page.waitForURL((u) => u.pathname === "/customers", { timeout: 60_000 });
    await expect(page.locator("main h1")).toHaveText("Customers & Invoices");

    await context.clearCookies(); // nothing left
    await page.goto("/cashflow");
    await expect(page).toHaveURL(/\/login\?next=%2Fcashflow/);
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  // Calls the proxy directly with cookies but no X-CSRF-Token: the backend must answer 403 CSRF_FAILED.
  test("unsafe API calls without the CSRF header are refused by the backend through the proxy", async ({ page }) => {
    await login(page);
    // page.request shares the browser context's cookies, so the session is valid and only the header is missing.
    const res = await page.request.post("/api/backend/api/v1/customers", { data: { name: "No CSRF" } });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("CSRF_FAILED");
  });
});

test.describe("customers, invoices and payments", () => {
  // Money path: overpayment blocked in the UI, then a partial payment reflected in the invoice, receivables, dashboard and API.
  test("create customer, invoice and partial payment; receivables and dashboard refresh", async ({ page }) => {
    await login(page);
    const name = uniqueName();
    const { invoiceId } = await createCustomerWithInvoice(page, name);

    await page.getByTestId("record-payment").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Amount (₹)").fill("18000.01");
    await dialog.getByRole("button", { name: "Record payment" }).click();
    await expect(dialog.getByText(/Cannot exceed the outstanding/)).toBeVisible();
    await dialog.getByLabel("Amount (₹)").fill("6000");
    await dialog.getByLabel("Method").selectOption("upi");
    await dialog.getByRole("button", { name: "Record payment" }).click();
    await expect(dialog.getByTestId("payment-confirmed")).toContainText("₹12,000.00");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("invoice-totals")).toContainText("₹12,000.00");
    await expect(page.getByTestId("invoice-payments")).toContainText("₹6,000.00");

    await page.getByRole("link", { name: "Receivables" }).first().click();
    await page.getByLabel("Search").fill(name);
    const row = page.getByTestId("receivable-rows").locator("tr", { hasText: name });
    await expect(row).toContainText("₹12,000.00");
    await expect(row).toContainText("Partially paid");

    await page.goto("/dashboard");
    await expect(page.getByTestId("recent-payments")).toContainText(name);
    const invoice = await apiGet<{ outstanding: string }>(page.request, `/invoices/${invoiceId}`);
    expect(invoice.outstanding).toBe("12000.00");
  });
});

test.describe("assistant and approvals", () => {
  // Both outcomes of the approval gate: rejection changes nothing; edit + approve writes payment, promise and audit entries.
  test("typed request -> proposal -> edit -> approve updates the books; a second proposal is rejected", async ({ page }) => {
    await login(page);
    const name = uniqueName();
    const { customerId, invoiceId } = await createCustomerWithInvoice(page, name);
    // partial payment first, as in the demo story
    await page.getByTestId("record-payment").click();
    await page.getByRole("dialog").getByLabel("Amount (₹)").fill("6000");
    await page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

    // Rejection path: nothing changes
    await page.getByTestId("assistant-launcher").click();
    const panel = page.getByRole("dialog", { name: "KAIRA assistant" });
    await panel.getByTestId("assistant-input").fill(`${name} paid me 1,000 rupees today.`);
    await panel.getByTestId("assistant-submit").click();
    const first = panel.getByTestId("proposal-card");
    await expect(first).toBeVisible();
    await first.getByRole("button", { name: /reject/i }).click();
    await expect(first.getByTestId("proposal-rejected")).toBeVisible();
    expect((await apiGet<{ outstanding: string }>(page.request, `/invoices/${invoiceId}`)).outstanding).toBe("12000.00");

    // Demo phrase
    await panel.getByTestId("assistant-input").fill(`${name} paid me 5,000 rupees today. He will clear the remaining amount next Monday.`);
    await panel.getByTestId("assistant-submit").click();
    const card = panel.getByTestId("proposal-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await expect(card).toBeVisible();
    const ops = card.getByTestId("proposal-operation");
    await expect(ops.nth(0)).toContainText("Record customer payment");
    await expect(ops.nth(0).getByTestId("resolution-customer")).toContainText(name);
    await expect(ops.nth(0).getByTestId("resolution-invoice")).toContainText("INV-");
    await expect(ops.nth(0)).toContainText("₹5,000.00");
    await expect(ops.nth(1)).toContainText("Record payment promise");
    await expect(ops.nth(1).getByTestId("computed-remaining_amount")).toContainText("₹7,000.00");
    await expect(card).toContainText("Confidence: high");
    await expect(card).toContainText("“next Monday”");

    // Edit: change the payment method, then approve
    await card.getByRole("button", { name: /edit/i }).click();
    await card.getByLabel("Payment method").first().selectOption("upi");
    await card.getByRole("button", { name: /save changes/i }).click();
    await expect(card).toContainText("edited by the owner");
    await card.getByRole("button", { name: /approve/i }).click();
    await expect(card).toHaveAttribute("data-status", "executed");
    await expect(card.getByTestId("proposal-result")).toContainText("Recorded payment of 5000.00");

    // Verify the real backend state
    const invoice = await apiGet<{ outstanding: string }>(page.request, `/invoices/${invoiceId}`);
    expect(invoice.outstanding).toBe("7000.00");
    const customer = await apiGet<Customer>(page.request, `/customers/${customerId}`);
    expect(customer.commitments.find((c) => c.status === "pending")?.amount).toBe("7000.00");
    const payments = await apiGet<{ items: { amount: string; source_action_id: string | null; payment_method: string }[] }>(page.request, `/invoices/${invoiceId}/payments`);
    const viaAssistant = payments.items.find((p) => p.source_action_id);
    expect(viaAssistant).toMatchObject({ amount: "5000.00", payment_method: "upi" });
    const audit = await apiGet<{ items: { action_type: string }[] }>(page.request, `/audit-logs?source_action_id=${viaAssistant!.source_action_id}`);
    expect(audit.items.map((a) => a.action_type)).toEqual(expect.arrayContaining(["payment.recorded", "commitment.created", "action.approved"]));

    // UI refreshed without reload
    await page.keyboard.press("Escape");
    await page.goto(`/customers/${customerId}`);
    await expect(page.getByTestId("customer-stats")).toContainText("₹7,000.00");
    await expect(page.getByTestId("customer-commitments")).toContainText("₹7,000.00");
  });

  // Fake media devices (playwright.config.ts) let recording run headless. The end state depends on whether the backend has a Sarvam key; typed input must stay usable either way.
  test("voice: explicit recording, honest provider error, typed fallback still available", async ({ page }) => {
    await login(page);
    await page.getByTestId("assistant-launcher").click();
    const panel = page.getByRole("dialog", { name: "KAIRA assistant" });
    await expect(panel.getByTestId("orb-state")).toHaveText("idle");
    await panel.getByTestId("voice-orb").click();
    await expect(panel.getByTestId("orb-state")).toHaveText("listening");
    // Record long enough to produce real audio; a near-instant second tap would end as empty_recording instead.
    await page.waitForTimeout(1500);
    await panel.getByTestId("voice-orb").click();
    // Read the backend's own provider status so the expected end state matches this environment.
    const ready = await page.request.get("/api/backend/api/v1/ready").then((r) => r.json());
    if (ready.data?.checks?.voice_provider === "configured") {
      await expect(panel.getByTestId("orb-state")).toHaveText(/ready|error/);
    } else {
      await expect(panel.getByTestId("orb-state")).toHaveText("error");
      await expect(panel.getByText(/SARVAM_API_KEY/)).toBeVisible();
      await expect(panel.getByText("Voice is not available on this server yet")).toBeVisible();
    }
    await expect(panel.getByTestId("assistant-input")).toBeEditable();
  });

  // Answers and reminder drafts must use the backend's figures (the 18,000.00 invoice); the draft says KAIRA never sends it.
  test("question is answered from backend data and a reminder draft uses real figures", async ({ page }) => {
    await login(page);
    const name = uniqueName();
    const { customerId } = await createCustomerWithInvoice(page, name);
    await page.getByTestId("assistant-launcher").click();
    const panel = page.getByRole("dialog", { name: "KAIRA assistant" });
    await panel.getByTestId("assistant-input").fill(`How much does ${name} owe?`);
    await panel.getByTestId("assistant-submit").click();
    await expect(panel.getByTestId("assistant-answer")).toContainText("₹18,000.00");
    await page.keyboard.press("Escape");

    await page.goto(`/customers/${customerId}`);
    await page.getByRole("button", { name: "Draft reminder" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Draft reminder" }).click();
    await expect(dialog.getByTestId("reminder-draft")).toContainText("₹18,000.00");
    await expect(dialog.getByTestId("reminder-draft")).toContainText("never sends");
  });
});

test.describe("forecast and what-if", () => {
  // Forecast milestones render, and running a what-if scenario leaves the stored forecast unchanged.
  test("forecast shows 30/60/90 projections; simulation is hypothetical and changes nothing", async ({ page }) => {
    await login(page);
    await page.goto("/cashflow");
    await expect(page.getByTestId("forecast-milestones")).toContainText("In 30 days");
    await expect(page.getByTestId("forecast-milestones")).toContainText("In 90 days");
    await expect(page.getByTestId("forecast-stats")).toContainText("Current cash (actual)");
    const before = await apiGet<{ points: unknown[]; current_cash: string }>(page.request, "/cashflow/forecast?horizon_days=90");

    await page.getByRole("link", { name: "What-If Analysis" }).first().click();
    await page.getByTestId("delay-days").fill("15");
    await page.getByTestId("run-simulation").click();
    const result = page.getByTestId("simulation-result");
    await expect(result).toContainText("Hypothetical scenario");
    await expect(result).toContainText("15 days late");
    await expect(page.getByTestId("simulation-comparison")).toContainText("90 days");
    await expect(page.getByTestId("simulation-explanation")).toContainText("no records were changed");

    const after = await apiGet<{ points: unknown[]; current_cash: string }>(page.request, "/cashflow/forecast?horizon_days=90");
    expect(after.points).toEqual(before.points);
    expect(after.current_cash).toBe(before.current_cash);
    await page.getByRole("button", { name: /Back to baseline/ }).click();
    await expect(page.getByText("No scenario running")).toBeVisible();
  });

  // Phone-sized viewport: navigation moves into a drawer and the page must not scroll horizontally.
  test("mobile layout: navigation drawer and readable tables", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Receivables" }).click();
    await expect(page.locator("main h1")).toHaveText("Receivables");
    // 1px tolerance absorbs sub-pixel rounding of scrollWidth.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });
});
