/**
 * Pure-function tests for money, dates and navigation helpers. Money is handled as decimal strings,
 * never JS floats, because the backend sends amounts as strings and the UI must match it exactly.
 */
import { describe, expect, it } from "vitest";

import { safeNext } from "@/components/auth/login-form";
import { validatePaymentAmount } from "@/components/invoices/payment-form";
import { insightHref } from "@/components/layout/app-shell";
import { addDays, formatDate } from "@/lib/format/dates";
import { compareMoney, estimateLine, formatMoney, isValidAmount, sumMoney } from "@/lib/format/money";

// Indian digit grouping (lakh/crore) and exact decimal arithmetic.
describe("money (exact, no floats)", () => {
  it("formats with Indian grouping", () => {
    expect(formatMoney("150000.00")).toBe("₹1,50,000.00");
    expect(formatMoney("229500")).toBe("₹2,29,500.00");
    expect(formatMoney("12345678.9")).toBe("₹1,23,45,678.90");
    expect(formatMoney("-60000.00")).toBe("-₹60,000.00");
    expect(formatMoney("999.5")).toBe("₹999.50");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney("100", { signed: true })).toBe("+₹100.00");
  });
  // Cases where binary floats go wrong (0.1 + 0.2, values near 2^53) must stay exact; estimateLine rounds half-up to 2 places.
  it("does not lose precision where floats would", () => {
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
    expect(formatMoney("90071992547409.99")).toBe("₹9,00,71,99,25,47,409.99");
    expect(estimateLine("3", "1250.50")).toBe("3751.50");
    expect(estimateLine("2.5", "100")).toBe("250.00");
    expect(estimateLine("1.333", "0.03")).toBe("0.04"); // 0.03999 -> half-up
  });
  // isValidAmount accepts only positive amounts with at most 2 decimal places.
  it("compares and validates amounts", () => {
    expect(compareMoney("1000.01", "1000")).toBe(1);
    expect(compareMoney("999.99", "1000.00")).toBe(-1);
    expect(compareMoney("5000", "5000.00")).toBe(0);
    expect(isValidAmount("5000")).toBe(true);
    expect(isValidAmount("0")).toBe(false);
    expect(isValidAmount("10.123")).toBe(false);
    expect(isValidAmount("-5")).toBe(false);
  });
});

// Client-side overpayment pre-check gives immediate feedback; the backend still enforces the rule (OVERPAYMENT).
describe("payment amount pre-check", () => {
  it("blocks amounts above the outstanding balance", () => {
    expect(validatePaymentAmount("12000.01", "12000.00")).toMatch(/Cannot exceed/);
    expect(validatePaymentAmount("12000", "12000.00")).toBeNull();
    expect(validatePaymentAmount("", "1")).toBe("Enter an amount");
    expect(validatePaymentAmount("1.234", "10")).toMatch(/2 decimal/);
  });
});

describe("dates", () => {
  // Date-only ISO strings are treated as calendar dates, so formatting and day arithmetic never shift by a timezone offset.
  it("formats ISO dates without timezone shifts", () => {
    expect(formatDate("2026-11-23")).toBe("23 Nov 2026");
    expect(addDays("2026-12-25", 10)).toBe("2027-01-04");
  });
});

// Open-redirect protection: ?next= after login may only be an app path - not protocol-relative, absolute, backslash tricks or API URLs.
describe("navigation safety", () => {
  it("only allows same-origin relative redirects after login", () => {
    expect(safeNext("/customers/1")).toBe("/customers/1");
    expect(safeNext("//evil.example")).toBe("/agent");
    expect(safeNext("https://evil.example")).toBe("/agent");
    expect(safeNext("/\\evil.example")).toBe("/agent");
    expect(safeNext("/api/backend/api/v1/auth/logout")).toBe("/agent");
    expect(safeNext(null)).toBe("/agent");
  });
  // Insight links are built from backend-provided types and ids only.
  it("routes insights to the related screen using backend ids only", () => {
    expect(insightHref({ type: "overdue_receivables", related: { customer_id: "c1" } })).toBe("/customers/c1");
    expect(insightHref({ type: "cash_shortfall", related: {} })).toBe("/cashflow");
    expect(insightHref({ type: "bills_due", related: {} })).toBe("/cashflow#bills");
  });
});
