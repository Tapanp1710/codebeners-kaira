/**
 * Invoice payments through the server-side payment-attempt registry (components/invoices/payment-form.tsx,
 * the invoice detail page, lib/payments). Backend: tests/attempt-server.ts (API 1.1.0 contract, verified
 * against PostgreSQL in kaira-backend). "Tabs" share localStorage and the backend; "another device" has
 * empty localStorage; "restart" is a fresh tree over the same localStorage.
 */
import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import InvoiceDetailPage from "@/app/(app)/invoices/[id]/page";
import { createBillPaymentAttempt, invoiceAttemptStorageKey, loadInvoicePaymentAttempt, loadInvoicePaymentDone } from "@/lib/api/payment-attempt";

import { attemptServer, type Failure } from "./attempt-server";
import { ownerSession } from "./fixtures";
import { renderApp } from "./render";

const BIZ = ownerSession.business.id;
const KEY1 = invoiceAttemptStorageKey(BIZ, "inv-1");

function server(f: { register?: Failure[]; execute?: Failure[] } = {}) {
  return attemptServer({
    kind: "invoice",
    targets: { "inv-1": { amount: "18000.00", label: "INV-0001" }, "inv-2": { amount: "9000.00", label: "INV-0002" } },
    registerFailures: f.register,
    executeFailures: f.execute,
  });
}

/** Renders the real invoice page (route params already resolved, as Next provides them). */
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
const keysOf = (xs: { key: string | null }[]) => xs.map((x) => x.key);

async function fillAndSubmit(d: HTMLElement, amount: string, extra: { method?: string; reference?: string; notes?: string } = {}) {
  await userEvent.clear(field(d, "Amount (₹)"));
  await userEvent.type(field(d, "Amount (₹)"), amount);
  if (extra.method) await userEvent.selectOptions(field(d, "Method"), extra.method);
  if (extra.reference) await userEvent.type(field(d, "Reference (optional)"), extra.reference);
  if (extra.notes) await userEvent.type(field(d, "Notes (optional)"), extra.notes);
  await click(d, "Record payment");
}

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

describe("invoice payments via the server registry", () => {
  it("records a payment once, shows the server's balance and clears the local record", async () => {
    const s = server();
    const d = await openDialog(openTab(s.handler));
    await fillAndSubmit(d, "5000", { method: "upi", reference: "UPI-77" });
    expect(await within(d).findByTestId("payment-confirmed")).toHaveTextContent("₹13,000.00");
    expect(s.state.registrations[0].body).toMatchObject({ amount: "5000", payment_method: "upi", reference: "UPI-77", notes: null });
    expect(s.state.payments.size).toBe(1);
    expect(window.localStorage.getItem(KEY1)).toBeNull();
    expect(loadInvoicePaymentDone(BIZ, "inv-1")?.key).toBe(s.state.registrations[0].key);
  });

  it("network failure before any response: retry uses the same attempt and records exactly once", async () => {
    const s = server({ execute: ["network-before"] });
    const d = await openDialog(openTab(s.handler));
    await fillAndSubmit(d, "4000");
    expect(await within(d).findByText("Payment not confirmed")).toBeInTheDocument();
    expect(s.state.payments.size).toBe(0);
    await click(d, "Retry payment");
    expect(await within(d).findByTestId("payment-confirmed")).toHaveTextContent("₹14,000.00");
    expect(new Set(keysOf(s.state.registrations)).size).toBe(1);
    expect(s.state.payments.size).toBe(1);
  });

  it.each<Failure>(["timeout-after", "500-after", "502-after"])("backend committed, response lost (%s): the retry confirms it once", async (f) => {
    const s = server({ execute: [f] });
    const d = await openDialog(openTab(s.handler));
    await fillAndSubmit(d, "6000");
    await within(d).findByText("Payment not confirmed");
    expect(s.state.payments.size).toBe(1);
    await click(d, "Retry payment");
    expect(await within(d).findByTestId("payment-confirmed")).toBeInTheDocument();
    expect(new Set(keysOf(s.state.registrations)).size).toBe(1);
    expect(s.state.payments.size).toBe(1);
  });

  it("unknown outcomes keep the attempt, one key and an identical request, with every field locked", async () => {
    const failures: Failure[] = ["network-before", "503-before", "409", "429", "408"];
    const s = server({ execute: [...failures], register: ["network-after"] });
    const d = await openDialog(openTab(s.handler));
    await fillAndSubmit(d, "7500.50", { method: "cheque", reference: "CHQ-12", notes: "Part payment" });
    for (let i = 0; i <= failures.length; i++) {
      await within(d).findByRole("button", { name: "Retry payment" });
      expect(loadInvoicePaymentAttempt(BIZ, "inv-1")?.key).toBe(s.state.registrations[0].key);
      for (const label of ["Amount (₹)", "Payment date", "Method", "Reference (optional)", "Notes (optional)"]) expect(field(d, label)).toBeDisabled();
      expect(within(d).queryByRole("button", { name: /Pay full balance/ })).not.toBeInTheDocument();
      await click(d, "Retry payment");
    }
    await within(d).findByTestId("payment-confirmed");
    expect(new Set(keysOf(s.state.registrations)).size).toBe(1);
    for (const r of s.state.registrations) expect(r.body).toEqual(s.state.registrations[0].body);
    expect(s.state.registrations[0].body).toMatchObject({ amount: "7500.50", payment_method: "cheque", reference: "CHQ-12", notes: "Part payment" });
    expect(s.state.attempts.size).toBe(1);
    expect(s.state.payments.size).toBe(1);
  });

  it("duplicate clicks while a request is in flight send one registration", async () => {
    const s = server();
    s.state.hold = true;
    const d = await openDialog(openTab(s.handler));
    await userEvent.type(field(d, "Amount (₹)"), "1000");
    const form = d.querySelector("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(s.state.registrations).toHaveLength(1));
    s.state.hold = false;
    s.state.release();
    await within(d).findByTestId("payment-confirmed");
    expect(s.state.registrations).toHaveLength(1);
    expect(s.state.executions).toHaveLength(1);
  });

  it("a definitive rejection releases the attempt for correction; separate payments get separate keys", async () => {
    const s = server({ execute: ["422"] });
    const tab = openTab(s.handler);
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
    expect(s.state.registrations.map((r) => r.body.amount)).toEqual(["1000", "900", "2000"]);
    expect(new Set(keysOf(s.state.registrations)).size).toBe(3);
    expect(s.state.payments.size).toBe(2);
  });

  it("different invoices keep independent attempts and keys", async () => {
    const s = server({ execute: ["network-before"] });
    const t1 = openTab(s.handler, "inv-1");
    const d1 = await openDialog(t1);
    await fillAndSubmit(d1, "1000");
    await within(d1).findByText("Payment not confirmed");
    t1.unmount();
    const d2 = await openDialog(openTab(s.handler, "inv-2"));
    expect(within(d2).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await fillAndSubmit(d2, "500");
    await within(d2).findByTestId("payment-confirmed");
    expect(s.state.registrations[0].key).not.toBe(s.state.registrations[1].key);
    expect(loadInvoicePaymentAttempt(BIZ, "inv-1")).not.toBeNull();
    expect(loadInvoicePaymentAttempt(BIZ, "inv-2")).toBeNull();
  });
});

describe("recovery of an unconfirmed invoice payment", () => {
  it("survives closing the dialog and the tab; the page offers Resolve payment and hides Void", async () => {
    const s = server({ execute: ["network-before"] });
    const tab = openTab(s.handler);
    const d = await openDialog(tab);
    await fillAndSubmit(d, "3000", { notes: "Cash at counter" });
    await within(d).findByText("Payment not confirmed");
    expect(within(d).queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();
    await click(d, "Close");
    expect(await within(tab.container).findByText("Payment awaiting confirmation")).toBeInTheDocument();
    expect(within(tab.container).queryByTestId("record-payment")).not.toBeInTheDocument();
    expect(within(tab.container).queryByRole("button", { name: /Void/ })).not.toBeInTheDocument();
    tab.unmount();
    const again = openTab(s.handler);
    const r = await openDialog(again, "resolve-payment");
    expect(field(r, "Amount (₹)").value).toBe("3000");
    expect(field(r, "Notes (optional)").value).toBe("Cash at counter");
    await click(r, "Retry payment");
    await within(r).findByTestId("payment-confirmed");
    expect(s.state.payments.size).toBe(1);
    expect(window.localStorage.getItem(KEY1)).toBeNull();
    await click(r, "Done");
    expect(await within(again.container).findByTestId("record-payment")).toBeInTheDocument();
  });

  it("survives a browser restart even when the lost payment fully paid the invoice", async () => {
    const s = server({ execute: ["network-after"] });
    const before = openTab(s.handler);
    const d = await openDialog(before);
    await userEvent.click(within(d).getByRole("button", { name: /Pay full balance/ }));
    await click(d, "Record payment");
    await within(d).findByText("Payment not confirmed");
    const stored = JSON.parse(window.localStorage.getItem(KEY1)!);
    expect(stored).toMatchObject({ v: 2, businessId: BIZ, invoiceId: "inv-1", body: { amount: "18000.00" } });
    expect(JSON.stringify(stored)).not.toMatch(/csrf|token|password|cookie/i);
    before.unmount();
    const after = openTab(s.handler);
    expect(await within(after.container).findByText("Payment awaiting confirmation")).toBeInTheDocument();
    expect(within(after.container).queryByTestId("record-payment")).not.toBeInTheDocument();
    const r = await openDialog(after, "resolve-payment");
    await click(r, "Retry payment");
    expect(await within(r).findByText(/had already been recorded/)).toBeInTheDocument();
    expect(s.state.payments.size).toBe(1);
    expect(window.localStorage.getItem(KEY1)).toBeNull();
  });

  it("is recovered from the server on another device (no local record at all)", async () => {
    const s = server({ execute: ["network-before"] });
    const deviceA = openTab(s.handler);
    const d = await openDialog(deviceA);
    await fillAndSubmit(d, "2500", { reference: "R-9" });
    await within(d).findByText("Payment not confirmed");
    deviceA.unmount();
    window.localStorage.clear();
    const deviceB = openTab(s.handler);
    expect(await within(deviceB.container).findByText("Payment awaiting confirmation")).toBeInTheDocument();
    const r = await openDialog(deviceB, "resolve-payment");
    expect(field(r, "Amount (₹)").value).toBe("2500.00");
    expect(field(r, "Reference (optional)").value).toBe("R-9");
    await click(r, "Retry payment");
    expect(await within(r).findByTestId("payment-confirmed")).toBeInTheDocument();
    expect(s.state.payments.size).toBe(1);
    expect(s.state.attempts.size).toBe(1);
  });

  it("migrates a record saved by an older build without paying twice", async () => {
    const s = server();
    const legacy = { amount: "1500.00", payment_date: "2026-11-21", payment_method: "upi" as const, reference: null, notes: null };
    await s.handler(new Request("http://localhost/api/backend/api/v1/invoices/inv-1/payments", { method: "POST", headers: { "idempotency-key": "legacy-inv-key" }, body: JSON.stringify(legacy) }));
    window.localStorage.setItem(KEY1, JSON.stringify({ v: 1, key: "legacy-inv-key", businessId: BIZ, invoiceId: "inv-1", userId: "u1", body: legacy, startedAt: "2026-11-21T00:00:00Z" }));
    const r = await openDialog(openTab(s.handler), "resolve-payment");
    await click(r, "Retry payment");
    expect(await within(r).findByText(/had already been recorded/)).toBeInTheDocument();
    expect(s.state.payments.size).toBe(1);
  });

  it("bill and invoice attempts are kept apart", async () => {
    createBillPaymentAttempt({ key: "bill-key", businessId: BIZ, billId: "inv-1", userId: "u1", body: { amount: "10.00", payment_date: "2026-11-21", payment_method: "cash" } });
    const s = server();
    const d = await openDialog(openTab(s.handler));
    expect(within(d).queryByText("Payment not confirmed")).not.toBeInTheDocument();
    await fillAndSubmit(d, "100");
    await within(d).findByTestId("payment-confirmed");
    expect(s.state.registrations[0].key).not.toBe("bill-key");
  });
});

describe("invoice payments across tabs", () => {
  let uninstall: () => void;
  beforeEach(() => (uninstall = installLocks()));
  afterEach(() => uninstall());

  it("a second tab recognises the pending payment and retries the same attempt; the first tab follows", async () => {
    const s = server({ execute: ["network-after"] });
    const tabA = openTab(s.handler);
    const tabB = openTab(s.handler);
    const dA = await openDialog(tabA);
    await fillAndSubmit(dA, "2500");
    await within(dA).findByText("Payment not confirmed");
    const dB = await openDialog(tabB, "resolve-payment");
    expect(field(dB, "Amount (₹)").value).toBe("2500");
    expect(field(dB, "Amount (₹)")).toBeDisabled();
    await click(dB, "Retry payment");
    await within(dB).findByText(/had already been recorded/);
    expect(s.state.payments.size).toBe(1);
    await waitFor(() => expect(within(tabA.container).queryByText("Payment not confirmed")).toBeNull());
    expect(await within(tabA.container).findByText(/confirmed in another tab; it was recorded once/)).toBeInTheDocument();
  });

  it("a tab with the dialog already open adopts the other tab's attempt instead of creating its own", async () => {
    const s = server({ execute: ["network-before"] });
    const tabA = openTab(s.handler);
    const tabB = openTab(s.handler);
    const dA = await openDialog(tabA);
    const dB = await openDialog(tabB);
    await userEvent.type(field(dB, "Amount (₹)"), "999");
    await fillAndSubmit(dA, "2500");
    await within(dA).findByText("Payment not confirmed");
    expect(await within(dB).findByText("Payment not confirmed")).toBeInTheDocument();
    expect(field(dB, "Amount (₹)").value).toBe("2500");
    expect(s.state.registrations).toHaveLength(1);
  });

  it("simultaneous retries from two tabs are serialised and both end confirmed", async () => {
    const s = server({ execute: ["network-after"] });
    const tabA = openTab(s.handler);
    const tabB = openTab(s.handler);
    const dA = await openDialog(tabA);
    await fillAndSubmit(dA, "2500");
    await within(dA).findByText("Payment not confirmed");
    const dB = await openDialog(tabB, "resolve-payment");
    act(() => {
      fireEvent.submit(dA.querySelector("form")!);
      fireEvent.submit(dB.querySelector("form")!);
    });
    await waitFor(() => expect(window.localStorage.getItem(KEY1)).toBeNull());
    await waitFor(() => expect(screen.queryAllByText("Payment not confirmed")).toHaveLength(0));
    expect(s.state.payments.size).toBe(1);
    expect(s.state.attempts.size).toBe(1);
  });

  it("a fresh payment is stopped if another tab just recorded one and the notice was missed", async () => {
    const s = server();
    const d = await openDialog(openTab(s.handler));
    window.localStorage.setItem(`kaira:invoice-payment-done:v1:${BIZ}:inv-1`, JSON.stringify({ v: 1, key: "elsewhere", at: Date.now() + 1 }));
    await fillAndSubmit(d, "100");
    expect(await within(d).findByText(/just recorded in another tab/)).toBeInTheDocument();
    expect(s.state.registrations).toHaveLength(0);
  });
});
