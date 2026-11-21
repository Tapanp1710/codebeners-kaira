/**
 * Public sign-in page. It sits outside the (app) route group, so it does not run the server-side session check
 * or mount the app Providers. This file is a Server Component that renders static branding; all interactive
 * behaviour (credentials, silent session resume, redirect back) lives in the client LoginForm.
 */
import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "@/components/auth/login-form";

// Rendered as "Sign in · KAIRA" through the root layout's title template.
export const metadata: Metadata = { title: "Sign in" };

/**
 * Two-column layout: the navy brand panel only appears from the lg breakpoint; on phones only the form shows.
 *
 * LoginForm reads `?next=`, `?resume=1` and `?expired=1` with useSearchParams. Next.js requires a Suspense
 * boundary around such a component so the rest of the page can still be prerendered; the fallback is empty
 * because the form appears immediately on the client. Inside the form, `next` is passed through safeNext()
 * (same-origin relative paths only, never /api/), `resume=1` first tries a silent POST /auth/refresh, and
 * `expired=1` shows the "session expired" notice set by lib/api/client.ts when a refresh fails.
 */
export default function LoginPage() {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-navy p-12 text-cream lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="orb block size-9" data-state="idle" aria-hidden="true" />
          <span className="font-display text-2xl font-semibold tracking-wide">KAIRA</span>
        </div>
        <div className="max-w-md">
          <p className="font-display text-4xl leading-tight">
            Speak your business.
            <br />
            <span className="text-champagne">KAIRA keeps the books straight.</span>
          </p>
          <p className="mt-5 text-cream/70">
            Record payments, invoices and promises in Telugu, Hindi or English. Nothing is written to your books
            until you approve it.
          </p>
        </div>
        <p className="text-xs text-cream/50">Every approved action is recorded in your audit history.</p>
        <div aria-hidden="true" className="pointer-events-none absolute -right-32 -bottom-32 size-[28rem] rounded-full bg-steel/30 blur-3xl" />
      </section>
      <section className="flex items-center justify-center px-6 py-12">
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}
