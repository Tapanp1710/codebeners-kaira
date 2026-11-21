/**
 * Pending-payment visibility (components/payments/pending-payments.tsx): driven by the server registry,
 * so it shows attempts started on any device and for records on any page of a list.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PendingPaymentsAlert } from "@/components/payments/pending-payments";

import { attemptServer } from "./attempt-server";
import { renderApp } from "./render";

describe("PendingPaymentsAlert", () => {
  it("lists every server-side pending payment with a link to resolve it", async () => {
    const inv = attemptServer({ kind: "invoice", targets: { "inv-7": { amount: "900.00", label: "INV-0007" } }, executeFailures: ["network-before"] });
    // Register (pending) through the stand-in, as another device would.
    await inv.handler(new Request("http://localhost/api/backend/api/v1/payment-attempts", { method: "POST", body: JSON.stringify({ resource_type: "invoice", resource_id: "inv-7", idempotency_key: "device-a-key", amount: "450.00", payment_method: "upi" }) }));
    renderApp(<PendingPaymentsAlert />, { handler: inv.handler });
    expect(await screen.findByText("1 payment awaiting confirmation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invoice INV-0007" })).toHaveAttribute("href", "/invoices/inv-7");
    expect(screen.getByText("₹450.00")).toBeInTheDocument();
  });

  it("renders nothing when no payment is pending", async () => {
    const inv = attemptServer({ kind: "invoice", targets: { "inv-7": { amount: "900.00", label: "INV-0007" } } });
    const { container } = renderApp(<PendingPaymentsAlert />, { handler: inv.handler });
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).not.toMatch(/awaiting confirmation/);
  });
});
