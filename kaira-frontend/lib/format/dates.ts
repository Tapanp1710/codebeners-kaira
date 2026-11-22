/** Dates from the API are ISO calendar dates (YYYY-MM-DD) in the business timezone. */
// Two kinds of values are handled differently: calendar dates are formatted as text with no Date
// parsing (so a browser in another timezone cannot shift them by a day), while timestamps are real
// instants converted with Intl into a given timezone. "Asia/Kolkata" is only the default: the forms pass
// session.business.timezone to todayIn(), while current formatDateTime() callers rely on the default.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-23" -> "23 Nov 2026" without timezone shifting (no Date parsing). */
// Only the leading YYYY-MM-DD is read, so a full timestamp shows its literal date part (not converted).
// Unrecognised strings are returned as-is; null/empty shows "—". The month is assumed to be 01-12.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "2026-11-23" -> "23 Nov" (no year), e.g. for chart ticks; same text-only parsing as formatDate. */
export function formatShortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso;
}

/** Timestamps (UTC ISO) rendered in Asia/Kolkata. */
// Asia/Kolkata is the default; pass another IANA zone to override. Invalid input is returned unchanged.
export function formatDateTime(iso: string | null | undefined, timeZone = "Asia/Kolkata"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Today's calendar date in the business timezone, as YYYY-MM-DD (for form defaults). */
export function todayIn(timeZone = "Asia/Kolkata"): string {
  // en-CA formats with year/month/day parts that are zero-padded; the parts are reassembled explicitly
  // rather than relying on the locale's separator. Uses the device clock, converted to `timeZone`.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Adds (or with a negative value subtracts) whole days to a YYYY-MM-DD date, returning YYYY-MM-DD. */
// Computed in UTC so DST transitions cannot skip or repeat a day; Date.UTC normalises month/year overflow.
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Short "x ago" label from epoch milliseconds; future times clamp to "just now". Largest unit is hours. */
export function relativeTime(fromMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** Turns an enum code into a label: "partially_paid" -> "Partially paid". */
export function humanize(code: string): string {
  return code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
