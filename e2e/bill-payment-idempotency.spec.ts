/**
 * Lost-response bill payment against a REAL backend.
 *
 * The first POST /bills/{id}/payments is let through to the backend (which commits the payment, the cash
 * outflow and the audit entry) and then aborted on its way back to the browser, so the frontend sees a
 * network failure. The owner retries. The backend must end with exactly one payment, one outflow and one
 * audit entry for that bill.
 *
 * Opt-in, and only against a DISPOSABLE backend: it creates bills and payments.
 *   E2E_DISPOSABLE_BACKEND=1 BACKEND_ORIGIN=http://127.0.0.1:8100 E2E_EMAIL=... E2E_PASSWORD=... \
 *     npx playwright test e2e/bill-payment-idempotency.spec.ts
 */
import { expect, test, type Page, type Request } from "@playwright/test";

import { apiGet, login, uniqueName } from "./helpers";

test.skip(process.env.E2E_DISPOSABLE_BACKEND !== "1", "Opt-in: writes bills and payments (set E2E_DISPOSABLE_BACKEND=1 against a disposable backend).");

type BillDetail = { id: string; outstanding: string; payments: { id: string; amount: string }[] };
type Position = { total_outflows: string };
type AuditPage = { total: number };

const PAYMENTS = /\/api\/backend\/api\/v1\/bills\/[^/]+\/payments$/;
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

/** Lets the first payment POST reach the backend, then drops its response; later POSTs pass through. */
async function loseFirstPaymentResponse(page: Page) {
  const sent: Request[] = [];
  const committed: number[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && PAYMENTS.test(r.url())) sent.push(r); });
  let first = true;
  await page.route(PAYMENTS, async (route) => {
    if (route.request().method() !== "POST" || !first) return route.continue();
    first = false;
    const upstream = await route.fetch();
    committed.push(upstream.status());
    await route.abort("failed");
  });
  return { sent, committed };
}

async function openPay(page: Page, vendor: string) {
  await page.goto("/cashflow#bills");
  await page.getByRole("row", { name: new RegExp(vendor) }).getByRole("button", { name: "Pay" }).click();
  return page.getByRole("dialog");
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

test("lost response after commit: the retry reuses the key and the backend holds exactly one payment", async ({ page }) => {
  await login(page);
  const { id, vendor } = await createBill(page, "4321.50");
  const before = await apiGet<Position>(page.request, "/cashflow/position");
  const { sent, committed } = await loseFirstPaymentResponse(page);

  const dialog = await openPay(page, vendor);
  await dialog.getByLabel("Amount (₹)").fill("1234.50");
  await dialog.getByRole("button", { name: "Record bill payment" }).click();
  await expect(dialog.getByText("Payment not confirmed")).toBeVisible();
  // The backend did commit the first request; only the response was lost.
  expect(committed).toEqual([201]);

  await dialog.getByRole("button", { name: "Retry payment" }).click();
  await expect(page.getByText(/had already been recorded; no duplicate was created/)).toBeVisible();

  expect(sent).toHaveLength(2);
  expect(sent[1].headers()["idempotency-key"]).toBe(sent[0].headers()["idempotency-key"]);
  expect(sent[1].postDataJSON()).toEqual(sent[0].postDataJSON());
  const bill = await expectExactlyOnePayment(page, id, "1234.50", before.total_outflows);
  expect(bill.outstanding).toBe("3087.00");
});

test("lost response, then a page reload: the restored attempt replays instead of paying twice", async ({ page }) => {
  await login(page);
  const { id, vendor } = await createBill(page, "900.00");
  const before = await apiGet<Position>(page.request, "/cashflow/position");
  const { sent, committed } = await loseFirstPaymentResponse(page);

  let dialog = await openPay(page, vendor);
  await dialog.getByLabel("Amount (₹)").fill("600.00");
  await dialog.getByRole("button", { name: "Record bill payment" }).click();
  await expect(dialog.getByText("Payment not confirmed")).toBeVisible();
  expect(committed).toEqual([201]);

  // Reload: the server now reports 300.00 outstanding, yet the stored 600.00 attempt must still be retried.
  await page.reload();
  dialog = await openPay(page, vendor);
  await expect(dialog.getByText("Payment not confirmed")).toBeVisible();
  await expect(dialog.getByLabel("Amount (₹)")).toHaveValue("600.00");
  await dialog.getByRole("button", { name: "Retry payment" }).click();
  await expect(page.getByText(/had already been recorded; no duplicate was created/)).toBeVisible();

  expect(sent).toHaveLength(2);
  expect(sent[1].headers()["idempotency-key"]).toBe(sent[0].headers()["idempotency-key"]);
  await expectExactlyOnePayment(page, id, "600.00", before.total_outflows);
});
