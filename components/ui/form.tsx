import { forwardRef, useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "./primitives";

const control =
  "w-full rounded-xl bg-white/70 px-3 py-2 text-sm text-ink ring-1 ring-line placeholder:text-muted/70 focus:bg-white focus:outline-none focus:ring-2 focus:ring-steel disabled:opacity-60 aria-[invalid=true]:ring-danger";

type FieldProps = { label: string; error?: string; hint?: ReactNode; children: (id: string, describedBy?: string) => ReactNode; className?: string };

/** Label + control + hint/error wired with ids for screen readers. */
export function Field({ label, error, hint, children, className }: FieldProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </label>
      {children(id, error || hint ? msgId : undefined)}
      {error ? (
        <p id={msgId} className="text-xs font-medium text-danger">{error}</p>
      ) : hint ? (
        <p id={msgId} className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} {...rest} className={cn(control, "h-10", className)} />;
});

export const Select = forwardRef<HTMLSelectElement, ComponentProps<"select">>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} {...rest} className={cn(control, "h-10", className)} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} {...rest} className={cn(control, "min-h-24", className)} />;
});

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger">
      {message}
    </p>
  );
}
