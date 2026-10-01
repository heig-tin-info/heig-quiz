/**
 * The format of a variable, and its rounding (ADR-056 §6).
 *
 * A variable IS its formatted value: `g` formatted `.2` is 9.81, and every
 * later row reads 9.81. Formats:
 *
 *  - `""`: shown with up to 6 significant figures (never fewer than the
 *    integer digits, so 1234567.8 shows "1234568"), trailing zeros dropped;
 *    the value keeps its full precision;
 *  - `int`: an integer;
 *  - `.1` … `.6`: that many decimals, trailing zeros kept ("9.80");
 *  - `1s` … `6s`: that many significant figures ("0.00123", "1230", "1.50").
 *
 * Rounding is half away from zero ON THE DECIMAL REPRESENTATION — the shortest
 * string that reads back as the same double, `String(x)` — never on the binary
 * value and never with `toFixed`: 1.005 at `.2` is "1.01" (`toFixed` says
 * "1.00"), -2.5 at `int` is -3. A value that a computation left just below a
 * half (1.00499999…) rounds down, as its decimal form says.
 *
 * The decimal separator is a dot in every language. `int` and `.n` always
 * write plain digits, whatever the magnitude (1e25 at `int` is a 1 and 25
 * zeros). `""` and `ns` write plain digits for 1e-6 ≤ |x| < 1e21 and switch to
 * an exponent outside that window ("1.23e-7", "4.5e+21"), as JavaScript does,
 * rather than print thirty zeros into a statement.
 */

export const FORMAT_PATTERN = /^(?:|int|\.[1-6]|[1-6]s)$/;

export function isFormat(format: string): boolean {
  return FORMAT_PATTERN.test(format);
}

/** A decimal: the digits, without leading zeros, and the position of the point. */
interface Decimal {
  digits: string;
  /** Digits before the point: "1.005" is 1005 with point 1, "0.012" is 12 with point -1. */
  point: number;
}

function decompose(x: number): Decimal {
  const [mantissa, exponent] = String(Math.abs(x)).split("e") as [string, string | undefined];
  const [int, frac = ""] = mantissa.split(".") as [string, string | undefined];
  const raw = int + frac;
  const lead = raw.length - raw.replace(/^0+/, "").length;
  const digits = raw.slice(lead).replace(/0+$/, "");
  return digits === "" ? { digits: "", point: 0 } : { digits, point: int.length - lead + Number(exponent ?? 0) };
}

/** Keeps the first `keep` digits, half away from zero. */
function roundDigits(d: Decimal, keep: number): Decimal {
  if (keep >= d.digits.length) return d;
  if (keep < 0) return { digits: "", point: 0 };
  const up = d.digits[keep]! >= "5";
  let digits = d.digits.slice(0, keep);
  let point = d.point;
  if (up) {
    const carried = String(BigInt(digits === "" ? "0" : digits) + 1n).padStart(keep, "0");
    if (carried.length > keep) point += 1;
    digits = carried;
  }
  digits = digits.replace(/0+$/, "");
  return digits === "" ? { digits: "", point: 0 } : { digits, point };
}

/** Plain digits, with exactly `decimals` digits after the point. */
function plain(d: Decimal, decimals: number): string {
  const all = d.point > 0 ? d.digits.padEnd(d.point, "0") : "0".repeat(1 - d.point) + d.digits;
  const intLength = Math.max(d.point, 1);
  const int = all.slice(0, intLength);
  const frac = all.slice(intLength).padEnd(decimals, "0").slice(0, decimals);
  return decimals > 0 ? `${int}.${frac}` : int;
}

function exponential(d: Decimal, minDigits: number): string {
  const mantissa = d.digits.padEnd(minDigits, "0");
  const e = d.point - 1;
  const rest = mantissa.slice(1);
  return `${mantissa[0]}${rest ? `.${rest}` : ""}e${e < 0 ? "-" : "+"}${Math.abs(e)}`;
}

/** The written form of a number under a format (the format is assumed valid). */
function formatNumber(x: number, format: string): string {
  const d = decompose(x);
  let body: string;
  if (format === "int" || format.startsWith(".")) {
    const decimals = format === "int" ? 0 : Number(format.slice(1));
    body = plain(roundDigits(d, d.point + decimals), decimals);
  } else {
    const significant = format === "" ? Math.max(6, d.point) : Number(format.slice(0, -1));
    const keepZeros = format !== "";
    const r = roundDigits(d, significant);
    if (r.digits === "") body = "0";
    else if (r.point <= -6 || r.point > 21) body = exponential(r, keepZeros ? significant : 0);
    else {
      const decimals = keepZeros ? Math.max(0, significant - r.point) : Math.max(0, r.digits.length - r.point);
      body = plain(r, decimals);
    }
  }
  return x < 0 && /[1-9]/.test(body) ? `-${body}` : body;
}

/** The displayed form of a value. A string is shown as it is, whatever the format. */
export function formatValue(value: number | string, format: string): string {
  return typeof value === "string" ? value : formatNumber(value, format);
}

/** The value a variable holds once rounded by its format (`""` keeps it whole). */
export function roundToFormat(x: number, format: string): number {
  return format === "" ? x : Number(formatNumber(x, format));
}
