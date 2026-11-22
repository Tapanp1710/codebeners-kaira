"use client";

/**
 * ProposalCard: the human-in-the-loop review surface for assistant proposals.
 *
 * The assistant (`POST /assistant/extract`) never writes to the books. It returns a ProposedAction with
 * status `pending`; this card shows what was understood (transcript, intent, customer/invoice resolution,
 * fields, backend-computed values, transcript evidence, warnings, confidence) and lets the owner:
 *   - Edit    -> `PATCH /actions/{id}` with the FULL rebuilt operation list (useEditAction)
 *   - Reject  -> `POST /actions/{id}/reject` (useRejectAction)
 *   - Approve -> `POST /actions/{id}/approve` (useApproveAction), which executes the operations server-side
 *
 * Used by app/(app)/actions/page.tsx (proposal list): proposals waiting for confirmation or for the owner
 * (staff requests, operations the voice agent read back). All validation of approvability is the backend's: the card only
 * mirrors `can_approve`, `warnings[].blocking` and `missing_fields` from the response.
 */
import { AlertTriangle, Check, CheckCircle2, Pencil, Quote, X, XCircle } from "lucide-react";
import { useState } from "react";

import { useSession, useToast } from "@/components/providers";
import { PAYMENT_METHOD_LABEL } from "@/components/ui/finance";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Button, cn } from "@/components/ui/primitives";
import { describeError } from "@/lib/api/errors";
import { useApproveAction, useCustomers, useEditAction, useInvoices, useRejectAction } from "@/lib/api/hooks";
import type { Operation, OperationOut, ProposedAction, Schemas } from "@/lib/api/types";
import { formatDate, formatDateTime, humanize } from "@/lib/format/dates";
import { formatMoney, isValidAmount } from "@/lib/format/money";

import {
  COMPUTED_LABEL,
  CONFIDENCE_TONE,
  DATE_FIELDS,
  FIELD_LABEL,
  INTENT_LABEL,
  MONEY_FIELDS,
  STATUS_TONE,
} from "./labels";

type Resolution = Schemas["ResolutionOut"];

/**
 * Formats one operation field / computed value for read-only display. Money keys stay decimal strings
 * and go through the exact BigInt formatter; date keys are formatted as calendar dates without Date
 * parsing (no timezone shift). Empty values render as an em dash.
 */
function displayValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  // amount_is_remaining=true means the speaker said "the rest/balance" rather than a figure; the actual
  // number then appears under computed.remaining_amount.
  if (key === "amount_is_remaining") return value ? "The remaining balance" : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (MONEY_FIELDS.has(key)) return formatMoney(String(value));
  if (DATE_FIELDS.has(key)) return formatDate(String(value));
  if (key === "payment_method") return PAYMENT_METHOD_LABEL[String(value)] ?? String(value);
  if (Array.isArray(value)) return `${value.length} item(s)`;
  return String(value);
}

/**
 * One row showing how the backend matched a spoken customer/invoice to a ledger record.
 * Status values come from ResolutionOut: `resolved` (single match), `new` (record will be created on
 * approval), `ambiguous` (several candidates, owner must pick via Edit) or `not_found`.
 * `not_applicable` (the intent has no such entity) renders nothing.
 */
function ResolutionLine({ title, res, testId }: { title: string; res: Resolution; testId: string }) {
  if (res.status === "not_applicable") return null;
  const tone = res.status === "resolved" ? "good" : res.status === "new" ? "info" : res.status === "ambiguous" ? "warn" : "danger";
  const text =
    res.status === "resolved"
      ? res.label
      : res.status === "new"
        ? `${res.label ?? ""} (new - created on approval)`
        : res.status === "ambiguous"
          ? "Needs your choice"
          : "Not found";
  return (
    <div data-testid={testId} className="flex flex-wrap items-baseline gap-2">
      <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{title}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{text}</span>
        <Badge tone={tone}>{humanize(res.status)}</Badge>
        {res.status === "ambiguous" && res.candidates.length > 0 && (
          <span className="w-full text-xs text-muted">
            Candidates: {res.candidates.map((c) => `${c.label}${c.outstanding ? ` (owes ${formatMoney(c.outstanding)})` : ""}`).join(" · ")}
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * Read-only view of a single operation inside a proposal (a proposal can carry several).
 * `evidence` is pre-filtered by the caller to this operation's index.
 */
function OperationView({ op, evidence }: { op: OperationOut; evidence: Schemas["EvidenceOut"][] }) {
  // Raw ids are hidden (the ResolutionLines show the matched labels instead); `items` is an array of
  // invoice lines that is not itemised here.
  const fieldEntries = Object.entries(op.fields).filter(([k]) => !["items", "customer_id", "invoice_id"].includes(k));
  const computed = Object.entries(op.computed ?? {});
  // Evidence rows quote the transcript fragment the model claimed for each field. `verified: false`
  // means the backend could not find that fragment in the transcript and ignored the value, which is
  // surfaced to the owner rather than hidden.
  return (
    <div className="rounded-xl bg-white/60 p-4 ring-1 ring-line" data-testid="proposal-operation">
      <p className="font-display text-base font-semibold" data-testid="operation-intent">{INTENT_LABEL[op.type]}</p>
      <dl className="mt-3 space-y-2">
        <ResolutionLine title="Customer" res={op.customer} testId="resolution-customer" />
        <ResolutionLine title="Invoice" res={op.invoice} testId="resolution-invoice" />
        {fieldEntries.map(([key, value]) => (
          <div key={key} className="flex flex-wrap items-baseline gap-2">
            <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{FIELD_LABEL[key] ?? humanize(key)}</dt>
            <dd className="num text-sm font-semibold">{displayValue(key, value)}</dd>
          </div>
        ))}
        {computed.map(([key, value]) => (
          <div key={key} className="flex flex-wrap items-baseline gap-2">
            <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-steel">{COMPUTED_LABEL[key] ?? humanize(key)}</dt>
            <dd className="num text-sm font-semibold text-steel-strong" data-testid={`computed-${key}`}>{displayValue(key, value)}</dd>
          </div>
        ))}
      </dl>
      {op.missing_fields.length > 0 && (
        <p className="mt-3 text-sm font-semibold text-danger">Missing: {op.missing_fields.map(humanize).join(", ")}</p>
      )}
      {evidence.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-3" aria-label="Evidence from what you said">
          {evidence.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-muted">
              <Quote className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-semibold text-ink">{FIELD_LABEL[e.field] ?? humanize(e.field)}:</span> “{e.fragment}”{" "}
                {e.verified ? (
                  <span className="text-good">found in transcript</span>
                ) : (
                  <span className="text-danger">not in transcript - ignored</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editing
// Editable subset of an operation, held as strings so it binds directly to inputs. Money stays a
// decimal string and dates stay YYYY-MM-DD; an empty string means "not set" and is dropped by toOperation.
type Draft = {
  customer_id: string;
  invoice_id: string;
  amount: string;
  date: string;
  expected_payment_date: string;
  due_date: string;
  payment_method: string;
  description: string;
};

/** Seeds an edit draft from the presented operation, taking ids from the backend's resolutions. */
function toDraft(op: OperationOut): Draft {
  const f = op.fields as Record<string, unknown>;
  return {
    customer_id: op.customer.id ?? "",
    invoice_id: op.invoice.id ?? "",
    // When no explicit amount was spoken ("pay the rest"), pre-fill with the backend-computed remaining amount.
    amount: f.amount ? String(f.amount) : op.computed?.remaining_amount ? String(op.computed.remaining_amount) : "",
    date: (f.date as string) ?? "",
    expected_payment_date: (f.expected_payment_date as string) ?? "",
    due_date: (f.due_date as string) ?? "",
    payment_method: (f.payment_method as string) ?? "",
    description: (f.description as string) ?? "",
  };
}

/** Rebuilds a contract Operation from the presented operation plus the owner's edits. */
export function toOperation(op: OperationOut, draft: Draft): Operation {
  // Start from the original field bag so fields the editor does not expose (items, category, vendor_name,
  // phone, ...) survive the PATCH unchanged.
  const base = { ...(op.fields as Record<string, unknown>), type: op.type } as Record<string, unknown>;
  // An emptied input removes the key rather than sending "", so the backend sees the field as absent.
  const set = (k: string, v: string) => {
    if (v) base[k] = v;
    else delete base[k];
  };
  set("customer_id", draft.customer_id);
  set("invoice_id", draft.invoice_id);
  // Amount rules: an amount different from computed.remaining_amount is sent as an explicit figure and
  // clears amount_is_remaining; an emptied amount is removed; an amount equal to remaining_amount leaves
  // the original fields untouched, so a "pay the remaining balance" proposal keeps that meaning instead of
  // freezing today's figure.
  if (draft.amount && draft.amount !== String(op.computed?.remaining_amount ?? "")) {
    base.amount = draft.amount;
    base.amount_is_remaining = false;
  } else if (!draft.amount) delete base.amount;
  set("date", draft.date);
  set("expected_payment_date", draft.expected_payment_date);
  set("due_date", draft.due_date);
  set("payment_method", draft.payment_method);
  set("description", draft.description);
  return base as Operation;
}

/**
 * Inline editor for one operation. Which inputs appear depends on the intent (op.type); the draft is
 * lifted to ProposalCard so all operations are saved together.
 */
function EditOperation({ op, draft, onChange }: { op: OperationOut; draft: Draft; onChange: (d: Draft) => void }) {
  const f = op.fields as Record<string, unknown>;
  const has = (k: string) => k in f || ["record_payment", "create_payment_commitment"].includes(op.type);
  const update = (k: keyof Draft) => (e: { target: { value: string } }) => onChange({ ...draft, [k]: e.target.value });
  // GET /customers (first 200) supplies the full choice list; customers beyond 200 are not selectable here.
  const allCustomers = useCustomers({ page_size: 200 });
  // Open invoices of the chosen customer (GET /invoices?customer_id&status=open) are only fetched for
  // payment/commitment intents and only once a customer is chosen (the hook's `enabled` flag).
  const needsInvoice = op.type === "record_payment" || op.type === "create_payment_commitment";
  const openInvoices = useInvoices({ customer_id: draft.customer_id, status: "open", page_size: 200 }, needsInvoice && !!draft.customer_id);
  // The backend's match candidates are listed first, then every other customer, de-duplicated by id.
  const customerOptions = [
    ...op.customer.candidates.map((c) => ({ id: c.id, label: c.label })),
    ...(allCustomers.data?.items ?? [])
      .filter((c) => !op.customer.candidates.some((x) => x.id === c.id))
      .map((c) => ({ id: c.id, label: c.name })),
  ];
  // Until the open-invoice query returns, fall back to the invoice candidates from the proposal.
  const invoiceOptions =
    draft.customer_id && openInvoices.data
      ? openInvoices.data.items.map((i) => ({ id: i.id, label: `${i.invoice_number} (due ${formatDate(i.due_date)})`, outstanding: i.outstanding }))
      : op.invoice.candidates;
  // Field visibility by intent: the customer picker is hidden for `new` customers (created on approval);
  // changing customer clears the invoice choice. For commitments an empty invoice means "whole customer
  // balance". The amount input is validated client-side with isValidAmount (positive, <= 2 decimals) for
  // feedback only; the backend re-validates on PATCH.
  return (
    <div className="grid gap-3 rounded-xl bg-white/60 p-4 ring-1 ring-line sm:grid-cols-2">
      <p className="font-display font-semibold sm:col-span-2">{INTENT_LABEL[op.type]}</p>
      {op.customer.status !== "not_applicable" && op.customer.status !== "new" && (
        <Field label="Customer" hint={customerOptions.length === 0 ? "No matching customers were found." : undefined}>
          {(id) => (
            <Select id={id} value={draft.customer_id} onChange={(e) => onChange({ ...draft, customer_id: e.target.value, invoice_id: "" })}>
              <option value="">Choose…</option>
              {customerOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {(op.type === "record_payment" || op.type === "create_payment_commitment") && (
        <Field label="Invoice">
          {(id) => (
            <Select id={id} value={draft.invoice_id} onChange={update("invoice_id")}>
              <option value="">{op.type === "create_payment_commitment" ? "Whole customer balance" : "Choose…"}</option>
              {invoiceOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.outstanding ? ` · owes ${formatMoney(c.outstanding)}` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {(has("amount") || op.type !== "create_customer") && (
        <Field label="Amount (₹)" error={draft.amount && !isValidAmount(draft.amount) ? "Enter a positive amount with up to 2 decimals." : undefined}>
          {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={draft.amount} onChange={update("amount")} />}
        </Field>
      )}
      {["record_payment", "record_sale", "create_invoice", "create_expense"].includes(op.type) && (
        <Field label="Date">{(id) => <Input id={id} type="date" value={draft.date} onChange={update("date")} />}</Field>
      )}
      {op.type === "create_payment_commitment" && (
        <Field label="Promised date">
          {(id) => <Input id={id} type="date" value={draft.expected_payment_date} onChange={update("expected_payment_date")} />}
        </Field>
      )}
      {["create_invoice", "create_expense"].includes(op.type) && (
        <Field label="Due date">{(id) => <Input id={id} type="date" value={draft.due_date} onChange={update("due_date")} />}</Field>
      )}
      {["record_payment", "create_expense"].includes(op.type) && (
        <Field label="Payment method">
          {(id) => (
            <Select id={id} value={draft.payment_method} onChange={update("payment_method")}>
              <option value="">Not stated (cash)</option>
              {Object.entries(PAYMENT_METHOD_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {["create_invoice", "create_expense", "record_sale"].includes(op.type) && (
        <Field label="Description" className="sm:col-span-2">
          {(id) => <Textarea id={id} className="min-h-16" value={draft.description} onChange={update("description")} />}
        </Field>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ card
/**
 * Review card for one ProposedAction.
 *
 * @param action   proposal as returned by the API; copied into local state (`current`) and replaced by
 *                 each mutation response, so the card reflects the server's latest view without waiting
 *                 for a list refetch. Callers key the card by id (and updated_at on the actions page) so a
 *                 refetched proposal remounts it with fresh state.
 * @param onChange optional callback receiving each updated proposal (no current caller passes it).
 */
export function ProposalCard({ action, onChange }: { action: ProposedAction; onChange?: (a: ProposedAction) => void }) {
  // isOwner = session.user.role === "owner". It only hides Approve/Reject for staff; the backend
  // enforces the role independently (403 FORBIDDEN).
  const { isOwner } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState(action);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const approve = useApproveAction(current.id);
  const reject = useRejectAction(current.id);
  const edit = useEditAction(current.id);
  // While any of the three mutations is in flight, every action button is disabled, so the owner cannot
  // e.g. approve while an edit is still being saved. Mutations are not auto-retried.
  const busy = approve.isPending || reject.isPending || edit.isPending;

  const update = (a: ProposedAction) => {
    setCurrent(a);
    onChange?.(a);
  };

  /**
   * Approve waits for the backend to execute the operations. On success the hook invalidates "actions"
   * plus every ledger-derived query (invalidateFinancial). The success toast fires only when the returned
   * status is `executed`; a `failed` result is shown through the status badge instead.
   */
  async function onApprove() {
    setError(null);
    try {
      const result = await approve.mutateAsync();
      update(result.action);
      if (result.action.status === "executed") toast("Approved and recorded in your books.");
    } catch (err) {
      // ApiError message from the backend envelope (e.g. FORBIDDEN, conflict) or a network/timeout message.
      setError(describeError(err));
    }
  }

  // Reject sends no reason (empty body) and only invalidates the "actions" queries: nothing was written to the ledger.
  async function onReject() {
    setError(null);
    try {
      const result = await reject.mutateAsync(undefined);
      update(result.action);
      toast("Proposal rejected. Nothing was recorded.", "info");
    } catch (err) {
      setError(describeError(err));
    }
  }

  /**
   * Saves edits by sending every operation (edited or not) to PATCH /actions/{id}. The response is a
   * re-evaluated proposal with fresh resolutions, warnings and `can_approve`; edit mode only closes on success.
   */
  async function onSaveEdit() {
    setError(null);
    try {
      const ops = current.operations.map((op, i) => toOperation(op, drafts[i]));
      const updated = await edit.mutateAsync(ops);
      update(updated);
      setEditing(false);
    } catch (err) {
      setError(describeError(err));
    }
  }

  const pending = current.status === "pending";
  // `result` is untyped in the contract; only the per-operation `summary` strings are read, defensively.
  const results = (current.result as { operations?: { summary?: string }[] } | null)?.operations ?? [];

  return (
    <article className="space-y-4 rounded-2xl bg-paper p-5 ring-1 ring-line" aria-label="Proposed action" data-testid="proposal-card" data-status={current.status}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[current.status]}>{humanize(current.status)}</Badge>
          <Badge tone={CONFIDENCE_TONE[current.confidence_level]}>Confidence: {current.confidence_level}</Badge>
          {current.provider && <Badge tone="neutral">Understood by: {current.provider === "rules" ? "built-in English rules" : "Sarvam AI"}</Badge>}
        </div>
        <time className="text-xs text-muted" dateTime={current.created_at}>{formatDateTime(current.created_at)}</time>
      </header>

      <blockquote className="rounded-xl bg-cream/70 px-4 py-3 font-display text-base italic text-ink" data-testid="proposal-transcript">
        “{current.source_transcript}”
      </blockquote>

      {current.warnings.length > 0 && (
        <ul className="space-y-1.5" aria-label="Warnings">
          {current.warnings.map((w, i) => (
            <li key={i} className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-sm", w.blocking ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn")}>
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {w.message}
                {w.blocking && <strong className="ml-1">(must be fixed before approval)</strong>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <div className="space-y-3">
          {current.operations.map((op, i) => (
            <EditOperation key={i} op={op} draft={drafts[i]} onChange={(d) => setDrafts((all) => all.map((x, j) => (j === i ? d : x)))} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {current.operations.map((op) => (
            <OperationView key={op.index} op={op} evidence={current.evidence.filter((e) => e.operation_index === op.index)} />
          ))}
        </div>
      )}

      {current.status === "executed" && results.length > 0 && (
        <div className="rounded-xl bg-good-soft p-4 text-sm text-good" data-testid="proposal-result">
          <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4" aria-hidden="true" /> Recorded {formatDateTime(current.executed_at)}</p>
          <ul className="mt-1 list-disc pl-6">
            {results.map((r, i) => (
              <li key={i}>{r.summary}</li>
            ))}
          </ul>
        </div>
      )}
      {current.status === "rejected" && (
        <p className="flex items-center gap-2 text-sm font-semibold text-muted" data-testid="proposal-rejected">
          <XCircle className="size-4" aria-hidden="true" /> Rejected {formatDateTime(current.rejected_at)}. No records were changed.
        </p>
      )}

      <FormError message={error} />

      {pending && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
          {!isOwner && <p className="mr-auto text-sm text-muted">Only the business owner can approve or reject.</p>}
          {editing ? (
            <>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
              <Button onClick={onSaveEdit} loading={edit.isPending} disabled={busy}>Save changes</Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDrafts(current.operations.map(toDraft));
                  setEditing(true);
                }}
                disabled={busy}
              >
                <Pencil className="size-4" aria-hidden="true" /> Edit
              </Button>
              {isOwner && (
                <>
                  <Button variant="secondary" onClick={onReject} loading={reject.isPending} disabled={busy}>
                    <X className="size-4" aria-hidden="true" /> Reject
                  </Button>
                  <Button variant="good" onClick={onApprove} loading={approve.isPending} disabled={busy || !current.can_approve}>
                    <Check className="size-4" aria-hidden="true" /> Approve
                  </Button>
                </>
              )}
            </>
          )}
        </footer>
      )}
      {pending && isOwner && !current.can_approve && !editing && (
        <p className="text-right text-xs text-muted">Approval is disabled until the missing or ambiguous details are resolved (use Edit).</p>
      )}
    </article>
  );
}
