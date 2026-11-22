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
 *
 * This module is framework-agnostic (plain Request/Response, injectable fetch) so it can be unit
 * tested directly (tests/proxy.test.ts). The only caller in the app is the catch-all route handler
 * app/api/backend/[...path]/route.ts, which resolves the origin/timeout from lib/server/env.ts.
 * The proxy itself does not authenticate anything: it relays cookies and the CSRF header, and the
 * backend remains the single authority for sessions, CSRF and authorization.
 */

export const PROXY_PREFIX = "/api/backend";
// Allow-list for the upstream path: only /api/v1/... is reachable, so backend extras such as /docs or
// /openapi.json are never exposed. Characters are limited to RFC 3986 "unreserved" plus "/"; because
// segments are re-encoded before this test, any segment that needs percent-encoding (contains "%") fails it.
const ALLOWED_PATH = /^api\/v1\/[A-Za-z0-9._~\-/]*$/;

// Explicit allow-list of request headers. Everything else (host, authorization, origin, referer,
// connection-level headers, ...) is dropped, so the browser cannot smuggle arbitrary headers upstream.
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "cookie",
  "x-csrf-token",
  "idempotency-key",
  "x-request-id",
  "user-agent",
];
// Response headers copied back to the browser. content-length / content-encoding are intentionally not
// copied: fetch() has already decoded the upstream body, so those values would no longer be accurate.
// Location is not copied either, so with redirect: "manual" a backend 3xx reaches the browser without a target.
const FORWARD_RESPONSE_HEADERS = ["content-type", "x-request-id", "retry-after", "content-disposition"];

/**
 * origin     backend origin from BACKEND_ORIGIN (already validated, no path).
 * timeoutMs  default upstream timeout; voice and agent-turn endpoints are raised to at least 90 s (upstreamTimeoutMs).
 * fetchImpl  injectable fetch for tests; defaults to the global fetch.
 * clientIp   browser address from a trusted proxy header (trustedClientIp), forwarded as x-forwarded-for.
 */
export type ProxyOptions = {
  origin: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  clientIp?: string | null;
};

// Proxy-generated errors use the same envelope shape as the backend ({success, data, error}), so the
// browser's unwrap() turns them into ApiError exactly like a backend error. no-store keeps them uncached.
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
 *
 * Effect on the KAIRA cookies: kaira_access (Path=/) is untouched; kaira_refresh (Path=/api/v1/auth)
 * becomes Path=/api/backend/api/v1/auth, so the browser still sends it to the proxied /auth/refresh
 * and nowhere else. Note: attributes are re-joined with "; " after trimming, so spacing is normalised.
 */
export function rewriteSetCookie(header: string): string {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part))
    .map((part) => {
      const match = /^path=(.*)$/i.exec(part);
      // Only API paths are prefixed; Path=/ (and any other non-/api/ path) is left as-is.
      if (match && match[1].startsWith("/api/")) return `Path=${PROXY_PREFIX}${match[1]}`;
      return part;
    })
    .join("; ");
}

/**
 * Joins the catch-all segments and validates them against the allow-list.
 *
 * Returns the relative upstream path (e.g. "api/v1/invoices/123") or null when the path must not be
 * forwarded (the caller answers 404 NOT_FOUND).
 *
 * Next has already percent-decoded each catch-all segment (verified on the production server: "%2574"
 * arrives as "%74"), so segments are encoded exactly once here and never decoded again. Decoding a second
 * time would route "heal%2574h" to "/health" and would throw on a literal "%" (HTTP 500). A segment Next
 * could not decode arrives raw; its "%" is encoded to "%25", which the allow-list rejects. "." and ".."
 * segments are rejected outright so a request cannot walk out of /api/v1 on the backend.
 */
export function upstreamPath(segments: string[]): string | null {
  if (segments.some((s) => s === ".." || s === ".")) return null;
  const path = segments.map((s) => encodeURIComponent(s)).join("/");
  return ALLOWED_PATH.test(path) ? path : null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+(%[0-9a-z]+)?$/i;

/**
 * The browser's address, read ONLY from a header set by a reverse proxy the operator trusts
 * (TRUSTED_CLIENT_IP_HEADER). Route handlers cannot see the socket address, and any X-Forwarded-For or
 * X-Real-IP the browser sends is attacker-controlled, so with no trusted header configured this returns
 * null and no client address is forwarded (the backend then sees this server as the client; its per-e-mail
 * login limit still applies). For X-Forwarded-For the RIGHTMOST entry is used: it was appended by the
 * nearest trusted proxy, while entries to its left are whatever the client sent. Values that are not a
 * syntactically valid IP are ignored.
 */
export function trustedClientIp(incoming: Headers, trustedHeader: string | null): string | null {
  if (!trustedHeader) return null;
  const raw = incoming.get(trustedHeader);
  if (!raw) return null;
  const hops = raw.split(",").map((h) => h.trim()).filter(Boolean);
  const candidate = trustedHeader.toLowerCase() === "x-forwarded-for" ? hops.at(-1) : hops[0];
  if (!candidate) return null;
  const ip = candidate.replace(/^\[|\]$/g, "");
  return IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip)) ? ip : null;
}

/**
 * Builds the upstream request headers from the allow-list. The browser's Cookie header is passed
 * through verbatim (it carries kaira_access, and kaira_refresh on /auth/* calls), as is X-CSRF-Token,
 * which the backend checks on unsafe methods. Incoming forwarding headers (X-Forwarded-For, X-Real-IP,
 * Forwarded) are never copied; the client IP from `trustedClientIp` is set as x-forwarded-for when known.
 */
export function forwardedRequestHeaders(incoming: Headers, clientIp?: string | null): Headers {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  return headers;
}

/**
 * Forwards one browser request to the backend and maps the result back to a browser Response.
 *
 * - Unknown/disallowed paths -> 404 NOT_FOUND envelope (backend never contacted).
 * - Network failure -> 502 BACKEND_UNAVAILABLE; timeout -> 504 BACKEND_TIMEOUT. Neither message
 *   echoes the internal backend URL.
 * - Otherwise the backend's status and body are streamed through unchanged, with an allow-listed set
 *   of headers plus rewritten Set-Cookie headers.
 */
/** Upstream budget for the slow endpoints (voice calls, typed agent turns). */
export const LONG_UPSTREAM_TIMEOUT_MS = 90_000;

/**
 * Upstream timeout for a validated backend path. Voice endpoints call the external speech provider, and a typed
 * agent turn (POST /agent/turn) may run up to the backend's AGENT_TURN_TIMEOUT_SECONDS (60 s) plus tool latency,
 * so both get at least 90 s. The browser client (lib/api/client.ts) waits 95 s for them, so this proxy's 504
 * normally arrives before the browser-side timeout fires.
 */
export function upstreamTimeoutMs(path: string, defaultMs: number): number {
  const slow = path.endsWith("voice/transcribe") || path.endsWith("voice/speak") || /(^|\/)agent\/turn\/?$/.test(path);
  return slow ? Math.max(defaultMs, LONG_UPSTREAM_TIMEOUT_MS) : defaultMs;
}

export async function proxyToBackend(request: Request, segments: string[], options: ProxyOptions): Promise<Response> {
  const path = upstreamPath(segments);
  if (!path) return envelopeError(404, "NOT_FOUND", "Unknown API path.");

  // The target is always built on the configured origin; only the validated path and the original
  // query string come from the browser, so the request cannot be redirected to another host.
  const incoming = new URL(request.url);
  const target = new URL(`/${path}`, options.origin);
  target.search = incoming.search;

  const method = request.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  // Raw bytes: preserves JSON exactly and multipart bodies (with their boundary) for audio uploads.
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const timeout = upstreamTimeoutMs(path, options.timeoutMs);
  const doFetch = options.fetchImpl ?? fetch;

  let upstream: Response;
  try {
    upstream = await doFetch(target, {
      method,
      headers: forwardedRequestHeaders(request.headers, options.clientIp),
      // Methods that may carry a body always send one (an empty buffer when the browser sent nothing);
      // GET/HEAD never do.
      body: body && body.byteLength > 0 ? body : hasBody ? new ArrayBuffer(0) : undefined,
      // Redirects are not followed server-side; the backend's 3xx status is returned as-is.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    // AbortSignal.timeout() rejects with a TimeoutError; AbortError is accepted for runtimes that report it that way.
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

  // Every proxied response is marked no-store: it carries per-user, cookie-authenticated data.
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
  // 204/304 responses and HEAD requests must not have a body (the Response constructor rejects one for 204/304).
  const nullBody = status === 204 || status === 304 || method === "HEAD";
  // The upstream body is streamed through rather than buffered.
  return new Response(nullBody ? null : upstream.body, { status, headers });
}
