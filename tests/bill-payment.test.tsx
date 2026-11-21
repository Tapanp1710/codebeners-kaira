/**
 * Bill payments through the server-side payment-attempt registry (components/cashflow/bills-panel.tsx,
 * lib/payments). The backend is the in-test stand-in in tests/attempt-server.ts, which follows the 1.1.0
 * contract verified against PostgreSQL in kaira-backend. "Tabs" are separate React trees sharing
 * localStorage and the backend; "another device" is a tree with empty localStorage; "restart" is a fresh
 * tree over the same localStorage. Real-browser versions: e2e/bill-payment-idempotency.spec.ts.
 */
import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillsPanel } from "@/components/cashflow/bills-panel";
import { ApiError } from "@/lib/api/errors";
import { attemptStorageKey, createBillPaymentAttempt, isDefinitiveRejection, loadBillPaymentAttempt, loadBillPaymentDone } from "@/lib/api/payment-attempt";

import { setTransport } from "@/lib/api/client";
import { runLocalAttempt } from "@/lib/payments/server-attempts";

import { attemptServer, type Failure } from "./attempt-server";
import { ownerSession } from "./fixtures";
import { renderApp } from "./render";

const BIZ = ownerSession.business.id;
const KEY = attemptStorageKey(BIZ, "bill-1");

function server(f: { register?: Failure[]; execute?: Failure[] } = {}, extraBills = 0) {
  const targets: Record<string, { amount: string; label: string }> = { "bill-1": { amount: "20000.00", label: "Sharma Rentals" } };
  for (let i = 0; i < extraBills; i++) targets[`bill-x${i}`] = { amount: "100.00", label: `Vendor ${i}` };
  return attemptServer({ kind: "bill", targets, registerFailures: f.register, executeFailures: f.execute });
}

async function openBill(scope: RenderResult | null = null, name: RegExp = /^(Pay|Resolve payment)$/) {
  const q = scope ? within(scope.container) : screen;
  await userEvent.click((await q.findAllByRole("button", { name }))[0]);
  return q.findByRole("dialog");
}
const amountIn = (d: HTMLElement) => within(d).getByLabelText("Amount (₹)") as HTMLInputElement;
const click = (el: HTMLElement, name: string | RegExp) => userEvent.click(within(el).getByRole("button", { name }));
const keysOf = (xs: { key: string | null }[]) => xs.map((x) => x.key);

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

describe("bill payments via the server registry", () => {
  it("registers, executes once, and clears the local record", async () => {
    const s = server();
    renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill();
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "5000");
    await click(d, "Record bill payment");
    expect(await screen.findByText(/Paid ₹5,000.00 to Sharma Rentals/)).toBeInTheDocument();
    expect(s.state.registrations).toHaveLength(1);
    expect(s.state.executions).toHaveLength(1);
    expect(s.state.executions[0].key).toBe(s.state.registrations[0].key);
    expect(s.state.payments.size).toBe(1);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(loadBillPaymentDone(BIZ, "bill-1")?.key).toBe(s.state.registrations[0].key);
  });

  it("network failure before the response: retry reuses the same attempt and records exactly once", async () => {
    const s = server({ execute: ["network-before"] });
    renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill();
    await click(d, "Record bill payment");
    expect(await within(d).findByText("Payment not confirmed")).toBeInTheDocument();
    expect(s.state.payments.size).toBe(0);
    await click(d, "Retry payment");
    expect(await screen.findByText(/Paid ₹20,000.00/)).toBeInTheDocument();
    expect(new Set(keysOf(s.state.registrations)).size).toBe(1);
    expect(s.state.payments.size).toBe(1);
  });

  it.each<Failure>(["network-after", "timeout-after", "500-after", "502-after", "504-after"])("server committed but the response was lost (%s): the retry confirms it, no duplicate", async (failure) => {
    const s = server({ execute: [failure] });
    renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill();
    await click(d, "Record bill payment");
    await within(d).findByText("Payment not confirmed");
    expect(s.state.payments.size).toBe(1);
    await click(d, "Retry payment");
    expect(await screen.findByText(/had already been recorded; no duplicate was created/)).toBeInTheDocument();
    expect(s.state.payments.size).toBe(1);
  });

  it("a lost registration response is retried with the same key and still records once", async () => {
    const s = server({ register: ["network-after"] });
    renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill();
    await click(d, "Record bill payment");
    await within(d).findByText("Payment not confirmed");
    expect(s.state.attempts.size).toBe(1); // the server did register it
    await click(d, "Retry payment");
    await screen.findByText(/Paid ₹20,000.00/);
    expect(keysOf(s.state.registrations)).toEqual([s.state.registrations[0].key, s.state.registrations[0].key]);
    expect(s.state.attempts.size).toBe(1);
    expect(s.state.payments.size).toBe(1);
  });

  it("an unknown outcome never produces a new key, and the request stays identical", async () => {
    // Unknown outcomes where nothing committed (after-commit cases: see the lost-response tests; once the
    // server has committed, the next retry's registration already reports the payment as done).
    const failures: Failure[] = ["network-before", "503-before", "409", "429", "408", "network-before", "503-before"];
    const s = server({ execute: [...failures] });
    renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill();
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "7500.50");
    await userEvent.selectOptions(within(d).getByLabelText("Method"), "upi");
    await click(d, "Record bill payment");
    for (let i = 0; i < failures.length; i++) {
      await within(d).findByRole("button", { name: "Retry payment" });
      expect(amountIn(d)).toBeDisabled();
      expect(within(d).getByLabelText("Method")).toBeDisabled();
      await click(d, "Retry payment");
    }
    await screen.findByText(/Paid ₹7,500.50/);
    expect(new Set(keysOf(s.state.registrations)).size).toBe(1);
    for (const r of s.state.registrations) expect(r.body).toEqual(s.state.registrations[0].body);
    expect(s.state.registrations[0].body).toMatchObject({ amount: "7500.50", payment_method: "upi" });
    expect(s.state.attempts.size).toBe(1);
    expect(s.state.payments.size).toBe(1);
  });

  it("duplicate clicks while a request is in flight send one registration and one execution", async () => {
    const s = server();
    s.state.hold = true;
    renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill();
    const form = d.querySelector("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(s.state.registrations).toHaveLength(1));
    s.state.hold = false;
    s.state.release();
    await screen.findByText(/Paid ₹20,000.00/);
    expect(s.state.registrations).toHaveLength(1);
    expect(s.state.executions).toHaveLength(1);
  });

  it("a definitive rejection releases the attempt for correction; separate payments get separate keys", async () => {
    const s = server({ execute: ["422"] });
    renderApp(<BillsPanel />, { handler: s.handler });
    let d = await openBill();
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "1000");
    await click(d, "Record bill payment");
    expect(await within(d).findByText(/exceeds the outstanding balance/)).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(amountIn(d)).not.toBeDisabled();
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "900");
    await click(d, "Record bill payment");
    await screen.findByText(/Paid ₹900.00/);
    d = await openBill();
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "2000");
    await click(d, "Record bill payment");
    await screen.findByText(/Paid ₹2,000.00/);
    expect(s.state.registrations.map((r) => r.body.amount)).toEqual(["1000", "900", "2000"]);
    expect(new Set(keysOf(s.state.registrations)).size).toBe(3);
    expect(s.state.payments.size).toBe(2);
  });
});

describe("recovery of an unconfirmed bill payment", () => {
  it("cannot be discarded: closing keeps it, and the row offers Resolve payment", async () => {
    const s = server({ execute: ["network-after"] });
    renderApp(<BillsPanel />, { handler: s.handler });
    let d = await openBill();
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "5000");
    await click(d, "Record bill payment");
    await within(d).findByText("Payment not confirmed");
    expect(within(d).queryByRole("button", { name: /discard|cancel payment/i })).not.toBeInTheDocument();
    await click(d, "Close");
    d = await openBill(null, /^Resolve payment$/);
    expect(amountIn(d).value).toBe("5000");
    expect(amountIn(d)).toBeDisabled();
    await click(d, "Retry payment");
    await screen.findByText(/had already been recorded/);
    expect(s.state.payments.size).toBe(1);
  });

  it("survives a browser restart (local record) and retries even though the balance has dropped", async () => {
    const s = server({ execute: ["network-after"] });
    const before = renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill(before);
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "15000");
    await click(d, "Record bill payment");
    await within(d).findByText("Payment not confirmed");
    const stored = JSON.parse(window.localStorage.getItem(KEY)!);
    expect(stored).toMatchObject({ v: 2, businessId: BIZ, billId: "bill-1", body: { amount: "15000" } });
    expect(stored.attemptId).toBe([...s.state.attempts.keys()][0]);
    expect(JSON.stringify(stored)).not.toMatch(/csrf|token|password|cookie/i);
    before.unmount();
    const after = renderApp(<BillsPanel />, { handler: s.handler });
    const r = await openBill(after, /^Resolve payment$/);
    expect(amountIn(r).value).toBe("15000");
    await click(r, "Retry payment");
    await screen.findByText(/had already been recorded/);
    expect(s.state.payments.size).toBe(1);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("is recovered from the server on another device (no local record at all)", async () => {
    // The attempt was registered but the execute request never reached the server.
    const s = server({ execute: ["network-before"] });
    const deviceA = renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill(deviceA);
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "4000");
    await click(d, "Record bill payment");
    await within(d).findByText("Payment not confirmed");
    deviceA.unmount();
    window.localStorage.clear(); // device B has nothing locally
    const deviceB = renderApp(<BillsPanel />, { handler: s.handler });
    const r = await openBill(deviceB, /^Resolve payment$/);
    expect(within(r).getByText("Payment not confirmed")).toBeInTheDocument();
    expect(amountIn(r).value).toBe("4000.00");
    await click(r, "Retry payment");
    await screen.findByText(/Paid ₹4,000.00/);
    expect(s.state.payments.size).toBe(1);
    expect(s.state.attempts.size).toBe(1);
    expect(new Set(s.state.executions.map((e) => e.key)).size).toBe(1);
  });

  it("another device simply sees the payment as done when the server had committed it", async () => {
    const s = server({ execute: ["network-after"] });
    const deviceA = renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill(deviceA);
    await userEvent.clear(amountIn(d));
    await userEvent.type(amountIn(d), "4000");
    await click(d, "Record bill payment");
    await within(d).findByText("Payment not confirmed");
    deviceA.unmount();
    window.localStorage.clear();
    renderApp(<BillsPanel />, { handler: s.handler });
    expect(await screen.findByRole("button", { name: "Pay" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve payment" })).not.toBeInTheDocument();
    expect(await screen.findByText("₹16,000.00")).toBeInTheDocument();
    expect(s.state.payments.size).toBe(1);
  });

  it("stays reachable when the lost payment cleared the bill out of the Unpaid list", async () => {
    const s = server({ execute: ["network-after"] });
    const tab = renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill(tab);
    await click(d, "Record bill payment");
    await within(d).findByText("Payment not confirmed");
    tab.unmount();
    // This browser still holds the local record; the bill is fully paid so it left the Unpaid list.
    renderApp(<BillsPanel />, { handler: s.handler });
    expect(await screen.findByText("Bill payment awaiting confirmation")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Resolve/ }));
    const r = await screen.findByRole("dialog");
    await click(r, "Retry payment");
    await screen.findByText(/had already been recorded/);
    expect(s.state.payments.size).toBe(1);
  });

  it("migrates a record saved by an older build without paying twice", async () => {
    // An older build sent this payment straight to POST /bills/{id}/payments with this key; the response was lost.
    const s = server();
    const legacyBody = { amount: "3000.00", payment_date: "2026-11-21", payment_method: "cash" as const };
    await s.handler(new Request("http://localhost/api/backend/api/v1/bills/bill-1/payments", { method: "POST", headers: { "idempotency-key": "legacy-key-1" }, body: JSON.stringify(legacyBody) }));
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, key: "legacy-key-1", businessId: BIZ, billId: "bill-1", userId: "u1", body: legacyBody, startedAt: "2026-11-21T00:00:00Z" }));
    renderApp(<BillsPanel />, { handler: s.handler });
    const r = await openBill(null, /^Resolve payment$/);
    await click(r, "Retry payment");
    await screen.findByText(/had already been recorded/);
    expect(s.state.payments.size).toBe(1);
    expect([...s.state.attempts.values()][0]).toMatchObject({ key: "legacy-key-1", status: "succeeded" });
  });

  it("is scoped to the business, and a corrupt local entry is ignored", async () => {
    createBillPaymentAttempt({ key: "other-biz-key", businessId: "b2", billId: "bill-1", userId: "u9", body: { amount: "100.00", payment_date: "2026-11-21", payment_method: "cash" } });
    window.localStorage.setItem(attemptStorageKey(BIZ, "bill-x0"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = server();
    renderApp(<BillsPanel />, { handler: s.handler });
    const d = await openBill(null, /^Pay$/);
    expect(within(d).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await click(d, "Record bill payment");
    await screen.findByText(/Paid ₹20,000.00/);
    expect(s.state.registrations[0].key).not.toBe("other-biz-key");
    expect(loadBillPaymentAttempt("b2", "bill-1")?.key).toBe("other-biz-key");
    warn.mockRestore();
  });

  it("never overwrites a pending local record", () => {
    const body = { amount: "100.00", payment_date: "2026-11-21", payment_method: "cash" as const };
    const first = createBillPaymentAttempt({ key: "k1", businessId: BIZ, billId: "bill-1", userId: "u1", body });
    const second = createBillPaymentAttempt({ key: "k2", businessId: BIZ, billId: "bill-1", userId: "u1", body: { ...body, amount: "200.00" } });
    expect(second).toEqual({ attempt: first.attempt, created: false });
  });
});

describe("bill payments across tabs", () => {
  it("without Web Locks, two tabs that each saved their own key end with one attempt (the server decides)", async () => {
    // localStorage is not a lock: in real browsers two tabs can both pass the local check and each create a
    // record. Simulate exactly that with two distinct v2 records and run both pipelines concurrently.
    const s = server();
    setTransport(s.handler);
    const body = { amount: "100.00", payment_date: "2026-11-22", payment_method: "cash" as const };
    const rec = (key: string) => ({ v: 2 as const, key, businessId: BIZ, userId: "u1", startedAt: "2026-11-22T00:00:00Z", body });
    const [a, b] = await Promise.all([
      runLocalAttempt("bill", BIZ, "bill-1", rec("tab-a-key")),
      runLocalAttempt("bill", BIZ, "bill-1", rec("tab-b-key")),
    ]);
    expect([a.type, b.type].sort()).toEqual(["conflict", "done"]);
    const loser = a.type === "conflict" ? a : b;
    if (loser.type === "conflict") expect(loser.attempt.status).not.toBe("rejected");
    expect(s.state.attempts.size).toBe(1);
    expect(s.state.executions).toHaveLength(1);
    expect(s.state.payments.size).toBe(1);
  });

  describe("with Web Locks", () => {
    let uninstall: () => void;
    beforeEach(() => (uninstall = installLocks()));
    afterEach(() => uninstall());

    it("a second tab recognises the pending payment and retries the same attempt; the first tab follows", async () => {
      const s = server({ execute: ["network-after"] });
      const tabA = renderApp(<BillsPanel />, { handler: s.handler });
      const tabB = renderApp(<BillsPanel />, { handler: s.handler });
      const dA = await openBill(tabA);
      const dB = await openBill(tabB);
      await click(dA, "Record bill payment");
      await within(dA).findByText("Payment not confirmed");
      expect(await within(dB).findByText("Payment not confirmed")).toBeInTheDocument();
      expect(amountIn(dB)).toBeDisabled();
      await click(dB, "Retry payment");
      await within(tabB.container).findByText(/had already been recorded/);
      expect(s.state.payments.size).toBe(1);
      expect(new Set(keysOf(s.state.registrations)).size).toBe(1);
      await waitFor(() => expect(within(tabA.container).queryByRole("dialog")).not.toBeInTheDocument());
      expect(await within(tabA.container).findByText(/confirmed in another tab; it was recorded once/)).toBeInTheDocument();
    });

    it("simultaneous retries from two tabs are serialised: one more execution, both end confirmed", async () => {
      const s = server({ execute: ["network-after"] });
      const tabA = renderApp(<BillsPanel />, { handler: s.handler });
      const tabB = renderApp(<BillsPanel />, { handler: s.handler });
      const dA = await openBill(tabA);
      await click(dA, "Record bill payment");
      await within(dA).findByText("Payment not confirmed");
      const dB = await openBill(tabB, /^Resolve payment$/);
      act(() => {
        fireEvent.submit(dA.querySelector("form")!);
        fireEvent.submit(dB.querySelector("form")!);
      });
      await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
      expect(s.state.payments.size).toBe(1);
      expect(s.state.attempts.size).toBe(1);
    });

    it("a fresh submit is stopped if another tab just recorded a payment and the notice was missed", async () => {
      const s = server();
      renderApp(<BillsPanel />, { handler: s.handler });
      const d = await openBill();
      window.localStorage.setItem(`kaira:bill-payment-done:v1:${BIZ}:bill-1`, JSON.stringify({ v: 1, key: "elsewhere", at: Date.now() + 1 }));
      await click(d, "Record bill payment");
      expect(await within(d).findByText(/just recorded in another tab/)).toBeInTheDocument();
      expect(s.state.registrations).toHaveLength(0);
    });
  });
});

describe("pagination", () => {
  it("pages through bills instead of silently stopping at the first page", async () => {
    const s = server({}, 30);
    renderApp(<BillsPanel />, { handler: s.handler });
    expect(await screen.findByText(/Page 1 of 2 · 31 total/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Page 2 of 2/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Pay" })).toHaveLength(6);
  });
});

describe("isDefinitiveRejection", () => {
  it("treats only processed 4xx rejections as outcomes", () => {
    expect(isDefinitiveRejection(new ApiError(422, { code: "OVERPAYMENT", message: "" }))).toBe(true);
    expect(isDefinitiveRejection(new ApiError(404, { code: "NOT_FOUND", message: "" }))).toBe(true);
    for (const status of [0, 401, 408, 409, 429, 500, 502, 503, 504]) {
      expect(isDefinitiveRejection(new ApiError(status, { code: "X", message: "" }))).toBe(false);
    }
  });
});
