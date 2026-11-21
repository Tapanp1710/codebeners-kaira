/**
 * Lost-response bill payments against a REAL backend.
 *
 * The first POST /bills/{id}/payments is let through to the backend (which commits the payment, the cash
 * outflow and the audit entry) and then aborted on its way back to the browser, so the frontend sees a
 * network failure. The payment is then recovered: in the same page, after a reload, after a full browser
 * restart (persistent profile closed and relaunched), and from a second tab. Each time the backend must end
 * with exactly one payment, one outflow and one audit entry for that bill.
 *
 * Opt-in, and only against a DISPOSABLE backend: it creates bills and payments.
 *   E2E_DISPOSABLE_BACKEND=1 BACKEND_ORIGIN=http://127.0.0.1:8100 E2E_EMAIL=... E2E_PASSWORD=... \
 *     npx playwright test e2e/bill-payment-idempotency.spec.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, test, type Page, type Request } from "@playwright/test";

import { apiGet, EMAIL, login, PASSWORD, uniqueName } from "./helpers";

test.skip(process.env.E2E_DISPOSABLE_BACKEND !== "1", "Opt-in: writes bills and payments (set E2E_DISPOSABLE_BACKEND=1 against a disposable backend).");

type BillDetail = { id: string; outstanding: string; payments: { id: string; amount: string }[] };
type Position = { total_outflows: string };
type AuditPage = { total: number };

const PAYMENTS = /\/api\/backend\/api\/v1\/bills\/[^/]+\/payments$/;
const ATTEMPT_PREFIX = "kaira:bill-payment-attempt:v1:";
const cents = (s: string) => BigInt(s.replace(".", ""));

/** Creates a uniquely named unpaid bill through the proxy (CSRF token from /auth/me). */
async function createBill(page: Page, amount: string) {
  const me = await apiGet<{ csrf_token: string }>(page.request, "/auth/me");
  const vendor = `${uniqueName()} Supplies`;
  const res = await page.request.post("/api/backend/api/v1/bills", {
    headers: { "X-CSRF-Token": me.csrf_token },
    data: { vendor_name: vendor, amount, category: "test" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { id: body.data.id as string, vendor };
}

/**
 * Records every payment POST the page sends (key + body). The pass-through route enables interception,
 * which is what lets Playwright expose the streamed request body; it does not alter the request.
 */
async function recordPaymentPosts(page: Page, into: Request[]) {
  await page.route(PAYMENTS, (route) => route.continue());
  page.on("request", (r) => { if (r.method() === "POST" && PAYMENTS.test(r.url())) into.push(r); });
}

/** Lets the first payment POST reach the backend, then drops its response; later POSTs pass through. */
async function loseFirstPaymentResponse(page: Page) {
  const committed: number[] = [];
  let first = true;
  await page.route(PAYMENTS, async (route) => {
    if (route.request().method() !== "POST" || !first) return route.continue();
    first = false;
    const upstream = await route.fetch();
    committed.push(upstream.status());
    await route.abort("failed");
  });
  return committed;
}

async function openBill(page: Page, vendor: string, action: "Pay" | "Resolve payment") {
  await page.goto("/cashflow#bills");
  await page.getByRole("row", { name: new RegExp(vendor) }).getByRole("button", { name: action, exact: true }).click();
  return page.getByRole("dialog");
}

async function payAndLoseResponse(page: Page, vendor: string, amount: string) {
  const committed = await loseFirstPaymentResponse(page);
  const dialog = await openBill(page, vendor, "Pay");
  await dialog.getByLabel("Amount (₹)").fill(amount);
  await dialog.getByRole("button", { name: "Record bill payment" }).click();
  await expect(dialog.getByText("Payment not confirmed")).toBeVisible();
  // The backend did commit the first request; only the response was lost.
  expect(committed).toEqual([201]);
  // Discarding is not offered for an uncertain payment.
  await expect(dialog.getByRole("button", { name: /discard/i })).toHaveCount(0);
  return dialog;
}

async function expectExactlyOnePayment(page: Page, billId: string, amount: string, outflowsBefore: string) {
  const bill = await apiGet<BillDetail>(page.request, `/bills/${billId}`);
  expect(bill.payments).toHaveLength(1);
  expect(bill.payments[0].amount).toBe(amount);
  const audit = await apiGet<AuditPage>(page.request, `/audit-logs?entity_type=bill_payment&entity_id=${bill.payments[0].id}`);
  expect(audit.total).toBe(1);
  const pos = await apiGet<Position>(page.request, "/cashflow/position");
  expect(cents(pos.total_outflows) - cents(outflowsBefore)).toBe(cents(amount));
  return bill;
}

function expectSameAttempt(sent: Request[], count: number) {
  expect(sent).toHaveLength(count);
  for (const r of sent) {
    expect(r.headers()["idempotency-key"]).toBe(sent[0].headers()["idempotency-key"]);
    expect(r.postDataJSON()).toEqual(sent[0].postDataJSON());
  }
}

test("lost response after commit: the retry reuses the key and the backend holds exactly one payment", async ({ page }) => {
  await login(page);
  const { id, vendor } = await createBill(page, "4321.50");
  const before = await apiGet<Position>(page.request, "/cashflow/position");
  const sent: Request[] = [];
  await recordPaymentPosts(page, sent);

  const dialog = await payAndLoseResponse(page, vendor, "1234.50");
  await dialog.getByRole("button", { name: "Retry payment" }).click();
  await expect(page.getByText(/had already been recorded; no duplicate was created/)).toBeVisible();

  expectSameAttempt(sent, 2);
  const bill = await expectExactlyOnePayment(page, id, "1234.50", before.total_outflows);
  expect(bill.outstanding).toBe("3087.00");
});

test("lost response, closed dialog, then a reload: the restored attempt replays instead of paying twice", async ({ page }) => {
  await login(page);
  const { id, vendor } = await createBill(page, "900.00");
  const before = await apiGet<Position>(page.request, "/cashflow/position");
  const sent: Request[] = [];
  await recordPaymentPosts(page, sent);

  const dialog = await payAndLoseResponse(page, vendor, "600.00");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  // The server now reports 300.00 outstanding, yet the stored 600.00 attempt must still be retried.
  const reopened = await openBill(page, vendor, "Resolve payment");
  await expect(reopened.getByText("Payment not confirmed")).toBeVisible();
  await expect(reopened.getByLabel("Amount (₹)")).toHaveValue("600.00");
  await reopened.getByRole("button", { name: "Retry payment" }).click();
  await expect(page.getByText(/had already been recorded; no duplicate was created/)).toBeVisible();

  expectSameAttempt(sent, 2);
  await expectExactlyOnePayment(page, id, "600.00", before.total_outflows);
});

test("lost response, browser closed, browser reopened: the retry replays the original payment", async ({}, testInfo) => {
  const profile = mkdtempSync(join(tmpdir(), "kaira-e2e-profile-"));
  const baseURL = testInfo.project.use.baseURL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`;
  const sent: Request[] = [];
  try {
    // Session 1: a real Chromium profile on disk.
    let browser = await chromium.launchPersistentContext(profile, { baseURL });
    let page = browser.pages()[0] ?? (await browser.newPage());
    await recordPaymentPosts(page, sent);
    await login(page);
    const { id, vendor } = await createBill(page, "2500.00");
    const before = await apiGet<Position>(page.request, "/cashflow/position");
    await payAndLoseResponse(page, vendor, "2500.00");
    const saved = await page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)), ATTEMPT_PREFIX);
    expect(saved).toHaveLength(1);
    await browser.close();

    // Session 2: relaunch the same profile, as after quitting and reopening the browser.
    browser = await chromium.launchPersistentContext(profile, { baseURL });
    page = browser.pages()[0] ?? (await browser.newPage());
    await recordPaymentPosts(page, sent);
    await page.goto("/cashflow#bills");
    if (new URL(page.url()).pathname === "/login") {
      await page.getByLabel("Email").fill(EMAIL);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((u) => u.pathname === "/cashflow");
    }
    // The full payment cleared the bill from the Unpaid list; the pending payment is still surfaced.
    await expect(page.getByText("Bill payment awaiting confirmation")).toBeVisible();
    await page.getByRole("button", { name: "Show all bills" }).click();
    await page.getByRole("row", { name: new RegExp(vendor) }).getByRole("button", { name: "Resolve payment", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Amount (₹)")).toHaveValue("2500.00");
    await dialog.getByRole("button", { name: "Retry payment" }).click();
    await expect(page.getByText(/had already been recorded; no duplicate was created/)).toBeVisible();

    expectSameAttempt(sent, 2);
    await expectExactlyOnePayment(page, id, "2500.00", before.total_outflows);
    expect(await page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)), ATTEMPT_PREFIX)).toHaveLength(0);
    await browser.close();
  } finally {
    // Best effort: on Windows Chromium may still hold cache files for a moment after close().
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      console.warn(`Could not remove temporary profile ${profile}: ${String(e)}`);
    }
  }
});

test("two tabs: the second tab recognises the pending payment, retries it with the same key, the first tab follows", async ({ page, context }) => {
  await login(page);
  const { id, vendor } = await createBill(page, "1800.00");
  const before = await apiGet<Position>(page.request, "/cashflow/position");
  const sent: Request[] = [];
  await recordPaymentPosts(page, sent);

  const dialogA = await payAndLoseResponse(page, vendor, "700.00");

  const tabB = await context.newPage();
  await recordPaymentPosts(tabB, sent);
  const dialogB = await openBill(tabB, vendor, "Resolve payment");
  await expect(dialogB.getByText("Payment not confirmed")).toBeVisible();
  await expect(dialogB.getByLabel("Amount (₹)")).toHaveValue("700.00");
  await expect(dialogB.getByLabel("Amount (₹)")).toBeDisabled();
  await dialogB.getByRole("button", { name: "Retry payment" }).click();
  await expect(tabB.getByText(/had already been recorded; no duplicate was created/)).toBeVisible();

  // Tab A, still showing the uncertain payment, is told it was confirmed and closes its dialog.
  await expect(dialogA).toHaveCount(0);
  await expect(page.getByText(/confirmed in another tab; it was recorded once/)).toBeVisible();

  expectSameAttempt(sent, 2);
  await expectExactlyOnePayment(page, id, "700.00", before.total_outflows);
});
