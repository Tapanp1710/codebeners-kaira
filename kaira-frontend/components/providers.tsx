"use client";

/**
 * Client-side context root for every authenticated page.
 *
 * Mounted once by `app/(app)/layout.tsx`, which first verifies the session on the server
 * (GET /auth/me) and passes the resulting `Session` in. This module wires three things:
 * - a single TanStack Query client (cache + retry policy for all hooks in `lib/api/hooks.ts`),
 * - the session context (user, role, business, and the in-memory CSRF token held by `lib/api/client.ts`),
 * - a lightweight toast queue used by forms to confirm successful writes.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { onSessionChange, setSessionFromServer } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import type { Session } from "@/lib/api/types";

// ------------------------------------------------------------------ session
type SessionValue = { session: Session | null; isOwner: boolean };
const SessionContext = createContext<SessionValue>({ session: null, isOwner: false });

/** Current session and a derived `isOwner` flag (owner-only UI such as settings and approvals). Role checks here only hide UI; the backend enforces them. */
export function useSession() {
  return useContext(SessionContext);
}

/**
 * Seeds the session from the server-rendered value, then follows changes published by the API
 * client (login, refresh, CSRF re-sync, logout or a failed refresh all call `publish`).
 */
function SessionProvider({ initial, children }: { initial: Session | null; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    setSessionFromServer(initial); // CSRF token lives in memory only
    return initial;
  });
  // onSessionChange returns its unsubscribe function, which doubles as the effect cleanup.
  useEffect(() => onSessionChange((s) => setSession(s)), []);
  const value = useMemo(() => ({ session, isOwner: session?.user.role === "owner" }), [session]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// ------------------------------------------------------------------ toasts
type Toast = { id: number; message: string; tone: "good" | "danger" | "info" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});
/** Returns `push(message, tone?)`; tone defaults to "good". Outside the provider it is a no-op. */
export const useToast = () => useContext(ToastContext);

/** Holds the visible toasts and renders them in one polite live region so screen readers announce each message. */
function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Stable callback (empty deps) so consumers can safely list it in their own hook dependencies.
  // Each toast removes itself after 5 s; there is no manual dismiss.
  const push = useCallback((message: string, tone: Toast["tone"] = "good") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "pointer-events-auto rounded-full px-4 py-2 text-sm font-semibold shadow-lg " +
              (t.tone === "danger" ? "bg-danger text-cream" : t.tone === "info" ? "bg-navy text-cream" : "bg-good text-cream")
            }
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ------------------------------------------------------------------ root
/**
 * Root provider stack: QueryClient -> Session -> Toasts, wrapping the AppShell and every page.
 * `session` is the server-verified value from the (app) layout; the layout never renders this for an
 * unauthenticated request (it redirects to /login first).
 */
export function Providers({ session, children }: { session: Session | null; children: ReactNode }) {
  // Lazy useState keeps one QueryClient per mounted tree instead of a module-level singleton,
  // so cached data never outlives the provider (logout additionally clears it and reloads).
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is considered fresh for 15 s; returning to the tab refetches stale ledger views.
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            // Never retry client errors (4xx); retry transient failures once.
            // "Transient" includes 5xx, proxy 502/504 and network/timeout errors (ApiError status 0).
            // 401/403 recovery (refresh, CSRF re-sync) already happens inside kairaFetch, below this layer.
            retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
          },
          // Retrying a write is left to the user; a resubmitted payment reuses its Idempotency-Key (see PaymentDialog).
          mutations: { retry: false }, // financial writes are never retried blindly
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SessionProvider initial={session}>
        <ToastProvider>{children}</ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
