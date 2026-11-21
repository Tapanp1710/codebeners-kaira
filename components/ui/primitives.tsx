import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------------------------------------ Button
const VARIANTS = {
  primary: "bg-steel text-cream hover:bg-steel-strong disabled:bg-steel/50",
  dark: "bg-navy text-cream hover:bg-abyss disabled:bg-navy/50",
  secondary: "bg-paper text-ink ring-1 ring-line hover:bg-cream disabled:text-muted",
  ghost: "text-ink hover:bg-navy/5 disabled:text-muted",
  danger: "bg-danger text-cream hover:bg-danger/90 disabled:bg-danger/50",
  good: "bg-good text-cream hover:bg-good/90 disabled:bg-good/50",
} as const;

type ButtonProps = ComponentProps<"button"> & {
  variant?: keyof typeof VARIANTS;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
};

export function Button({ variant = "primary", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-3 text-sm" : size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm",
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = "secondary", className, children }: { href: string; variant?: keyof typeof VARIANTS; className?: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cn("inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors", VARIANTS[variant], className)}
    >
      {children}
    </Link>
  );
}

// ------------------------------------------------------------------ Card
export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section {...rest} className={cn("min-w-0 rounded-[var(--radius-card)] bg-paper p-5 shadow-[var(--shadow-card)] ring-1 ring-line/70", className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, action, id }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id={id} className="font-display text-lg font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

// ------------------------------------------------------------------ Badge
const TONES = {
  neutral: "bg-navy/5 text-ink ring-navy/10",
  good: "bg-good-soft text-good ring-good/20",
  warn: "bg-warn-soft text-warn ring-warn/20",
  danger: "bg-danger-soft text-danger ring-danger/20",
  info: "bg-steel/10 text-steel-strong ring-steel/20",
  sim: "bg-sim/10 text-sim ring-sim/25",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", TONES[tone], className)}>
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ Stat
export function Stat({ label, value, hint, tone, href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "danger" | "warn"; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={cn("num mt-2 font-display text-2xl font-semibold", tone === "danger" ? "text-danger" : tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-ink")}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="block min-w-0 rounded-[var(--radius-card)] bg-paper p-5 shadow-[var(--shadow-card)] ring-1 ring-line/70 transition hover:ring-steel/40">
      {body}
    </Link>
  ) : (
    <Card>{body}</Card>
  );
}

// ------------------------------------------------------------------ states
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-lg bg-navy/[0.06]", className)} />;
}

export function LoadingBlock({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <p className="font-display text-base font-semibold text-ink">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const code = (error as { code?: string })?.code;
  return (
    <div role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger ring-1 ring-danger/20">
      <p className="font-semibold">{code === "BACKEND_UNAVAILABLE" ? "KAIRA server unreachable" : "Could not load this"}</p>
      <p className="mt-0.5">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 font-semibold underline underline-offset-2">
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "danger" | "good" | "sim"; title?: string; children: ReactNode }) {
  const styles = {
    info: "bg-steel/10 text-steel-strong ring-steel/20",
    warn: "bg-warn-soft text-warn ring-warn/20",
    danger: "bg-danger-soft text-danger ring-danger/20",
    good: "bg-good-soft text-good ring-good/20",
    sim: "bg-sim/10 text-sim ring-sim/25",
  }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "note"} className={cn("rounded-xl px-4 py-3 text-sm ring-1", styles)}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-0.5" : ""}>{children}</div>
    </div>
  );
}
