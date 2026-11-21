/**
 * Component tests for the voice orb, the payment status badge and the proposal (approval) card.
 * The proposal card is the safety gate between AI extraction and the books: these tests pin that
 * nothing is recorded until the owner approves and the backend confirms.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProposalCard } from "@/components/actions/proposal-card";
import { PaymentStatusBadge } from "@/components/ui/finance";
import { VoiceOrb, type OrbState } from "@/components/voice/voice-orb";

import { demoProposal, envelope, errorEnvelope, staffSession } from "./fixtures";
import { pathOf, renderApp } from "./render";

// Components use Next's router hooks; there is no App Router in jsdom, so they are stubbed.
vi.mock("next/navigation", () => ({
  usePathname: () => "/customers",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The orb drives recording, so its state must be exposed to assistive tech (status text, aria-pressed, accessible name).
describe("VoiceOrb", () => {
  it.each<[OrbState, string]>([
    ["idle", "Tap to speak"],
    ["listening", "Listening… tap to stop"],
    ["processing", "Working on it…"],
    ["ready", "Ready"],
    ["speaking", "Speaking…"],
    ["error", "Something went wrong"],
  ])("renders the %s state", (state, label) => {
    render(<VoiceOrb state={state} onPress={() => {}} seconds={4} />);
    const button = screen.getByTestId("voice-orb");
    expect(button).toHaveAttribute("data-state", state);
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(button).toHaveAccessibleName(state === "listening" ? "Stop recording" : "Start recording");
    expect(button).toHaveAttribute("aria-pressed", String(state === "listening"));
  });

  // No auto-recording: the microphone is used only after an explicit press.
  it("only records on an explicit press", async () => {
    const onPress = vi.fn();
    render(<VoiceOrb state="idle" onPress={onPress} />);
    expect(onPress).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("voice-orb"));
    expect(onPress).toHaveBeenCalledOnce();
  });
});

// Partial payment and overdue state must both be visible at once.
describe("PaymentStatusBadge", () => {
  it("shows status and overdue days", () => {
    render(<PaymentStatusBadge status="partially_paid" overdue daysOverdue={20} />);
    expect(screen.getByText("Partially paid")).toBeInTheDocument();
    expect(screen.getByText("Overdue · 20d")).toBeInTheDocument();
  });
});

// ProposalCard: everything the owner needs to decide is shown, and only the backend's answer decides the outcome.
describe("ProposalCard", () => {
  // Renders the demo proposal from fixture data: intents, resolved customer/invoice, amounts, computed balances, promised date, evidence, confidence.
  it("presents the demo proposal: intent, customer, invoice, amounts, promise, evidence, confidence", () => {
    renderApp(<ProposalCard action={demoProposal()} />);
    expect(screen.getByTestId("proposal-transcript")).toHaveTextContent("Ramesh paid me 5,000 rupees today");
    const ops = screen.getAllByTestId("proposal-operation");
    expect(within(ops[0]).getByTestId("operation-intent")).toHaveTextContent("Record customer payment");
    expect(within(ops[0]).getByTestId("resolution-customer")).toHaveTextContent("Ramesh Kumar");
    expect(within(ops[0]).getByTestId("resolution-invoice")).toHaveTextContent("INV-0001");
    expect(within(ops[0]).getByText("₹5,000.00")).toBeInTheDocument();
    expect(within(ops[0]).getByTestId("computed-invoice_outstanding_after")).toHaveTextContent("₹7,000.00");
    expect(within(ops[1]).getByTestId("operation-intent")).toHaveTextContent("Record payment promise");
    expect(within(ops[1]).getByTestId("computed-remaining_amount")).toHaveTextContent("₹7,000.00");
    expect(within(ops[1]).getByText("23 Nov 2026")).toBeInTheDocument();
    expect(screen.getByText("Confidence: high")).toBeInTheDocument();
    expect(within(ops[1]).getByText(/“next Monday”/)).toBeInTheDocument();
  });

  // No optimistic success: while approve is pending the button is disabled (no double submit) and the result appears only after the backend resolves. Approve is a CSRF-protected POST.
  it("shows success only after the backend confirms execution, and refreshes data", async () => {
    // The approve response is a promise resolved by hand, so the in-flight state can be asserted
    // deterministically before the backend "answers"; every other call gets an empty list envelope.
    let resolveApprove!: (r: Response) => void;
    const { requests } = renderApp(<ProposalCard action={demoProposal()} />, {
      handler: (req) => {
        if (pathOf(req) === "POST /actions/a1/approve") return new Promise<Response>((r) => (resolveApprove = r));
        return envelope({ items: [], total: 0, page: 1, page_size: 20 });
      },
    });
    const approve = screen.getByRole("button", { name: /approve/i });
    await userEvent.click(approve);
    await userEvent.click(approve); // double click must not send twice
    expect(screen.queryByTestId("proposal-result")).not.toBeInTheDocument();
    expect(approve).toBeDisabled();
    resolveApprove(
      envelope({
        replayed: false,
        action: demoProposal({
          status: "executed",
          executed_at: "2026-11-21T10:01:00Z",
          result: { operations: [{ summary: "Recorded payment of 5000.00 on INV-0001" }, { summary: "Expecting 7000.00 on 2026-11-23" }] },
        }),
      }),
    );
    expect(await screen.findByTestId("proposal-result")).toHaveTextContent("Recorded payment of 5000.00 on INV-0001");
    expect(requests.filter((r) => pathOf(r) === "POST /actions/a1/approve")).toHaveLength(1);
    expect(requests.find((r) => pathOf(r) === "POST /actions/a1/approve")!.headers.get("x-csrf-token")).toBe("csrf-test");
  });

  // A failed approval keeps the card pending and shows the backend's message.
  it("shows the backend error and stays pending when approval fails", async () => {
    renderApp(<ProposalCard action={demoProposal()} />, {
      handler: (req) =>
        pathOf(req).endsWith("/approve")
          ? errorEnvelope(422, "ACTION_NOT_EXECUTABLE", "This action cannot be approved yet.")
          : envelope({ items: [], total: 0, page: 1, page_size: 20 }),
    });
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This action cannot be approved yet.");
    expect(screen.getByTestId("proposal-card")).toHaveAttribute("data-status", "pending");
  });

  // Reject only calls the reject endpoint; no financial write (e.g. POST /invoices) is made.
  it("rejects without touching financial data", async () => {
    const { requests } = renderApp(<ProposalCard action={demoProposal()} />, {
      handler: (req) =>
        pathOf(req).endsWith("/reject")
          ? envelope({ replayed: false, action: demoProposal({ status: "rejected", rejected_at: "2026-11-21T10:02:00Z" }) })
          : envelope({ items: [], total: 0, page: 1, page_size: 20 }),
    });
    await userEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(await screen.findByTestId("proposal-rejected")).toHaveTextContent("No records were changed");
    expect(requests.map(pathOf)).not.toContain("POST /invoices");
  });

  // can_approve=false from the backend disables Approve and the reason is displayed.
  it("disables approval while blocking issues remain and explains why", () => {
    // The warning in this fixture is non-blocking; the disabled button comes only from can_approve=false,
    // so the card must follow the backend's flag rather than re-deriving it from the warnings.
    renderApp(
      <ProposalCard
        action={demoProposal({
          can_approve: false,
          confidence_level: "low",
          warnings: [{ code: "AMBIGUOUS_CUSTOMER", message: "Several customers match 'Ramesh'. Choose one.", operation_index: 0, blocking: false }],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
    expect(screen.getByText(/Several customers match/)).toBeInTheDocument();
    expect(screen.getByText(/Approval is disabled/)).toBeInTheDocument();
  });

  // Owner-only controls are hidden from staff; the backend enforces the same rule (403 FORBIDDEN) regardless.
  it("hides approve/reject from staff (backend still enforces)", () => {
    renderApp(<ProposalCard action={demoProposal()} />, { session: staffSession });
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the business owner can approve/)).toBeInTheDocument();
  });

  // Edits send the complete operation list (with resolved ids), not a diff; the backend then flags the action as edited.
  it("edits the amount and sends the full operation list to PATCH /actions/{id}", async () => {
    const { requests } = renderApp(<ProposalCard action={demoProposal()} />, {
      handler: (req) => (req.method === "PATCH" ? envelope(demoProposal({ warnings: [{ code: "EDITED_BY_OWNER", message: "Values were edited by the owner after extraction.", operation_index: null, blocking: false }] })) : envelope({ items: [], total: 0, page: 1, page_size: 200 })),
    });
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    // Each operation has its own Amount field: index 0 is the payment, index 1 the promise.
    const amounts = screen.getAllByLabelText("Amount (₹)");
    await userEvent.clear(amounts[0]);
    await userEvent.type(amounts[0], "4500");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await screen.findByText(/edited by the owner/);
    const patch = requests.find((r) => r.method === "PATCH")!;
    const body = await patch.json();
    expect(body.operations).toHaveLength(2);
    expect(body.operations[0]).toMatchObject({ type: "record_payment", amount: "4500", customer_id: "cust-1", invoice_id: "inv-1" });
    expect(body.operations[1]).toMatchObject({ type: "create_payment_commitment", amount_is_remaining: true, expected_payment_date: "2026-11-23" });
  });
});
