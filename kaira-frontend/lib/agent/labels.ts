/**
 * Plain-English activity labels for agent tools (shown in the activity feed while a tool runs).
 * Known tool names (backend app/services/agent/tools.py) are mapped explicitly; unknown ones get a label built from
 * their verb, so a new backend tool still reads sensibly.
 */
const LABELS: Record<string, string> = {
  record_customer_payment: "Recording payment",
  record_payment_and_promise: "Recording payment and promise",
  record_payment_promise: "Recording payment promise",
  record_missed_promise: "Noting missed promise",
  record_expense: "Recording expense",
  correct_payment_amount: "Correcting payment",
  get_customer: "Looking up customer",
  find_customer: "Looking up customer",
  find_customers: "Searching customers",
  customer_balance: "Checking customer balance",
  create_customer: "Adding customer",
  update_customer: "Updating customer",
  add_collection_note: "Adding collection note",
  create_invoice: "Creating invoice",
  update_invoice: "Updating invoice",
  invoice_status: "Checking invoice",
  list_invoices: "Checking invoices",
  list_payments: "Checking payments",
  list_promises: "Checking payment promises",
  list_bills: "Checking bills",
  receivables_overview: "Checking receivables",
  business_summary: "Summarising the business",
  cash_forecast: "Forecasting cash flow",
  simulate_late_payment: "Simulating a late payment",
  recent_activity: "Checking recent activity",
  pending_confirmations: "Checking pending confirmations",
  confirm_pending_action: "Confirming action",
  cancel_pending_action: "Cancelling action",
  draft_payment_reminder: "Drafting reminder",
  navigate: "Opening screen",
};

const VERBS: Record<string, string> = {
  get: "Looking up",
  find: "Finding",
  search: "Searching",
  list: "Checking",
  create: "Creating",
  add: "Adding",
  record: "Recording",
  update: "Updating",
  correct: "Correcting",
  delete: "Deleting",
  cancel: "Cancelling",
  confirm: "Confirming",
  draft: "Drafting",
  send: "Sending",
  check: "Checking",
  calculate: "Calculating",
  simulate: "Simulating",
  approve: "Approving",
};

/** Human label for a tool name, e.g. record_customer_payment -> "Recording payment". */
export function toolLabel(tool: string): string {
  const known = LABELS[tool];
  if (known) return known;
  const words = tool
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\s.-]+/)
    .filter(Boolean);
  if (words.length === 0) return "Working";
  const verb = VERBS[words[0]];
  if (verb) return words.length > 1 ? `${verb} ${words.slice(1).join(" ")}` : verb;
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
