/**
 * Test render helper: mounts UI inside the real app Providers (React Query client, session, toasts)
 * and routes every API call through the real client to an in-test handler via setTransport,
 * recording each request so tests can assert on what was actually sent.
 */
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

import { Providers } from "@/components/providers";
import { setTransport } from "@/lib/api/client";
import type { Session } from "@/lib/api/types";

import { ownerSession } from "./fixtures";

export type Handler = (req: Request) => Response | Promise<Response>;

/** Renders inside the real providers; network goes to `handler` (default: 404 envelope). */
export function renderApp(ui: ReactElement, { session = ownerSession, handler }: { session?: Session; handler?: Handler } = {}) {
  const requests: Request[] = [];
  setTransport(async (req) => {
    // Clone before the handler consumes the body so tests can still read it afterwards.
    requests.push(req.clone());
    if (handler) return handler(req);
    // Unmocked calls get a 404 error envelope, so a test fails visibly instead of reaching the network.
    return new Response(JSON.stringify({ success: false, data: null, error: { code: "NOT_FOUND", message: "not mocked" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
  const utils = render(<Providers session={session}>{ui}</Providers>);
  return { ...utils, requests };
}

/** "METHOD /path" with the proxy and /api/v1 prefixes stripped, e.g. "POST /actions/a1/approve". */
export const pathOf = (req: Request) => `${req.method} ${new URL(req.url).pathname.replace("/api/backend/api/v1", "")}`;
