/**
 * The CSV export (F-RES-02, PLAN-MVP §4.6).
 *
 * Two decisions the requirement makes for us, and which are asserted by the
 * tests byte for byte:
 *
 *   - a UTF-8 BOM (`EF BB BF`). Excel on Windows reads a BOM-less UTF-8 file
 *     as Latin-1 and turns every accent into mojibake — and this file is full
 *     of French family names;
 *   - `;` as the separator, for the same reason: a French or Swiss Excel
 *     splits on `;` and puts a comma-separated file in one column.
 *
 * Numbers use `.` as the decimal separator (a spreadsheet converts, a parser
 * does not), and the grade is written at one decimal, which is the
 * granularity of the Swiss scale (§7.1).
 */
import type { ResultsView } from "@quiz/contracts";
import { round2 } from "@quiz/domain";

/** U+FEFF, which UTF-8 encodes as the three bytes `EF BB BF`. */
export const BOM = "﻿";
export const SEPARATOR = ";";
/** A header built from `internal_name` is truncated to this (§4.6). */
const HEADER_MAX = 30;

/**
 * RFC-4180 quoting, with the separator of this file. A field is quoted only
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
 * A number this module wrote itself, from a `number`: it cannot be a formula,
 * so it skips the prefix of {@link csvField}. Without that, a negative point
 * count (negative marking, ADR-026) would reach the spreadsheet as the TEXT
 * `'-1`, which no sum adds up. Text from outside — a name, an email — always
 * goes through {@link csvField}, even when it looks like a number.
 */
interface NumericField {
  numeric: string;
}

const line = (fields: readonly (string | NumericField)[]): string =>
  fields.map((f) => (typeof f === "string" ? csvField(f) : f.numeric)).join(SEPARATOR);

/** Two decimals, `.` separator, no trailing zeroes beyond what is needed. */
const points = (value: number): NumericField => ({ numeric: String(round2(value) + 0) });

/** Exactly one decimal: `4` is written `4.0`, because a grade always is. */
const grade = (value: number): NumericField => ({ numeric: value.toFixed(1) });

/**
 * `email;last_name;first_name;q1;…;total;grade`, one row per STUDENT — the
 * absent ones included, with empty per-item cells and a 1.0.
 *
 * A teacher's own test walk (ADR-018) is NOT a row of this file. The export
 * is a grade sheet: it is read by a human, pasted into another one, and
 * sometimes imported by an administration. An extra column saying "ignore
 * this line" is a footnote every downstream reader has to honour, and the
 * first one who does not turns a rehearsal into a student's grade. The row
 * is on the screen, where the badge is read by the person who put it there.
 */
export function resultsCsv(view: ResultsView): string {
  const header = [
    "email",
    "last_name",
    "first_name",
    ...view.items.map((i) => i.internalName.slice(0, HEADER_MAX)),
    "total",
    "grade",
  ];
  const rows = view.rows
    .filter((row) => !row.staff)
    .map((row) =>
      line([
        row.email,
        row.lastName,
        row.firstName,
        ...view.items.map((item) => {
          const value = row.perItem[item.id];
          return value === undefined ? "" : points(value);
        }),
        points(row.points),
        grade(row.grade),
      ]),
    );
  // A trailing newline: every line of the file, including the last, ends.
  return `${BOM}${[line(header), ...rows].join("\r\n")}\r\n`;
}

/** The `Content-Disposition` filename: the title, reduced to a safe slug. */
export function csvFilename(title: string): string {
  const slug =
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "results";
  return `${slug}.csv`;
}
