/**
 * Catch-all Route Handler for /api/backend/* - the HTTP entry point of the same-origin backend proxy.
 *
 * Browser code (lib/api/client.ts, lib/api/voice.ts, useReadiness in lib/api/hooks.ts) calls
 * /api/backend/api/v1/...; the `path` segments after /api/backend are handed to proxyToBackend()
 * (lib/server/proxy.ts), which validates them, forwards the request and maps the response back.
 * This file only resolves configuration (BACKEND_ORIGIN, timeout) and the client IP.
 */
import { backendOrigin, backendTimeoutMs, FrontendConfigError, trustedClientIpHeader } from "@/lib/server/env";
import { proxyToBackend, trustedClientIp } from "@/lib/server/proxy";

// Always run per request: proxied responses depend on the caller's cookies and must never be cached.
export const dynamic = "force-dynamic";

// In this Next.js version route `params` is a Promise and must be awaited.
async function handle(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  let origin: string;
  try {
    origin = backendOrigin();
  } catch (error) {
    // Misconfiguration is reported in the standard error envelope so the UI shows a readable message
    // instead of a framework error page. The message names the variable, never a backend URL.
    const message = error instanceof FrontendConfigError ? error.message : "Frontend misconfigured.";
    return Response.json(
      { success: false, data: null, error: { code: "FRONTEND_MISCONFIGURED", message, details: null } },
      { status: 500 },
    );
  }
  // First X-Forwarded-For hop as received by this server (set by whatever sits in front of Next.js).
  // It is taken from the incoming header without verification, so it is only as trustworthy as that hop.
  // Never the browser-supplied X-Forwarded-For: only a header from a configured trusted proxy (see env.ts).
  const clientIp = trustedClientIp(request.headers, trustedClientIpHeader());
  return proxyToBackend(request, path, { origin, timeoutMs: backendTimeoutMs(), clientIp });
}

// One handler for every method the API uses. HEAD and OPTIONS are not exported here.
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
