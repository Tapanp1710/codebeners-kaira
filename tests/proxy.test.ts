// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { forwardedRequestHeaders, proxyToBackend, rewriteSetCookie, upstreamPath } from "@/lib/server/proxy";

const ORIGIN = "http://backend.internal:8000";

function upstream(body: BodyInit | null, init: ResponseInit & { cookies?: string[] } = {}) {
  const headers = new Headers(init.headers);
  for (const c of init.cookies ?? []) headers.append("set-cookie", c);
  return new Response(body, { status: init.status ?? 200, headers });
}

describe("rewriteSetCookie", () => {
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

describe("upstreamPath", () => {
  it("allows only /api/v1 paths", () => {
    expect(upstreamPath(["api", "v1", "customers"])).toBe("api/v1/customers");
    expect(upstreamPath(["docs"])).toBeNull();
    expect(upstreamPath(["openapi.json"])).toBeNull();
    expect(upstreamPath(["api", "v1", "..", "..", "admin"])).toBeNull();
    expect(upstreamPath(["api", "v2", "x"])).toBeNull();
  });
});

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

describe("proxyToBackend", () => {
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

  it("forwards multipart audio uploads byte-for-byte with the original boundary", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: "audio/webm" }), "rec.webm");
    form.append("language_code", "te-IN");
    const original = new Request("http://app.local/api/backend/api/v1/voice/transcribe", { method: "POST", body: form });
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

  it("passes binary response bodies through unchanged", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 128]);
    const fetchImpl = vi.fn(async () => upstream(bytes, { headers: { "content-type": "audio/wav" } }));
    const res = await proxyToBackend(new Request("http://app.local/x"), ["api", "v1", "voice", "speak"], { origin: ORIGIN, timeoutMs: 1000, fetchImpl });
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

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

  it("returns BACKEND_TIMEOUT when the backend is too slow", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const res = await proxyToBackend(new Request("http://app.local/x"), ["api", "v1", "dashboard"], { origin: ORIGIN, timeoutMs: 10, fetchImpl });
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("BACKEND_TIMEOUT");
  });

  it("refuses paths outside /api/v1 without calling the backend", async () => {
    const fetchImpl = vi.fn();
    const res = await proxyToBackend(new Request("http://app.local/x"), ["docs"], { origin: ORIGIN, timeoutMs: 10, fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
