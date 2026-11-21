/**
 * Lost-response invoice payments against a REAL backend.
 *
 * The first POST /invoices/{id}/payments reaches the backend (which commits the payment, the cash inflow
 * and the audit entry) and its response is then dropped, so the browser sees a network failure. The payment
 * is recovered after a full browser restart (persistent Chromium profile closed and relaunched), after a
 * reload, and from a second tab. Each time the backend must hold exactly one payment for the invoice, one
 * inflow's worth of cash movement and one `payment.recorded` audit entry.
 *
 * Opt-in, and only against a DISPOSABLE backend: it creates customers, invoices and payments.
 *   E2E_DISPOSABLE_BACKEND=1 BACKEND_ORIGIN=http://127.0.0.1:8100 E2E_EMAIL=... E2E_PASSWORD=... \
 *     npx playwright test e2e/invoice-payment-idempotency.spec.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, test, type Page, type Request } from "@playwright/test";

import { apiGet, EMAIL, login, PASSWORD, uniqueName } from "./helpers";

test.skip(process.env.E2E_DISPOSABLE_BACKEND !== "1", "Opt-in: writes customers, invoices and payments (set E2E_DISPOSABLE_BACKEND=1 against a disposable backend).");

type Invoice = { id: string; invoice_number: string; outstanding: string; payment_status: string };
type Payments = { items: { id: string; amount: string }[]; total: number };
type Position = { total_inflows: string };
type AuditPage = { total: number };

const PAYMENTS = /\/api\/backend\/api\/v1\/invoices\/[^/]+\/payments$/;
const ATTEMPT_PREFIX = "kaira:invoice-payment-attempt:v1:";
const cents = (s: string) => BigInt(s.replace(".", ""));

/** Creates a uniquely named customer and a one-line invoice through the proxy (CSRF token from /auth/me). */
async function createInvoice(page: Page, amount: string): Promise<Invoice> {
  const me = await apiGet<{ csrf_token: string }>(page.request, "/auth/me");
  const headers = { "X-CSRF-Token": me.csrf_token };
  const c = await page.request.post("/api/backend/api/v1/customers", { headers, data: { name: `${uniqueName()} Traders` } });
  expect(c.status(), await c.text()).toBe(201);
  const customerId = (await c.json()).data.id as string;
  const inv = await page.request.post("/api/backend/api/v1/invoices", {
    headers,
    data: { customer_id: customerId, items: [{ description: "Goods", quantity: "1", unit_price: amount }] },
  });
  expect(inv.status(), await inv.text()).toBe(201);
  return (await inv.json()).data as Invoice;
}

/** Records every payment POST (key + body); the pass-through route lets Playwright expose the request body. */
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

async function payAndLoseResponse(page: Page, invoice: Invoice, fill: { amount?: string; full?: boolean; reference?: string; notes?: string }) {
  const committed = await loseFirstPaymentResponse(page);
  await page.goto(`/invoices/${invoice.id}`);
  await page.getByTestId("record-payment").click();
  const dialog = page.getByRole("dialog");
  if (fill.full) await dialog.getByRole("button", { name: /Pay full balance/ }).click();
  else await dialog.getByLabel("Amount (₹)").fill(fill.amount!);
  await dialog.getByLabel("Method").selectOption("upi");
  if (fill.reference) await dialog.getByLabel("Reference (optional)").fill(fill.reference);
  if (fill.notes) await dialog.getByLabel("Notes (optional)").fill(fill.notes);
  await dialog.getByRole("button", { name: "Record payment" }).click();
  await expect(dialog.getByText("Payment not confirmed")).toBeVisible();
  // The backend did commit the first request; only the response was lost.
  expect(committed).toEqual([201]);
  await expect(dialog.getByRole("button", { name: /discard/i })).toHaveCount(0);
  return dialog;
}

async function expectExactlyOnePayment(page: Page, invoiceId: string, amount: string, inflowsBefore: string) {
  const payments = await apiGet<Payments>(page.request, `/invoices/${invoiceId}/payments?page_size=200`);
  expect(payments.total).toBe(1);
  expect(payments.items[0].amount).toBe(amount);
  const audit = await apiGet<AuditPage>(page.request, `/audit-logs?entity_type=payment&entity_id=${payments.items[0].id}`);
  expect(audit.total).toBe(1);
  const pos = await apiGet<Position>(page.request, "/cashflow/position");
  expect(cents(pos.total_inflows) - cents(inflowsBefore)).toBe(cents(amount));
}

function expectSameAttempt(sent: Request[], count: number) {
  expect(sent).toHaveLength(count);
  for (const r of sent) {
    expect(r.headers()["idempotency-key"]).toBe(sent[0].headers()["idempotency-key"]);
    expect(r.postDataJSON()).toEqual(sent[0].postDataJSON());
  }
}

test("lost response, browser closed and reopened: the invoice payment is recovered and replayed once", async ({}, testInfo) => {
  const profile = mkdtempSync(join(tmpdir(), "kaira-e2e-profile-"));
  const baseURL = testInfo.project.use.baseURL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`;
  const sent: Request[] = [];
  try {
    // Session 1: a real Chromium profile on disk. The payment clears the invoice in full.
    let browser = await chromium.launchPersistentContext(profile, { baseURL });
    let page = browser.pages()[0] ?? (await browser.newPage());
    await recordPaymentPosts(page, sent);
    await login(page);
    const invoice = await createInvoice(page, "3200.00");
    const before = await apiGet<Position>(page.request, "/cashflow/position");
    await payAndLoseResponse(page, invoice, { full: true, reference: "UPI-REF-1", notes: "Settled at counter" });
    const saved = await page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)), ATTEMPT_PREFIX);
    expect(saved).toHaveLength(1);
    await browser.close();

    // Session 2: relaunch the same profile, as after quitting and reopening the browser.
    browser = await chromium.launchPersistentContext(profile, { baseURL });
    page = browser.pages()[0] ?? (await browser.newPage());
    await recordPaymentPosts(page, sent);
    await page.goto(`/invoices/${invoice.id}`);
    if (new URL(page.url()).pathname === "/login") {
      await page.getByLabel("Email").fill(EMAIL);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((u) => u.pathname === `/invoices/${invoice.id}`);
    }
    // The lost payment was recorded, so the invoice now reads fully paid: no Record payment button, but the
    // pending payment is surfaced and resumable.
    await expect(page.getByText("Payment awaiting confirmation")).toBeVisible();
    await expect(page.getByTestId("record-payment")).toHaveCount(0);
    await page.getByTestId("resolve-payment").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Payment not confirmed")).toBeVisible();
    await expect(dialog.getByLabel("Amount (₹)")).toHaveValue("3200.00");
    await expect(dialog.getByLabel("Notes (optional)")).toHaveValue("Settled at counter");
    await expect(dialog.getByLabel("Amount (₹)")).toBeDisabled();
    await dialog.getByRole("button", { name: "Retry payment" }).click();
    await expect(dialog.getByTestId("payment-confirmed")).toContainText("no duplicate was created");

    expectSameAttempt(sent, 2);
    expect(sent[0].postDataJSON()).toMatchObject({ amount: "3200.00", payment_method: "upi", reference: "UPI-REF-1", notes: "Settled at counter" });
    await expectExactlyOnePayment(page, invoice.id, "3200.00", before.total_inflows);
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

test("lost response, reload: the restored invoice payment replays instead of paying twice", async ({ page }) => {
  await login(page);
  const invoice = await createInvoice(page, "5000.00");
  const before = await apiGet<Position>(page.request, "/cashflow/position");
  const sent: Request[] = [];
  await recordPaymentPosts(page, sent);

  const dialog = await payAndLoseResponse(page, invoice, { amount: "1250.75" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page.getByTestId("resolve-payment").click();
  const reopened = page.getByRole("dialog");
  await expect(reopened.getByLabel("Amount (₹)")).toHaveValue("1250.75");
  await reopened.getByRole("button", { name: "Retry payment" }).click();
  await expect(reopened.getByTestId("payment-confirmed")).toContainText("no duplicate was created");

  expectSameAttempt(sent, 2);
  await expectExactlyOnePayment(page, invoice.id, "1250.75", before.total_inflows);
});

test("two tabs: the second tab recovers the pending invoice payment with the same key; the first tab follows", async ({ page, context }) => {
  await login(page);
  const invoice = await createInvoice(page, "4000.00");
  const before = await apiGet<Position>(page.request, "/cashflow/position");
  const sent: Request[] = [];
  await recordPaymentPosts(page, sent);

  const dialogA = await payAndLoseResponse(page, invoice, { amount: "1500.00" });

  const tabB = await context.newPage();
  await recordPaymentPosts(tabB, sent);
  await tabB.goto(`/invoices/${invoice.id}`);
  await expect(tabB.getByText("Payment awaiting confirmation")).toBeVisible();
  await tabB.getByTestId("resolve-payment").click();
  const dialogB = tabB.getByRole("dialog");
  await expect(dialogB.getByLabel("Amount (₹)")).toHaveValue("1500.00");
  await expect(dialogB.getByLabel("Amount (₹)")).toBeDisabled();
  await dialogB.getByRole("button", { name: "Retry payment" }).click();
  await expect(dialogB.getByTestId("payment-confirmed")).toContainText("no duplicate was created");

  // Tab A, still showing the uncertain payment, is told it was confirmed and closes its dialog.
  await expect(dialogA).toBeHidden();
  await expect(page.getByText(/confirmed in another tab; it was recorded once/)).toBeVisible();

  expectSameAttempt(sent, 2);
  await expectExactlyOnePayment(page, invoice.id, "1500.00", before.total_inflows);
});
