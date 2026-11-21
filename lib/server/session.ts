import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import type { Schemas } from "@/lib/api/types";
import { backendOrigin } from "@/lib/server/env";

export type ServerSession =
  | { status: "authenticated"; session: Schemas["SessionOut"] }
  | { status: "unauthenticated" }
  | { status: "backend_unavailable"; message: string };

/**
 * Authoritative server-side session check: asks the backend who the access cookie belongs to.
 * The presence of a cookie is never treated as proof of authentication.
 */
export const getServerSession = cache(async (): Promise<ServerSession> => {
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
    const res = await fetch(new URL("/api/v1/auth/me", origin), {
      headers: { cookie: `kaira_access=${access}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { status: "unauthenticated" };
    const body = await res.json();
    if (!res.ok || !body?.success) {
      return { status: "backend_unavailable", message: body?.error?.message ?? `Backend returned ${res.status}` };
    }
    return { status: "authenticated", session: body.data as Schemas["SessionOut"] };
  } catch {
    return {
      status: "backend_unavailable",
      message: "The KAIRA server is not reachable. Check that the backend is running and BACKEND_ORIGIN is correct.",
    };
  }
});
