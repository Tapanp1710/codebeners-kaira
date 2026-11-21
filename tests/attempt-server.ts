/**
 * In-test stand-in for the backend's payment endpoints (API 1.1.0), following its contract as implemented
 * and tested against PostgreSQL in kaira-backend (tests/api/test_payment_attempts.py):
 *
 * - POST /payment-attempts: same key + same request -> 200 existing; same key + different request -> 422
 *   IDEMPOTENCY_KEY_REUSED; another pending attempt for the target -> 409 PAYMENT_ATTEMPT_PENDING
 *   {attempt_id}; a key already on a recorded payment -> created as succeeded; else 201 pending.
 * - POST /payment-attempts/{id}/execute: succeeded -> replay; rejected -> 422; pending -> record once.
 * - GET /payment-attempts (status/resource filters), GET /payment-attempts/{id}.
 * - Direct POST /{kind}s/{id}/payments with Idempotency-Key (used by older builds; same key rules).
 *
 * Failures can be injected per registration or execution, before or after the server commits, to simulate
 * lost responses. `executions` records every execution that reached the payment logic (key + body);
 * `payments` is what the "database" holds.
 */
import { envelope, errorEnvelope } from "./fixtures";
import { pathOf } from "./render";

export type Failure =
  | "network-before"
  | "network-after"
  | "timeout-after"
  | "500-after"
  | "502-after"
  | "503-before"
  | "504-after"
  | "409"
  | "429"
  | "408"
  | "422";

type Kind = "invoice" | "bill";
type Body = { amount: string; payment_date: string | null; payment_method: string; reference: string | null; notes: string | null };
type Attempt = {
  id: string;
  kind: Kind;
  targetId: string;
  key: string;
  body: Body;
  fp: string;
  status: "pending" | "succeeded" | "rejected" | "cancelled";
  payment_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
};

const cents = (s: string) => BigInt(Math.round(Number(s) * 100));
const money = (c: bigint) => (Number(c) / 100).toFixed(2);
const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);

export function attemptServer(opts: {
  kind: Kind;
  targets: Record<string, { amount: string; label: string; extra?: Record<string, unknown> }>;
  registerFailures?: Failure[];
  executeFailures?: Failure[];
}) {
  const { kind } = opts;
  const total = Object.fromEntries(Object.entries(opts.targets).map(([id, t]) => [id, cents(t.amount)]));
  const outstanding: Record<string, bigint> = { ...total };
  const attempts = new Map<string, Attempt>();
  const payments = new Map<string, { id: string; targetId: string; amount: string; body: Body }>();
  const executions: { key: string; body: Body; attemptId: string }[] = [];
  const registrations: { key: string | null; body: Body }[] = [];
  const registerFailures = [...(opts.registerFailures ?? [])];
  const executeFailures = [...(opts.executeFailures ?? [])];
  let seq = 0;
  let release: (() => void) | null = null;
  const state = { attempts, payments, executions, registrations, hold: false, release: () => release?.(), outstanding };

  const fpOf = (targetId: string, b: Body) =>
    JSON.stringify([targetId, money(cents(b.amount)), b.payment_date, b.payment_method, text(b.reference), text(b.notes)]);
  const targetOut = (id: string) => {
    const t = opts.targets[id];
    const out = outstanding[id];
    const paid = total[id] - out;
    const status = out === BigInt(0) ? "paid" : paid === BigInt(0) ? "unpaid" : "partially_paid";
    return kind === "invoice"
      ? { id, invoice_number: t.label, customer_id: "cust-1", customer_name: "Ramesh Kumar", invoice_date: "2026-11-01", due_date: "2026-12-01", lifecycle_status: "issued", payment_status: status, is_overdue: false, days_overdue: 0, total: money(total[id]), paid: money(paid), outstanding: money(out), notes: null, created_at: "2026-11-01T00:00:00Z", items: [], ...t.extra }
      : { id, vendor_name: t.label, description: null, category: "rent", amount: money(total[id]), paid: money(paid), outstanding: money(out), payment_status: status, is_overdue: false, days_overdue: 0, bill_date: "2026-11-01", due_date: "2026-11-30", notes: null, ...t.extra };
  };
  const attemptOut = (a: Attempt, replayed = true) => {
    const p = a.payment_id ? [...payments.values()].find((x) => x.id === a.payment_id) : undefined;
    const paymentOut = p && { id: p.id, amount: p.amount, payment_date: p.body.payment_date ?? "2026-11-22", payment_method: p.body.payment_method, reference: p.body.reference, [kind === "invoice" ? "invoice_id" : "bill_id"]: a.targetId };
    return {
      id: a.id,
      resource_type: a.kind,
      resource_id: a.targetId,
      resource_label: opts.targets[a.targetId].label,
      status: a.status,
      request: { ...a.body, amount: money(cents(a.body.amount)) },
      payment_id: a.payment_id,
      failure_code: a.failure_code,
      failure_message: a.failure_message,
      created_by: "u1",
      created_at: "2026-11-22T00:00:00Z",
      updated_at: "2026-11-22T00:00:00Z",
      completed_at: null,
      result:
        a.status === "succeeded" && paymentOut
          ? { replayed, [kind === "invoice" ? "invoice_payment" : "bill_payment"]: { replayed, payment: paymentOut, [kind]: targetOut(a.targetId) } }
          : null,
    };
  };

  /** Records a payment under `key`, or replays the one already recorded (the backend's idempotency rule). */
  function pay(targetId: string, key: string, body: Body): { created: boolean; id: string } | Response {
    const existing = payments.get(key);
    if (existing) {
      if (existing.targetId !== targetId || fpOf(targetId, existing.body) !== fpOf(targetId, body)) {
        return errorEnvelope(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a payment with different details.");
      }
      return { created: false, id: existing.id };
    }
    const amount = cents(body.amount);
    if (amount > outstanding[targetId]) return errorEnvelope(422, "OVERPAYMENT", "Payment exceeds the outstanding balance.");
    const id = `pay-${payments.size + 1}`;
    payments.set(key, { id, targetId, amount: money(amount), body });
    outstanding[targetId] -= amount;
    return { created: true, id };
  }

  async function injected(f: Failure | undefined, phase: "before" | "after"): Promise<Response | null> {
    if (!f) return null;
    if (phase === "before") {
      if (f === "network-before") throw new TypeError("Failed to fetch");
      if (f === "503-before") return errorEnvelope(503, "DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
      if (f === "409") return errorEnvelope(409, "CONFLICT", "The request conflicts with existing data. Please retry.");
      if (f === "429") return errorEnvelope(429, "RATE_LIMITED", "Too many requests");
      if (f === "408") return errorEnvelope(408, "REQUEST_TIMEOUT", "Request timeout");
      return null;
    }
    if (f === "network-after") throw new TypeError("Failed to fetch");
    if (f === "timeout-after") throw new DOMException("The operation timed out.", "TimeoutError");
    if (f === "500-after") return errorEnvelope(500, "INTERNAL_SERVER_ERROR", "An unexpected error occurred.");
    if (f === "502-after") return errorEnvelope(502, "BACKEND_UNAVAILABLE", "Backend unavailable");
    if (f === "504-after") return errorEnvelope(504, "BACKEND_TIMEOUT", "Backend timeout");
    return null;
  }

  const handler = async (req: Request): Promise<Response> => {
    const p = pathOf(req);
    const url = new URL(req.url);
    const listPath = kind === "invoice" ? "invoices" : "bills";

    // Lists and details of the targets.
    if (p === `GET /${listPath}`) {
      const status = url.searchParams.get("status");
      const pageSize = Number(url.searchParams.get("page_size") ?? 50);
      const page = Number(url.searchParams.get("page") ?? 1);
      const all = Object.keys(opts.targets).map(targetOut).filter((t) => !(status === "open" && t.outstanding === "0.00"));
      return envelope({ items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, page_size: pageSize });
    }
    const detail = p.match(new RegExp(`^GET /${listPath}/([^/]+)$`));
    if (detail && opts.targets[detail[1]]) return envelope(targetOut(detail[1]));
    if (p.match(new RegExp(`^GET /${listPath}/[^/]+/payments$`))) return envelope({ items: [], total: 0, page: 1, page_size: 200 });

    // Direct payment endpoint (older builds) with Idempotency-Key.
    const direct = p.match(new RegExp(`^POST /${listPath}/([^/]+)/payments$`));
    if (direct) {
      const raw = (await req.json()) as Record<string, unknown>;
      const body: Body = { amount: String(raw.amount), payment_date: (raw.payment_date as string) ?? null, payment_method: String(raw.payment_method), reference: text(raw.reference), notes: text(raw.notes) };
      const r = pay(direct[1], req.headers.get("idempotency-key")!, body);
      if (r instanceof Response) return r;
      return envelope({ replayed: !r.created, payment: { id: r.id, amount: money(cents(body.amount)) }, [kind]: targetOut(direct[1]) }, 201);
    }

    if (p === "GET /payment-attempts") {
      const items = [...attempts.values()].filter(
        (a) =>
          (!url.searchParams.get("status") || a.status === url.searchParams.get("status")) &&
          (!url.searchParams.get("resource_type") || a.kind === url.searchParams.get("resource_type")) &&
          (!url.searchParams.get("resource_id") || a.targetId === url.searchParams.get("resource_id")),
      );
      return envelope({ items: items.map((a) => attemptOut(a)), total: items.length, page: 1, page_size: 200 });
    }
    const one = p.match(/^GET \/payment-attempts\/([^/]+)$/);
    if (one) {
      const a = attempts.get(one[1]);
      return a ? envelope(attemptOut(a)) : errorEnvelope(404, "NOT_FOUND", "Payment attempt not found.");
    }

    if (p === "POST /payment-attempts") {
      const raw = (await req.json()) as Record<string, unknown>;
      const body: Body = { amount: String(raw.amount), payment_date: (raw.payment_date as string) ?? null, payment_method: String(raw.payment_method), reference: text(raw.reference), notes: text(raw.notes) };
      const key = (raw.idempotency_key as string) ?? null;
      const targetId = String(raw.resource_id);
      registrations.push({ key, body });
      if (state.hold) await new Promise<void>((r) => (release = r));
      const failure = registerFailures.shift();
      const early = await injected(failure, "before");
      if (early) return early;
      const fp = fpOf(targetId, body);
      const byKey = key ? [...attempts.values()].find((a) => a.key === key) : undefined;
      let result: { a: Attempt; created: boolean } | Response;
      if (byKey) {
        result = byKey.fp === fp ? { a: byKey, created: false } : errorEnvelope(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a payment with different details.");
      } else {
        const pending = [...attempts.values()].find((a) => a.targetId === targetId && a.status === "pending");
        if (pending) {
          result = !key && pending.fp === fp
            ? { a: pending, created: false }
            : new Response(JSON.stringify({ success: false, data: null, error: { code: "PAYMENT_ATTEMPT_PENDING", message: "Another payment for this is awaiting confirmation. Resolve it first.", details: { attempt_id: pending.id } } }), { status: 409, headers: { "content-type": "application/json" } });
        } else {
          const a: Attempt = { id: `att-${++seq}`, kind, targetId, key: key ?? `pa_${seq}`, body, fp, status: "pending", payment_id: null, failure_code: null, failure_message: null };
          const recorded = key ? payments.get(key) : undefined;
          if (recorded) {
            if (fpOf(targetId, recorded.body) !== fp) result = errorEnvelope(422, "IDEMPOTENCY_KEY_REUSED", "Key reused.");
            else {
              a.status = "succeeded";
              a.payment_id = recorded.id;
              attempts.set(a.id, a);
              result = { a, created: true };
            }
          } else {
            attempts.set(a.id, a);
            result = { a, created: true };
          }
        }
      }
      if (result instanceof Response) return result;
      const late = await injected(failure, "after");
      if (late) return late;
      return envelope(attemptOut(result.a), result.created ? 201 : 200);
    }

    const exec = p.match(/^POST \/payment-attempts\/([^/]+)\/execute$/);
    if (exec) {
      const a = attempts.get(exec[1]);
      if (!a) return errorEnvelope(404, "NOT_FOUND", "Payment attempt not found.");
      if (state.hold) await new Promise<void>((r) => (release = r));
      const failure = executeFailures.shift();
      const early = await injected(failure, "before");
      if (early) return early;
      if (failure === "422") {
        a.status = "rejected";
        a.failure_code = "OVERPAYMENT";
        a.failure_message = "Payment exceeds the outstanding balance.";
        return errorEnvelope(422, "OVERPAYMENT", "Payment exceeds the outstanding balance.");
      }
      if (a.status === "succeeded") {
        // A replay's response can be lost too.
        const lostReplay = await injected(failure, "after");
        return lostReplay ?? envelope(attemptOut(a, true));
      }
      if (a.status === "rejected") return errorEnvelope(422, a.failure_code ?? "REJECTED", a.failure_message ?? "");
      if (a.status === "cancelled") return errorEnvelope(409, "PAYMENT_ATTEMPT_CANCELLED", "This payment attempt was cancelled.");
      executions.push({ key: a.key, body: a.body, attemptId: a.id });
      const r = pay(a.targetId, a.key, a.body);
      if (r instanceof Response) {
        const err = (await r.clone().json()).error;
        a.status = "rejected";
        a.failure_code = err.code;
        a.failure_message = err.message;
        return r;
      }
      a.status = "succeeded";
      a.payment_id = r.id;
      const late = await injected(failure, "after");
      if (late) return late;
      return envelope(attemptOut(a, !r.created));
    }
    return envelope({});
  };
  return { state, handler };
}
