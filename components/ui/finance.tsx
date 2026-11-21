import type { ReactNode } from "react";

import { formatMoney } from "@/lib/format/money";

import { Badge, cn, type Tone } from "./primitives";

/** Displays a backend money string exactly (no float conversion). */
export function Money({ value, className, signed }: { value: string | null | undefined; className?: string; signed?: boolean }) {
  return <span className={cn("num whitespace-nowrap", className)}>{formatMoney(value, { signed })}</span>;
}

const PAYMENT_STATUS: Record<string, { tone: Tone; label: string }> = {
  paid: { tone: "good", label: "Paid" },
  partially_paid: { tone: "warn", label: "Partially paid" },
  unpaid: { tone: "neutral", label: "Unpaid" },
  void: { tone: "neutral", label: "Void" },
};

export function PaymentStatusBadge({ status, overdue, daysOverdue }: { status: string; overdue?: boolean; daysOverdue?: number }) {
  const s = PAYMENT_STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={s.tone}>{s.label}</Badge>
      {overdue && <Badge tone="danger">Overdue{daysOverdue ? ` · ${daysOverdue}d` : ""}</Badge>}
    </span>
  );
}

const COMMITMENT: Record<string, Tone> = { pending: "info", fulfilled: "good", cancelled: "neutral", broken: "danger" };
export function CommitmentBadge({ status }: { status: string }) {
  return <Badge tone={COMMITMENT[status] ?? "neutral"}>Promise · {status}</Badge>;
}

export const AGEING_LABEL: Record<string, string> = {
  current: "Not yet due",
  "1_30": "1–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  "90_plus": "90+ days",
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  other: "Other",
};

/** Accessible scrollable table wrapper that stays usable on mobile. */
export function DataTable({ caption, children, className }: { caption: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("-mx-5 overflow-x-auto px-5", className)}>
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export const th = "border-b border-line px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted first:pl-0 last:pr-0";
export const td = "border-b border-line/60 px-3 py-3 align-top first:pl-0 last:pr-0";
export const tdNum = cn(td, "text-right");
export const thNum = cn(th, "text-right");
