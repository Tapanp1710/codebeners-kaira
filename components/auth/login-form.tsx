"use client";

/**
 * Sign-in form rendered by app/login/page.tsx (inside a Suspense boundary, required for useSearchParams).
 *
 * Query parameters it understands:
 *   - `next`    where to go after sign-in (sanitised by safeNext)
 *   - `resume=1` set by proxy.ts / app/(app)/layout.tsx when the access cookie is missing or rejected;
 *               the form first tries a silent refresh before showing the password fields
 *   - `expired=1` set by the API client's session-lost handler; shows a "session expired" notice
 *
 * Credentials go to `POST /auth/login` via lib/api/client.ts `login()`. Tokens come back only as
 * HttpOnly cookies; the JSON session (with the CSRF token) is kept in memory by the client.
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Field, FormError, Input } from "@/components/ui/form";
import { Button, Notice } from "@/components/ui/primitives";
import { login, refreshSession } from "@/lib/api/client";
import { describeError } from "@/lib/api/errors";

/** Only same-origin relative paths are accepted as a post-login destination (no open redirects). */
export function safeNext(next: string | null): string {
  // Rejects absolute URLs, protocol-relative "//host", the "/\host" form some browsers normalise to
  // "//host", and /api/ paths (a JSON proxy route is never a page). Anything rejected falls back to /dashboard.
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/api/")) {
    return "/dashboard";
  }
  return next;
}

/** Email/password sign-in with a silent-resume phase for returning users whose access cookie lapsed. */
export function LoginForm() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  // Starts in the "Restoring your session" state when resume=1, so the form does not flash first.
  const [resuming, setResuming] = useState(params.get("resume") === "1");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Silent resume: refreshSession() first tries GET /auth/me (another tab may have refreshed already),
  // then POST /auth/refresh with the refresh cookie, single-flight and serialised across tabs by a Web
  // Lock. Success does a full replace() navigation so the server layout re-checks the session and this
  // login URL is not left in history; failure falls through to the normal form. `cancelled` ignores a
  // late result after unmount or a dependency change.
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

  /**
   * Email is trimmed, the password is sent exactly as typed. After a successful login a full-page
   * navigation (not router.push) loads the app so the server layout renders with the new cookies.
   */
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      window.location.assign(next);
    } catch (err) {
      // Shows the backend's envelope message (e.g. invalid credentials) or the network/timeout message.
      // `submitting` is only reset on failure; on success the page is navigating away.
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

  // noValidate: browser validation bubbles are suppressed; the submit button stays disabled until both
  // fields are non-empty and all credential checks happen on the backend. autoComplete hints let
  // password managers fill the form.
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
