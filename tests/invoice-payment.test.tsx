/**
 * Invoice-payment idempotency and recovery (components/invoices/payment-form.tsx, the invoice detail page and
 * the invoice instance of lib/api/payment-attempt.ts).
 *
 * The handler stands in for the invoice endpoints with the backend's contract (payment_service.
 * record_customer_payment): one payment per Idempotency-Key per business, the key looked up before the
 * void/already-paid/overpayment checks, a repeated key returns the original with `replayed: true`, and a key
 * reused for another invoice or amount is 422 IDEMPOTENCY_KEY_REUSED. It can lose the response AFTER
 * recording. "Tabs" are separate React trees sharing localStorage and the backend; "restart" is a fresh
 * tree over the same localStorage. The real-browser versions run in e2e/invoice-payment-idempotency.spec.ts.
 */
import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import InvoiceDetailPage from "@/app/(app)/invoices/[id]/page";
import {
  createBillPaymentAttempt,
  invoiceAttemptStorageKey,
  loadInvoicePaymentAttempt,
  loadInvoicePaymentDone,
} from "@/lib/api/payment-attempt";
import type { Invoice } from "@/lib/api/types";

import { envelope, errorEnvelope, ownerSession } from "./fixtures";
import { pathOf, renderApp } from "./render";

const BIZ = ownerSession.business.id;
const KEY1 = invoiceAttemptStorageKey(BIZ, "inv-1");

const baseInvoice = {
  customer_id: "cust-1",
  customer_name: "Ramesh Kumar",
  invoice_date: "2026-11-01",
  due_date: "2026-12-01",
  lifecycle_status: "issued",
  is_overdue: false,
  days_overdue: 0,
  total: "18000.00",
  notes: null,
  created_at: "2026-11-01T00:00:00Z",
  items: [],
};

type Failure = "network-before" | "network-after" | "timeout-after" | "500-after" | "502-after" | "503-before" | "504-after" | "409" | "429" | "408" | "422";

/** In-test stand-in for GET /invoices/{id}, GET /invoices/{id}/payments and POST /invoices/{id}/payments. */
function ledger(failures: Failure[] = []) {
  const outstanding: Record<string, bigint> = { "inv-1": BigInt(1800000), "inv-2": BigInt(900000) };
  const payments = new Map<string, { invoiceId: string; amount: string; body: Record<string, unknown> }>();
  const posts: { invoiceId: string; key: string | null; body: Record<string, unknown> }[] = [];
  let release: (() => void) | null = null;
  const state = { payments, posts, hold: false, release: () => release?.() };
  const money = (c: bigint) => (Number(c) / 100).toFixed(2);
  const invoice = (id: string) => {
    const out = outstanding[id];
    const total = id === "inv-1" ? BigInt(1800000) : BigInt(900000);
    return {
      ...baseInvoice,
      id,
      invoice_number: id === "inv-1" ? "INV-0001" : "INV-0002",
      total: money(total),
      paid: money(total - out),
      outstanding: money(out),
      payment_status: out === BigInt(0) ? "paid" : out === total ? "unpaid" : "partially_paid",
    } as Invoice;
  };
  const handler = async (req: Request) => {
    const p = pathOf(req);
    const m = p.match(/^(GET|POST) \/invoices\/(inv-\d)(\/payments)?$/);
    if (!m) return envelope({});
    const [, method, id, sub] = m;
    if (method === "GET" && !sub) return envelope(invoice(id));
    if (method === "GET" && sub) return envelope({ items: [], total: 0, page: 1, page_size: 200 });
    const key = req.headers.get("idempotency-key");
    const body = (await req.json()) as Record<string, unknown>;
    posts.push({ invoiceId: id, key, body });
    if (state.hold) await new Promise<void>((r) => (release = r));
    const failure = failures.shift();
    if (failure === "network-before") throw new TypeError("Failed to fetch");
    if (failure === "503-before") return errorEnvelope(503, "DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
    if (failure === "409") return errorEnvelope(409, "CONFLICT", "The request conflicts with existing data. Please retry.");
    if (failure === "429") return errorEnvelope(429, "RATE_LIMITED", "Too many requests");
    if (failure === "408") return errorEnvelope(408, "REQUEST_TIMEOUT", "Request timeout");
    if (failure === "422") return errorEnvelope(422, "OVERPAYMENT", "Payment exceeds the outstanding balance.");
    const existing = payments.get(key!);
    if (existing && (existing.invoiceId !== id || existing.amount !== body.amount)) {
      return errorEnvelope(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different payment.");
    }
    const replayed = !!existing;
    if (!replayed) {
      payments.set(key!, { invoiceId: id, amount: String(body.amount), body });
      outstanding[id] -= BigInt(Math.round(Number(body.amount) * 100));
    }
    // Recorded on the "server", but the response never reaches the browser.
    if (failure === "network-after") throw new TypeError("Failed to fetch");
    if (failure === "timeout-after") throw new DOMException("The operation timed out.", "TimeoutError");
    if (failure === "500-after") return errorEnvelope(500, "INTERNAL_ERROR", "Unexpected error");
    if (failure === "502-after") return errorEnvelope(502, "BACKEND_UNAVAILABLE", "Backend unavailable");
    if (failure === "504-after") return errorEnvelope(504, "BACKEND_TIMEOUT", "Backend timeout");
    const stored = payments.get(key!)!;
    return envelope({
      replayed,
      payment: { id: `pay-${payments.size}`, invoice_id: id, amount: stored.amount, payment_date: stored.body.payment_date, payment_method: stored.body.payment_method },
      invoice: invoice(id),
    }, 201);
  };
  return { state, handler };
}

/**
 * Renders the real invoice detail page (a "tab") for one invoice. The route params promise is marked as
 * already fulfilled (React 19's `use()` reads `status`/`value` from such thenables) so the page renders
 * immediately, as it does once Next has resolved the route.
 */
function openTab(handler: (req: Request) => Promise<Response>, id = "inv-1") {
  const params = Object.assign(Promise.resolve({ id }), { status: "fulfilled", value: { id } });
  return renderApp(
    <Suspense fallback={<p>loading</p>}>
      <InvoiceDetailPage params={params} />
    </Suspense>,
    { handler },
  );
}

async function openDialog(tab: RenderResult, testId: "record-payment" | "resolve-payment" = "record-payment") {
  const q = within(tab.container);
  await userEvent.click(await q.findByTestId(testId));
  return q.findByRole("dialog");
}

const field = (d: HTMLElement, label: string) => within(d).getByLabelText(label) as HTMLInputElement;
const click = (el: HTMLElement, name: string | RegExp) => userEvent.click(within(el).getByRole("button", { name }));

async function fillAndSubmit(d: HTMLElement, amount: string, extra: { method?: string; reference?: string; notes?: string } = {}) {
  await userEvent.clear(field(d, "Amount (₹)"));
  await userEvent.type(field(d, "Amount (₹)"), amount);
  if (extra.method) await userEvent.selectOptions(field(d, "Method"), extra.method);
  if (extra.reference) await userEvent.type(field(d, "Reference (optional)"), extra.reference);
  if (extra.notes) await userEvent.type(field(d, "Notes (optional)"), extra.notes);
  await click(d, "Record payment");
}

/** Minimal Web Locks stand-in: one FIFO queue per lock name, shared by every "tab" in the test. */
function installLocks() {
  const queues = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (name: string, fn: () => Promise<unknown>) => {
        const run = (queues.get(name) ?? Promise.resolve()).then(fn, fn);
        queues.set(name, run.catch(() => undefined));
        return run;
      },
    },
  });
  return () => Reflect.deleteProperty(navigator, "locks");
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("invoice payment idempotency", () => {
  it("records a successful payment, shows the server's balance and clears the saved attempt", async () => {
    const { state, handler } = ledger();
    const tab = openTab(handler);
    const d = await openDialog(tab);
    await fillAndSubmit(d, "5000", { method: "upi", reference: "UPI-77" });
    expect(await within(d).findByTestId("payment-confirmed")).toHaveTextContent("₹13,000.00");
    expect(state.payments.size).toBe(1);
    expect(state.posts[0].body).toEqual({ amount: "5000", payment_date: expect.any(String), payment_method: "upi", reference: "UPI-77", notes: null });
    expect(window.localStorage.getItem(KEY1)).toBeNull();
    expect(loadInvoicePaymentDone(BIZ, "inv-1")?.key).toBe(state.posts[0].key);
  });

  it("network failure before any response: retry reuses the key and records exactly once", async () => {
    const { state, handler } = ledger(["network-before"]);
    const d = await openDialog(openTab(handler));
    await fillAndSubmit(d, "4000");
    expect(await within(d).findByText("Payment not confirmed")).toBeInTheDocument();
    expect(state.payments.size).toBe(0);
    await click(d, "Retry payment");
    expect(await within(d).findByTestId("payment-confirmed")).toHaveTextContent("₹14,000.00");
    expect(state.posts.map((p) => p.key)).toEqual([state.posts[0].key, state.posts[0].key]);
    expect(state.payments.size).toBe(1);
  });

  it("timeout after the backend committed: the retry replays the original payment", async () => {
    const { state, handler } = ledger(["timeout-after"]);
    const d = await openDialog(openTab(handler));
    await fillAndSubmit(d, "6000");
    await within(d).findByText("Payment not confirmed");
    expect(state.payments.size).toBe(1);
    await click(d, "Retry payment");
    expect(await within(d).findByText(/had already been recorded; no duplicate was created/)).toBeInTheDocument();
    expect(state.posts[1].key).toBe(state.posts[0].key);
    expect(state.payments.size).toBe(1);
  });

  it("server failure after the backend committed: the retry replays the original payment", async () => {
    const { state, handler } = ledger(["500-after"]);
    const d = await openDialog(openTab(handler));
    await fillAndSubmit(d, "6000");
    await within(d).findByText("Payment not confirmed");
    await click(d, "Retry payment");
    await within(d).findByText(/had already been recorded/);
    expect(state.posts[1].key).toBe(state.posts[0].key);
    expect(state.payments.size).toBe(1);
  });

  it("an unknown outcome never produces a new key; the payload stays identical and every field stays locked", async () => {
    const failures: Failure[] = ["timeout-after", "502-after", "503-before", "504-after", "409", "429", "408", "network-after"];
    const { state, handler } = ledger([...failures]);
    const d = await openDialog(openTab(handler));
    await fillAndSubmit(d, "7500.50", { method: "cheque", reference: "CHQ-12", notes: "Part payment" });
    for (let i = 0; i < failures.length; i++) {
      await within(d).findByRole("button", { name: "Retry payment" });
      // The attempt is still saved after every unknown outcome.
      expect(loadInvoicePaymentAttempt(BIZ, "inv-1")?.key).toBe(state.posts[0].key);
      for (const label of ["Amount (₹)", "Payment date", "Method", "Reference (optional)", "Notes (optional)"]) expect(field(d, label)).toBeDisabled();
      expect(within(d).queryByRole("button", { name: /Pay full balance/ })).not.toBeInTheDocument();
      await click(d, "Retry payment");
    }
    await within(d).findByText(/had already been recorded/);
    expect(state.posts).toHaveLength(failures.length + 1);
    expect(new Set(state.posts.map((p) => p.key)).size).toBe(1);
    for (const p of state.posts) expect(p.body).toEqual(state.posts[0].body);
    expect(state.posts[0].body).toMatchObject({ amount: "7500.50", payment_method: "cheque", reference: "CHQ-12", notes: "Part payment" });
    expect(state.payments.size).toBe(1);
  });

  it("duplicate clicks while a request is in flight send a single request", async () => {
    const { state, handler } = ledger();
    state.hold = true;
    const d = await openDialog(openTab(handler));
    await userEvent.type(field(d, "Amount (₹)"), "1000");
    const form = d.querySelector("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(within(d).getByRole("button", { name: /Record payment|Retry payment/ })).toBeDisabled();
    state.hold = false;
    state.release();
    await within(d).findByTestId("payment-confirmed");
    expect(state.posts).toHaveLength(1);
    expect(state.payments.size).toBe(1);
  });

  it("a definitive rejection releases the attempt for correction; separate payments get separate keys", async () => {
    const { state, handler } = ledger(["422"]);
    const tab = openTab(handler);
    let d = await openDialog(tab);
    await fillAndSubmit(d, "1000");
    expect(await within(d).findByText(/exceeds the outstanding balance/)).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY1)).toBeNull();
    expect(field(d, "Amount (₹)")).not.toBeDisabled();
    await fillAndSubmit(d, "900");
    await within(d).findByTestId("payment-confirmed");
    await click(d, "Done");
    d = await openDialog(tab);
    await fillAndSubmit(d, "2000");
    await within(d).findByTestId("payment-confirmed");
    expect(state.posts.map((p) => p.body.amount)).toEqual(["1000", "900", "2000"]);
    expect(new Set(state.posts.map((p) => p.key)).size).toBe(3);
    expect(state.payments.size).toBe(2);
  });

  it("different invoices keep independent attempts and keys", async () => {
    const server = ledger(["network-after"]);
    const tab1 = openTab(server.handler, "inv-1");
    const d1 = await openDialog(tab1);
    await fillAndSubmit(d1, "1000");
    await within(d1).findByText("Payment not confirmed");
    tab1.unmount();
    // A pending payment on INV-0001 does not block or lock INV-0002.
    const tab2 = openTab(server.handler, "inv-2");
    const d2 = await openDialog(tab2);
    expect(within(d2).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await fillAndSubmit(d2, "500");
    await within(d2).findByTestId("payment-confirmed");
    expect(server.state.posts.map((p) => p.invoiceId)).toEqual(["inv-1", "inv-2"]);
    expect(server.state.posts[0].key).not.toBe(server.state.posts[1].key);
    expect(loadInvoicePaymentAttempt(BIZ, "inv-1")?.key).toBe(server.state.posts[0].key);
    expect(loadInvoicePaymentAttempt(BIZ, "inv-2")).toBeNull();
  });
});

describe("recovery of an uncertain invoice payment", () => {
  it("survives closing the dialog and leaving the page; the invoice page offers Resolve payment and hides Void", async () => {
    const server = ledger(["network-before"]);
    const tab = openTab(server.handler);
    const d = await openDialog(tab);
    await fillAndSubmit(d, "3000", { notes: "Cash at counter" });
    await within(d).findByText("Payment not confirmed");
    expect(within(d).queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();
    await click(d, "Close");
    expect(await within(tab.container).findByText("Payment awaiting confirmation")).toBeInTheDocument();
    expect(within(tab.container).queryByTestId("record-payment")).not.toBeInTheDocument();
    expect(within(tab.container).queryByRole("button", { name: /Void/ })).not.toBeInTheDocument();
    tab.unmount();

    // Reopening the invoice ("tab closed and reopened"): the saved attempt is restored with its frozen values.
    const again = openTab(server.handler);
    const restored = await openDialog(again, "resolve-payment");
    expect(within(restored).getByText("Payment not confirmed")).toBeInTheDocument();
    expect(field(restored, "Amount (₹)").value).toBe("3000");
    expect(field(restored, "Notes (optional)").value).toBe("Cash at counter");
    await click(restored, "Retry payment");
    await within(restored).findByTestId("payment-confirmed");
    expect(server.state.posts.map((p) => p.key)).toEqual([server.state.posts[0].key, server.state.posts[0].key]);
    expect(server.state.payments.size).toBe(1);
    // Confirmation clears the saved attempt and the page goes back to normal.
    expect(window.localStorage.getItem(KEY1)).toBeNull();
    await click(restored, "Done");
    expect(await within(again.container).findByTestId("record-payment")).toBeInTheDocument();
  });

  it("survives a browser restart even when the lost payment fully paid the invoice", async () => {
    const server = ledger(["network-after"]);
    const before = openTab(server.handler);
    const d = await openDialog(before);
    await userEvent.click(within(d).getByRole("button", { name: /Pay full balance/ }));
    await click(d, "Record payment");
    await within(d).findByText("Payment not confirmed");
    const stored = JSON.parse(window.localStorage.getItem(KEY1)!);
    expect(stored).toMatchObject({ v: 1, key: server.state.posts[0].key, businessId: BIZ, invoiceId: "inv-1", body: { amount: "18000.00" } });
    expect(Object.keys(stored).sort()).toEqual(["body", "businessId", "invoiceId", "key", "startedAt", "userId", "v"]);
    expect(JSON.stringify(stored)).not.toMatch(/csrf|token|password|cookie/i);

    // "Restart": nothing in memory survives. The backend now reports the invoice as fully paid, so there is
    // no Record payment button; the pending payment must still be resumable and must replay, not fail.
    before.unmount();
    const after = openTab(server.handler);
    expect(await within(after.container).findByText("Payment awaiting confirmation")).toBeInTheDocument();
    expect(within(after.container).queryByTestId("record-payment")).not.toBeInTheDocument();
    const restored = await openDialog(after, "resolve-payment");
    expect(field(restored, "Amount (₹)").value).toBe("18000.00");
    await click(restored, "Retry payment");
    expect(await within(restored).findByText(/had already been recorded/)).toBeInTheDocument();
    expect(server.state.posts.map((p) => p.key)).toEqual([stored.key, stored.key]);
    expect(server.state.payments.size).toBe(1);
    expect(window.localStorage.getItem(KEY1)).toBeNull();
  });

  it("bill and invoice attempts are kept apart", async () => {
    createBillPaymentAttempt({ key: "bill-key", businessId: BIZ, billId: "inv-1", userId: "u1", body: { amount: "10.00", payment_date: "2026-11-21", payment_method: "cash" } });
    const { state, handler } = ledger();
    const d = await openDialog(openTab(handler));
    expect(within(d).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await fillAndSubmit(d, "100");
    await within(d).findByTestId("payment-confirmed");
    expect(state.posts[0].key).not.toBe("bill-key");
  });
});

describe("invoice payments across tabs", () => {
  let uninstall: () => void;
  beforeEach(() => (uninstall = installLocks()));
  afterEach(() => uninstall());

  it("a second tab recognises the pending payment and retries it with the same key; the first tab follows", async () => {
    const server = ledger(["network-after"]);
    const tabA = openTab(server.handler);
    const tabB = openTab(server.handler);
    const dA = await openDialog(tabA);
    await fillAndSubmit(dA, "2500");
    await within(dA).findByText("Payment not confirmed");

    // Tab B sees it without reloading: Resolve payment, frozen values.
    const dB = await openDialog(tabB, "resolve-payment");
    expect(within(dB).getByText("Payment not confirmed")).toBeInTheDocument();
    expect(field(dB, "Amount (₹)").value).toBe("2500");
    expect(field(dB, "Amount (₹)")).toBeDisabled();
    await click(dB, "Retry payment");
    await within(dB).findByText(/had already been recorded/);
    expect(server.state.posts.map((p) => p.key)).toEqual([server.state.posts[0].key, server.state.posts[0].key]);
    expect(server.state.payments.size).toBe(1);

    // Tab A learns about the confirmation: its dialog closes and it says the payment was recorded once.
    await waitFor(() => expect(within(tabA.container).queryByRole("dialog", { hidden: false })).toBeNull());
    expect(await within(tabA.container).findByText(/confirmed in another tab; it was recorded once/)).toBeInTheDocument();
  });

  it("a tab with the dialog already open adopts the other tab's attempt instead of creating its own", async () => {
    const server = ledger(["network-after"]);
    const tabA = openTab(server.handler);
    const tabB = openTab(server.handler);
    const dA = await openDialog(tabA);
    const dB = await openDialog(tabB);
    await userEvent.type(field(dB, "Amount (₹)"), "999");
    await fillAndSubmit(dA, "2500");
    await within(dA).findByText("Payment not confirmed");
    expect(await within(dB).findByText("Payment not confirmed")).toBeInTheDocument();
    expect(field(dB, "Amount (₹)").value).toBe("2500");
    expect(server.state.posts).toHaveLength(1);
  });

  it("simultaneous retries from two tabs are serialised: one retry request, both tabs end confirmed", async () => {
    const server = ledger(["network-after"]);
    const tabA = openTab(server.handler);
    const tabB = openTab(server.handler);
    const dA = await openDialog(tabA);
    await fillAndSubmit(dA, "2500");
    await within(dA).findByText("Payment not confirmed");
    const dB = await openDialog(tabB, "resolve-payment");
    server.state.hold = true;
    act(() => {
      fireEvent.submit(dA.querySelector("form")!);
      fireEvent.submit(dB.querySelector("form")!);
    });
    await waitFor(() => expect(server.state.posts).toHaveLength(2));
    server.state.hold = false;
    server.state.release();
    await waitFor(() => expect(window.localStorage.getItem(KEY1)).toBeNull());
    await waitFor(() => expect(screen.queryAllByText("Payment not confirmed")).toHaveLength(0));
    expect(server.state.posts).toHaveLength(2);
    expect(new Set(server.state.posts.map((p) => p.key)).size).toBe(1);
    expect(server.state.payments.size).toBe(1);
  });

  it("a fresh payment is stopped if another tab just recorded one and the notice was missed", async () => {
    const server = ledger();
    const d = await openDialog(openTab(server.handler));
    window.localStorage.setItem(`kaira:invoice-payment-done:v1:${BIZ}:inv-1`, JSON.stringify({ v: 1, key: "elsewhere", at: Date.now() + 1 }));
    await fillAndSubmit(d, "100");
    expect(await within(d).findByText(/just recorded in another tab/)).toBeInTheDocument();
    expect(server.state.posts).toHaveLength(0);
  });

  it("an attempt written by another browsing context arrives over BroadcastChannel", async () => {
    const { handler } = ledger();
    const tab = openTab(handler);
    await within(tab.container).findByTestId("record-payment");
    window.localStorage.setItem(KEY1, JSON.stringify({ v: 1, key: "from-other-tab", businessId: BIZ, invoiceId: "inv-1", userId: "u1", body: { amount: "300.00", payment_date: "2026-11-21", payment_method: "cash", reference: null, notes: null }, startedAt: new Date().toISOString() }));
    const other = new BroadcastChannel("kaira-invoice-payment-attempts");
    other.postMessage("changed");
    expect(await within(tab.container).findByTestId("resolve-payment")).toBeInTheDocument();
    other.close();
  });
});
