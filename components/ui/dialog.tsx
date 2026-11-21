"use client";

/**
 * Shared modal used by the payment, customer, bill and reminder dialogs. Client component because
 * it drives the imperative HTMLDialogElement API (showModal/close) from React state.
 */
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "./primitives";

/**
 * Accessible modal built on the native <dialog> (focus trap, Esc to close, inert background).
 * Fully controlled: `open` decides visibility and `onClose` should set it to false in the parent.
 * `onClose` can run more than once per closing (button/Esc, then the native `close` event fired when
 * the effect calls el.close()), so it must be idempotent.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Mirrors `open` onto the element. Where showModal/close are missing (older browsers, jsdom in tests)
  // it falls back to toggling the `open` attribute, which shows the dialog without modal behaviour.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  // Esc's `cancel` event is prevented and routed to onClose so React state stays the source of truth.
  // Children render only while open, which resets uncontrolled inner state and keeps the fixed
  // "dialog-title" id unique in the DOM (only an open dialog renders its heading).
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-2xl bg-paper p-0 text-ink shadow-2xl ring-1 ring-line",
        wide ? "max-w-3xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="max-h-[85vh] overflow-y-auto p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 id="dialog-title" className="font-display text-xl font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded-full p-1.5 text-muted hover:bg-navy/5 hover:text-ink">
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
