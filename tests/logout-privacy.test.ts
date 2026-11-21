/**
 * Logout privacy (lib/payments/server-attempts.ts clearLocalAttemptsForLogout): local payment records are
 * removed at sign-out without losing any payment; the server keeps every unconfirmed one for the next login.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setTransport } from "@/lib/api/client";
import { attemptStorageKey, invoiceAttemptStorageKey, listPendingBillIds, listPendingInvoiceIds } from "@/lib/api/payment-attempt";
import { clearLocalAttemptsForLogout, listPendingAttempts, runLocalAttempt } from "@/lib/payments/server-attempts";

import { attemptServer } from "./attempt-server";

const BIZ = "b1";
const body = { amount: "100.00", payment_date: "2026-11-22", payment_method: "cash" as const, reference: null, notes: null };

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("clearLocalAttemptsForLogout", () => {
  it("clears v2 records; the server still holds the unconfirmed payment for the next login", async () => {
    const s = attemptServer({ kind: "bill", targets: { "bill-1": { amount: "500.00", label: "Rent" } }, executeFailures: ["network-before"] });
    setTransport(s.handler);
    const rec = { v: 2 as const, key: "v2-key-1", businessId: BIZ, userId: "u1", startedAt: "x", body, billId: "bill-1" };
    window.localStorage.setItem(attemptStorageKey(BIZ, "bill-1"), JSON.stringify(rec));
    expect((await runLocalAttempt("bill", BIZ, "bill-1", rec)).type).toBe("uncertain");
    expect(await clearLocalAttemptsForLogout(BIZ)).toBe(0);
    expect(listPendingBillIds(BIZ)).toEqual([]);
    const pending = await listPendingAttempts({ resource_type: "bill" });
    expect(pending.items.map((a) => a.resource_id)).toEqual(["bill-1"]);
    expect(s.state.payments.size).toBe(0);
  });

  it("registers a v1 (older build) record before clearing it, and keeps it if registration fails", async () => {
    const s = attemptServer({ kind: "invoice", targets: { "inv-1": { amount: "500.00", label: "INV-1" }, "inv-2": { amount: "500.00", label: "INV-2" } }, registerFailures: ["network-before"] });
    setTransport(s.handler);
    const v1 = (id: string, key: string) => ({ v: 1, key, businessId: BIZ, userId: "u1", startedAt: "x", body, invoiceId: id });
    window.localStorage.setItem(invoiceAttemptStorageKey(BIZ, "inv-1"), JSON.stringify(v1("inv-1", "legacy-1")));
    window.localStorage.setItem(invoiceAttemptStorageKey(BIZ, "inv-2"), JSON.stringify(v1("inv-2", "legacy-2")));
    // The first registration (inv-1, sorted first) fails: that record is kept; inv-2 registers and is cleared.
    expect(await clearLocalAttemptsForLogout(BIZ)).toBe(1);
    expect(listPendingInvoiceIds(BIZ)).toEqual(["inv-1"]);
    expect([...s.state.attempts.values()].map((a) => a.key)).toEqual(["legacy-2"]);
  });

  it("only touches the signed-out business's records", async () => {
    setTransport(attemptServer({ kind: "bill", targets: {} }).handler);
    window.localStorage.setItem(attemptStorageKey("other-biz", "bill-9"), JSON.stringify({ v: 2, key: "k-other", businessId: "other-biz", userId: "u9", startedAt: "x", body, billId: "bill-9" }));
    await clearLocalAttemptsForLogout(BIZ);
    expect(listPendingBillIds("other-biz")).toEqual(["bill-9"]);
  });
});
