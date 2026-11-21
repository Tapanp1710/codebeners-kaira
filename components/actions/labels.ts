/**
 * Display vocabulary for assistant proposals (`ProposalCard`).
 *
 * Maps the backend's machine codes (operation intents, operation field keys, computed keys, status and
 * confidence enums) to owner-facing English labels and badge tones. Pure data, no logic: the keys come
 * from the generated contract types in lib/api/types.ts, so a new intent added to the contract fails
 * type-checking here until it is given a label.
 */
import type { Intent } from "@/lib/api/types";

// Record<Intent, ...> (not Partial) forces every contract intent, including "unknown", to have a label.
export const INTENT_LABEL: Record<Intent, string> = {
  record_payment: "Record customer payment",
  record_sale: "Record cash sale",
  create_invoice: "Create invoice",
  create_expense: "Add expense / bill",
  create_customer: "Add customer",
  create_payment_commitment: "Record payment promise",
  query_receivables: "Question: receivables",
  query_customer_balance: "Question: customer balance",
  query_cash_position: "Question: cash position",
  request_payment_reminder: "Draft payment reminder",
  unknown: "Not understood",
};

// Labels for `OperationOut.fields` and `EvidenceOut.field`. Keyed by plain string because the field bag
// is untyped in the contract; unlisted keys fall back to humanize() at the call site.
// "Heard customer" signals this is the name as transcribed, not the resolved customer record.
export const FIELD_LABEL: Record<string, string> = {
  customer_name: "Heard customer",
  vendor_name: "Vendor",
  invoice_reference: "Invoice mentioned",
  amount: "Amount",
  amount_is_remaining: "Amount",
  date: "Date",
  due_date: "Due date",
  expected_payment_date: "Promised date",
  payment_method: "Payment method",
  description: "Description",
  category: "Category",
  paid_now: "Already paid",
  phone: "Phone",
  email: "Email",
  notes: "Notes",
};

// Labels for `OperationOut.computed`: values the backend derived from the ledger (not from the
// transcript), shown in a distinct colour on the card.
export const COMPUTED_LABEL: Record<string, string> = {
  invoice_outstanding_before: "Invoice balance before",
  invoice_outstanding_after: "Invoice balance after",
  remaining_amount: "Remaining amount promised",
  payment_date_defaulted: "Date used (not stated)",
  supersedes_existing_commitments: "Replaces earlier promises",
};

// Keys whose values are decimal money strings / ISO dates; displayValue() in proposal-card routes them
// through formatMoney / formatDate instead of printing the raw value.
export const MONEY_FIELDS = new Set(["amount", "invoice_outstanding_before", "invoice_outstanding_after", "remaining_amount"]);
export const DATE_FIELDS = new Set(["date", "due_date", "expected_payment_date", "payment_date_defaulted"]);

// Badge tones for ProposedActionOut.status and .confidence_level; `as const` keeps the literal tone
// types so they satisfy Badge's `tone` prop.
export const STATUS_TONE = { pending: "warn", executed: "good", rejected: "neutral", failed: "danger" } as const;
export const CONFIDENCE_TONE = { high: "good", medium: "warn", low: "danger" } as const;
