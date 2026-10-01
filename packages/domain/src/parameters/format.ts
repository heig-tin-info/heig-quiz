/**
 * The format of a variable, and its rounding (ADR-056 §6). Internal:
 * `../parameters.ts` is the entry point.
 *
 * A variable IS its formatted value: `g` formatted `.2` is 9.81, and every
 * later row reads 9.81. Formats (`FORMAT_PATTERN`, `../parameterNames.ts`):
 *
 *  - `""`: shown with up to 6 significant figures (never fewer than the
 *    integer digits, so 1234567.8 shows "1234568"), trailing zeros dropped;
 *    the value keeps its full precision;
 *  - `int`: an integer;
 *  - `.1` … `.6`: that many decimals, trailing zeros kept ("9.80");
 *  - `1s` … `6s`: that many significant figures ("0.00123", "1230", "1.50").
 *
 * The digits come from mathjs's `format`, which rounds half away from zero
 * on the DECIMAL representation (the shortest string that reads back as the
 * same double), not on the binary value: 1.005 at `.2` is "1.01" where
 * `toFixed` says "1.00", -2.5 at `int` is -3. This is the one rounding of the
 * platform that does not go through `../round.ts`: a displayed decimal must
 * be the decimal the teacher wrote.
 *
 * The decimal separator is a dot in every language. `int` and `.n` always
 * write plain digits, whatever the magnitude. `""` and `ns` write plain digits
 * for 1e-6 ≤ |x| < 1e21 and switch to an exponent outside that window
 * ("1.2e-7", "4.50e+21"), as JavaScript does, rather than print thirty zeros
 * into a statement.
 */
import { math } from "./evaluator.js";

const fixed = (x: number, decimals: number) => math.format(x, { notation: "fixed", precision: decimals });
const auto = (x: number, digits: number) =>
  math.format(x, { notation: "auto", precision: digits, lowerExp: -6, upperExp: 21 });
const exponential = (x: number, digits: number) => math.format(x, { notation: "exponential", precision: digits });

function formatNumber(x: number, format: string): string {
  let out: string;
  if (format === "int") out = fixed(x, 0);
  else if (format.startsWith(".")) out = fixed(x, Number(format.slice(1)));
  else if (format === "") {
    const intDigits = Math.abs(x) < 1e21 ? String(Math.trunc(Math.abs(x))).length : 1;
    out = auto(x, Math.max(6, intDigits));
  } else {
    // `auto` rounds to n figures but drops trailing zeros; the exponent of
    // the rounded value says how many decimals keep them ("1.50", "10.0").
    const n = Number(format.slice(0, -1));
    const rounded = auto(x, n);
    if (Number(rounded) === 0) out = "0";
    else if (rounded.includes("e")) out = exponential(x, n);
    else {
      const exponent = Number(exponential(Number(rounded), n).split("e")[1]);
      out = fixed(Number(rounded), Math.max(0, n - 1 - exponent));
    }
  }
  // mathjs keeps the sign of a value that rounds to zero ("-0.00").
  return out.replace(/^-(?=[0.]*$)/, "");
}

/** The displayed form of a value. A string is shown as it is, whatever the format. */
export function formatValue(value: number | string, format: string): string {
  return typeof value === "string" ? value : formatNumber(value, format);
}

/** The value a variable holds once rounded by its format (`""` keeps it whole). */
export function roundToFormat(x: number, format: string): number {
  return format === "" ? x : Number(formatNumber(x, format));
}
