"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui/primitives";

/**
 * Secondary navigation inside "Customers & Invoices".
 * Rendered at the top of app/(app)/customers/page.tsx and app/(app)/invoices/page.tsx; pure client-side
 * links, no data fetching.
 */
export function SectionTabs() {
  const pathname = usePathname();
  // In the map below, a tab is active on its own route and on nested routes (e.g. /customers/{id}); the trailing "/" check
  // avoids matching unrelated paths that merely share the prefix.
  const tabs = [
    { href: "/customers", label: "Customers" },
    { href: "/invoices", label: "Invoices" },
  ];
  return (
    <nav aria-label="Customers and invoices" className="mb-6 inline-flex rounded-full bg-paper p-1 ring-1 ring-line">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn("rounded-full px-4 py-1.5 text-sm font-semibold", active ? "bg-navy text-cream" : "text-muted hover:text-ink")}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
