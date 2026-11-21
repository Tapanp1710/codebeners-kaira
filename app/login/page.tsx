import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in" };

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
