/**
 * Server-side payment attempts (backend API 1.1.0, /api/v1/payment-attempts) and the one submission pipeline
 * used by both the invoice and the bill payment dialogs.
 *
 * Authority: the backend. An attempt is registered (key + frozen request stored server-side) before any money
 * moves, then executed. Any authorised device can list pending attempts and execute them again; executing is
 * always safe (records once or replays). PostgreSQL allows only one pending attempt per invoice/bill, which is
 * what stops two tabs or devices from creating independent payments, with or without Web Locks.
 *
 * The browser keeps a local record (lib/api/payment-attempt.ts) only as a recovery aid for the window between
 * choosing a key and the server confirming the registration, and to migrate records written by older builds.
 */
import { api, unwrap } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { attemptStores, isDefinitiveRejection } from "@/lib/api/payment-attempt";
import type { Schemas } from "@/lib/api/types";

export type Kind = "invoice" | "bill";
export type ServerAttempt = Schemas["PaymentAttemptDetailOut"];
export type AttemptListItem = Schemas["PaymentAttemptOut"];
export type AttemptResult = Schemas["PaymentAttemptResult"];

/** The frozen request in the shape both the local store and the server use. */
export type PaymentBody = {
  amount: string;
  payment_date?: string | null;
  payment_method: Schemas["PaymentAttemptCreate"]["payment_method"];
  reference?: string | null;
  notes?: string | null;
};

/** A locally saved attempt, for either kind (the id field differs). */
export type LocalAttempt = {
  v: 1 | 2;
  key: string;
  businessId: string;
  userId: string;
  startedAt: string;
  attemptId?: string;
  body: PaymentBody;
};

export function registerAttempt(kind: Kind, targetId: string, key: string, body: PaymentBody): Promise<ServerAttempt> {
  return unwrap(
    api.POST("/api/v1/payment-attempts", {
      body: {
        resource_type: kind,
        resource_id: targetId,
        idempotency_key: key,
        amount: body.amount,
        payment_date: body.payment_date ?? null,
        payment_method: body.payment_method,
        reference: body.reference ?? null,
        notes: kind === "invoice" ? (body.notes ?? null) : null,
      },
    }),
  );
}

export function executeAttempt(attemptId: string): Promise<ServerAttempt> {
  return unwrap(api.POST("/api/v1/payment-attempts/{attempt_id}/execute", { params: { path: { attempt_id: attemptId } } }));
}

export function getAttempt(attemptId: string): Promise<ServerAttempt> {
  return unwrap(api.GET("/api/v1/payment-attempts/{attempt_id}", { params: { path: { attempt_id: attemptId } } }));
}

export function listPendingAttempts(filter: { resource_type?: Kind; resource_id?: string; page?: number; page_size?: number } = {}) {
  return unwrap(api.GET("/api/v1/payment-attempts", { params: { query: { status: "pending", page_size: 200, ...filter } } }));
}

/** Converts the server's frozen request to the dialog's body shape. */
export function bodyFromServer(a: AttemptListItem): PaymentBody {
  return {
    amount: a.request.amount,
    payment_date: a.request.payment_date ?? null,
    payment_method: a.request.payment_method as PaymentBody["payment_method"],
    reference: a.request.reference ?? null,
    notes: a.request.notes ?? null,
  };
}

export type Outcome =
  | { type: "done"; attempt: ServerAttempt }
  /** Processed and refused: nothing was recorded; the local record was released. */
  | { type: "definitive"; error: ApiError }
  /** Another attempt is already pending for this invoice/bill; adopt it. */
  | { type: "conflict"; attempt: ServerAttempt; error: ApiError }
  /** Outcome unknown (network, timeout, 5xx, 401/408/409/429): keep everything and retry. */
  | { type: "uncertain"; error: unknown; attemptId?: string };

function definitiveFromAttempt(a: ServerAttempt): ApiError {
  return new ApiError(a.status === "cancelled" ? 409 : 422, {
    code: a.failure_code ?? (a.status === "cancelled" ? "PAYMENT_ATTEMPT_CANCELLED" : "PAYMENT_REJECTED"),
    message: a.failure_message ?? `This payment was ${a.status}.`,
  });
}

/**
 * Executes an attempt by id. 422/404 and 409 PAYMENT_ATTEMPT_CANCELLED are definitive (nothing recorded);
 * everything else is uncertain.
 */
async function execute(attemptId: string): Promise<Outcome> {
  try {
    return { type: "done", attempt: await executeAttempt(attemptId) };
  } catch (err) {
    if (isDefinitiveRejection(err) || (err instanceof ApiError && err.code === "PAYMENT_ATTEMPT_CANCELLED")) {
      return { type: "definitive", error: err as ApiError };
    }
    return { type: "uncertain", error: err, attemptId };
  }
}

/**
 * Runs a locally saved attempt to an outcome: register (idempotent by key, so repeating it after a lost
 * response returns the same server attempt), then execute. Updates the local store as the outcome becomes
 * known. Never generates a key.
 */
export async function runLocalAttempt(kind: Kind, businessId: string, targetId: string, local: LocalAttempt): Promise<Outcome> {
  const store = attemptStores[kind];
  let attempt: ServerAttempt;
  try {
    attempt = await registerAttempt(kind, targetId, local.key, local.body);
  } catch (err) {
    if (err instanceof ApiError && err.code === "PAYMENT_ATTEMPT_PENDING") {
      const otherId = (err.details as { attempt_id?: string } | null)?.attempt_id;
      // A v2 key was never sent anywhere but registration, so nothing can be recorded under it: drop it.
      // A v1 (older build) key may have been sent to the direct payment endpoint: keep it until it registers.
      if (local.v === 2) store.reject(businessId, targetId, local.key);
      if (otherId) {
        try {
          return { type: "conflict", attempt: await getAttempt(otherId), error: err };
        } catch {
          // fall through: report uncertain so the user retries
        }
      }
      return { type: "uncertain", error: err };
    }
    if (isDefinitiveRejection(err)) {
      store.reject(businessId, targetId, local.key);
      return { type: "definitive", error: err as ApiError };
    }
    return { type: "uncertain", error: err };
  }
  store.setServerId(businessId, targetId, local.key, attempt.id);
  if (attempt.status === "succeeded") {
    store.confirm(businessId, targetId, local.key);
    return { type: "done", attempt };
  }
  if (attempt.status === "rejected" || attempt.status === "cancelled") {
    store.reject(businessId, targetId, local.key);
    return { type: "definitive", error: definitiveFromAttempt(attempt) };
  }
  const outcome = await execute(attempt.id);
  if (outcome.type === "done") store.confirm(businessId, targetId, local.key);
  if (outcome.type === "definitive") store.reject(businessId, targetId, local.key);
  return outcome;
}

/** Retries an attempt known only from the server (another device, or this browser's storage was cleared). */
export function runServerAttempt(attemptId: string): Promise<Outcome> {
  return execute(attemptId);
}

/**
 * Logout privacy: removes this business's payment records from browser storage without losing any payment.
 *
 * - v2 records only ever sent their key to POST /payment-attempts, so the server either holds the attempt
 *   (recoverable after the next login, from any device) or nothing happened at all: safe to remove.
 * - v1 records (older builds) may have been sent straight to a payment endpoint: each is registered with its
 *   original key first (the server links an already-recorded payment), and removed only if that succeeds.
 *   One that cannot be registered now (offline, for example) is kept.
 * Server-side attempts are never cancelled here. Returns how many records were kept.
 */
export async function clearLocalAttemptsForLogout(businessId: string): Promise<number> {
  let kept = 0;
  for (const kind of ["invoice", "bill"] as const) {
    const store = attemptStores[kind];
    for (const targetId of store.listPending(businessId)) {
      const local = store.load(businessId, targetId) as LocalAttempt | null;
      if (!local) continue;
      if (local.v === 1) {
        try {
          await registerAttempt(kind, targetId, local.key, local.body);
        } catch {
          kept += 1; // not provably on the server yet: keep it for the next session
          continue;
        }
      }
      store.reject(businessId, targetId, local.key);
    }
  }
  return kept;
}
