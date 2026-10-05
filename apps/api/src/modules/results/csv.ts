/**
 * The results CSV (F-RES-02, PLAN-MVP §4.6). The conventions — UTF-8 BOM, `;`,
 * quoting, one-decimal grades — are the application's one CSV writer,
 * `apps/api/src/csv.ts`, shared with the gradebook's export.
 */
import type { ResultsView } from "@quiz/contracts";

import { csvFile, grade, line, points } from "../../csv.js";

export { BOM, csvField, csvFilename } from "../../csv.js";

/** A header built from `internal_name` is truncated to this (§4.6). */
const HEADER_MAX = 30;

/** What a bonus item's header ends with (ADR-052): its points are not in the total. */
const BONUS_SUFFIX = " (bonus)";

/**
 * `email;last_name;first_name;q1;…;total;grade`, one row per STUDENT — the
 * absent ones included, with empty per-item cells and a 1.0. A bonus item's
 * header says ` (bonus)`; `total` is the student's points, bonus included.
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
    ...view.items.map((i) => `${i.internalName.slice(0, HEADER_MAX)}${i.bonus ? BONUS_SUFFIX : ""}`),
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
  return csvFile([line(header), ...rows]);
}
