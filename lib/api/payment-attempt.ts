/**
 * Uncertain bill-payment attempts.
 *
 * POST /bills/{id}/payments is idempotent per `Idempotency-Key`: the backend looks the key up before any
 * balance check and, if it already recorded a payment under it, returns that payment with
 * `replayed: true` instead of recording another (backend payment_service.record_bill_payment). Reusing a key
 * for a different bill or amount is rejected with 422 IDEMPOTENCY_KEY_REUSED.
 *
 * So once a payment request has been sent, its key and exact body are frozen together as an "attempt" and
 * kept until the backend confirms an outcome. A network error, timeout or 5xx is NOT an outcome: the server
 * may have committed the payment before the response was lost. Retrying the same attempt is always safe; it
 * either records the payment once or replays the original.
 *
 * Attempts are kept in sessionStorage (per tab, survives a reload, cleared when the tab closes), keyed by
 * user and bill. They hold only the key and the payment fields the user typed: no tokens or session data.
 */
import { ApiError } from "./errors";
import type { Schemas } from "./types";

export type BillPaymentAttempt = {
  key: string;
  billId: string;
  body: Schemas["BillPaymentCreate"];
  startedAt: string;
};

const PREFIX = "kaira:bill-payment-attempt:";
const storageKey = (userId: string, billId: string) => `${PREFIX}${userId}:${billId}`;

/** Returns the stored attempt for this user and bill, or null if none (or storage is unavailable/corrupt). */
export function loadBillPaymentAttempt(userId: string, billId: string): BillPaymentAttempt | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(userId, billId));
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<BillPaymentAttempt>;
    const ok =
      typeof a.key === "string" && a.key.length > 0 && a.billId === billId &&
      typeof a.body?.amount === "string" && typeof a.body.payment_method === "string";
    return ok ? (a as BillPaymentAttempt) : null;
  } catch {
    return null;
  }
}

/** Persists the attempt before the request is sent, so a reload mid-request can still retry with the same key. */
export function saveBillPaymentAttempt(userId: string, attempt: BillPaymentAttempt): void {
  try {
    window.sessionStorage.setItem(storageKey(userId, attempt.billId), JSON.stringify(attempt));
  } catch {
    // Storage blocked or full: the attempt still lives in component state for in-page retries.
  }
}

export function clearBillPaymentAttempt(userId: string, billId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(userId, billId));
  } catch {
    // Nothing to clear if storage is unavailable.
  }
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
