/**
 * End-to-end workflows against a real KAIRA backend through the production build (see
 * playwright.config.ts). Tests that write data create their own uniquely named customer, so the
 * suite can be re-run against the same backend without clean-up or seed data.
 */
import { expect, test, type Page } from "@playwright/test";

import { apiGet, askKaira, csrfToken, EMAIL, login, PASSWORD, settleLatestWrite, uniqueName } from "./helpers";

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

test.describe("KAIRA agent and approvals", () => {
  // The typed path of the voice agent: the request is executed (or proposed and approved) on the real books, and
  // every ledger view refreshes. Which path is taken is the server's autonomy policy, so both are handled.
  test("typed request to KAIRA records a payment and promise; the books and the UI refresh", async ({ page }) => {
    await login(page);
    const name = uniqueName();
    const { customerId, invoiceId } = await createCustomerWithInvoice(page, name);
    // partial payment first, as in the demo story
    await page.getByTestId("record-payment").click();
    await page.getByRole("dialog").getByLabel("Amount (₹)").fill("6000");
    await page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

    // Demo phrase, typed to KAIRA on the agent home (reached through the primary navigation)
    const reply = await askKaira(page, `${name} paid me 5,000 rupees today. He will clear the remaining amount next Monday.`);
    expect(reply).toMatch(/5,000|5000/);
    await expect(page.locator('[data-testid="activity-item"][data-kind="write"]').first()).toBeVisible();
    const path = await settleLatestWrite(page, name);
    test.info().annotations.push({ type: "agent-path", description: path });

    // Verify the real backend state
    const invoice = await apiGet<{ outstanding: string }>(page.request, `/invoices/${invoiceId}`);
    expect(invoice.outstanding).toBe("7000.00");
    const customer = await apiGet<Customer>(page.request, `/customers/${customerId}`);
    expect(customer.commitments.find((c) => c.status === "pending")?.amount).toBe("7000.00");
    const payments = await apiGet<{ items: { amount: string; source_action_id: string | null }[] }>(page.request, `/invoices/${invoiceId}/payments`);
    const viaAgent = payments.items.find((p) => p.source_action_id);
    expect(viaAgent).toMatchObject({ amount: "5000.00" });
    const audit = await apiGet<{ items: { action_type: string }[] }>(page.request, `/audit-logs?source_action_id=${viaAgent!.source_action_id}`);
    expect(audit.items.map((a) => a.action_type)).toEqual(expect.arrayContaining(["payment.recorded", "commitment.created"]));

    // Manual screens show the new figures
    await page.goto(`/customers/${customerId}`);
    await expect(page.getByTestId("customer-stats")).toContainText("₹7,000.00");
    await expect(page.getByTestId("customer-commitments")).toContainText("₹7,000.00");
  });

  // Staff requests and unconfirmed agent requests become proposals that the owner reviews on the Approvals page.
  // The proposals are created through the extraction API here so the review flow is tested on its own:
  // rejection changes nothing; edit + approve writes payment, promise and audit entries.
  test("proposal review on Approvals: reject changes nothing; edit + approve updates the books", async ({ page }) => {
    await login(page);
    const name = uniqueName();
    const { customerId, invoiceId } = await createCustomerWithInvoice(page, name);
    await page.getByTestId("record-payment").click();
    await page.getByRole("dialog").getByLabel("Amount (₹)").fill("6000");
    await page.getByRole("dialog").getByRole("button", { name: "Record payment" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

    const token = await csrfToken(page.request);
    const propose = async (transcript: string) => {
      const res = await page.request.post("/api/backend/api/v1/assistant/extract", {
        headers: { "X-CSRF-Token": token },
        data: { transcript, language: null, input_mode: "text" },
      });
      expect(res.ok(), `POST /assistant/extract -> ${res.status()}`).toBeTruthy();
      const body = await res.json();
      expect(body.data.kind).toBe("proposal");
    };

    // Rejection path: nothing changes
    const small = `${name} paid me 1,000 rupees today.`;
    await propose(small);
    await page.goto("/actions");
    const first = page.getByTestId("proposal-card").filter({ hasText: small });
    await expect(first).toBeVisible();
    await first.getByRole("button", { name: /reject/i }).click();
    await expect(first.getByTestId("proposal-rejected")).toBeVisible();
    expect((await apiGet<{ outstanding: string }>(page.request, `/invoices/${invoiceId}`)).outstanding).toBe("12000.00");

    // Demo phrase
    const demo = `${name} paid me 5,000 rupees today. He will clear the remaining amount next Monday.`;
    await propose(demo);
    await page.reload();
    const card = page.getByTestId("proposal-card").filter({ hasText: demo });
    await expect(card).toHaveAttribute("data-status", "pending");
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
    const viaProposal = payments.items.find((p) => p.source_action_id);
    expect(viaProposal).toMatchObject({ amount: "5000.00", payment_method: "upi" });
    const audit = await apiGet<{ items: { action_type: string }[] }>(page.request, `/audit-logs?source_action_id=${viaProposal!.source_action_id}`);
    expect(audit.items.map((a) => a.action_type)).toEqual(expect.arrayContaining(["payment.recorded", "commitment.created", "action.approved"]));

    await page.goto(`/customers/${customerId}`);
    await expect(page.getByTestId("customer-stats")).toContainText("₹7,000.00");
    await expect(page.getByTestId("customer-commitments")).toContainText("₹7,000.00");
  });

  // The live session is an explicit switch. Fake media devices (playwright.config.ts) grant a microphone; whether
  // live voice then works depends on the backend's Sarvam key, so the expected state is read from /ready. In both
  // cases nothing pretends to listen, and the typed path stays usable.
  test("voice: explicit live session, honest status, typed fallback still available", async ({ page }) => {
    // Reduced motion keeps the orb still, so Playwright's stability checks never wait on the animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page);
    const toggle = page.getByTestId("agent-live-toggle");
    await expect(page.getByTestId("agent-status-label")).toHaveText("Live session off");
    await expect(page.getByRole("img", { name: "KAIRA: Live session off" })).toBeVisible();
    await expect(page.getByTestId("status-mic")).toContainText("Off");
    await expect(page.getByTestId("agent-mic-notice")).toContainText("The microphone is off");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    const ready = await page.request.get("/api/backend/api/v1/ready").then((r) => r.json());
    if (ready.data?.checks?.voice_provider === "configured") {
      await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
      await expect(page.getByTestId("agent-mic-notice")).toContainText("Microphone is on");
      await expect(page.getByTestId("status-mic")).toContainText("On");
      await expect(page.getByRole("img", { name: /KAIRA: (Connecting…|Listening|Hearing you|Understanding|Speaking)/ })).toBeVisible({ timeout: 30_000 });
      // Muting is a real state change; ending the session turns the microphone off again.
      await page.getByTestId("agent-mute").click();
      await expect(page.getByTestId("status-mic")).toContainText("Muted");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("agent-status-label")).toHaveText("Live session off");
    } else {
      await expect(page.getByTestId("agent-error")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("img", { name: "KAIRA: Voice unavailable" })).toBeVisible();
      await expect(page.getByTestId("status-mic")).not.toContainText("On");
    }
    await expect(page.getByTestId("agent-text-input")).toBeEditable();
  });

  // The dock talks to the same session from any page: a question asked on a customer page is answered from the
  // backend's figures (the 18,000.00 invoice), and the tool run is listed on the agent home afterwards.
  test("question asked from the dock is answered from backend data; a reminder draft uses real figures", async ({ page }) => {
    await login(page);
    const name = uniqueName();
    const { customerId } = await createCustomerWithInvoice(page, name);
    await page.goto(`/customers/${customerId}`);
    await expect(page.getByTestId("agent-dock")).toBeVisible();
    // Exactly one agent interface: the legacy launcher is gone.
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
    const answer = await askKaira(page, `How much does ${name} owe?`, "dock");
    expect(answer).toMatch(/18,000/);

    // Client-side navigation keeps the session: the dock's turn is on the agent home.
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "KAIRA", exact: true }).click();
    await page.waitForURL((u) => u.pathname === "/agent");
    await expect(page.locator('[data-testid="activity-item"][data-kind="read"][data-state="completed"]').first()).toBeVisible();
    await expect(page.getByTestId("transcript-entry").filter({ hasText: `How much does ${name} owe?` })).toHaveCount(1);
    await expect(page.getByTestId("agent-dock")).toHaveCount(0);

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
    // The agent home fits a phone without horizontal scrolling.
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Receivables" }).click();
    await expect(page.locator("main h1")).toHaveText("Receivables");
    // On a phone the dock is collapsed to state + live switch; "Show more" reveals the typed input.
    await expect(page.getByTestId("agent-dock")).toBeVisible();
    await expect(page.getByTestId("dock-text-input")).toBeHidden();
    await page.getByRole("button", { name: "Show more" }).click();
    await expect(page.getByTestId("dock-text-input")).toBeVisible();
    // 1px tolerance absorbs sub-pixel rounding of scrollWidth.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });
});
