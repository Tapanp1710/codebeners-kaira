/**
 * Shared test data shaped like real backend payloads (types from lib/api/types, which follow the
 * OpenAPI contract), so component tests exercise the same shapes the UI receives in production.
 */
import type { ProposedAction, Session } from "@/lib/api/types";

// Owner session: the role allowed to approve/reject proposals. Tests expect "csrf-test" on unsafe requests.
export const ownerSession = {
  user: { id: "u1", business_id: "b1", name: "Demo Owner", email: "demo@kaira.local", role: "owner", is_active: true },
  business: {
    id: "b1",
    name: "KAIRA Demo Traders",
    business_type: null,
    currency: "INR",
    timezone: "Asia/Kolkata",
    opening_cash_balance: "85000.00",
    opening_cash_as_of: "2026-09-22",
    overdue_collection_delay_days: 30,
    low_cash_threshold: "10000.00",
    created_at: "2026-11-21T00:00:00Z",
    updated_at: "2026-11-21T00:00:00Z",
  },
  csrf_token: "csrf-test",
  access_token_expires_at: "2026-11-21T12:00:00Z",
} as Session;

// Same session with role "staff", used to check that owner-only controls are hidden.
export const staffSession = { ...ownerSession, user: { ...ownerSession.user, role: "staff" } } as Session;

/** Shape returned by the real backend for the demo phrase (captured from the API contract). */
export function demoProposal(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    id: "a1",
    conversation_id: "c1",
    action_type: "compound",
    status: "pending",
    source_transcript: "Ramesh paid me 5,000 rupees today. He will clear the remaining amount next Monday.",
    language: "en-IN",
    provider: "rules",
    confidence_level: "high",
    operations: [
      // Two operations from one sentence: the payment, then a promise for the remainder computed by the backend.
      {
        index: 0,
        type: "record_payment",
        fields: { customer_name: "Ramesh", amount: "5000.00", date: "2026-11-21" },
        customer: { status: "resolved", id: "cust-1", label: "Ramesh Kumar", candidates: [{ id: "cust-1", label: "Ramesh Kumar", score: 0.92, outstanding: "12000.00" }] },
        invoice: { status: "resolved", id: "inv-1", label: "INV-0001", candidates: [{ id: "inv-1", label: "INV-0001 (due 2026-12-01)", score: 1, outstanding: "12000.00" }] },
        missing_fields: [],
        computed: { invoice_outstanding_before: "12000.00", invoice_outstanding_after: "7000.00" },
      },
      {
        index: 1,
        type: "create_payment_commitment",
        fields: { customer_name: "Ramesh", amount_is_remaining: true, expected_payment_date: "2026-11-23" },
        customer: { status: "resolved", id: "cust-1", label: "Ramesh Kumar", candidates: [] },
        invoice: { status: "resolved", id: "inv-1", label: "INV-0001", candidates: [] },
        missing_fields: [],
        computed: { remaining_amount: "7000.00", supersedes_existing_commitments: true },
      },
    ],
    // Each extracted field linked to the transcript fragment it came from, as displayed on the proposal card.
    evidence: [
      { field: "customer_name", fragment: "Ramesh", verified: true, operation_index: 0 },
      { field: "amount", fragment: "5,000", verified: true, operation_index: 0 },
      { field: "expected_payment_date", fragment: "next Monday", verified: true, operation_index: 1 },
    ],
    warnings: [],
    can_approve: true,
    result: null,
    approved_by: null,
    approved_at: null,
    rejected_at: null,
    executed_at: null,
    created_at: "2026-11-21T10:00:00Z",
    updated_at: "2026-11-21T10:00:00Z",
    // Tests override individual fields (status, warnings, can_approve, ...) to reach other card states.
    ...overrides,
  } as ProposedAction;
}

// Response builders for mocked transport handlers (success and error envelope forms).
export const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data, error: null }), { status, headers: { "content-type": "application/json" } });
export const errorEnvelope = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ success: false, data: null, error: { code, message, details: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
