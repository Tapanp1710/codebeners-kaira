/**
 * Server-only configuration for reaching the KAIRA backend.
 *
 * Read by the proxy route handler (app/api/backend/[...path]/route.ts) and the server session check
 * (lib/server/session.ts). The "server-only" import makes any client-component import a build error,
 * so the backend address cannot leak into the browser bundle. Values are read from process.env on
 * every call (not cached at module load).
 */
import "server-only";

// Distinguishes configuration mistakes from other failures, so the route handler can show the message verbatim.
export class FrontendConfigError extends Error {}

/** Server-only backend origin (no trailing slash, no /api/v1). Never exposed to the browser. */
export function backendOrigin(): string {
  const raw = process.env.BACKEND_ORIGIN?.trim();
  if (!raw) {
    throw new FrontendConfigError(
      "BACKEND_ORIGIN is not set. Add BACKEND_ORIGIN=http://<backend-host>:8000 to .env.local and restart.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FrontendConfigError(`BACKEND_ORIGIN is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FrontendConfigError("BACKEND_ORIGIN must use http or https.");
  }
  // Only scheme://host[:port] is kept; any path, query or trailing slash in the variable is discarded.
  return url.origin;
}

/** Default upstream timeout in ms: BACKEND_TIMEOUT_MS when it is a positive number, otherwise 30 s. */
/**
 * Name of a header set by the reverse proxy in front of this server that carries the browser's address
 * (for example "x-real-ip", or "x-forwarded-for" from a platform proxy that appends to it). Unset means no
 * client address is trusted or forwarded. Only set it when every request reaches Next through that proxy.
 */
export function trustedClientIpHeader(): string | null {
  const raw = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  return raw && /^[a-z0-9-]+$/.test(raw) ? raw : null;
}

export function backendTimeoutMs(): number {
  const value = Number(process.env.BACKEND_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}
