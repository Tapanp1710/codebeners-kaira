/**
 * Authenticated layout for the `(app)` route group. The parenthesised folder name is not part of the URL, so
 * /dashboard, /customers, /invoices, /receivables, /cashflow, /scenarios, /actions and /settings all render
 * inside this layout while /login does not.
 *
 * This Server Component is the authoritative auth gate. proxy.ts only checks that a `kaira_access` cookie exists;
 * here the backend itself is asked who the cookie belongs to before any protected page renders.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { Providers } from "@/components/providers";
import { getServerSession } from "@/lib/server/session";

// Render on every request: the result depends on the caller's cookies, so it must never be prerendered or
// served from a shared cache.
export const dynamic = "force-dynamic";

/** Resolves the session on the server, then either redirects, shows an outage page, or renders the app shell. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // GET {BACKEND_ORIGIN}/api/v1/auth/me with the access cookie forwarded (no-store, 10 s timeout). React cache()
  // dedupes it within one request. Outcomes: authenticated | unauthenticated (no cookie, 401/403) |
  // backend_unavailable (bad BACKEND_ORIGIN, network failure, non-success envelope).
  const result = await getServerSession();
  if (result.status === "unauthenticated") {
    // proxy.ts copies the requested path + query into `x-kaira-path` so the user can be returned there after
    // signing in. `resume=1` makes the login page try a silent refresh first: an expired access cookie may still
    // have a valid refresh cookie. redirect() throws, so nothing below runs for this request.
    const path = (await headers()).get("x-kaira-path") ?? "/dashboard";
    redirect(`/login?next=${encodeURIComponent(path)}&resume=1`);
  }
  // An unreachable backend is not an auth failure, so the user is not bounced to /login. A standalone page is
  // rendered without Providers/AppShell; the empty href reloads the current URL and re-runs this check.
  if (result.status === "backend_unavailable") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6">
        <p className="font-display text-3xl font-semibold">KAIRA can&apos;t reach its server</p>
        <p className="mt-3 text-muted">{result.message}</p>
        <a href="" className="mt-6 inline-flex h-10 w-fit items-center rounded-full bg-steel px-5 text-sm font-semibold text-cream">
          Try again
        </a>
      </main>
    );
  }
  // Authenticated: the session (user, role, csrf_token) is serialised into the client Providers, which keep the
  // CSRF token in memory, expose isOwner to pages, and create the React Query client. AppShell adds navigation.
  return (
    <Providers session={result.session}>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
