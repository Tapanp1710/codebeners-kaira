import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { Providers } from "@/components/providers";
import { getServerSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const result = await getServerSession();
  if (result.status === "unauthenticated") {
    const path = (await headers()).get("x-kaira-path") ?? "/dashboard";
    redirect(`/login?next=${encodeURIComponent(path)}&resume=1`);
  }
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
  return (
    <Providers session={result.session}>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
