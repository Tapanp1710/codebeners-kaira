import "server-only";

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
  return url.origin;
}

export function backendTimeoutMs(): number {
  const value = Number(process.env.BACKEND_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}
