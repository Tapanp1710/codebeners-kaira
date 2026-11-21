/**
 * Uncertain payment attempts (bill payments and invoice payments): persistence, cross-tab coordination and
 * outcome classification.
 *
 * Backend contract (payment_service.record_bill_payment / record_customer_payment): POST /bills/{id}/payments
 * and POST /invoices/{id}/payments are idempotent per `Idempotency-Key` within a business. The key is looked
 * up before any balance, void or already-paid check; if a payment was already recorded under it, that payment
 * is returned with `replayed: true`. Keys never expire on the backend (unique constraint, no TTL), so
 * retrying an old key is always safe.
 *
 * Once a payment request may have been sent, its key and exact body are frozen as an "attempt". An
 * attempt is removed ONLY when the backend confirms an outcome: success (recorded or replayed) or a
 * processed 4xx rejection. There is deliberately no "discard": an attempt whose outcome is unknown can only
 * be resolved by retrying it.
 *
 * Persistence: localStorage, so attempts survive reloads, closing the tab and browser restarts, and are
 * visible to every tab of this origin. Keys are scoped to business and target (bill or invoice): users of
 * one business share a target's pending attempt, which is what prevents a second user or tab from paying it
 * again; other businesses never see it. Stored fields: key, ids, the payment fields sent and a timestamp.
 * No tokens, cookies or credentials. Trade-off: the entry outlives logout on a shared device until the
 * payment is resolved. If localStorage is unavailable, an in-memory store keeps in-page retries working
 * (no cross-tab or reload recovery in that case). Nothing here protects across devices or browsers; that
 * would need a backend recovery capability.
 *
 * Cross-tab: writes are announced on a BroadcastChannel and observed through `storage` events; submits
 * for one target are serialised across tabs with a Web Lock where supported. The backend's idempotency
 * check remains the final authority.
 *
 * Bill and invoice attempts are two instances of the same store with separate storage keys, channels and
 * lock names. The bill API and storage format are unchanged from the bill-only version.
 */
import { ApiError } from "./errors";
import type { Schemas } from "./types";

type AttemptBase = { v: 1; key: string; businessId: string; userId: string; startedAt: string };

export type BillPaymentAttempt = AttemptBase & { billId: string; body: Schemas["BillPaymentCreate"] };
export type InvoicePaymentAttempt = AttemptBase & { invoiceId: string; body: Schemas["PaymentCreate"] };

/** Short-lived marker telling other tabs which key was confirmed, so they can close instead of retrying. */
export type PaymentDone = { v: 1; key: string; at: number };
export type BillPaymentDone = PaymentDone;

// Completion markers only exist for cross-tab sync; attempts themselves never expire (see header).
const DONE_TTL_MS = 24 * 60 * 60 * 1000;
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

const memory = new Map<string, string>();
const store = {
  get(k: string): string | null {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return memory.get(k) ?? null;
    }
  },
  set(k: string, v: string) {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      memory.set(k, v);
    }
  },
  remove(k: string) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      memory.delete(k);
    }
  },
  keys(): string[] {
    try {
      return Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!).filter(Boolean);
    } catch {
      return [...memory.keys()];
    }
  },
};

const optionalString = (v: unknown) => v == null || typeof v === "string";

/** Fields every payment body must have to be retried as-is. */
function validPaymentBody(b: Record<string, unknown> | undefined): boolean {
  return (
    !!b && typeof b.amount === "string" && AMOUNT.test(b.amount.trim()) &&
    typeof b.payment_method === "string" && optionalString(b.payment_date) && optionalString(b.reference)
  );
}

type Listener = (remote: boolean) => void;

/**
 * One attempt store. `name` namespaces storage keys ("kaira:<name>-payment-attempt:v1:<business>:<id>"),
 * the BroadcastChannel and the Web Lock; `idField` is the target id property in the stored JSON.
 */
function createAttemptStore<A extends AttemptBase & { body: object }>(cfg: {
  name: "bill" | "invoice";
  idField: "billId" | "invoiceId";
  validBody: (b: Record<string, unknown> | undefined) => boolean;
}) {
  const ATTEMPT_PREFIX = `kaira:${cfg.name}-payment-attempt:v1:`;
  const DONE_PREFIX = `kaira:${cfg.name}-payment-done:v1:`;
  const CHANNEL = `kaira-${cfg.name}-payment-attempts`;
  const scope = (businessId: string, id: string) => `${businessId}:${id}`;
  const storageKey = (businessId: string, id: string) => ATTEMPT_PREFIX + scope(businessId, id);
  const doneKey = (businessId: string, id: string) => DONE_PREFIX + scope(businessId, id);

  function parse(raw: string, businessId: string, id: string): A | null {
    try {
      const a = JSON.parse(raw) as Record<string, unknown>;
      const valid =
        a.v === 1 && typeof a.key === "string" && a.key.length > 0 && a.key.length <= 200 &&
        a.businessId === businessId && a[cfg.idField] === id && typeof a.userId === "string" &&
        typeof a.startedAt === "string" && cfg.validBody(a.body as Record<string, unknown> | undefined);
      return valid ? (a as unknown as A) : null;
    } catch {
      return null;
    }
  }

  /**
   * Returns the pending attempt for this business and target, or null. A corrupt entry carries no key that
   * can be trusted, so it cannot be retried safely either way; it is removed (with a console warning) rather
   * than left to block the target permanently.
   */
  function load(businessId: string, id: string): A | null {
    const k = storageKey(businessId, id);
    const raw = store.get(k);
    if (!raw) return null;
    const a = parse(raw, businessId, id);
    if (!a) {
      console.warn(`Ignoring a corrupt saved ${cfg.name}-payment attempt`, k);
      store.remove(k);
    }
    return a;
  }

  function loadDone(businessId: string, id: string): PaymentDone | null {
    const k = doneKey(businessId, id);
    const raw = store.get(k);
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as Partial<PaymentDone>;
      if (d.v === 1 && typeof d.key === "string" && typeof d.at === "number" && Date.now() - d.at < DONE_TTL_MS) return d as PaymentDone;
    } catch {
      // fall through: corrupt or expired markers are simply dropped
    }
    store.remove(k);
    return null;
  }

  /** Target ids with a valid pending attempt for this business. Read-only: no cleanup here. */
  function listPending(businessId: string): string[] {
    const prefix = `${ATTEMPT_PREFIX}${businessId}:`;
    return store
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((id) => parse(store.get(storageKey(businessId, id)) ?? "", businessId, id) !== null)
      .sort();
  }

  /**
   * Saves a new attempt unless one already exists for this target, in which case the existing attempt is
   * returned untouched (`created: false`): a pending attempt is never overwritten.
   */
  function create(input: Omit<A, "v" | "startedAt">): { attempt: A; created: boolean } {
    const id = (input as unknown as Record<string, string>)[cfg.idField];
    const existing = load(input.businessId, id);
    if (existing) return { attempt: existing, created: false };
    const attempt = { v: 1, ...input, startedAt: new Date().toISOString() } as unknown as A;
    store.set(storageKey(input.businessId, id), JSON.stringify(attempt));
    notify();
    return { attempt, created: true };
  }

  /** Backend confirmed the payment (recorded or replayed): remove the attempt and leave a completion marker. */
  function confirm(businessId: string, id: string, key: string): void {
    store.set(doneKey(businessId, id), JSON.stringify({ v: 1, key, at: Date.now() } satisfies PaymentDone));
    if (load(businessId, id)?.key === key) store.remove(storageKey(businessId, id));
    notify();
  }

  /** Backend processed and rejected the request, so nothing was recorded under this key: release it. */
  function reject(businessId: string, id: string, key: string): void {
    if (load(businessId, id)?.key === key) store.remove(storageKey(businessId, id));
    notify();
  }

  const listeners = new Set<Listener>();
  let channel: BroadcastChannel | null = null;
  let wired = false;

  function wire() {
    if (wired || typeof window === "undefined") return;
    wired = true;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = () => listeners.forEach((l) => l(true));
    } catch {
      channel = null;
    }
    // Fallback for browsers without BroadcastChannel; also covers writes from tabs that predate it.
    window.addEventListener("storage", (e) => {
      if (e.key === null || e.key.startsWith(ATTEMPT_PREFIX) || e.key.startsWith(DONE_PREFIX)) listeners.forEach((l) => l(true));
    });
  }

  function notify() {
    listeners.forEach((l) => l(false));
    try {
      channel?.postMessage("changed");
    } catch {
      // Channel closed: storage events still reach other tabs.
    }
  }

  /** Calls `listener` after any attempt change; `remote` is true when it came from another tab. */
  function subscribe(listener: Listener): () => void {
    wire();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Runs `fn` while holding a per-target Web Lock shared by all tabs of this origin, so two tabs cannot create
   * competing attempts or send the same one concurrently. Without Web Locks it runs directly; the backend's
   * idempotency check still prevents duplicates for a shared key.
   */
  function withLock<T>(businessId: string, id: string, fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    return locks ? (locks.request(`kaira-${cfg.name}-payment:${scope(businessId, id)}`, fn) as Promise<T>) : fn();
  }

  return { storageKey, load, loadDone, listPending, create, confirm, reject, subscribe, withLock };
}

// ------------------------------------------------------------------ bill payments

const bills = createAttemptStore<BillPaymentAttempt>({ name: "bill", idField: "billId", validBody: validPaymentBody });

export const attemptStorageKey = bills.storageKey;
export const loadBillPaymentAttempt = bills.load;
export const loadBillPaymentDone = bills.loadDone;
/** Bill ids with a valid pending attempt for this business (for the bills list). */
export const listPendingBillIds = bills.listPending;
export const createBillPaymentAttempt = bills.create;
export const confirmBillPaymentAttempt = bills.confirm;
export const rejectBillPaymentAttempt = bills.reject;
export const subscribeBillPaymentAttempts = bills.subscribe;
export const withBillPaymentLock = bills.withLock;

// ------------------------------------------------------------------ invoice payments

const invoices = createAttemptStore<InvoicePaymentAttempt>({
  name: "invoice",
  idField: "invoiceId",
  // Invoice payments also carry optional notes, which are part of the frozen body.
  validBody: (b) => validPaymentBody(b) && optionalString(b?.notes),
});

export const invoiceAttemptStorageKey = invoices.storageKey;
export const loadInvoicePaymentAttempt = invoices.load;
export const loadInvoicePaymentDone = invoices.loadDone;
/** Invoice ids with a valid pending attempt for this business. */
export const listPendingInvoiceIds = invoices.listPending;
export const createInvoicePaymentAttempt = invoices.create;
export const confirmInvoicePaymentAttempt = invoices.confirm;
export const rejectInvoicePaymentAttempt = invoices.reject;
export const subscribeInvoicePaymentAttempts = invoices.subscribe;
export const withInvoicePaymentLock = invoices.withLock;

/**
 * True only when the backend processed the request and rejected it, so nothing was recorded under the key
 * and the attempt can be released. Network errors and timeouts (status 0), 5xx (including the proxy's
 * 502/504) and 401/408/409/429 leave the outcome unknown and keep the attempt.
 */
export function isDefinitiveRejection(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  return ![401, 408, 409, 429].includes(err.status);
}
