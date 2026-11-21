/**
 * Error model shared by the whole data layer.
 *
 * unwrap() in lib/api/client.ts converts every failed call (backend envelope error, proxy-generated
 * 502/504/500 envelope, non-JSON HTTP failure, network/timeout) into an ApiError. Components read
 * `code` for branching (e.g. VALIDATION_ERROR), fieldErrors() for forms and describeError() for banners.
 */

// Same shape as the `error` object in the backend envelope ({ success, data, error }).
export type ErrorBody = { code: string; message: string; details?: unknown };

/** Any failure from the KAIRA API (HTTP or application-level), or from reaching it. */
export class ApiError extends Error {
  readonly code: string;
  // HTTP status; 0 when no response was received (network failure or browser-side timeout).
  readonly status: number;
  readonly details: unknown;
  // X-Request-ID echoed by the backend, useful for correlating a UI error with backend logs.
  readonly requestId: string | null;

  constructor(status: number, body: ErrorBody, requestId: string | null = null) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details ?? null;
    this.requestId = requestId;
  }

  /**
   * Field-level validation messages from VALIDATION_ERROR details, keyed by the last loc segment.
   * Assumes details look like { errors: [{ loc, msg }] } (a Pydantic-style error list); anything else yields {}.
   * Nested fields collapse onto their last segment (e.g. ["body","items",0,"quantity"] -> "quantity").
   */
  fieldErrors(): Record<string, string> {
    const errors = (this.details as { errors?: { loc: (string | number)[]; msg: string }[] } | null)?.errors;
    const out: Record<string, string> = {};
    for (const e of errors ?? []) {
      const key = String(e.loc[e.loc.length - 1]);
      // Strips the "Value error, " prefix Pydantic adds to custom validator messages.
      out[key] = e.msg.replace(/^Value error, /, "");
    }
    return out;
  }
}

// Client-side error bodies used by unwrap() when the request never produced a response (status 0).
export const NETWORK_ERROR: ErrorBody = {
  code: "NETWORK_ERROR",
  message: "Could not reach KAIRA. Check your connection and try again.",
};
export const TIMEOUT_ERROR: ErrorBody = {
  code: "REQUEST_TIMEOUT",
  message: "KAIRA took too long to respond. Please try again.",
};

/** User-facing message for any thrown value; falls back to a generic text for non-Error values. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
