export type ErrorBody = { code: string; message: string; details?: unknown };

/** Any failure from the KAIRA API (HTTP or application-level), or from reaching it. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(status: number, body: ErrorBody, requestId: string | null = null) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details ?? null;
    this.requestId = requestId;
  }

  /** Field-level validation messages from VALIDATION_ERROR details, keyed by the last loc segment. */
  fieldErrors(): Record<string, string> {
    const errors = (this.details as { errors?: { loc: (string | number)[]; msg: string }[] } | null)?.errors;
    const out: Record<string, string> = {};
    for (const e of errors ?? []) {
      const key = String(e.loc[e.loc.length - 1]);
      out[key] = e.msg.replace(/^Value error, /, "");
    }
    return out;
  }
}

export const NETWORK_ERROR: ErrorBody = {
  code: "NETWORK_ERROR",
  message: "Could not reach KAIRA. Check your connection and try again.",
};
export const TIMEOUT_ERROR: ErrorBody = {
  code: "REQUEST_TIMEOUT",
  message: "KAIRA took too long to respond. Please try again.",
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
