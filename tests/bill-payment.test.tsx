/**
 * Bill-payment idempotency and recovery (components/cashflow/bills-panel.tsx + lib/api/payment-attempt.ts).
 *
 * The handler below stands in for POST /bills/{id}/payments with the backend's documented contract:
 * one payment per Idempotency-Key, a repeated key returns the original with `replayed: true`. It can
 * also lose the response AFTER recording, which is the dangerous case: the frontend sees a network error
 * or timeout although the payment exists. `ledger.payments` counts what the "server" recorded.
 *
 * "Tabs" are separate React trees (separate QueryClients) sharing localStorage and the same backend, as
 * real tabs of one origin do. "Restart" is a fresh tree over the same localStorage. The real-browser
 * versions of these scenarios run against a real backend in e2e/bill-payment-idempotency.spec.ts.
 */
import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillsPanel } from "@/components/cashflow/bills-panel";
import { ApiError } from "@/lib/api/errors";
import {
  attemptStorageKey,
  createBillPaymentAttempt,
  isDefinitiveRejection,
  loadBillPaymentAttempt,
  loadBillPaymentDone,
} from "@/lib/api/payment-attempt";
import type { Bill } from "@/lib/api/types";

import { envelope, errorEnvelope, ownerSession } from "./fixtures";
import { pathOf, renderApp } from "./render";

const BIZ = ownerSession.business.id;
const STORE_KEY = attemptStorageKey(BIZ, "bill-1");

const bill = {
  id: "bill-1",
  vendor_name: "Sharma Rentals",
  description: "Shop rent",
  category: "rent",
  amount: "20000.00",
  paid: "0.00",
  outstanding: "20000.00",
  payment_status: "unpaid",
  is_overdue: false,
  days_overdue: 0,
  bill_date: "2026-11-01",
  due_date: "2026-11-30",
  notes: null,
} as Bill;

type Failure = "network-before" | "network-after" | "timeout-after" | "502-after" | "503-before" | "504-after" | "429" | "408" | "422";

/** In-test stand-in for the bill payment endpoint; `failures` are consumed one per POST. */
function ledger(failures: Failure[] = []) {
  const payments = new Map<string, { amount: string }>();
  const posts: { key: string | null; body: Record<string, unknown> }[] = [];
  let outstanding = BigInt(2000000);
  let release: (() => void) | null = null;
  const state = { payments, posts, hold: false, release: () => release?.() };
  const money = () => (Number(outstanding) / 100).toFixed(2);
  const handler = async (req: Request) => {
    const p = pathOf(req);
    if (p === "GET /bills") {
      // Mirrors the "Unpaid" filter: a fully paid bill leaves the list.
      const status = new URL(req.url).searchParams.get("status");
      const items = status === "open" && outstanding === BigInt(0) ? [] : [{ ...bill, outstanding: money() }];
      return envelope({ items, total: items.length, page: 1, page_size: 100 });
    }
    if (p === "POST /bills/bill-1/payments") {
      const key = req.headers.get("idempotency-key");
      const body = (await req.json()) as Record<string, unknown>;
      posts.push({ key, body });
      if (state.hold) await new Promise<void>((r) => (release = r));
      const failure = failures.shift();
      if (failure === "network-before") throw new TypeError("Failed to fetch");
      if (failure === "503-before") return errorEnvelope(503, "SERVICE_UNAVAILABLE", "Try again");
      if (failure === "429") return errorEnvelope(429, "RATE_LIMITED", "Too many requests");
      if (failure === "408") return errorEnvelope(408, "REQUEST_TIMEOUT", "Request timeout");
      if (failure === "422") return errorEnvelope(422, "OVERPAYMENT", "Payment exceeds the remaining payable amount.");
      const replayed = payments.has(key!);
      if (!replayed) {
        payments.set(key!, { amount: String(body.amount) });
        outstanding -= BigInt(Math.round(Number(body.amount) * 100));
      }
      // Recorded on the "server", but the response never reaches the browser.
      if (failure === "network-after") throw new TypeError("Failed to fetch");
      if (failure === "timeout-after") throw new DOMException("The operation timed out.", "TimeoutError");
      if (failure === "502-after") return errorEnvelope(502, "BACKEND_UNAVAILABLE", "Backend unavailable");
      if (failure === "504-after") return errorEnvelope(504, "BACKEND_TIMEOUT", "Backend timeout");
      return envelope({ replayed, payment: { id: `bp-${payments.size}`, bill_id: "bill-1", amount: String(body.amount), payment_date: body.payment_date, payment_method: body.payment_method }, bill: { ...bill, outstanding: money() } }, replayed ? 200 : 201);
    }
    return envelope({});
  };
  return { state, handler };
}

/** Opens the bill's dialog in one tab (or the whole document) and returns the dialog element. */
async function openBill(scope: RenderResult | null = null, name: RegExp = /^(Pay|Resolve payment)$/) {
  const q = scope ? within(scope.container) : screen;
  await userEvent.click(await q.findByRole("button", { name }));
  return q.findByRole("dialog");
}

const amountIn = (el: HTMLElement) => within(el).getByLabelText("Amount (₹)") as HTMLInputElement;
const click = (el: HTMLElement, name: string | RegExp) => userEvent.click(within(el).getByRole("button", { name }));

/** Minimal Web Locks stand-in: one FIFO queue per lock name, shared by every "tab" in the test. */
function installLocks() {
  const queues = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, fn: () => Promise<unknown>) => {
      const prev = queues.get(name) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      queues.set(name, run.catch(() => undefined));
      return run;
    },
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  return () => Reflect.deleteProperty(navigator, "locks");
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("bill payment idempotency", () => {
  it("records a successful payment once and clears the saved attempt", async () => {
    const { state, handler } = ledger();
    renderApp(<BillsPanel />, { handler });
    const dialog = await openBill();
    await userEvent.clear(amountIn(dialog));
    await userEvent.type(amountIn(dialog), "5000");
    await click(dialog, "Record bill payment");
    expect(await screen.findByText(/Paid ₹5,000.00 to Sharma Rentals/)).toBeInTheDocument();
    expect(state.payments.size).toBe(1);
    expect(state.posts[0].key).toMatch(/.{8,}/);
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
    expect(loadBillPaymentDone(BIZ, "bill-1")?.key).toBe(state.posts[0].key);
  });

  it("network failure before any response: retry reuses the key and records exactly once", async () => {
    const { state, handler } = ledger(["network-before"]);
    renderApp(<BillsPanel />, { handler });
    const dialog = await openBill();
    await click(dialog, "Record bill payment");
    expect(await within(dialog).findByText("Payment not confirmed")).toBeInTheDocument();
    expect(state.payments.size).toBe(0);
    await click(dialog, "Retry payment");
    expect(await screen.findByText(/Paid ₹20,000.00 to Sharma Rentals/)).toBeInTheDocument();
    expect(state.posts.map((p) => p.key)).toEqual([state.posts[0].key, state.posts[0].key]);
    expect(state.payments.size).toBe(1);
  });

  it("server committed but the response was lost: the retry replays, no duplicate", async () => {
    const { state, handler } = ledger(["network-after"]);
    renderApp(<BillsPanel />, { handler });
    const dialog = await openBill();
    await click(dialog, "Record bill payment");
    await within(dialog).findByText("Payment not confirmed");
    expect(state.payments.size).toBe(1);
    await click(dialog, "Retry payment");
    expect(await screen.findByText(/had already been recorded; no duplicate was created/)).toBeInTheDocument();
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1].key).toBe(state.posts[0].key);
    expect(state.payments.size).toBe(1);
  });

  it("an uncertain outcome never produces a new key, and the payload stays byte-identical", async () => {
    const { state, handler } = ledger(["timeout-after", "502-after", "503-before", "504-after", "429", "408", "network-after"]);
    renderApp(<BillsPanel />, { handler });
    const dialog = await openBill();
    await userEvent.clear(amountIn(dialog));
    await userEvent.type(amountIn(dialog), "7500.50");
    await userEvent.selectOptions(within(dialog).getByLabelText("Method"), "upi");
    await click(dialog, "Record bill payment");
    for (let i = 0; i < 7; i++) {
      await within(dialog).findByRole("button", { name: "Retry payment" });
      // Frozen payload: the fields stay locked for as long as the outcome is unknown.
      expect(amountIn(dialog)).toBeDisabled();
      expect(within(dialog).getByLabelText("Method")).toBeDisabled();
      await click(dialog, "Retry payment");
    }
    await screen.findByText(/had already been recorded/);
    expect(state.posts).toHaveLength(8);
    expect(new Set(state.posts.map((p) => p.key)).size).toBe(1);
    for (const p of state.posts) expect(p.body).toEqual(state.posts[0].body);
    expect(state.posts[0].body).toMatchObject({ amount: "7500.50", payment_method: "upi" });
    expect(state.payments.size).toBe(1);
  });

  it("duplicate clicks while a request is in flight send a single request", async () => {
    const { state, handler } = ledger();
    state.hold = true;
    renderApp(<BillsPanel />, { handler });
    const dialog = await openBill();
    const form = dialog.querySelector("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: /Record bill payment|Retry payment/ })).toBeDisabled();
    state.hold = false;
    state.release();
    await screen.findByText(/Paid ₹20,000.00/);
    expect(state.posts).toHaveLength(1);
    expect(state.payments.size).toBe(1);
  });

  it("separate payments get separate keys; a definitive rejection releases the attempt for correction", async () => {
    const { state, handler } = ledger(["422"]);
    renderApp(<BillsPanel />, { handler });
    let dialog = await openBill();
    await userEvent.clear(amountIn(dialog));
    await userEvent.type(amountIn(dialog), "1000");
    await click(dialog, "Record bill payment");
    expect(await within(dialog).findByText(/exceeds the remaining payable amount/)).toBeInTheDocument();
    // 422 proves nothing was recorded: storage is cleared and the fields unlock for correction.
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
    expect(amountIn(dialog)).not.toBeDisabled();
    expect(within(dialog).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await userEvent.clear(amountIn(dialog));
    await userEvent.type(amountIn(dialog), "900");
    await click(dialog, "Record bill payment");
    await screen.findByText(/Paid ₹900.00/);
    dialog = await openBill();
    await userEvent.clear(amountIn(dialog));
    await userEvent.type(amountIn(dialog), "2000");
    await click(dialog, "Record bill payment");
    await screen.findByText(/Paid ₹2,000.00/);
    expect(state.posts.map((p) => p.body.amount)).toEqual(["1000", "900", "2000"]);
    expect(new Set(state.posts.map((p) => p.key)).size).toBe(3);
    expect(state.payments.size).toBe(2);
  });
});

describe("recovery of an uncertain payment", () => {
  it("cannot be discarded: closing keeps it, and reopening the bill restores it", async () => {
    const { state, handler } = ledger(["network-after"]);
    renderApp(<BillsPanel />, { handler });
    let dialog = await openBill();
    await click(dialog, "Record bill payment");
    await within(dialog).findByText("Payment not confirmed");
    expect(within(dialog).queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["Close", "Retry payment"]));
    await click(dialog, "Close");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(loadBillPaymentAttempt(BIZ, "bill-1")?.key).toBe(state.posts[0].key);

    // The row now offers to resolve the payment; reopening shows the frozen attempt.
    dialog = await openBill(null, /^Resolve payment$/);
    expect(within(dialog).getByText("Payment not confirmed")).toBeInTheDocument();
    expect(amountIn(dialog).value).toBe("20000.00");
    expect(amountIn(dialog)).toBeDisabled();
    await click(dialog, "Retry payment");
    await screen.findByText(/had already been recorded/);
    expect(state.posts[1].key).toBe(state.posts[0].key);
    expect(state.payments.size).toBe(1);
  });

  it("survives a browser restart and retries even though the balance has dropped", async () => {
    const server = ledger(["network-after"]);
    const before = renderApp(<BillsPanel />, { handler: server.handler });
    const dialog = await openBill(before);
    await userEvent.clear(amountIn(dialog));
    await userEvent.type(amountIn(dialog), "15000");
    await click(dialog, "Record bill payment");
    await within(dialog).findByText("Payment not confirmed");
    const stored = JSON.parse(window.localStorage.getItem(STORE_KEY)!);
    expect(stored).toMatchObject({ v: 1, key: server.state.posts[0].key, businessId: BIZ, billId: "bill-1", body: { amount: "15000" } });
    expect(Object.keys(stored).sort()).toEqual(["billId", "body", "businessId", "key", "startedAt", "userId", "v"]);
    expect(JSON.stringify(stored)).not.toMatch(/csrf|token|password|cookie/i);

    // "Restart": everything in memory is gone; only localStorage remains. The server now reports 5,000
    // outstanding, so a client-side overpayment check would wrongly block re-sending 15,000.
    before.unmount();
    const after = renderApp(<BillsPanel />, { handler: server.handler });
    const reopened = await openBill(after, /^Resolve payment$/);
    expect(amountIn(reopened).value).toBe("15000");
    await click(reopened, "Retry payment");
    await screen.findByText(/had already been recorded/);
    expect(server.state.posts.map((p) => p.key)).toEqual([stored.key, stored.key]);
    expect(server.state.payments.size).toBe(1);
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });

  it("stays reachable when the lost payment cleared the bill out of the Unpaid list", async () => {
    const server = ledger(["network-after"]);
    const tab = renderApp(<BillsPanel />, { handler: server.handler });
    const dialog = await openBill(tab);
    await click(dialog, "Record bill payment");
    await within(dialog).findByText("Payment not confirmed");
    await click(dialog, "Close");
    tab.unmount();
    renderApp(<BillsPanel />, { handler: server.handler });
    expect(await screen.findByText("Bill payment awaiting confirmation")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all bills" }));
    const reopened = await openBill(null, /^Resolve payment$/);
    await click(reopened, "Retry payment");
    await screen.findByText(/had already been recorded/);
    expect(server.state.payments.size).toBe(1);
  });

  it("is scoped to the business: another business never sees it", async () => {
    createBillPaymentAttempt({ key: "other-biz-key", businessId: "b2", billId: "bill-1", userId: "u9", body: { amount: "100.00", payment_date: "2026-11-21", payment_method: "cash" } });
    const { state, handler } = ledger();
    renderApp(<BillsPanel />, { handler });
    const dialog = await openBill(null, /^Pay$/);
    expect(within(dialog).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await click(dialog, "Record bill payment");
    await screen.findByText(/Paid ₹20,000.00/);
    expect(state.posts[0].key).not.toBe("other-biz-key");
    expect(loadBillPaymentAttempt("b2", "bill-1")?.key).toBe("other-biz-key");
  });

  it("ignores a corrupt saved entry instead of retrying an untrustworthy key", async () => {
    window.localStorage.setItem(STORE_KEY, "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { state, handler } = ledger();
    renderApp(<BillsPanel />, { handler });
    const dialog = await openBill(null, /^Pay$/);
    expect(within(dialog).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    await click(dialog, "Record bill payment");
    await screen.findByText(/Paid ₹20,000.00/);
    expect(state.payments.size).toBe(1);
    warn.mockRestore();
  });

  it("never overwrites a pending attempt", () => {
    const body = { amount: "100.00", payment_date: "2026-11-21", payment_method: "cash" as const };
    const first = createBillPaymentAttempt({ key: "k1", businessId: BIZ, billId: "bill-1", userId: "u1", body });
    const second = createBillPaymentAttempt({ key: "k2", businessId: BIZ, billId: "bill-1", userId: "u1", body: { ...body, amount: "200.00" } });
    expect(first.created).toBe(true);
    expect(second).toEqual({ attempt: first.attempt, created: false });
    expect(loadBillPaymentAttempt(BIZ, "bill-1")?.key).toBe("k1");
  });
});

describe("cross-tab safety", () => {
  let uninstall: () => void;
  beforeEach(() => (uninstall = installLocks()));
  afterEach(() => uninstall());

  it("a second tab recognises the pending attempt and retries it with the same key; the first tab follows", async () => {
    const server = ledger(["network-after"]);
    const tabA = renderApp(<BillsPanel />, { handler: server.handler });
    const tabB = renderApp(<BillsPanel />, { handler: server.handler });
    const dialogA = await openBill(tabA);
    // Tab B opened the same bill before tab A submitted.
    const dialogB = await openBill(tabB);
    await click(dialogA, "Record bill payment");
    await within(dialogA).findByText("Payment not confirmed");

    // Tab B adopts tab A's attempt live: locked, same values, retry instead of a fresh payment.
    expect(await within(dialogB).findByText("Payment not confirmed")).toBeInTheDocument();
    expect(amountIn(dialogB)).toBeDisabled();
    await click(dialogB, "Retry payment");
    await within(tabB.container).findByText(/had already been recorded/);
    expect(server.state.posts.map((p) => p.key)).toEqual([server.state.posts[0].key, server.state.posts[0].key]);
    expect(server.state.payments.size).toBe(1);
    // Tab A learns about the confirmation and closes instead of offering another retry.
    await waitFor(() => expect(within(tabA.container).queryByRole("dialog")).not.toBeInTheDocument());
    expect(await within(tabA.container).findByText(/confirmed in another tab; it was recorded once/)).toBeInTheDocument();
  });

  it("a fresh payment in another tab does not get its own key while one is pending", async () => {
    const server = ledger(["network-after"]);
    const tabA = renderApp(<BillsPanel />, { handler: server.handler });
    const dialogA = await openBill(tabA);
    // Partial payment, so the bill stays in tab B's "Unpaid" list.
    await userEvent.clear(amountIn(dialogA));
    await userEvent.type(amountIn(dialogA), "5000");
    await click(dialogA, "Record bill payment");
    await within(dialogA).findByText("Payment not confirmed");
    const tabB = renderApp(<BillsPanel />, { handler: server.handler });
    const dialogB = await openBill(tabB, /^Resolve payment$/);
    expect(within(dialogB).getByText("Payment not confirmed")).toBeInTheDocument();
    expect(server.state.posts).toHaveLength(1);
  });

  it("simultaneous retries from two tabs are serialised: one request, the other tab just closes", async () => {
    const server = ledger(["network-after"]);
    const tabA = renderApp(<BillsPanel />, { handler: server.handler });
    const tabB = renderApp(<BillsPanel />, { handler: server.handler });
    const dialogA = await openBill(tabA);
    await click(dialogA, "Record bill payment");
    await within(dialogA).findByText("Payment not confirmed");
    const dialogB = await openBill(tabB, /^Resolve payment$/);
    server.state.hold = true;
    act(() => {
      fireEvent.submit(dialogA.querySelector("form")!);
      fireEvent.submit(dialogB.querySelector("form")!);
    });
    await waitFor(() => expect(server.state.posts).toHaveLength(2));
    server.state.hold = false;
    server.state.release();
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    // Initial lost request + exactly one retry; the queued tab found the attempt resolved and did not send.
    expect(server.state.posts).toHaveLength(2);
    expect(new Set(server.state.posts.map((p) => p.key)).size).toBe(1);
    expect(server.state.payments.size).toBe(1);
  });

  it("a tab with the same bill open follows a payment made in another tab and does not pay again", async () => {
    const server = ledger();
    const tabA = renderApp(<BillsPanel />, { handler: server.handler });
    const tabB = renderApp(<BillsPanel />, { handler: server.handler });
    const dialogA = await openBill(tabA);
    await openBill(tabB);
    await userEvent.clear(amountIn(dialogA));
    await userEvent.type(amountIn(dialogA), "5000");
    await click(dialogA, "Record bill payment");
    await within(tabA.container).findByText(/Paid ₹5,000.00/);
    // Tab B saw the attempt appear and then get confirmed, so its dialog closed rather than offering to pay.
    await waitFor(() => expect(within(tabB.container).queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.state.posts).toHaveLength(1);
    expect(server.state.payments.size).toBe(1);
  });

  it("if the cross-tab notice was missed, a fresh submit is still stopped by the completion marker", async () => {
    const server = ledger();
    renderApp(<BillsPanel />, { handler: server.handler });
    const dialog = await openBill();
    // Another tab confirmed a payment after this dialog opened, but no notification arrived.
    window.localStorage.setItem("kaira:bill-payment-done:v1:" + `${BIZ}:bill-1`, JSON.stringify({ v: 1, key: "elsewhere", at: Date.now() + 1 }));
    await click(dialog, "Record bill payment");
    expect(await within(dialog).findByText(/just recorded in another tab/)).toBeInTheDocument();
    expect(server.state.posts).toHaveLength(0);
  });

  it("an attempt written by another browsing context arrives over BroadcastChannel", async () => {
    const { handler } = ledger();
    renderApp(<BillsPanel />, { handler });
    await screen.findByRole("button", { name: /^Pay$/ });
    // Simulates another tab: write storage directly, then announce it on a separate channel instance.
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, key: "from-other-tab", businessId: BIZ, billId: "bill-1", userId: "u1", body: { amount: "300.00", payment_date: "2026-11-21", payment_method: "cash" }, startedAt: new Date().toISOString() }));
    const other = new BroadcastChannel("kaira-bill-payment-attempts");
    other.postMessage("changed");
    expect(await screen.findByRole("button", { name: "Resolve payment" })).toBeInTheDocument();
    other.close();
  });
});

describe("isDefinitiveRejection", () => {
  it("treats only processed 4xx rejections as outcomes", () => {
    expect(isDefinitiveRejection(new ApiError(422, { code: "OVERPAYMENT", message: "" }))).toBe(true);
    expect(isDefinitiveRejection(new ApiError(404, { code: "NOT_FOUND", message: "" }))).toBe(true);
    for (const status of [0, 401, 408, 409, 429, 500, 502, 503, 504]) {
      expect(isDefinitiveRejection(new ApiError(status, { code: "X", message: "" }))).toBe(false);
    }
    expect(isDefinitiveRejection(new TypeError("Failed to fetch"))).toBe(false);
  });
});
