/**
 * The CSV conventions of every export (F-RES-02, F-GBOOK-04, PLAN-MVP §4.6):
 * the application's one writer, so a second export cannot drift from the
 * first. Asserted byte for byte by the tests of each export.
 *
 *   - a UTF-8 BOM (`EF BB BF`). Excel on Windows reads a BOM-less UTF-8 file
 *     as Latin-1 and turns every accent into mojibake — and these files are
 *     full of French family names;
 *   - `;` as the separator, for the same reason: a French or Swiss Excel
 *     splits on `;` and puts a comma-separated file in one column.
 *
 * Numbers use `.` as the decimal separator (a spreadsheet converts, a parser
 * does not), and a grade is written at one decimal, which is the granularity
 * of the Swiss scale (§7.1).
 */
import { round2, slugify } from "@quiz/domain";

/** U+FEFF, which UTF-8 encodes as the three bytes `EF BB BF`. */
export const BOM = "﻿";
export const SEPARATOR = ";";

/**
 * RFC-4180 quoting, with the separator of these files. A field is quoted only
 * when it has to be, so a plain export stays diff-readable.
 *
 * A field that a spreadsheet would read as a FORMULA is prefixed with a
 * single quote first. Names and emails come from the roster import and from
 * the identity provider's claims, so `=HYPERLINK("http://…"&A1)` in a family
 * name is a grade sheet walking out of the teacher's Excel; quoting does not
 * stop that, the prefix does, and Excel does not display it.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function csvField(value: string): string {
  const safe = FORMULA_LEAD.has(value.slice(0, 1)) ? `'${value}` : value;
  return /[";\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * A number a file writer made itself, from a `number`: it cannot be a formula,
 * so it skips the prefix of {@link csvField}. Without that, a negative point
 * count (negative marking, ADR-026) would reach the spreadsheet as the TEXT
 * `'-1`, which no sum adds up. Text from outside — a name, an email — always
 * goes through {@link csvField}, even when it looks like a number.
 */
export interface NumericField {
  numeric: string;
}

export const line = (fields: readonly (string | NumericField)[]): string =>
  fields.map((f) => (typeof f === "string" ? csvField(f) : f.numeric)).join(SEPARATOR);

/** Two decimals, `.` separator, no trailing zeroes beyond what is needed. */
export const points = (value: number): NumericField => ({ numeric: String(round2(value) + 0) });

/** Exactly one decimal: `4` is written `4.0`, because a grade always is. */
export const grade = (value: number): NumericField => ({ numeric: value.toFixed(1) });

/** A whole file: the BOM, the lines, and a trailing newline — every line, the last included, ends. */
export const csvFile = (lines: readonly string[]): string => `${BOM}${lines.join("\r\n")}\r\n`;

/** The `Content-Disposition` filename: the title, reduced to a safe slug (`fallback` when it has none). */
export function csvFilename(title: string, fallback = "results"): string {
  return `${slugify(title) || fallback}.csv`;
}
