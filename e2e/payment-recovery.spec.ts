/**
 * Payment recovery against a REAL backend (API 1.1.0) and disposable PostgreSQL, for invoices and bills.
 *
 * The browser registers a payment attempt, then executes it. The first execute request reaches the
 * backend (which commits the payment, its cash movement, the audit entry and the attempt's success) and its
 * response is dropped, so the browser cannot know the outcome. Recovery is exercised:
 *   - in the same page,
 *   - after a reload,
 *   - after a full browser restart (persistent Chromium profile closed and relaunched),
 *   - from a second tab,
 *   - from ANOTHER DEVICE: a separate browser context (own cookies, empty storage) signed in as a different
 *     user of the same business, which finds the attempt only through the server.
 * Each scenario checks one attempt, one payment, one audit entry and one cash movement for the target.
 *
 * Opt-in, and only against a DISPOSABLE backend:
 *   E2E_DISPOSABLE_BACKEND=1 BACKEND_ORIGIN=http://127.0.0.1:8100 E2E_EMAIL=... E2E_PASSWORD=... \
 *   E2E_STAFF_EMAIL=... E2E_STAFF_PASSWORD=... npx playwright test e2e/payment-recovery.spec.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, test, type Browser, type Page, type Request } from "@playwright/test";

import { apiGet, EMAIL, login, PASSWORD, uniqueName } from "./helpers";

test.skip(process.env.E2E_DISPOSABLE_BACKEND !== "1", "Opt-in: writes payments (set E2E_DISPOSABLE_BACKEND=1 against a disposable backend).");

type Kind = "invoice" | "bill";
type Position = { total_inflows: string; total_outflows: string };
const REGISTER = /\/api\/backend\/api\/v1\/payment-attempts$/;
const EXECUTE = /\/api\/backend\/api\/v1\/payment-attempts\/[^/]+\/execute$/;
const cents = (s: string) => BigInt(s.replace(".", ""));

async function csrf(page: Page) {
  return (await apiGet<{ csrf_token: string }>(page.request, "/auth/me")).csrf_token;
}

/** Creates a fresh invoice (with a new customer) or bill through the proxy. Returns its id and UI label. */
async function createTarget(page: Page, kind: Kind, amount: string) {
  const headers = { "X-CSRF-Token": await csrf(page) };
  if (kind === "bill") {
    const vendor = `${uniqueName()} Supplies`;
    const r = await page.request.post("/api/backend/api/v1/bills", { headers, data: { vendor_name: vendor, amount, category: "test" } });
    expect(r.status(), await r.text()).toBe(201);
    return { id: (await r.json()).data.id as string, label: vendor };
  }
  const c = await page.request.post("/api/backend/api/v1/customers", { headers, data: { name: `${uniqueName()} Traders` } });
  expect(c.status(), await c.text()).toBe(201);
  const inv = await page.request.post("/api/backend/api/v1/invoices", {
    headers,
    data: { customer_id: (await c.json()).data.id, items: [{ description: "Goods", quantity: "1", unit_price: amount }] },
  });
  expect(inv.status(), await inv.text()).toBe(201);
  const body = (await inv.json()).data;
  return { id: body.id as string, label: body.invoice_number as string };
}

/** Records registrations (bodies) and executions; the pass-through route exposes request bodies. */
async function watch(page: Page, into: { registered: Request[]; executed: Request[] }) {
  await page.route(REGISTER, (r) => r.continue());
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    if (REGISTER.test(r.url())) into.registered.push(r);
    if (EXECUTE.test(r.url())) into.executed.push(r);
  });
}

/** Lets the first execute reach the backend, then drops its response. */
async function loseFirstExecuteResponse(page: Page) {
  const committed: number[] = [];
  let first = true;
  await page.route(EXECUTE, async (route) => {
    if (!first) return route.continue();
    first = false;
    committed.push((await route.fetch()).status());
    await route.abort("failed");
  });
  return committed;
}

async function openTarget(page: Page, kind: Kind, target: { id: string; label: string }, action: "pay" | "resolve") {
  if (kind === "invoice") {
    await page.goto(`/invoices/${target.id}`);
    await page.getByTestId(action === "pay" ? "record-payment" : "resolve-payment").click();
  } else {
    await page.goto("/cashflow#bills");
    const row = page.getByRole("row", { name: new RegExp(target.label) });
    await row.getByRole("button", { name: action === "pay" ? "Pay" : "Resolve payment", exact: true }).click();
  }
  return page.getByRole("dialog");
}

async function payAndLoseResponse(page: Page, kind: Kind, target: { id: string; label: string }, amount: string) {
  const committed = await loseFirstExecuteResponse(page);
  const dialog = await openTarget(page, kind, target, "pay");
  await dialog.getByLabel("Amount (₹)").fill(amount);
  await dialog.getByRole("button", { name: kind === "invoice" ? "Record payment" : "Record bill payment" }).click();
  await expect(dialog.getByText("Payment not confirmed")).toBeVisible();
  expect(committed).toEqual([200]); // the backend did commit; only the response was lost
  await expect(dialog.getByRole("button", { name: /discard/i })).toHaveCount(0);
  return dialog;
}

const confirmedText = /had already been recorded|no duplicate was created/;

async function expectExactlyOnce(page: Page, kind: Kind, targetId: string, amount: string, before: Position) {
  const attempts = await apiGet<{ items: { status: string; payment_id: string }[]; total: number }>(
    page.request,
    `/payment-attempts?resource_type=${kind}&resource_id=${targetId}`,
  );
  expect(attempts.total).toBe(1);
  expect(attempts.items[0].status).toBe("succeeded");
  const paymentId = attempts.items[0].payment_id;
  if (kind === "invoice") {
    const p = await apiGet<{ total: number; items: { amount: string }[] }>(page.request, `/invoices/${targetId}/payments`);
    expect(p.total).toBe(1);
    expect(p.items[0].amount).toBe(amount);
  } else {
    const b = await apiGet<{ payments: { amount: string }[] }>(page.request, `/bills/${targetId}`);
    expect(b.payments).toHaveLength(1);
    expect(b.payments[0].amount).toBe(amount);
  }
  const audit = await apiGet<{ total: number }>(page.request, `/audit-logs?entity_type=${kind === "invoice" ? "payment" : "bill_payment"}&entity_id=${paymentId}`);
  expect(audit.total).toBe(1);
  const pos = await apiGet<Position>(page.request, "/cashflow/position");
  const delta = kind === "invoice" ? cents(pos.total_inflows) - cents(before.total_inflows) : cents(pos.total_outflows) - cents(before.total_outflows);
  expect(delta).toBe(cents(amount));
}

function sameAttempt(seen: { registered: Request[]; executed: Request[] }) {
  const keys = new Set(seen.registered.map((r) => r.postDataJSON().idempotency_key));
  expect(keys.size).toBe(1);
  for (const r of seen.registered) expect(r.postDataJSON()).toEqual(seen.registered[0].postDataJSON());
  expect(new Set(seen.executed.map((r) => r.url())).size).toBe(1);
}

for (const kind of ["invoice", "bill"] as const) {
  test.describe(`${kind} payments`, () => {
    test(`${kind}: lost response, then a reload: the retry confirms the original payment once`, async ({ page }) => {
      await login(page);
      const target = await createTarget(page, kind, "3000.00");
      const before = await apiGet<Position>(page.request, "/cashflow/position");
      const seen = { registered: [] as Request[], executed: [] as Request[] };
      await watch(page, seen);
      const dialog = await payAndLoseResponse(page, kind, target, "1200.50");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.reload();
      const reopened = await openTarget(page, kind, target, "resolve");
      await expect(reopened.getByLabel("Amount (₹)")).toHaveValue("1200.50");
      await reopened.getByRole("button", { name: "Retry payment" }).click();
      await expect(page.getByText(confirmedText).first()).toBeVisible();
      sameAttempt(seen);
      await expectExactlyOnce(page, kind, target.id, "1200.50", before);
    });

    test(`${kind}: lost response, browser closed and reopened: recovered and confirmed once`, async ({}, testInfo) => {
      const profile = mkdtempSync(join(tmpdir(), "kaira-e2e-profile-"));
      const baseURL = testInfo.project.use.baseURL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`;
      const seen = { registered: [] as Request[], executed: [] as Request[] };
      try {
        let ctx = await chromium.launchPersistentContext(profile, { baseURL });
        let page = ctx.pages()[0] ?? (await ctx.newPage());
        await watch(page, seen);
        await login(page);
        const target = await createTarget(page, kind, "2500.00");
        const before = await apiGet<Position>(page.request, "/cashflow/position");
        await payAndLoseResponse(page, kind, target, "2500.00");
        await ctx.close();

        ctx = await chromium.launchPersistentContext(profile, { baseURL });
        page = ctx.pages()[0] ?? (await ctx.newPage());
        await watch(page, seen);
        await page.goto(kind === "invoice" ? `/invoices/${target.id}` : "/cashflow#bills");
        if (new URL(page.url()).pathname === "/login") {
          await page.getByLabel("Email").fill(EMAIL);
          await page.getByLabel("Password").fill(PASSWORD);
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.waitForURL((u) => u.pathname !== "/login");
        }
        if (kind === "invoice") {
          // The lost payment cleared the invoice, so only "Resolve payment" remains.
          await expect(page.getByTestId("record-payment")).toHaveCount(0);
          await page.getByTestId("resolve-payment").click();
        } else {
          await page.goto("/cashflow#bills");
          // The full payment moved the bill out of the Unpaid list; it is reachable from the notice.
          await page.getByRole("button", { name: new RegExp(`^Resolve (${target.label}|payment)$`) }).first().click();
        }
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByLabel("Amount (₹)")).toHaveValue("2500.00");
        await dialog.getByRole("button", { name: "Retry payment" }).click();
        await expect(page.getByText(confirmedText).first()).toBeVisible();
        sameAttempt(seen);
        await expectExactlyOnce(page, kind, target.id, "2500.00", before);
        await ctx.close();
      } finally {
        try {
          rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch {
          // best effort on Windows
        }
      }
    });

    test(`${kind}: two tabs: the second tab retries the same attempt and the first follows`, async ({ page, context }) => {
      await login(page);
      const target = await createTarget(page, kind, "4000.00");
      const before = await apiGet<Position>(page.request, "/cashflow/position");
      const seen = { registered: [] as Request[], executed: [] as Request[] };
      await watch(page, seen);
      const dialogA = await payAndLoseResponse(page, kind, target, "1500.00");
      const tabB = await context.newPage();
      await watch(tabB, seen);
      const dialogB = await openTarget(tabB, kind, target, "resolve");
      await expect(dialogB.getByLabel("Amount (₹)")).toBeDisabled();
      await dialogB.getByRole("button", { name: "Retry payment" }).click();
      await expect(tabB.getByText(confirmedText).first()).toBeVisible();
      await expect(dialogA.getByText("Payment not confirmed")).toHaveCount(0);
      sameAttempt(seen);
      await expectExactlyOnce(page, kind, target.id, "1500.00", before);
    });

    test(`${kind}: cross-device: another user on another device finds the payment on the server and confirms it once`, async ({ page, browser }) => {
      test.skip(!process.env.E2E_STAFF_EMAIL, "needs E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD (a second user of the business)");
      await login(page);
      const target = await createTarget(page, kind, "5000.00");
      const before = await apiGet<Position>(page.request, "/cashflow/position");
      // Device A: the execute request is cut BEFORE it reaches the backend, so the attempt stays pending.
      await page.route(EXECUTE, (r) => r.abort("failed"));
      const dA = await openTarget(page, kind, target, "pay");
      await dA.getByLabel("Amount (₹)").fill("2000.00");
      await dA.getByRole("button", { name: kind === "invoice" ? "Record payment" : "Record bill payment" }).click();
      await expect(dA.getByText("Payment not confirmed")).toBeVisible();

      // Device B: a separate browser context (own cookies, empty localStorage), signed in as another user.
      const deviceB = await (browser as Browser).newContext({ baseURL: test.info().project.use.baseURL });
      try {
        const pageB = await deviceB.newPage();
        expect(await pageB.evaluate(() => localStorage.length).catch(() => 0)).toBe(0);
        await pageB.goto(`/login?next=/dashboard`);
        await pageB.getByLabel("Email").fill(process.env.E2E_STAFF_EMAIL!);
        await pageB.getByLabel("Password").fill(process.env.E2E_STAFF_PASSWORD!);
        await pageB.getByRole("button", { name: "Sign in" }).click();
        await pageB.waitForURL((u) => u.pathname === "/dashboard");
        // The dashboard lists it (server registry), with a link to where it is resolved.
        await expect(pageB.getByText(/payments? awaiting confirmation/)).toBeVisible();
        const dB = await openTarget(pageB, kind, target, "resolve");
        await expect(dB.getByLabel("Amount (₹)")).toHaveValue("2000.00");
        await expect(dB.getByLabel("Amount (₹)")).toBeDisabled();
        await dB.getByRole("button", { name: "Retry payment" }).click();
        await expect(kind === "invoice" ? dB.getByTestId("payment-confirmed") : pageB.getByText(/Paid ₹2,000\.00/)).toBeVisible();
        await expectExactlyOnce(pageB, kind, target.id, "2000.00", before);
      } finally {
        await deviceB.close();
      }
    });
  });
}
