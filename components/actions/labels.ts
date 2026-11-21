import type { Intent } from "@/lib/api/types";

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

export const COMPUTED_LABEL: Record<string, string> = {
  invoice_outstanding_before: "Invoice balance before",
  invoice_outstanding_after: "Invoice balance after",
  remaining_amount: "Remaining amount promised",
  payment_date_defaulted: "Date used (not stated)",
  supersedes_existing_commitments: "Replaces earlier promises",
};

export const MONEY_FIELDS = new Set(["amount", "invoice_outstanding_before", "invoice_outstanding_after", "remaining_amount"]);
export const DATE_FIELDS = new Set(["date", "due_date", "expected_payment_date", "payment_date_defaulted"]);

export const STATUS_TONE = { pending: "warn", executed: "good", rejected: "neutral", failed: "danger" } as const;
export const CONFIDENCE_TONE = { high: "good", medium: "warn", low: "danger" } as const;
