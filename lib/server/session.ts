/**
 * Server-side session resolution for protected pages.
 *
 * Used by app/(app)/layout.tsx: "unauthenticated" redirects to /login?resume=1, "backend_unavailable"
 * renders an explanatory screen, and "authenticated" passes the SessionOut (including csrf_token) to
 * the client Providers, which seed the in-memory CSRF token in lib/api/client.ts.
 * This call goes straight to BACKEND_ORIGIN from the Next.js server, not through the /api/backend proxy.
 */
import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import type { Schemas } from "@/lib/api/types";
import { backendOrigin } from "@/lib/server/env";

// Three explicit outcomes so a backend outage is never mistaken for "logged out" (and vice versa).
export type ServerSession =
  | { status: "authenticated"; session: Schemas["SessionOut"] }
  | { status: "unauthenticated" }
  | { status: "backend_unavailable"; message: string };

/**
 * Authoritative server-side session check: asks the backend who the access cookie belongs to.
 * The presence of a cookie is never treated as proof of authentication.
 *
 * Wrapped in React cache() so repeated calls within one server render share a single /auth/me request.
 */
export const getServerSession = cache(async (): Promise<ServerSession> => {
  // cookies() is async in this Next.js version; reading it also makes the rendering route dynamic.
  const store = await cookies();
  const access = store.get("kaira_access")?.value;
  if (!access) return { status: "unauthenticated" };
  let origin: string;
  try {
    origin = backendOrigin();
  } catch (error) {
    return { status: "backend_unavailable", message: (error as Error).message };
  }
  try {
    // Only the access cookie is forwarded (not the whole Cookie header). No refresh is attempted here:
    // an expired access token yields "unauthenticated", and the login page then tries a silent refresh.
    const res = await fetch(new URL("/api/v1/auth/me", origin), {
      headers: { cookie: `kaira_access=${access}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { status: "unauthenticated" };
    const body = await res.json();
    // Any other non-success (5xx, unexpected envelope) is treated as an outage, not as a logout.
    if (!res.ok || !body?.success) {
      return { status: "backend_unavailable", message: body?.error?.message ?? `Backend returned ${res.status}` };
    }
    return { status: "authenticated", session: body.data as Schemas["SessionOut"] };
  } catch {
    // Network error, 10 s timeout, or a non-JSON body all land here; the message never echoes the backend URL.
    return {
      status: "backend_unavailable",
      message: "The KAIRA server is not reachable. Check that the backend is running and BACKEND_ORIGIN is correct.",
    };
  }
});
