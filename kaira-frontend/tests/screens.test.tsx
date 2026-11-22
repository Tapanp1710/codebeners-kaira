/**
 * Screen-level tests for navigation, payment recording and invoice creation (the agent UI is covered in
 * tests/agent.test.tsx).
 * Everything is rendered with renderApp, so API calls go through the real client (CSRF, envelope
 * handling) to an in-test handler.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NAV } from "@/components/layout/app-shell";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { PaymentDialog } from "@/components/invoices/payment-form";
import type { Invoice } from "@/lib/api/types";

import { attemptServer } from "./attempt-server";
import { envelope } from "./fixtures";
import { pathOf, renderApp } from "./render";

// Stub App Router hooks; ?customer=cust-1 mimics arriving at the invoice form from a customer page.
vi.mock("next/navigation", () => ({
  usePathname: () => "/invoices/new",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("customer=cust-1"),
}));

// Partially paid invoice with 12,000.00 outstanding, used by the payment tests.
const invoice = {
  id: "inv-1",
  invoice_number: "INV-0001",
  customer_id: "cust-1",
  customer_name: "Ramesh Kumar",
  invoice_date: "2026-11-01",
  due_date: "2026-12-01",
  lifecycle_status: "issued",
  payment_status: "partially_paid",
  is_overdue: false,
  days_overdue: 0,
  total: "18000.00",
  paid: "6000.00",
  outstanding: "12000.00",
  notes: null,
  created_at: "2026-11-01T00:00:00Z",
  items: [],
} as Invoice;

describe("navigation", () => {
  // Voice-first information architecture: the KAIRA agent home first, then the manual modules.
  it("lists KAIRA first, then the manual modules, approvals and settings", () => {
    expect(NAV.map((n) => n.label)).toEqual([
      "KAIRA",
      "Dashboard",
      "Customers & Invoices",
      "Receivables",
      "Cash-Flow Forecast",
      "What-If Analysis",
      "Approvals",
      "Settings",
    ]);
    expect(NAV.map((n) => n.href)).toEqual(["/agent", "/dashboard", "/customers", "/receivables", "/cashflow", "/scenarios", "/actions", "/settings"]);
  });
});

describe("PaymentDialog", () => {
  // Overpayment is caught client-side: no request is sent at all.
  it("blocks amounts above the outstanding balance before calling the API", async () => {
    const { requests } = renderApp(<PaymentDialog invoice={invoice} open onClose={() => {}} />);
    // One paisa over the outstanding balance: the comparison has to be exact, not float-rounded.
    await userEvent.type(screen.getByLabelText("Amount (₹)"), "12000.01");
    await userEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(await screen.findByText(/Cannot exceed the outstanding ₹12,000.00/)).toBeInTheDocument();
    // Only the read of pending attempts happens; no payment is registered or executed.
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  // The payment is registered (with a key) before it is executed; the confirmed balance shown is the backend's.
  it("records a partial payment through a registered attempt and shows the confirmed balance", async () => {
    const backend = attemptServer({ kind: "invoice", targets: { "inv-1": { amount: "12000.00", label: "INV-0001" } } });
    const { requests } = renderApp(<PaymentDialog invoice={invoice} open onClose={() => {}} />, { handler: backend.handler });
    await userEvent.type(screen.getByLabelText("Amount (₹)"), "5000");
    await userEvent.selectOptions(screen.getByLabelText("Method"), "upi");
    await userEvent.click(screen.getByRole("button", { name: "Record payment" }));
    expect(await screen.findByTestId("payment-confirmed")).toHaveTextContent("₹7,000.00");
    const register = requests.find((r) => pathOf(r) === "POST /payment-attempts")!;
    const body = await register.json();
    expect(body.idempotency_key).toMatch(/.{8,}/);
    expect(body).toMatchObject({ resource_type: "invoice", resource_id: "inv-1", amount: "5000", payment_method: "upi" });
    expect(backend.state.payments.size).toBe(1);
  });
});

describe("InvoiceForm", () => {
  // The estimate uses exact decimals (3 x 1250.50 + 0.10 = 3,751.60) and amounts are posted as strings, as the contract requires.
  it("shows a running estimate with exact decimals and posts the contract body", async () => {
    const { requests } = renderApp(<InvoiceForm />, {
      handler: (req) => {
        if (pathOf(req).startsWith("GET /customers")) {
          return envelope({ items: [{ id: "cust-1", name: "Ramesh Kumar" }], total: 1, page: 1, page_size: 200 });
        }
        if (pathOf(req) === "POST /invoices") return envelope({ ...invoice, id: "inv-9", invoice_number: "INV-0009" }, 201);
        return envelope({});
      },
    });
    // Wait for the customer list to load: options arrive asynchronously and selectOptions needs them present.
    await screen.findByRole("option", { name: "Ramesh Kumar" });
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "cust-1");
    await userEvent.type(screen.getByLabelText("Item 1 description"), "Rice bags");
    const qty = screen.getByLabelText("Quantity");
    await userEvent.clear(qty);
    await userEvent.type(qty, "3");
    await userEvent.type(screen.getByLabelText("Unit price (₹)"), "1250.50");
    await userEvent.click(screen.getByRole("button", { name: /add item/i }));
    await userEvent.type(screen.getByLabelText("Item 2 description"), "Dal");
    await userEvent.type(screen.getAllByLabelText("Unit price (₹)")[1], "0.10");
    expect(screen.getByTestId("invoice-estimate")).toHaveTextContent("₹3,751.60");
    await userEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() => expect(requests.some((r) => pathOf(r) === "POST /invoices")).toBe(true));
    const body = await requests.find((r) => pathOf(r) === "POST /invoices")!.json();
    expect(body).toMatchObject({
      customer_id: "cust-1",
      items: [
        { description: "Rice bags", quantity: "3", unit_price: "1250.50" },
        { description: "Dal", quantity: "1", unit_price: "0.10" },
      ],
    });
  });

  // Server-side line-item validation errors land on the right line and are also listed with the server message.
  it("shows the backend's line-item validation errors on the affected line and in the summary", async () => {
    renderApp(<InvoiceForm />, {
      handler: (req) => {
        if (pathOf(req).startsWith("GET /customers")) return envelope({ items: [{ id: "cust-1", name: "Ramesh Kumar" }], total: 1, page: 1, page_size: 200 });
        if (pathOf(req) === "POST /invoices") {
          return new Response(
            JSON.stringify({
              success: false,
              data: null,
              error: {
                code: "VALIDATION_ERROR",
                message: "The supplied data is invalid.",
                details: {
                  errors: [
                    { loc: ["body", "items", 0, "description"], msg: "String should have at most 500 characters", type: "string_too_long" },
                    { loc: ["body", "items", 1, "quantity"], msg: "Input should be greater than 0", type: "greater_than" },
                    { loc: ["body", "items", 1, "unit_price"], msg: "Value error, at most 2 decimal places", type: "value_error" },
                    { loc: ["body", "items"], msg: "List should have at most 100 items", type: "too_long" },
                  ],
                },
              },
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        }
        return envelope({});
      },
    });
    await screen.findByRole("option", { name: "Ramesh Kumar" });
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "cust-1");
    await userEvent.type(screen.getByLabelText("Item 1 description"), "Rice bags");
    await userEvent.type(screen.getByLabelText("Unit price (₹)"), "100");
    await userEvent.click(screen.getByRole("button", { name: /add item/i }));
    await userEvent.type(screen.getByLabelText("Item 2 description"), "Dal");
    await userEvent.type(screen.getAllByLabelText("Unit price (₹)")[1], "10");
    await userEvent.click(screen.getByRole("button", { name: "Create invoice" }));

    const lines = await screen.findAllByTestId("invoice-item");
    // Inline, on the right line and field.
    expect(await within(lines[0]).findByText("String should have at most 500 characters")).toBeInTheDocument();
    expect(within(lines[1]).getByText("Input should be greater than 0")).toBeInTheDocument();
    expect(within(lines[1]).getByText("at most 2 decimal places")).toBeInTheDocument();
    expect(within(lines[0]).queryByText("Input should be greater than 0")).not.toBeInTheDocument();
    // Summary: the server's own message plus every error, including the one with no input to attach to.
    const summary = screen.getByText(/The supplied data is invalid./);
    expect(summary).toHaveTextContent("Item 1 – Description: String should have at most 500 characters");
    expect(summary).toHaveTextContent("Item 2 – Quantity: Input should be greater than 0");
    expect(summary).toHaveTextContent("Item 2 – Unit price: at most 2 decimal places");
    expect(summary).toHaveTextContent("Items: List should have at most 100 items");
  });

  // Client-side validation blocks submission of an incomplete form.
  it("validates required fields before submitting", async () => {
    const { requests } = renderApp(<InvoiceForm />, { handler: () => envelope({ items: [], total: 0, page: 1, page_size: 200 }) });
    // The mocked ?customer=cust-1 query preselects a customer, so the selection is cleared explicitly.
    await userEvent.selectOptions(screen.getByLabelText("Customer"), "");
    await userEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    expect(await screen.findByText("Choose a customer", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Describe the item")).toBeInTheDocument();
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });
});
