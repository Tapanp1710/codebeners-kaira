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
 *
 * Layers, bottom to top: `transport` (plain fetch, swappable in tests) -> `kairaFetch` (CSRF header,
 * timeouts, refresh/CSRF retry) -> `api` (typed openapi-fetch client over lib/api/types `paths`) ->
 * `unwrap()` (envelope -> payload or ApiError). Consumers: lib/api/hooks.ts, lib/agent/api.ts,
 * components/providers.tsx (session seeding/listening) and components/auth/login-form.tsx.
 * Module-level state below is per browser tab and is reset by any full page load.
 */
import createClient from "openapi-fetch";

import { ApiError, NETWORK_ERROR, TIMEOUT_ERROR, type ErrorBody } from "./errors";
import type { paths, Session } from "./types";

export const API_BASE = "/api/backend";

/** Absolute same-origin URL (Request objects outside browsers reject relative URLs). */
export function apiUrl(path: string): string {
  // Outside a browser (SSR import, Vitest) falls back to http://localhost; only the path matters to the proxy.
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost";
  return `${origin}${path}`;
}
const v1 = (path: string) => apiUrl(`${API_BASE}/api/v1${path}`);
// Methods that require X-CSRF-Token on the backend.
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Browser-side timeouts: 30 s normally, 95 s for /voice/ (just above the proxy's 90 s voice timeout).
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 95_000;

// ------------------------------------------------------------------ session state (memory only)
// Deliberately not persisted (no localStorage/cookie): a reload drops it and the server layout re-seeds it.
let csrfToken: string | null = null;
type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();

/**
 * Seeds the CSRF token from the session resolved on the server (app/(app)/layout.tsx -> Providers).
 * Does not notify listeners: the provider that calls it already holds the same session.
 */
export function setSessionFromServer(session: Session | null) {
  csrfToken = session?.csrf_token ?? null;
}
export function getCsrfToken() {
  return csrfToken;
}
/** Subscribes to session changes (login, refresh, CSRF re-sync, logout/loss). Returns an unsubscribe function. */
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
// Single place where a new session (or null) is applied: updates the CSRF token, then notifies React.
function publish(session: Session | null) {
  csrfToken = session?.csrf_token ?? null;
  listeners.forEach((l) => l(session));
}

// Called when refresh fails during a request. Replaceable (e.g. in tests) via setSessionLostHandler.
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

// Peeks at the envelope's error.code without consuming the body (clone), so callers can still read it.
async function readEnvelopeCode(res: Response): Promise<string | null> {
  try {
    const body = await res.clone().json();
    return body?.error?.code ?? null;
  } catch {
    return null;
  }
}

// Decorates a request just before it is sent: CSRF header on unsafe methods (only if a token is known),
// same-origin credentials so the HttpOnly cookies are attached, and a fresh timeout signal per attempt.
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

// The pending refresh for this tab, shared by every request that hits a 401 at the same time.
let refreshInFlight: Promise<boolean> | null = null;

// One refresh attempt. These requests use `transport` directly (no prepare/kairaFetch), so they carry no
// CSRF header (the contract does not require one for refresh), have no client timeout, and never recurse.
async function runRefresh(): Promise<boolean> {
  // Another tab may already have refreshed: the new access cookie then makes /me succeed.
  const me = await transport(new Request(v1("/auth/me"), { credentials: "same-origin" }));
  if (me.ok) {
    const body = await me.json();
    publish(body.data as Session);
    return true;
  }
  // Rotates both cookies (the refresh cookie is scoped to /api/backend/api/v1/auth by the proxy rewrite)
  // and returns a new csrf_token, which publish() stores.
  const res = await transport(new Request(v1("/auth/refresh"), { method: "POST", credentials: "same-origin" }));
  if (!res.ok) return false;
  const body = await res.json();
  publish(body.data as Session);
  return true;
}

/**
 * Refreshes the session at most once at a time. Within a tab, concurrent callers share one promise;
 * across tabs, the "kaira-session-refresh" Web Lock makes refreshes run one after another, and the
 * /auth/me probe in runRefresh() lets a waiting tab reuse a refresh another tab just completed.
 * Resolves true on success, false on any failure (errors are swallowed). Without Web Locks it runs unlocked.
 * Also called by the login page for a silent resume (resume=1).
 */
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

// Re-reads the current session (and its CSRF token) after a CSRF_FAILED; failures are ignored here.
async function syncCsrf(): Promise<void> {
  const res = await transport(new Request(v1("/auth/me"), { credentials: "same-origin" }));
  if (res.ok) publish((await res.json()).data as Session);
}

/**
 * fetch wrapper used by every API call. Sends the request once and, at most once, recovers:
 * - 401 with SESSION_EXPIRED/UNAUTHENTICATED -> refreshSession(), then replay; if refresh fails the
 *   session is cleared and sessionLostHandler() navigates to /login?expired=1.
 * - 403 with CSRF_FAILED -> syncCsrf(), then replay (whether or not the re-sync succeeded).
 * Any other response (including other 401/403 codes) is returned unchanged for unwrap() to map.
 */
export const kairaFetch: FetchLike = async (input) => {
  // login/refresh/logout responses are returned as-is: a 401 there is a real answer, and retrying
  // refresh would risk re-using a rotated refresh token.
  const isAuthCall = /\/auth\/(login|refresh|logout)$/.test(new URL(input.url, "http://x").pathname);
  // Cloned before the first send because a Request body can only be consumed once.
  const retryCopy = input.clone();
  let res = await transport(prepare(input));
  if (isAuthCall) return res;
  if (res.status === 401) {
    const code = await readEnvelopeCode(res);
    if (code === "SESSION_EXPIRED" || code === "UNAUTHENTICATED") {
      if (await refreshSession()) {
        // prepare() runs again, so the replay carries the new CSRF token and a new timeout.
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

// Typed client: paths, params and bodies are checked against the generated contract; baseUrl is the proxy prefix.
export const api = createClient<paths>({ baseUrl: apiUrl(API_BASE), fetch: kairaFetch });

// ------------------------------------------------------------------ envelope handling
// Backend envelope: { success, data, error }. openapi-fetch puts a parsed 2xx body in `data` and a
// parsed non-2xx body in `error`.
type Envelope<T> = { success: boolean; data?: T | null; error?: ErrorBody | null };
type ClientResult<T> = { data?: Envelope<T>; error?: unknown; response: Response };

/**
 * Turns an openapi-fetch result into the payload, or throws ApiError. A response only counts as
 * success when the HTTP status is 2xx AND the envelope says success with data present.
 *
 * Error mapping:
 * - promise rejected (no response) -> status 0, REQUEST_TIMEOUT or NETWORK_ERROR;
 * - envelope with error.code -> that code/message/details, with the HTTP status and X-Request-ID;
 * - anything else -> INVALID_RESPONSE (2xx with a bad body) or HTTP_ERROR (non-2xx without an envelope).
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
  // A 2xx with success:false or null data is NOT treated as success.
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
/** Logs in; the backend sets the HttpOnly cookies via the proxy, and the returned session's CSRF token is published. */
export async function login(email: string, password: string): Promise<Session> {
  const session = await unwrap(api.POST("/api/v1/auth/login", { body: { email, password } }));
  publish(session);
  return session;
}

/** Logs out on the backend (revokes the refresh token, clears cookies); local state is cleared even if that call fails. */
export async function logout(): Promise<void> {
  try {
    await unwrap(api.POST("/api/v1/auth/logout"));
  } finally {
    publish(null);
  }
}

/** New idempotency key per user submission; reuse it when retrying the same submission. */
export function newIdempotencyKey(): string {
  // crypto.randomUUID needs a secure context (HTTPS or localhost); the fallback is unique enough per
  // submission but not cryptographically random.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
