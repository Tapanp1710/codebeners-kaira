/**
 * Browser API client. All calls go to the same-origin proxy (/api/backend/api/v1/...).
 *
 * Security model (from contracts/API_CONTRACT.md):
 * - HttpOnly cookies carry the session; JavaScript never sees tokens.
 * - The CSRF token is held in memory only and sent as X-CSRF-Token on unsafe methods.
 * - On 401 SESSION_EXPIRED/UNAUTHENTICATED: one refresh (POST /auth/refresh), then one retry.
 *   Refreshes are de-duplicated in this tab and serialised across tabs with a Web Lock, because the
 *   backend treats re-use of a rotated refresh token as theft and revokes every session.
 * - On 403 CSRF_FAILED (token rotated by another tab): re-sync via GET /auth/me, retry once.
 */
import createClient from "openapi-fetch";

import { ApiError, NETWORK_ERROR, TIMEOUT_ERROR, type ErrorBody } from "./errors";
import type { paths, Session } from "./types";

export const API_BASE = "/api/backend";

/** Absolute same-origin URL (Request objects outside browsers reject relative URLs). */
export function apiUrl(path: string): string {
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost";
  return `${origin}${path}`;
}
const v1 = (path: string) => apiUrl(`${API_BASE}/api/v1${path}`);
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 95_000;

// ------------------------------------------------------------------ session state (memory only)
let csrfToken: string | null = null;
type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();

export function setSessionFromServer(session: Session | null) {
  csrfToken = session?.csrf_token ?? null;
}
export function getCsrfToken() {
  return csrfToken;
}
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(session: Session | null) {
  csrfToken = session?.csrf_token ?? null;
  listeners.forEach((l) => l(session));
}

let sessionLostHandler: () => void = () => {
  if (typeof window !== "undefined") {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    // Full reload on purpose: drops the in-memory CSRF token and query cache, then the server re-checks the session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/login?next=${next}&expired=1`);
  }
};
export function setSessionLostHandler(handler: () => void) {
  sessionLostHandler = handler;
}

// ------------------------------------------------------------------ low-level fetch
type FetchLike = (input: Request) => Promise<Response>;
let transport: FetchLike = (input) => fetch(input);
/** Test hook. */
export function setTransport(fn: FetchLike) {
  transport = fn;
}

async function readEnvelopeCode(res: Response): Promise<string | null> {
  try {
    const body = await res.clone().json();
    return body?.error?.code ?? null;
  } catch {
    return null;
  }
}

function prepare(req: Request): Request {
  const headers = new Headers(req.headers);
  if (UNSAFE.has(req.method) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const long = /\/voice\//.test(new URL(req.url, "http://x").pathname);
  return new Request(req, {
    headers,
    credentials: "same-origin",
    signal: AbortSignal.timeout(long ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
  });
}

let refreshInFlight: Promise<boolean> | null = null;

async function runRefresh(): Promise<boolean> {
  // Another tab may already have refreshed: the new access cookie then makes /me succeed.
  const me = await transport(new Request(v1("/auth/me"), { credentials: "same-origin" }));
  if (me.ok) {
    const body = await me.json();
    publish(body.data as Session);
    return true;
  }
  const res = await transport(new Request(v1("/auth/refresh"), { method: "POST", credentials: "same-origin" }));
  if (!res.ok) return false;
  const body = await res.json();
  publish(body.data as Session);
  return true;
}

export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const task = locks ? locks.request("kaira-session-refresh", runRefresh) : runRefresh();
    refreshInFlight = Promise.resolve(task)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function syncCsrf(): Promise<void> {
  const res = await transport(new Request(v1("/auth/me"), { credentials: "same-origin" }));
  if (res.ok) publish((await res.json()).data as Session);
}

export const kairaFetch: FetchLike = async (input) => {
  const isAuthCall = /\/auth\/(login|refresh|logout)$/.test(new URL(input.url, "http://x").pathname);
  const retryCopy = input.clone();
  let res = await transport(prepare(input));
  if (isAuthCall) return res;
  if (res.status === 401) {
    const code = await readEnvelopeCode(res);
    if (code === "SESSION_EXPIRED" || code === "UNAUTHENTICATED") {
      if (await refreshSession()) {
        res = await transport(prepare(retryCopy));
      } else {
        publish(null);
        sessionLostHandler();
      }
    }
  } else if (res.status === 403 && (await readEnvelopeCode(res)) === "CSRF_FAILED") {
    await syncCsrf();
    res = await transport(prepare(retryCopy));
  }
  return res;
};

export const api = createClient<paths>({ baseUrl: apiUrl(API_BASE), fetch: kairaFetch });

// ------------------------------------------------------------------ envelope handling
type Envelope<T> = { success: boolean; data?: T | null; error?: ErrorBody | null };
type ClientResult<T> = { data?: Envelope<T>; error?: unknown; response: Response };

/**
 * Turns an openapi-fetch result into the payload, or throws ApiError. A response only counts as
 * success when the HTTP status is 2xx AND the envelope says success with data present.
 */
export async function unwrap<T>(promise: Promise<ClientResult<T>>): Promise<T> {
  let result: ClientResult<T>;
  try {
    result = await promise;
  } catch (error) {
    const name = (error as Error)?.name;
    throw new ApiError(0, name === "TimeoutError" || name === "AbortError" ? TIMEOUT_ERROR : NETWORK_ERROR);
  }
  const { data, error, response } = result;
  const requestId = response.headers.get("x-request-id");
  if (response.ok && data && data.success === true && data.data !== undefined && data.data !== null) {
    return data.data;
  }
  const body = (error ?? data) as Envelope<T> | undefined;
  if (body && typeof body === "object" && body.error && typeof body.error.code === "string") {
    throw new ApiError(response.status, body.error, requestId);
  }
  throw new ApiError(
    response.status,
    {
      code: response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR",
      message: response.ok
        ? "KAIRA returned an unexpected response."
        : `Request failed (HTTP ${response.status}).`,
    },
    requestId,
  );
}

// ------------------------------------------------------------------ auth helpers
export async function login(email: string, password: string): Promise<Session> {
  const session = await unwrap(api.POST("/api/v1/auth/login", { body: { email, password } }));
  publish(session);
  return session;
}

export async function logout(): Promise<void> {
  try {
    await unwrap(api.POST("/api/v1/auth/logout"));
  } finally {
    publish(null);
  }
}

/** New idempotency key per user submission; reuse it when retrying the same submission. */
export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
