/**
 * The gradebook's CSV export (F-GBOOK-04, ADR-074; merge task M5-03b), in the
 * format of F-RES-02: the conventions are the application's one CSV writer
 * (`apps/api/src/csv.ts`).
 *
 * `email;last_name;first_name;<one column per gradebook column>;mean`, the
 * columns in the table's order, one row per claimed STUDENT seat — the table
 * never holds a staff seat (ADR-018 §3). A cell is the grade at one decimal,
 * `a1.0` for the school's absence mark (1.0 marked as an absence, which counts
 * as 1.0 and must stay distinguishable from a real 1.0 in the file), or empty.
 * The file says what the screen says: a column not released carries its
 * header's ` (unreleased)` suffix, and stays out of the mean.
 */
import type { GradebookStaff, GradebookStaffCell } from "@quiz/contracts";

import { csvFile, grade, line, type NumericField } from "../../csv.js";

/** What a column header ends with while the column is not released: its grades are not in the mean. */
const UNRELEASED_SUFFIX = " (unreleased)";
/** A header built from an activity's title is truncated to this, as the results export's. */
const HEADER_MAX = 30;

/** How a cell is written: its grade, the absence sigil, or nothing. */
function cellField(cell: GradebookStaffCell | undefined): string | NumericField {
  if (!cell) return "";
  if (cell.kind === "absent") return "a1.0";
  return cell.kind === "grade" && cell.grade !== null ? grade(cell.grade) : "";
}

export function gradebookCsv(table: GradebookStaff): string {
  const header = [
    "email",
    "last_name",
    "first_name",
    ...table.columns.map((c) => `${c.title.slice(0, HEADER_MAX)}${c.released ? "" : UNRELEASED_SUFFIX}`),
    "mean",
  ];
  const rows = table.rows.map((row) =>
    line([
      row.email,
      row.nom,
      row.prenom,
      ...table.columns.map((c) => cellField(row.cells[c.activityId])),
      row.mean === null ? "" : grade(row.mean),
    ]),
  );
  return csvFile([line(header), ...rows]);
}
