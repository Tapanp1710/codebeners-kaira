"use client";

/**
 * Authenticated application chrome, rendered by `app/(app)/layout.tsx` inside `<Providers>`.
 *
 * Provides the desktop sidebar and mobile navigation drawer, the sticky header (pending-approval
 * badge, alerts menu, user menu with sign-out), the persistent KAIRA agent dock (every page except the
 * agent home, which is the full-size version of the same session), and a skip link to `#main`. It reads the
 * session from context and queries GET /actions (pending count) and GET /insights (alerts); both refresh
 * through the normal React Query staleness rules and `invalidateFinancial` / action invalidations elsewhere.
 * The live voice session itself lives in <AgentProvider> (app/(app)/layout.tsx), above this shell, so it
 * survives navigation between pages.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  AudioLines,
  Bell,
  ClipboardCheck,
  FlaskConical,
  LayoutDashboard,
  LineChart,
  LogOut,
  Menu,
  Settings,
  Users,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { useSession } from "@/components/providers";
import { Badge, cn } from "@/components/ui/primitives";
import { AgentDock } from "@/components/agent/agent-dock";
import { logout } from "@/lib/api/client";
import { clearLocalAttemptsForLogout } from "@/lib/payments/server-attempts";
import { useActions, useInsights } from "@/lib/api/hooks";

/**
 * Primary navigation, in order: the KAIRA agent home first, then the manual modules. `also` lists extra path
 * prefixes that highlight the same entry (invoice pages live under "Customers & Invoices"). The Approvals entry
 * carries the pending-proposal count. Exported for tests.
 */
export const NAV = [
  { href: "/agent", label: "KAIRA", icon: AudioLines },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/customers", label: "Customers & Invoices", icon: Users, also: ["/invoices"] },
  { href: "/receivables", label: "Receivables", icon: Wallet },
  { href: "/cashflow", label: "Cash-Flow Forecast", icon: LineChart },
  { href: "/scenarios", label: "What-If Analysis", icon: FlaskConical },
  { href: "/actions", label: "Approvals", icon: ClipboardCheck },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/** The agent home, where the full agent UI replaces the dock. */
export const AGENT_HOME = "/agent";

/** Exact match or a sub-path ("/customers/123"), but not a sibling sharing a prefix ("/customersX"). */
function isActive(pathname: string, item: (typeof NAV)[number]) {
  const prefixes = [item.href, ...("also" in item ? item.also : [])];
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Shared by the sidebar and the mobile drawer; `onNavigate` lets the drawer close itself. Marks the active link
 * with aria-current="page". `pendingCount` is shown on Approvals.
 */
function NavLinks({ onNavigate, pendingCount }: { onNavigate?: () => void; pendingCount: number }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-1">
      {NAV.map((item) => {
        const active = isActive(pathname, item);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors",
                active ? "bg-cream text-navy" : "text-cream/75 hover:bg-white/5 hover:text-cream",
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className="flex-1">{item.label}</span>
              {item.href === "/actions" && pendingCount > 0 && (
                <span className="rounded-full bg-champagne px-2 text-xs font-bold text-navy" aria-label={`${pendingCount} awaiting approval`}>
                  {pendingCount}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Bell button with a dropdown of backend insights (GET /insights). The badge counts only
 * non-"info" insights, while the list shows all of them. The dropdown is a simple toggle: it does not
 * close on outside click or Esc, only on the bell or on following a link.
 */
function Notifications() {
  const insights = useInsights();
  const [open, setOpen] = useState(false);
  // Insights have no id in this payload, so list items are keyed by index below.
  const urgent = (insights.data ?? []).filter((i) => i.severity !== "info");
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Alerts${urgent.length ? `, ${urgent.length} need attention` : ""}`}
        className="relative rounded-full p-2 text-ink hover:bg-navy/5"
      >
        <Bell className="size-5" aria-hidden="true" />
        {urgent.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-danger text-[10px] font-bold text-cream">
            {urgent.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-2xl bg-paper p-3 shadow-xl ring-1 ring-line">
          <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">Alerts</p>
          {(insights.data ?? []).length === 0 && <p className="px-2 py-3 text-sm text-muted">No alerts.</p>}
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {(insights.data ?? []).map((i, idx) => (
              <li key={idx}>
                <Link href={insightHref(i)} onClick={() => setOpen(false)} className="block rounded-xl px-2 py-2 hover:bg-cream">
                  <p className="text-sm font-semibold">
                    <Badge tone={i.severity === "critical" ? "danger" : i.severity === "warning" ? "warn" : "info"} className="mr-1">
                      {i.severity}
                    </Badge>
                    {i.title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{i.message}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Where an insight leads. Uses only ids present in the backend's `related` payload.
 * A related customer wins over the insight type; unknown types fall back to the dashboard.
 * Also used by the dashboard's alert list (components/dashboard/dashboard-view.tsx).
 */
export function insightHref(i: { type: string; related: Record<string, unknown> }): string {
  const customer = i.related?.customer_id;
  if (typeof customer === "string") return `/customers/${customer}`;
  if (i.type === "cash_shortfall") return "/cashflow";
  if (i.type === "bills_due") return "/cashflow#bills";
  if (i.type === "overdue_receivables" || i.type === "commitments_due") return "/receivables";
  return "/dashboard";
}

/**
 * Avatar menu: user name/role/email, an owner-only "Business settings" link (hidden for staff; the
 * backend still enforces the role), and sign-out.
 */
function UserMenu() {
  const { session, isOwner } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Placed after all hooks so hook order stays stable when the session is cleared.
  if (!session) return null;
  /**
   * POST /auth/logout (the backend revokes the refresh token and clears its HttpOnly cookies), then wipe client state regardless
   * of the outcome: `logout()` publishes a null session in its own finally, and this finally clears
   * the query cache and hard-navigates to /login even if the request failed.
   */
  async function onLogout() {
    setBusy(true);
    try {
      // Payment records in this browser are only a recovery aid; the server keeps every unconfirmed payment
      // for the next login (any device). Clear them so the next person on this device cannot see them.
      await clearLocalAttemptsForLogout(session!.business.id).catch(() => 0);
      await logout();
    } finally {
      qc.clear();
      // Full reload on purpose: drops the in-memory CSRF token and query cache, then the server re-checks the session.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-2 rounded-full py-1 pr-3 pl-1 hover:bg-navy/5">
        <span className="grid size-8 place-items-center rounded-full bg-steel text-sm font-bold text-cream" aria-hidden="true">
          {session.user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-semibold leading-tight">{session.user.name}</span>
          <span className="block text-xs capitalize text-muted">{session.user.role}</span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-56 rounded-2xl bg-paper p-2 shadow-xl ring-1 ring-line">
          <p className="truncate px-3 py-2 text-xs text-muted">{session.user.email}</p>
          {isOwner && (
            <Link href="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-cream">
              <Settings className="size-4" aria-hidden="true" /> Business settings
            </Link>
          )}
          <button type="button" onClick={onLogout} disabled={busy} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-cream">
            <LogOut className="size-4" aria-hidden="true" /> {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Page frame for every route under app/(app). `children` is the routed page, rendered inside <main id="main">.
 * The agent dock is rendered on every page except the agent home; <main> then gets extra bottom padding so
 * the fixed dock never covers the end of a page.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const pathname = usePathname();
  const [mobileNav, setMobileNav] = useState(false);
  // Fetches a single row only to read `total`: the number of proposals awaiting approval.
  // Its key starts with "actions", so extract/approve/reject invalidations refresh this badge too.
  const pending = useActions({ status: "pending", page_size: 1 });
  const pendingCount = pending.data?.total ?? 0;
  const showDock = !(pathname === AGENT_HOME || pathname.startsWith(`${AGENT_HOME}/`));

  // The mobile drawer is rendered only while open (role="dialog", aria-modal) and closes on backdrop
  // click or navigation; it is not a native <dialog>, so it has no built-in focus trap or Esc handling.
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_1fr]">
      <a href="#main" className="sr-only z-50 rounded bg-paper px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-dvh flex-col overflow-y-auto bg-navy px-4 py-6 lg:flex">
        <Link href={AGENT_HOME} className="mb-8 flex items-center gap-3 px-2">
          <span className="orb block size-8" data-state="idle" aria-hidden="true" />
          <span className="font-display text-xl font-semibold tracking-wide text-cream">KAIRA</span>
        </Link>
        <nav aria-label="Primary">
          <NavLinks pendingCount={pendingCount} />
        </nav>
        <div className="mt-auto pt-6">
          <div className="rounded-2xl bg-abyss px-3 py-3 text-xs text-cream/70">
            <p className="font-semibold text-cream">{session?.business.name}</p>
            <p>{session?.business.currency} · {session?.business.timezone}</p>
          </div>
        </div>
      </aside>

      {/* Mobile navigation */}
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" className="absolute inset-0 bg-navy/50" aria-label="Close navigation" onClick={() => setMobileNav(false)} />
          <nav aria-label="Primary" className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-navy px-4 py-6">
            <NavLinks pendingCount={pendingCount} onNavigate={() => setMobileNav(false)} />
          </nav>
        </div>
      )}

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line/70 bg-cream/90 px-4 py-3 backdrop-blur sm:px-8">
          <button type="button" className="rounded-full p-2 lg:hidden" aria-label="Open navigation" onClick={() => setMobileNav(true)}>
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <p className="truncate font-display text-lg font-semibold lg:hidden">{session?.business.name}</p>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {pendingCount > 0 && (
              <Link href="/actions" className="hidden rounded-full bg-warn-soft px-3 py-1.5 text-xs font-semibold text-warn ring-1 ring-warn/20 sm:block">
                {pendingCount} awaiting approval
              </Link>
            )}
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main id="main" className={cn("mx-auto max-w-7xl px-4 py-8 sm:px-8", showDock && "pb-36 sm:pb-40")}>
          {children}
        </main>
      </div>

      {/* One agent interface per page: the dock everywhere except the agent home (same live session). */}
      {showDock && <AgentDock />}
    </div>
  );
}
