/**
 * Money is a decimal STRING from the backend ("150000.00"). The browser never derives financial
 * truth; these helpers only format, compare and produce on-screen estimates using exact
 * integer arithmetic (BigInt paise / milli-units) - never floating point.
 *
 * Currency assumption: every amount is INR. The rupee symbol and Indian digit grouping (lakh/crore)
 * are hard-coded; no currency code is read from the API. Used by tables, cards, the invoice form's
 * running estimate (estimateLine/sumMoney) and the forecast charts (formatMoneyCompact/chartNumber).
 */

// Plain decimal only: optional leading "-", digits, optional fraction. No "+", exponent, commas or spaces inside.
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value.trim());
}

/** Indian grouping for an integer string: 1234567 -> 12,34,567 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  // Everything before the last three digits is grouped in pairs (lakh, crore, ...).
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/**
 * "150000.5" -> "₹1,50,000.50"; null/undefined -> "—". Rounds half-up to 2 places as text.
 * opts.symbol === false omits "₹"; opts.signed adds "+" to positive values. Input that is not a plain
 * decimal string is returned unchanged rather than throwing.
 */
export function formatMoney(value: string | null | undefined, opts: { symbol?: boolean; signed?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value).trim();
  if (!isDecimalString(text)) return text;
  // Work in paise (scale 2) so the whole/fraction split is exact integer division.
  const scaled = toScaled(text, 2);
  const negative = scaled < BigInt(0);
  const abs = negative ? -scaled : scaled;
  const whole = (abs / BigInt(100)).toString();
  const frac = (abs % BigInt(100)).toString().padStart(2, "0");
  // Zero is never signed, and a value that rounds to 0.00 never shows "-".
  const sign = negative ? "-" : opts.signed && abs > BigInt(0) ? "+" : "";
  return `${sign}${opts.symbol === false ? "" : "₹"}${groupIndian(whole)}.${frac}`;
}

/** Compact form for chart axes only: ₹1.5L, ₹2.3Cr, ₹45K. */
// Uses floating point and one decimal (L/Cr) or none (K), so it is approximate by design and never used for amounts users act on.
export function formatMoneyCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(0)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/**
 * Parses a decimal string into a BigInt scaled by 10^places (half-up rounding).
 * Rounding looks only at the first dropped digit and is applied to the magnitude, so negatives round
 * half away from zero ("-1.005" at 2 places -> -101). Throws on anything that is not a decimal string.
 */
export function toScaled(value: string, places: number): bigint {
  const text = value.trim();
  if (!isDecimalString(text)) throw new Error(`Not a decimal: ${value}`);
  const negative = text.startsWith("-");
  const [intPart, fracPart = ""] = text.replace("-", "").split(".");
  // Keep `places` digits plus one extra digit that decides the rounding.
  const padded = (fracPart + "0".repeat(places + 1)).slice(0, places + 1);
  let n = BigInt(intPart + padded.slice(0, places));
  if (Number(padded[places]) >= 5) n += BigInt(1);
  return negative ? -n : n;
}

// Inverse of toScaled: renders a scaled BigInt as a plain decimal string with exactly `places` decimals.
function fromScaled(n: bigint, places: number): string {
  const negative = n < BigInt(0);
  const abs = negative ? -n : n;
  const base = BigInt(10) ** BigInt(places);
  const text = `${abs / base}.${(abs % base).toString().padStart(places, "0")}`;
  return negative ? `-${text}` : text;
}

/** Exact line estimate: quantity (≤3 dp) × unit price (≤2 dp), half-up to 2 dp. Display only. */
// Inputs with more decimals are first rounded to 3 dp / 2 dp by toScaled. The backend computes the real total.
export function estimateLine(quantity: string, unitPrice: string): string | null {
  if (!isDecimalString(quantity) || !isDecimalString(unitPrice)) return null;
  const product = toScaled(quantity, 3) * toScaled(unitPrice, 2); // scale 5
  // Adding ±500 before BigInt division (which truncates toward zero) gives half-away-from-zero rounding.
  const rounded = (product + (product >= BigInt(0) ? BigInt(500) : BigInt(-500))) / BigInt(1000); // to scale 2
  return fromScaled(rounded, 2);
}

/** Exact sum to 2 dp; null and non-decimal entries are skipped silently (e.g. half-typed form lines). */
export function sumMoney(values: (string | null)[]): string {
  let total = BigInt(0);
  for (const v of values) if (v && isDecimalString(v)) total += toScaled(v, 2);
  return fromScaled(total, 2);
}

/** -1, 0, 1 comparison of two decimal strings (exact). */
// Compares after rounding to 2 dp, and throws (via toScaled) if either value is not a decimal string.
export function compareMoney(a: string, b: string): number {
  const x = toScaled(a, 2);
  const y = toScaled(b, 2);
  return x === y ? 0 : x > y ? 1 : -1;
}

/** Valid money input: positive, at most 2 decimal places. */
// Also caps the integer part at 12 digits; signs, commas and more than 2 decimals are rejected by the regex.
export function isValidAmount(value: string): boolean {
  return /^\d{1,12}(\.\d{1,2})?$/.test(value.trim()) && toScaled(value, 2) > BigInt(0);
}

/** For chart geometry ONLY (never for financial calculation). */
// Null/undefined/"" plot as 0; Number() may lose precision on very large values, which is acceptable for pixels.
export function chartNumber(value: string | null | undefined): number {
  return value ? Number(value) : 0;
}
