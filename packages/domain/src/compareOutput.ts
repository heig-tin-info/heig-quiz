/**
 * Output comparison for the `code` type (docs/04 §4.7, PLAN-MVP §2.4).
 *
 * The steps are applied in order, on both sides, so that a trailing newline or
 * a Windows line ending never decides a grade.
 */

export interface NumericCompare {
  epsilon: number;
  mode: "abs" | "rel";
}

export interface CompareOptions {
  trimTrailing?: boolean | undefined;
  ignoreCase?: boolean | undefined;
  numeric?: NumericCompare | null | undefined;
}

function prepare(s: string, opts: CompareOptions): string {
  let out = s.replace(/\r\n?/g, "\n");
  if (opts.trimTrailing !== false) {
    out = out
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  }
  if (opts.ignoreCase === true) out = out.toLowerCase();
  return out;
}

/** True when the produced output counts as the expected one. */
export function compareOutput(expected: string, actual: string, opts: CompareOptions = {}): boolean {
  const a = prepare(expected, opts);
  const b = prepare(actual, opts);
  const numeric = opts.numeric ?? null;
  if (numeric === null) return a === b;

  const left = a.split(/\s+/).filter((t) => t !== "");
  const right = b.split(/\s+/).filter((t) => t !== "");
  if (left.length !== right.length) return false;
  return left.every((token, i) => compareToken(token, right[i]!, numeric));
}

function compareToken(expected: string, actual: string, numeric: NumericCompare): boolean {
  const e = Number(expected);
  const a = Number(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a)) return expected === actual;
  const limit = numeric.mode === "rel" ? Math.abs(e) * numeric.epsilon : numeric.epsilon;
  return Math.abs(a - e) <= limit + 1e-12;
}
