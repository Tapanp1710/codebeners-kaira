/**
 * Uncertain bill-payment attempts: persistence, cross-tab coordination and outcome classification.
 *
 * Backend contract (payment_service.record_bill_payment): POST /bills/{id}/payments is idempotent per
 * `Idempotency-Key` within a business. The key is looked up before any balance check; if a payment was
 * already recorded under it, that payment is returned with `replayed: true`. Keys never expire on the
 * backend (unique constraint, no TTL), so retrying an old key is always safe.
 *
 * Once a payment request may have been sent, its key and exact body are frozen as an "attempt". An
 * attempt is removed ONLY when the backend confirms an outcome: success (recorded or replayed) or a
 * processed 4xx rejection. There is deliberately no "discard": an attempt whose outcome is unknown can only
 * be resolved by retrying it.
 *
 * Persistence: localStorage, so attempts survive reloads, closing the tab and browser restarts, and are
 * visible to every tab of this origin. Keys are scoped to business and bill (users of one business share a
 * bill's pending attempt, which is what prevents a second user or tab from paying it again; other
 * businesses never see it). Stored fields: key, ids, the payment fields typed (amount, date, method) and a
 * timestamp. No tokens, cookies or credentials. Trade-off: the entry outlives logout on a shared device
 * until the payment is resolved; it reveals one amount/date/method and opaque ids, nothing else.
 * If localStorage is unavailable, an in-memory store keeps in-page retries working (no cross-tab or
 * reload recovery in that case).
 *
 * Cross-tab: writes are announced on a BroadcastChannel and observed through `storage` events; submits
 * for one bill are serialised across tabs with a Web Lock where supported. The backend's idempotency check
 * remains the final authority.
 */
import { ApiError } from "./errors";
import type { Schemas } from "./types";

export type BillPaymentAttempt = {
  v: 1;
  key: string;
  businessId: string;
  billId: string;
  userId: string;
  body: Schemas["BillPaymentCreate"];
  startedAt: string;
};

/** Short-lived marker telling other tabs which key was confirmed, so they can close instead of retrying. */
export type BillPaymentDone = { v: 1; key: string; at: number };

const ATTEMPT_PREFIX = "kaira:bill-payment-attempt:v1:";
const DONE_PREFIX = "kaira:bill-payment-done:v1:";
const CHANNEL = "kaira-bill-payment-attempts";
// Completion markers only exist for cross-tab sync; attempts themselves never expire (see header).
const DONE_TTL_MS = 24 * 60 * 60 * 1000;
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

const scope = (businessId: string, billId: string) => `${businessId}:${billId}`;
export const attemptStorageKey = (businessId: string, billId: string) => ATTEMPT_PREFIX + scope(businessId, billId);
const doneStorageKey = (businessId: string, billId: string) => DONE_PREFIX + scope(businessId, billId);

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

function parseAttempt(raw: string, businessId: string, billId: string): BillPaymentAttempt | null {
  try {
    const a = JSON.parse(raw) as Partial<BillPaymentAttempt>;
    const b = a.body;
    const valid =
      a.v === 1 && typeof a.key === "string" && a.key.length > 0 && a.key.length <= 200 &&
      a.businessId === businessId && a.billId === billId && typeof a.userId === "string" &&
      typeof a.startedAt === "string" && !!b && typeof b.amount === "string" && AMOUNT.test(b.amount.trim()) &&
      typeof b.payment_method === "string" && (b.payment_date == null || typeof b.payment_date === "string");
    return valid ? (a as BillPaymentAttempt) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the pending attempt for this business and bill, or null. A corrupt entry carries no key that can
 * be trusted, so it cannot be retried safely either way; it is removed (with a console warning) rather
 * than left to block the bill permanently.
 */
export function loadBillPaymentAttempt(businessId: string, billId: string): BillPaymentAttempt | null {
  const k = attemptStorageKey(businessId, billId);
  const raw = store.get(k);
  if (!raw) return null;
  const a = parseAttempt(raw, businessId, billId);
  if (!a) {
    console.warn("Ignoring a corrupt saved bill-payment attempt", k);
    store.remove(k);
  }
  return a;
}

export function loadBillPaymentDone(businessId: string, billId: string): BillPaymentDone | null {
  const k = doneStorageKey(businessId, billId);
  const raw = store.get(k);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<BillPaymentDone>;
    if (d.v === 1 && typeof d.key === "string" && typeof d.at === "number" && Date.now() - d.at < DONE_TTL_MS) return d as BillPaymentDone;
  } catch {
    // fall through: corrupt or expired markers are simply dropped
  }
  store.remove(k);
  return null;
}

/** Bill ids with a valid pending attempt for this business (for the bills list). Read-only: no cleanup here. */
export function listPendingBillIds(businessId: string): string[] {
  const prefix = `${ATTEMPT_PREFIX}${businessId}:`;
  return store
    .keys()
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter((billId) => parseAttempt(store.get(attemptStorageKey(businessId, billId)) ?? "", businessId, billId) !== null)
    .sort();
}

/**
 * Saves a new attempt unless one already exists for this bill, in which case the existing attempt is
 * returned untouched (`created: false`): a pending attempt is never overwritten.
 */
export function createBillPaymentAttempt(input: Omit<BillPaymentAttempt, "v" | "startedAt">): { attempt: BillPaymentAttempt; created: boolean } {
  const existing = loadBillPaymentAttempt(input.businessId, input.billId);
  if (existing) return { attempt: existing, created: false };
  const attempt: BillPaymentAttempt = { v: 1, ...input, startedAt: new Date().toISOString() };
  store.set(attemptStorageKey(input.businessId, input.billId), JSON.stringify(attempt));
  notify();
  return { attempt, created: true };
}

/** Backend confirmed the payment (recorded or replayed): remove the attempt and leave a completion marker. */
export function confirmBillPaymentAttempt(businessId: string, billId: string, key: string): void {
  store.set(doneStorageKey(businessId, billId), JSON.stringify({ v: 1, key, at: Date.now() } satisfies BillPaymentDone));
  if (loadBillPaymentAttempt(businessId, billId)?.key === key) store.remove(attemptStorageKey(businessId, billId));
  notify();
}

/** Backend processed and rejected the request, so nothing was recorded under this key: release it. */
export function rejectBillPaymentAttempt(businessId: string, billId: string, key: string): void {
  if (loadBillPaymentAttempt(businessId, billId)?.key === key) store.remove(attemptStorageKey(businessId, billId));
  notify();
}

// ------------------------------------------------------------------ change notifications

type Listener = (remote: boolean) => void;
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
export function subscribeBillPaymentAttempts(listener: Listener): () => void {
  wire();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs `fn` while holding a per-bill Web Lock shared by all tabs of this origin, so two tabs cannot create
 * competing attempts or send the same one concurrently. Without Web Locks it runs directly; the backend's
 * idempotency check still prevents duplicates for a shared key.
 */
export function withBillPaymentLock<T>(businessId: string, billId: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? (locks.request(`kaira-bill-payment:${scope(businessId, billId)}`, fn) as Promise<T>) : fn();
}

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
