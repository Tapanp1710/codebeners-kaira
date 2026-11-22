"use client";

/**
 * "Try KAIRA Demo" panel on the sign-in page: shows the public evaluator account (lib/demo-account.ts) with a
 * Copy button per credential and a "Login as Demo" button. That button does not bypass anything: the parent
 * LoginForm fills its fields and runs its normal POST /auth/login flow with these values.
 */
import { useState } from "react";

import { Button } from "@/components/ui/primitives";
import type { DemoAccount } from "@/lib/demo-account";

type CopyState = { field: "email" | "password"; ok: boolean } | null;

export function DemoLogin({
  account,
  onLogin,
  busy,
}: {
  account: DemoAccount;
  onLogin: (account: DemoAccount) => void;
  busy: boolean;
}) {
  const [copied, setCopied] = useState<CopyState>(null);

  async function copy(field: "email" | "password", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied({ field, ok: true });
    } catch {
      // Clipboard can be blocked (insecure context, permissions); the value is still visible to select by hand.
      setCopied({ field, ok: false });
    }
  }

  const label = (field: "email" | "password") =>
    copied?.field === field ? (copied.ok ? "Copied" : "Copy failed") : "Copy";

  return (
    <section
      aria-labelledby="demo-login-title"
      className="rounded-2xl bg-paper p-5 ring-1 ring-line"
      data-testid="demo-login"
    >
      <h2 id="demo-login-title" className="font-display text-xl font-semibold">
        Try KAIRA Demo
      </h2>
      <p className="mt-1 text-sm text-muted">
        Demo account provided for hackathon evaluation. You can explore KAIRA
        using the sample business data.
      </p>
      <dl className="mt-4 space-y-2 text-sm">
        {(
          [
            ["email", "Username", account.email],
            ["password", "Password", account.password],
          ] as const
        ).map(([field, name, value]) => (
          <div key={field} className="flex items-center justify-between gap-3">
            <dt className="w-20 shrink-0 text-muted">{name}</dt>
            <dd
              className="min-w-0 flex-1 truncate font-mono select-all"
              data-testid={`demo-${field}`}
            >
              {value}
            </dd>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => copy(field, value)}
              aria-label={`Copy demo ${name.toLowerCase()}`}
            >
              {label(field)}
            </Button>
          </div>
        ))}
      </dl>
      {/* Announces copy results to screen readers. */}
      <p role="status" className="sr-only">
        {copied
          ? `${copied.field === "email" ? "Username" : "Password"} ${copied.ok ? "copied" : "could not be copied"}`
          : ""}
      </p>
      <Button
        type="button"
        variant="dark"
        className="mt-4 w-full"
        loading={busy}
        onClick={() => onLogin(account)}
      >
        Login as Demo
      </Button>
    </section>
  );
}
