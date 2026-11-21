/**
 * Money is a decimal STRING from the backend ("150000.00"). The browser never derives financial
 * truth; these helpers only format, compare and produce on-screen estimates using exact
 * integer arithmetic (BigInt paise / milli-units) - never floating point.
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value.trim());
}

/** Indian grouping for an integer string: 1234567 -> 12,34,567 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/** "150000.5" -> "₹1,50,000.50"; null/undefined -> "—". Rounds half-up to 2 places as text. */
export function formatMoney(value: string | null | undefined, opts: { symbol?: boolean; signed?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value).trim();
  if (!isDecimalString(text)) return text;
  const scaled = toScaled(text, 2);
  const negative = scaled < BigInt(0);
  const abs = negative ? -scaled : scaled;
  const whole = (abs / BigInt(100)).toString();
  const frac = (abs % BigInt(100)).toString().padStart(2, "0");
  const sign = negative ? "-" : opts.signed && abs > BigInt(0) ? "+" : "";
  return `${sign}${opts.symbol === false ? "" : "₹"}${groupIndian(whole)}.${frac}`;
}

/** Compact form for chart axes only: ₹1.5L, ₹2.3Cr, ₹45K. */
export function formatMoneyCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(0)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Parses a decimal string into a BigInt scaled by 10^places (half-up rounding). */
export function toScaled(value: string, places: number): bigint {
  const text = value.trim();
  if (!isDecimalString(text)) throw new Error(`Not a decimal: ${value}`);
  const negative = text.startsWith("-");
  const [intPart, fracPart = ""] = text.replace("-", "").split(".");
  const padded = (fracPart + "0".repeat(places + 1)).slice(0, places + 1);
  let n = BigInt(intPart + padded.slice(0, places));
  if (Number(padded[places]) >= 5) n += BigInt(1);
  return negative ? -n : n;
}

function fromScaled(n: bigint, places: number): string {
  const negative = n < BigInt(0);
  const abs = negative ? -n : n;
  const base = BigInt(10) ** BigInt(places);
  const text = `${abs / base}.${(abs % base).toString().padStart(places, "0")}`;
  return negative ? `-${text}` : text;
}

/** Exact line estimate: quantity (≤3 dp) × unit price (≤2 dp), half-up to 2 dp. Display only. */
export function estimateLine(quantity: string, unitPrice: string): string | null {
  if (!isDecimalString(quantity) || !isDecimalString(unitPrice)) return null;
  const product = toScaled(quantity, 3) * toScaled(unitPrice, 2); // scale 5
  const rounded = (product + (product >= BigInt(0) ? BigInt(500) : BigInt(-500))) / BigInt(1000); // to scale 2
  return fromScaled(rounded, 2);
}

export function sumMoney(values: (string | null)[]): string {
  let total = BigInt(0);
  for (const v of values) if (v && isDecimalString(v)) total += toScaled(v, 2);
  return fromScaled(total, 2);
}

/** -1, 0, 1 comparison of two decimal strings (exact). */
export function compareMoney(a: string, b: string): number {
  const x = toScaled(a, 2);
  const y = toScaled(b, 2);
  return x === y ? 0 : x > y ? 1 : -1;
}

/** Valid money input: positive, at most 2 decimal places. */
export function isValidAmount(value: string): boolean {
  return /^\d{1,12}(\.\d{1,2})?$/.test(value.trim()) && toScaled(value, 2) > BigInt(0);
}

/** For chart geometry ONLY (never for financial calculation). */
export function chartNumber(value: string | null | undefined): number {
  return value ? Number(value) : 0;
}
