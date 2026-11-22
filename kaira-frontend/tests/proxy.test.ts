// @vitest-environment node
/**
 * Security and fidelity tests for the same-origin backend proxy (lib/server/proxy.ts), through which
 * every browser API call passes. Runs in the Node environment (pragma above) because the proxy is
 * server code relying on Node's fetch primitives such as Headers.getSetCookie(). The backend is
 * replaced by an injected fetchImpl, so no network is used.
 */
import { describe, expect, it, vi } from "vitest";

import {
  forwardedRequestHeaders,
  LONG_UPSTREAM_TIMEOUT_MS,
  proxyToBackend,
  rewriteSetCookie,
  trustedClientIp,
  upstreamPath,
  upstreamTimeoutMs,
} from "@/lib/server/proxy";

// Internal-looking host on purpose: the outage test asserts this name never appears in a response body.
const ORIGIN = "http://backend.internal:8000";

/** Fake backend response; cookies are appended one by one so several Set-Cookie headers exist, as from the real backend. */
function upstream(body: BodyInit | null, init: ResponseInit & { cookies?: string[] } = {}) {
  const headers = new Headers(init.headers);
  for (const c of init.cookies ?? []) headers.append("set-cookie", c);
  return new Response(body, { status: init.status ?? 200, headers });
}

// Cookie rewriting keeps auth cookies first-party: the browser only sees /api/backend/... paths, and a backend Domain must never pin a cookie to the backend host.
describe("rewriteSetCookie", () => {
  // The refresh cookie must be scoped to the proxied auth path, or the browser would never send it to /api/backend/api/v1/auth/refresh.
  it("rewrites API paths to the proxy prefix and keeps security attributes", () => {
    const out = rewriteSetCookie("kaira_refresh=abc; HttpOnly; Max-Age=604800; Path=/api/v1/auth; SameSite=lax; Secure");
    expect(out).toBe("kaira_refresh=abc; HttpOnly; Max-Age=604800; Path=/api/backend/api/v1/auth; SameSite=lax; Secure");
  });
  it("leaves Path=/ untouched and strips Domain", () => {
    expect(rewriteSetCookie("kaira_access=t; Domain=api.example.com; HttpOnly; Path=/; SameSite=none; Secure")).toBe(
      "kaira_access=t; HttpOnly; Path=/; SameSite=none; Secure",
    );
  });
});

// Path allow-list: the proxy must not relay to backend docs, the OpenAPI spec, other API versions or ".." traversal.
describe("upstreamPath", () => {
  it("allows only /api/v1 paths", () => {
    expect(upstreamPath(["api", "v1", "customers"])).toBe("api/v1/customers");
    expect(upstreamPath(["docs"])).toBeNull();
    expect(upstreamPath(["openapi.json"])).toBeNull();
    expect(upstreamPath(["api", "v1", "..", "..", "admin"])).toBeNull();
    expect(upstreamPath(["api", "v2", "x"])).toBeNull();
  });
});

// Header allow-list: client-supplied Authorization, Host and X-Forwarded-* are dropped (no token injection or host spoofing); X-Forwarded-For comes only from the clientIp argument.
describe("forwardedRequestHeaders", () => {
  it("forwards only the allow-listed headers", () => {
    const h = forwardedRequestHeaders(
      new Headers({
        cookie: "kaira_access=a",
        "x-csrf-token": "c",
        "idempotency-key": "k",
        "content-type": "application/json",
        authorization: "Bearer attacker",
        host: "evil.example",
        "x-forwarded-host": "evil",
      }),
      "10.0.0.5",
    );
    expect(h.get("cookie")).toBe("kaira_access=a");
    expect(h.get("x-csrf-token")).toBe("c");
    expect(h.get("idempotency-key")).toBe("k");
    expect(h.get("authorization")).toBeNull();
    expect(h.get("host")).toBeNull();
    expect(h.get("x-forwarded-for")).toBe("10.0.0.5");
  });
});

// Full proxied calls with the upstream fetch mocked.
describe("proxyToBackend", () => {
  // Backend status codes and error envelopes reach the client unchanged; responses are forced to no-store so authenticated data is not cached.
  it("forwards method, query, headers and JSON body; preserves status and envelope", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe(`${ORIGIN}/api/v1/customers?search=ram&page=2`);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Headers;
      expect(headers.get("x-csrf-token")).toBe("csrf-1");
      expect(headers.get("cookie")).toBe("kaira_access=tok");
      expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe('{"name":"Ramesh"}');
      return upstream(JSON.stringify({ success: false, data: null, error: { code: "VALIDATION_ERROR" } }), {
        status: 422,
        headers: { "content-type": "application/json", "x-request-id": "rid-1" },
      });
    });
    const req = new Request("http://app.local/api/backend/api/v1/customers?search=ram&page=2", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-1", cookie: "kaira_access=tok" },
      body: '{"name":"Ramesh"}',
    });
    const res = await proxyToBackend(req, ["api", "v1", "customers"], { origin: ORIGIN, timeoutMs: 1000, fetchImpl });
    expect(res.status).toBe(422);
    expect(res.headers.get("x-request-id")).toBe("rid-1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  // Login sets two cookies; joining Set-Cookie values with commas is ambiguous (Expires dates contain commas), so each must stay a separate header.
  it("keeps multiple Set-Cookie headers separate (never comma-joined) and rewrites paths", async () => {
    const fetchImpl = vi.fn(async () =>
      upstream("{}", {
        headers: { "content-type": "application/json" },
        cookies: [
          "kaira_access=AAA; HttpOnly; Max-Age=900; Path=/; SameSite=lax",
          "kaira_refresh=BBB; HttpOnly; Max-Age=604800; Path=/api/v1/auth; SameSite=lax",
        ],
      }),
    );
    const res = await proxyToBackend(new Request("http://app.local/x", { method: "POST" }), ["api", "v1", "auth", "login"], {
      origin: ORIGIN,
      timeoutMs: 1000,
      fetchImpl,
    });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe("kaira_access=AAA; HttpOnly; Max-Age=900; Path=/; SameSite=lax");
    expect(cookies[1]).toBe("kaira_refresh=BBB; HttpOnly; Max-Age=604800; Path=/api/backend/api/v1/auth; SameSite=lax");
  });

  // Voice upload: the body is forwarded as raw bytes, so the multipart boundary in Content-Type still matches the payload.
  it("forwards multipart audio uploads byte-for-byte with the original boundary", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: "audio/webm" }), "rec.webm");
    form.append("language_code", "te-IN");
    const original = new Request("http://app.local/api/backend/api/v1/voice/transcribe", { method: "POST", body: form });
    // Expected bytes come from a clone so `original` still has an unread body when the proxy consumes it;
    // the boundary is generated by Request, so it is read back rather than hard-coded.
    const expectedBytes = new Uint8Array(await original.clone().arrayBuffer());
    const contentType = original.headers.get("content-type")!;
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect((init?.headers as Headers).get("content-type")).toBe(contentType);
      expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(expectedBytes);
      return upstream(JSON.stringify({ success: true, data: { transcript: "x" }, error: null }), { headers: { "content-type": "application/json" } });
    });
    const res = await proxyToBackend(original, ["api", "v1", "voice", "transcribe"], { origin: ORIGIN, timeoutMs: 1000, fetchImpl });
    expect(res.status).toBe(200);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  // TTS audio comes back as binary; it must pass through without any text decoding.
  it("passes binary response bodies through unchanged", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 128]);
    const fetchImpl = vi.fn(async () => upstream(bytes, { headers: { "content-type": "audio/wav" } }));
    const res = await proxyToBackend(new Request("http://app.local/x"), ["api", "v1", "voice", "speak"], { origin: ORIGIN, timeoutMs: 1000, fetchImpl });
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  // Backend down -> 502 in the standard envelope, without exposing the internal BACKEND_ORIGIN host to the browser.
  it("returns BACKEND_UNAVAILABLE when the backend cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await proxyToBackend(new Request("http://app.local/x"), ["api", "v1", "dashboard"], { origin: ORIGIN, timeoutMs: 1000, fetchImpl });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, data: null, error: { code: "BACKEND_UNAVAILABLE" } });
    expect(JSON.stringify(body)).not.toContain("backend.internal"); // internal URL is never leaked
  });

  // Timeouts are distinguished from outages (504 BACKEND_TIMEOUT vs 502 BACKEND_UNAVAILABLE).
  it("returns BACKEND_TIMEOUT when the backend is too slow", async () => {
    // Throws the same DOMException name that AbortSignal.timeout() produces inside the proxy, so no real wait is needed.
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const res = await proxyToBackend(new Request("http://app.local/x"), ["api", "v1", "dashboard"], { origin: ORIGIN, timeoutMs: 10, fetchImpl });
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("BACKEND_TIMEOUT");
  });

  // Disallowed paths are rejected locally with 404 before any upstream request is made.
  it("refuses paths outside /api/v1 without calling the backend", async () => {
    // A bare spy with no implementation: the only expectation is that it is never invoked.
    const fetchImpl = vi.fn();
    const res = await proxyToBackend(new Request("http://app.local/x"), ["docs"], { origin: ORIGIN, timeoutMs: 10, fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Regressions found by probing the production server (Next decodes catch-all segments before the route sees them).
describe("path decoding", () => {
  it("never decodes a second time: a literal '%74' segment is not turned into 't'", () => {
    // The browser sent "heal%2574h"; Next passes "heal%74h". Re-decoding would route to /health.
    expect(upstreamPath(["api", "v1", "heal%74h"])).toBeNull();
  });
  it("answers a malformed escape with the 404 envelope instead of throwing (was HTTP 500)", async () => {
    const fetchImpl = vi.fn();
    for (const seg of ["%E0%A4%A", "%", "%zz"]) {
      expect(() => upstreamPath(["api", "v1", seg])).not.toThrow();
      const res = await proxyToBackend(new Request("http://app.local/x"), ["api", "v1", seg], { origin: ORIGIN, timeoutMs: 10, fetchImpl });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("still encodes legitimate decoded segments exactly once", () => {
    expect(upstreamPath(["api", "v1", "customers", "3f2c-11"])).toBe("api/v1/customers/3f2c-11");
  });
});

describe("trustedClientIp", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("ignores every browser-supplied forwarding header when no trusted header is configured", () => {
    expect(trustedClientIp(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }), null)).toBeNull();
  });
  it("takes the rightmost X-Forwarded-For hop (appended by the trusted proxy), not the spoofable leftmost", () => {
    expect(trustedClientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), "x-forwarded-for")).toBe("203.0.113.9");
  });
  it("reads a single-value header such as X-Real-IP and rejects anything that is not an IP", () => {
    expect(trustedClientIp(h({ "x-real-ip": "198.51.100.7" }), "x-real-ip")).toBe("198.51.100.7");
    expect(trustedClientIp(h({ "x-real-ip": "2001:db8::1" }), "x-real-ip")).toBe("2001:db8::1");
    expect(trustedClientIp(h({ "x-real-ip": "evil; DROP" }), "x-real-ip")).toBeNull();
    expect(trustedClientIp(h({ "x-real-ip": "999.1.1.1" }), "x-real-ip")).toBeNull();
  });
  it("never copies incoming forwarding headers upstream; only the trusted address is set", async () => {
    let seen: Headers | null = null;
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return upstream("{}", { headers: { "content-type": "application/json" } });
    });
    const req = new Request("http://app.local/x", { headers: { "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6", forwarded: "for=6.6.6.6" } });
    await proxyToBackend(req, ["api", "v1", "dashboard"], { origin: ORIGIN, timeoutMs: 1000, fetchImpl, clientIp: null });
    expect(seen!.get("x-forwarded-for")).toBeNull();
    expect(seen!.get("x-real-ip")).toBeNull();
    expect(seen!.get("forwarded")).toBeNull();
  });
});

describe("root proxy (middleware) for /api/backend", () => {
  it("answers malformed percent-encoding with a 400 envelope before Next's own param decoding (which would 500)", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const bad = proxy(new NextRequest("http://app.local/api/backend/api/v1/%E0%A4%A"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("BAD_REQUEST_PATH");
    // Well-formed API calls pass through without the page login redirect (the backend answers 401 itself).
    const ok = proxy(new NextRequest("http://app.local/api/backend/api/v1/auth/me"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("location")).toBeNull();
  });
});

// The backend allows a typed agent turn up to AGENT_TURN_TIMEOUT_SECONDS = 60 s; a 30 s proxy cut-off would turn a
// slow but successful turn into a 504 that the user then retries.
describe("upstream timeouts", () => {
  it("gives voice calls and POST /agent/turn at least 90 s, everything else the default", () => {
    expect(LONG_UPSTREAM_TIMEOUT_MS).toBe(90_000);
    expect(upstreamTimeoutMs("api/v1/agent/turn", 30_000)).toBe(90_000);
    expect(upstreamTimeoutMs("api/v1/voice/transcribe", 30_000)).toBe(90_000);
    expect(upstreamTimeoutMs("api/v1/voice/speak", 30_000)).toBe(90_000);
    expect(upstreamTimeoutMs("api/v1/agent/turn", 120_000)).toBe(120_000); // a larger configured default wins
    expect(upstreamTimeoutMs("api/v1/agent/conversation", 30_000)).toBe(30_000);
    expect(upstreamTimeoutMs("api/v1/agent/session", 30_000)).toBe(30_000);
    expect(upstreamTimeoutMs("api/v1/dashboard", 30_000)).toBe(30_000);
  });

  it("applies the long budget to the upstream fetch of an agent turn", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchImpl = vi.fn(async () => upstream(JSON.stringify({ success: true, data: {}, error: null }), { headers: { "content-type": "application/json" } }));
      const req = new Request("http://app.local/api/backend/api/v1/agent/turn", { method: "POST", body: "{}" });
      await proxyToBackend(req, ["api", "v1", "agent", "turn"], { origin: ORIGIN, timeoutMs: 30_000, fetchImpl });
      expect(spy).toHaveBeenCalledWith(90_000);
    } finally {
      spy.mockRestore();
    }
  });
});
