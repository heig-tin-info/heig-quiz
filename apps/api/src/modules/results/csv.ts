/**
 * The results CSV (F-RES-02, PLAN-MVP §4.6). The conventions — UTF-8 BOM, `;`,
 * quoting, one-decimal grades — are the application's one CSV writer,
 * `apps/api/src/csv.ts`, shared with the gradebook's export.
 */
import type { ItemCounting, ResultsView } from "@quiz/contracts";

import { csvFile, grade, HEADER_MAX, line, points } from "../../csv.js";

export { BOM, csvField, csvFilename } from "../../csv.js";

/**
 * What an item's header ends with, by its counting: a bonus item's points
 * are not in the total but in the student's (ADR-052); a neutralized item's
 * are in neither, though its cells still show them (ADR-108). The file's
 * headers are English whatever the reader's language, like `total`.
 */
const COUNTING_SUFFIX: Record<ItemCounting, string> = {
  normal: "",
  bonus: " (bonus)",
  neutralized: " (not counted)",
};

/**
 * `email;last_name;first_name;q1;…;total;grade`, one row per STUDENT — the
 * absent ones included, with empty per-item cells and a 1.0. A bonus item's
 * header says ` (bonus)`, a neutralized one's ` (not counted)`; `total` is
 * the student's points, bonus included, neutralized items left out.
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
    ...view.items.map((i) => `${i.internalName.slice(0, HEADER_MAX)}${COUNTING_SUFFIX[i.counting]}`),
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
