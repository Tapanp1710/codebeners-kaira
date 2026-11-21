/**
 * Bill-payment idempotency (components/cashflow/bills-panel.tsx + lib/api/payment-attempt.ts).
 *
 * The handler below stands in for POST /bills/{id}/payments with the backend's documented contract:
 * one payment per Idempotency-Key, a repeated key returns the original with `replayed: true`. It can
 * also lose the response AFTER recording, which is the dangerous case: the frontend sees a network error
 * or timeout although the payment exists. `ledger.payments` counts what the "server" recorded.
 * The same scenario is exercised against a real backend in e2e/bill-payment-idempotency.spec.ts.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BillsPanel } from "@/components/cashflow/bills-panel";
import { ApiError } from "@/lib/api/errors";
import { isDefinitiveRejection } from "@/lib/api/payment-attempt";
import type { Bill } from "@/lib/api/types";

import { envelope, errorEnvelope } from "./fixtures";
import { pathOf, renderApp } from "./render";

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

type Failure = "network-before" | "network-after" | "timeout-after" | "502-after" | "422";

/** In-test stand-in for the bill payment endpoint; `failures` are consumed one per POST. */
function ledger(failures: Failure[] = []) {
  const payments = new Map<string, { amount: string }>();
  const posts: { key: string | null; body: Record<string, unknown> }[] = [];
  let outstanding = BigInt(2000000);
  let release: (() => void) | null = null;
  const state = { payments, posts, hold: false, release: () => release?.() };
  const handler = async (req: Request) => {
    const p = pathOf(req);
    if (p === "GET /bills") {
      const out = (Number(outstanding) / 100).toFixed(2);
      return envelope({ items: [{ ...bill, outstanding: out }], total: 1, page: 1, page_size: 100 });
    }
    if (p === "POST /bills/bill-1/payments") {
      const key = req.headers.get("idempotency-key");
      const body = (await req.json()) as Record<string, unknown>;
      posts.push({ key, body });
      if (state.hold) await new Promise<void>((r) => (release = r));
      const failure = failures.shift();
      if (failure === "network-before") throw new TypeError("Failed to fetch");
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
      const out = (Number(outstanding) / 100).toFixed(2);
      return envelope({ replayed, payment: { id: `bp-${payments.size}`, bill_id: "bill-1", amount: String(body.amount), payment_date: body.payment_date, payment_method: body.payment_method }, bill: { ...bill, outstanding: out } }, replayed ? 200 : 201);
    }
    return envelope({});
  };
  return { state, handler };
}

async function openPayDialog() {
  await userEvent.click(await screen.findByRole("button", { name: "Pay" }));
  return screen.findByRole("dialog");
}

const amountField = () => screen.getByLabelText("Amount (₹)") as HTMLInputElement;

beforeEach(() => window.sessionStorage.clear());
afterEach(() => window.sessionStorage.clear());

describe("bill payment idempotency", () => {
  it("records a successful payment once and clears the attempt", async () => {
    const { state, handler } = ledger();
    renderApp(<BillsPanel />, { handler });
    await openPayDialog();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), "5000");
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    expect(await screen.findByText(/Paid ₹5,000.00 to Sharma Rentals/)).toBeInTheDocument();
    expect(state.payments.size).toBe(1);
    expect(state.posts[0].key).toMatch(/.{8,}/);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("network failure before any response: retry reuses the key and records exactly once", async () => {
    const { state, handler } = ledger(["network-before"]);
    renderApp(<BillsPanel />, { handler });
    await openPayDialog();
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    expect(await screen.findByText("Payment not confirmed")).toBeInTheDocument();
    expect(state.payments.size).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    expect(await screen.findByText(/Paid ₹20,000.00 to Sharma Rentals/)).toBeInTheDocument();
    expect(state.posts.map((p) => p.key)).toEqual([state.posts[0].key, state.posts[0].key]);
    expect(state.payments.size).toBe(1);
  });

  it("server committed but the response was lost (network error): the retry replays, no duplicate", async () => {
    const { state, handler } = ledger(["network-after"]);
    renderApp(<BillsPanel />, { handler });
    await openPayDialog();
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    expect(await screen.findByText("Payment not confirmed")).toBeInTheDocument();
    expect(state.payments.size).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    expect(await screen.findByText(/had already been recorded; no duplicate was created/)).toBeInTheDocument();
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1].key).toBe(state.posts[0].key);
    expect(state.payments.size).toBe(1);
  });

  it("timeout after the server committed: the retry uses the same key and the same body", async () => {
    const { state, handler } = ledger(["timeout-after"]);
    renderApp(<BillsPanel />, { handler });
    await openPayDialog();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), "7500.50");
    await userEvent.selectOptions(screen.getByLabelText("Method"), "upi");
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    expect(await screen.findByText("Payment not confirmed")).toBeInTheDocument();
    // The payload is frozen: the fields lock so the retry cannot silently send different values.
    expect(amountField()).toBeDisabled();
    expect(screen.getByLabelText("Method")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    expect(await screen.findByText(/had already been recorded/)).toBeInTheDocument();
    expect(state.posts[1]).toEqual(state.posts[0]);
    expect(state.posts[0].body).toMatchObject({ amount: "7500.50", payment_method: "upi" });
    expect(state.payments.size).toBe(1);
  });

  it("a 5xx is not an outcome either: the key is kept", async () => {
    const { state, handler } = ledger(["502-after"]);
    renderApp(<BillsPanel />, { handler });
    await openPayDialog();
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    expect(await screen.findByText("Payment not confirmed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    await screen.findByText(/had already been recorded/);
    expect(state.posts[1].key).toBe(state.posts[0].key);
    expect(state.payments.size).toBe(1);
  });

  it("duplicate clicks while a request is in flight send a single request", async () => {
    const { state, handler } = ledger();
    state.hold = true;
    renderApp(<BillsPanel />, { handler });
    const dialog = await openPayDialog();
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

  it("separate payments get separate keys; a definitive rejection releases the attempt", async () => {
    const { state, handler } = ledger(["422"]);
    renderApp(<BillsPanel />, { handler });
    await openPayDialog();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), "1000");
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    expect(await screen.findByText(/exceeds the remaining payable amount/)).toBeInTheDocument();
    // 422 proves nothing was recorded: fields unlock and the next submit is a new attempt with a new key.
    expect(amountField()).not.toBeDisabled();
    expect(screen.queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    await screen.findByText(/Paid ₹1,000.00/);
    await openPayDialog();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), "2000");
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    await screen.findByText(/Paid ₹2,000.00/);
    const keys = state.posts.map((p) => p.key);
    expect(new Set(keys).size).toBe(3);
    expect(state.payments.size).toBe(2);
  });

  it("recovers the uncertain attempt after a reload and retries it even though the balance has dropped", async () => {
    const first = ledger(["network-after"]);
    const view = renderApp(<BillsPanel />, { handler: first.handler });
    await openPayDialog();
    await userEvent.clear(amountField());
    await userEvent.type(amountField(), "15000");
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    await screen.findByText("Payment not confirmed");
    const stored = JSON.parse(window.sessionStorage.getItem("kaira:bill-payment-attempt:u1:bill-1")!);
    expect(stored).toMatchObject({ key: first.state.posts[0].key, billId: "bill-1", body: { amount: "15000" } });
    expect(JSON.stringify(stored)).not.toMatch(/csrf|token|password/i);

    // "Reload": a fresh tree and query cache; the server now reports the lower balance (5,000 left),
    // so a client-side overpayment check would wrongly block re-sending 15,000.
    view.unmount();
    renderApp(<BillsPanel />, { handler: first.handler });
    const dialog = await openPayDialog();
    expect(within(dialog).getByText("Payment not confirmed")).toBeInTheDocument();
    expect(amountField().value).toBe("15000");
    await userEvent.click(screen.getByRole("button", { name: "Retry payment" }));
    await screen.findByText(/had already been recorded/);
    expect(first.state.posts.map((p) => p.key)).toEqual([stored.key, stored.key]);
    expect(first.state.payments.size).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("discarding an uncertain attempt needs a second, explicit confirmation", async () => {
    const { handler } = ledger(["network-before"]);
    renderApp(<BillsPanel />, { handler });
    await openPayDialog();
    await userEvent.click(screen.getByRole("button", { name: "Record bill payment" }));
    await screen.findByText("Payment not confirmed");
    await userEvent.click(screen.getByRole("button", { name: "Discard attempt" }));
    expect(screen.getByText("Discard this attempt?")).toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Discard anyway" }));
    expect(window.sessionStorage.length).toBe(0);
    expect(amountField()).not.toBeDisabled();
  });
});

describe("isDefinitiveRejection", () => {
  it("treats only processed 4xx rejections as outcomes", () => {
    expect(isDefinitiveRejection(new ApiError(422, { code: "OVERPAYMENT", message: "" }))).toBe(true);
    expect(isDefinitiveRejection(new ApiError(404, { code: "NOT_FOUND", message: "" }))).toBe(true);
    for (const status of [0, 401, 408, 409, 429, 500, 502, 504]) {
      expect(isDefinitiveRejection(new ApiError(status, { code: "X", message: "" }))).toBe(false);
    }
    expect(isDefinitiveRejection(new TypeError("Failed to fetch"))).toBe(false);
  });
});
