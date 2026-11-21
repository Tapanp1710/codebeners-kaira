"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { onSessionChange, setSessionFromServer } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import type { Session } from "@/lib/api/types";

// ------------------------------------------------------------------ session
type SessionValue = { session: Session | null; isOwner: boolean };
const SessionContext = createContext<SessionValue>({ session: null, isOwner: false });

export function useSession() {
  return useContext(SessionContext);
}

function SessionProvider({ initial, children }: { initial: Session | null; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    setSessionFromServer(initial); // CSRF token lives in memory only
    return initial;
  });
  useEffect(() => onSessionChange((s) => setSession(s)), []);
  const value = useMemo(() => ({ session, isOwner: session?.user.role === "owner" }), [session]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// ------------------------------------------------------------------ toasts
type Toast = { id: number; message: string; tone: "good" | "danger" | "info" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
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
export function Providers({ session, children }: { session: Session | null; children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            // Never retry client errors (4xx); retry transient failures once.
            retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
          },
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
