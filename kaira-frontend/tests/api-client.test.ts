/**
 * Contract tests for the browser API client (lib/api/client.ts).
 *
 * The real transport is swapped via setTransport(), so no network or backend is needed and every
 * outgoing Request is captured in `calls`. These tests pin down what the whole UI relies on: the
 * {success, data, error} envelope is the only source of truth, the CSRF token lives in memory and is
 * sent only on unsafe methods, and an expired session is refreshed exactly once (the backend treats
 * reuse of a rotated refresh token as theft and revokes every session).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  DEFAULT_TIMEOUT_MS,
  kairaFetch,
  login,
  LONG_TIMEOUT_MS,
  refreshSession,
  requestTimeoutMs,
  setSessionFromServer,
  setSessionLostHandler,
  setTransport,
  unwrap,
} from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";

// Builders for the backend's response envelope (success and error forms); errors carry an X-Request-ID.
const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: true, data, error: null }), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (status: number, code: string, message = code) =>
  new Response(JSON.stringify({ success: false, data: null, error: { code, message, details: null } }), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "rid-9" },
  });
// Minimal Session: only csrf_token matters to the client logic under test.
const session = (csrf: string) => ({ csrf_token: csrf, user: { role: "owner" }, business: {} });

type Handler = (req: Request) => Response | Promise<Response>;
let calls: Request[] = [];
/** Installs a fake transport for one test and resets the captured request list. */
function route(handler: Handler) {
  calls = [];
  setTransport(async (req) => {
    calls.push(req.clone());
    return handler(req);
  });
}

// Each test starts with a known CSRF token and a no-op session-lost handler (the real one reloads the page).
beforeEach(() => {
  setSessionFromServer(session("csrf-0") as never);
  setSessionLostHandler(() => {});
});

// unwrap() decides what counts as success. Screens trust its result, so a misread envelope would show wrong figures or hide errors.
describe("unwrap", () => {
  it("returns data for a success envelope", async () => {
    route(() => ok({ total: 1 }));
    await expect(unwrap(api.GET("/api/v1/insights"))).resolves.toEqual({ total: 1 });
  });

  it("throws ApiError with code, message, status and request id for an error envelope", async () => {
    route(() => fail(422, "OVERPAYMENT", "Payment exceeds the outstanding balance."));
    const err = await unwrap(api.GET("/api/v1/insights")).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "OVERPAYMENT", status: 422, requestId: "rid-9", message: "Payment exceeds the outstanding balance." });
  });

  // HTTP 200 alone is not success: the envelope's success flag must be true as well.
  it("never treats a 200 without success=true as success", async () => {
    route(() => new Response(JSON.stringify({ success: false, data: null, error: null }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(unwrap(api.GET("/api/v1/insights"))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  // A proxy or gateway HTML error page must still become an ApiError carrying the HTTP status.
  it("handles non-JSON server errors", async () => {
    route(() => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(unwrap(api.GET("/api/v1/insights"))).rejects.toMatchObject({ status: 502 });
  });

  // Transport exceptions become status-0 ApiErrors with distinct codes, so the UI can tell "cannot reach" from "timed out".
  it("maps network failures and timeouts to readable errors", async () => {
    route(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(unwrap(api.GET("/api/v1/insights"))).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    route(() => {
      throw new DOMException("timeout", "TimeoutError");
    });
    await expect(unwrap(api.GET("/api/v1/insights"))).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  // Pydantic-style `loc` arrays map to form field names, with the "Value error, " prefix stripped for display.
  it("exposes field errors from VALIDATION_ERROR details", () => {
    const err = new ApiError(422, {
      code: "VALIDATION_ERROR",
      message: "invalid",
      details: { errors: [{ loc: ["body", "email"], msg: "Value error, not an email", type: "value_error" }] },
    });
    expect(err.fieldErrors()).toEqual({ email: "not an email" });
  });
});

// Session/CSRF handling. A regression would break every write (missing token), leak the token to GETs, or reuse a refresh token.
describe("CSRF and sessions", () => {
  it("sends X-CSRF-Token on unsafe methods only, from memory", async () => {
    route(() => ok({}));
    await kairaFetch(new Request("http://localhost/api/backend/api/v1/dashboard"));
    await kairaFetch(new Request("http://localhost/api/backend/api/v1/customers", { method: "POST", body: "{}" }));
    expect(calls[0].headers.get("x-csrf-token")).toBeNull();
    expect(calls[1].headers.get("x-csrf-token")).toBe("csrf-0");
  });

  it("login stores the new CSRF token in memory", async () => {
    route(() => ok(session("csrf-login")));
    await login("demo@kaira.local", "pw");
    route(() => ok({}));
    await kairaFetch(new Request("http://localhost/api/backend/api/v1/customers", { method: "POST" }));
    expect(calls[0].headers.get("x-csrf-token")).toBe("csrf-login");
  });

  // Expected order: call fails -> /auth/me (another tab may already have refreshed) -> /auth/refresh -> one retry with the rotated token and original body.
  it("refreshes once on SESSION_EXPIRED and retries with the rotated CSRF token", async () => {
    let expired = true;
    route((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/auth/me")) return fail(401, "SESSION_EXPIRED");
      if (path.endsWith("/auth/refresh")) {
        expired = false;
        return ok(session("csrf-rotated"));
      }
      return expired ? fail(401, "SESSION_EXPIRED") : ok({ id: "c1" }, 201);
    });
    const data = await unwrap(api.POST("/api/v1/customers", { body: { name: "Ramesh" } }));
    expect(data).toEqual({ id: "c1" });
    const paths = calls.map((r) => `${r.method} ${new URL(r.url).pathname.replace("/api/backend/api/v1", "")}`);
    expect(paths).toEqual(["POST /customers", "GET /auth/me", "POST /auth/refresh", "POST /customers"]);
    expect(calls[3].headers.get("x-csrf-token")).toBe("csrf-rotated");
    expect(await calls[3].text()).toBe('{"name":"Ramesh"}'); // body preserved on retry
  });

  // Three callers hit an expired session at once; the shared in-flight promise must issue a single /auth/refresh.
  it("de-duplicates concurrent refreshes (refresh tokens are single-use)", async () => {
    let refreshes = 0;
    let fresh = false;
    route(async (req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/auth/me")) return fresh ? ok(session("c2")) : fail(401, "SESSION_EXPIRED");
      if (path.endsWith("/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        fresh = true;
        return ok(session("c2"));
      }
      return fresh ? ok([]) : fail(401, "SESSION_EXPIRED");
    });
    await Promise.all([unwrap(api.GET("/api/v1/insights")), unwrap(api.GET("/api/v1/insights")), refreshSession()]);
    expect(refreshes).toBe(1);
  });

  // When refresh fails the client must give up (the handler sends the user to login) instead of looping.
  it("calls the session-lost handler when refresh fails", async () => {
    const lost = vi.fn();
    setSessionLostHandler(lost);
    route(() => fail(401, "SESSION_EXPIRED"));
    await expect(unwrap(api.GET("/api/v1/dashboard"))).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledOnce();
  });

  // CSRF_FAILED means the token was rotated elsewhere (e.g. another tab): re-read it from /auth/me and retry once.
  it("re-syncs the CSRF token after CSRF_FAILED and retries once", async () => {
    let first = true;
    route((req) => {
      if (new URL(req.url).pathname.endsWith("/auth/me")) return ok(session("csrf-synced"));
      if (first) {
        first = false;
        return fail(403, "CSRF_FAILED");
      }
      return ok({ ok: true });
    });
    await expect(unwrap(api.POST("/api/v1/customers", { body: { name: "x" } }))).resolves.toEqual({ ok: true });
    expect(calls.at(-1)!.headers.get("x-csrf-token")).toBe("csrf-synced");
  });

  // Other 403s, such as a staff user calling an owner-only endpoint, are final: exactly one request, no retry.
  it("does not retry a CSRF/role rejection that is not CSRF_FAILED", async () => {
    route(() => fail(403, "FORBIDDEN", "Only the business owner can perform this action."));
    await expect(unwrap(api.POST("/api/v1/actions/{action_id}/approve", { params: { path: { action_id: "a" } } }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toHaveLength(1);
  });

  // The caller's Idempotency-Key must reach the wire so a retried payment is not recorded twice.
  it("sends the Idempotency-Key header for payments", async () => {
    route(() => ok({}, 201));
    await unwrap(
      api.POST("/api/v1/invoices/{invoice_id}/payments", {
        params: { path: { invoice_id: "i1" }, header: { "Idempotency-Key": "key-123" } },
        body: { amount: "100.00", payment_method: "cash" },
      }),
    );
    expect(calls[0].headers.get("idempotency-key")).toBe("key-123");
  });
});

// POST /agent/turn may legitimately take up to the backend's 60 s turn budget; it must not be cut at 30 s.
describe("request timeouts", () => {
  it("waits longer than the proxy's 90 s for voice calls and typed agent turns only", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(LONG_TIMEOUT_MS).toBeGreaterThan(90_000);
    expect(requestTimeoutMs("/api/backend/api/v1/agent/turn")).toBe(LONG_TIMEOUT_MS);
    expect(requestTimeoutMs("/api/backend/api/v1/voice/transcribe")).toBe(LONG_TIMEOUT_MS);
    expect(requestTimeoutMs("/api/backend/api/v1/agent/conversation")).toBe(DEFAULT_TIMEOUT_MS);
    expect(requestTimeoutMs("/api/backend/api/v1/agent/session")).toBe(DEFAULT_TIMEOUT_MS);
    expect(requestTimeoutMs("/api/backend/api/v1/insights")).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("puts the long timeout on the outgoing agent turn request", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      route(() => ok({ reply: "hi", events: [] }));
      await api.POST("/api/v1/agent/turn", { body: { text: "hello", turn_id: "t1", language: null } });
      expect(spy).toHaveBeenCalledWith(LONG_TIMEOUT_MS);
      expect(spy).not.toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
});
