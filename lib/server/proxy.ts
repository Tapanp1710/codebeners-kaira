/**
 * Same-origin backend proxy (Backend-for-Frontend).
 *
 * Browser  --/api/backend/api/v1/...-->  Next.js server  --/api/v1/...-->  KAIRA backend
 *
 * Why: frontend and backend run on different origins (often different laptops). Cookies set by the
 * backend would be third-party / cross-site for the browser. Proxying keeps every cookie first-party.
 *
 * Contract facts used here (contracts/API_CONTRACT.md):
 *   cookies   kaira_access (Path=/), kaira_refresh (Path=/api/v1/auth), both HttpOnly
 *   headers   X-CSRF-Token (unsafe methods), Idempotency-Key (payments), X-Request-ID
 */

export const PROXY_PREFIX = "/api/backend";
const ALLOWED_PATH = /^api\/v1\/[A-Za-z0-9._~\-/]*$/;

const FORWARD_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "cookie",
  "x-csrf-token",
  "idempotency-key",
  "x-request-id",
  "user-agent",
];
const FORWARD_RESPONSE_HEADERS = ["content-type", "x-request-id", "retry-after", "content-disposition"];

export type ProxyOptions = {
  origin: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  clientIp?: string | null;
};

function envelopeError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, data: null, error: { code, message, details: null } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Rewrites one backend Set-Cookie header for the proxy origin:
 * - Path=/api/v1/... becomes Path=/api/backend/api/v1/... (the browser only ever sees proxied paths),
 * - Domain is removed so the cookie binds to the frontend host.
 * All other attributes (HttpOnly, Secure, SameSite, Max-Age, Expires) are preserved unchanged.
 */
export function rewriteSetCookie(header: string): string {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part))
    .map((part) => {
      const match = /^path=(.*)$/i.exec(part);
      if (match && match[1].startsWith("/api/")) return `Path=${PROXY_PREFIX}${match[1]}`;
      return part;
    })
    .join("; ");
}

/** Joins the catch-all segments and validates them against the allow-list. */
export function upstreamPath(segments: string[]): string | null {
  const path = segments.map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
  if (segments.some((s) => s === ".." || s === ".")) return null;
  return ALLOWED_PATH.test(path) ? path : null;
}

export function forwardedRequestHeaders(incoming: Headers, clientIp?: string | null): Headers {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  return headers;
}

export async function proxyToBackend(request: Request, segments: string[], options: ProxyOptions): Promise<Response> {
  const path = upstreamPath(segments);
  if (!path) return envelopeError(404, "NOT_FOUND", "Unknown API path.");

  const incoming = new URL(request.url);
  const target = new URL(`/${path}`, options.origin);
  target.search = incoming.search;

  const method = request.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  // Raw bytes: preserves JSON exactly and multipart bodies (with their boundary) for audio uploads.
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const isAudio = path.endsWith("voice/transcribe") || path.endsWith("voice/speak");
  const timeout = isAudio ? Math.max(options.timeoutMs, 90_000) : options.timeoutMs;
  const doFetch = options.fetchImpl ?? fetch;

  let upstream: Response;
  try {
    upstream = await doFetch(target, {
      method,
      headers: forwardedRequestHeaders(request.headers, options.clientIp),
      body: body && body.byteLength > 0 ? body : hasBody ? new ArrayBuffer(0) : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return envelopeError(504, "BACKEND_TIMEOUT", "The KAIRA server took too long to respond. Please try again.");
    }
    return envelopeError(
      502,
      "BACKEND_UNAVAILABLE",
      "The KAIRA server is not reachable. Check that the backend is running and BACKEND_ORIGIN is correct.",
    );
  }

  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Each cookie is appended separately - never joined into one comma-separated header.
  for (const cookie of upstream.headers.getSetCookie()) {
    headers.append("set-cookie", rewriteSetCookie(cookie));
  }
  const status = upstream.status;
  const nullBody = status === 204 || status === 304 || method === "HEAD";
  return new Response(nullBody ? null : upstream.body, { status, headers });
}
