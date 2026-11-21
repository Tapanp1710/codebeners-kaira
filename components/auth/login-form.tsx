"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Field, FormError, Input } from "@/components/ui/form";
import { Button, Notice } from "@/components/ui/primitives";
import { login, refreshSession } from "@/lib/api/client";
import { describeError } from "@/lib/api/errors";

/** Only same-origin relative paths are accepted as a post-login destination (no open redirects). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/api/")) {
    return "/dashboard";
  }
  return next;
}

export function LoginForm() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [resuming, setResuming] = useState(params.get("resume") === "1");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!resuming) return;
    let cancelled = false;
    refreshSession().then((ok) => {
      if (cancelled) return;
      if (ok) window.location.replace(next);
      else setResuming(false);
    });
    return () => {
      cancelled = true;
    };
  }, [resuming, next]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      window.location.assign(next);
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    }
  }

  if (resuming) {
    return (
      <p role="status" className="text-sm text-muted">
        Restoring your session…
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5" noValidate>
      <div>
        <h1 className="font-display text-3xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Use the account your KAIRA administrator created.</p>
      </div>
      {params.get("expired") === "1" && <Notice tone="warn">Your session expired. Please sign in again.</Notice>}
      <Field label="Email">
        {(id) => (
          <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        )}
      </Field>
      <Field label="Password">
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={submitting} disabled={!email || !password}>
        Sign in
      </Button>
    </form>
  );
}
