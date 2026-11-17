/**
 * The gradebook's CSV export (F-GBOOK-04, ADR-074; merge task M5-03b), in the
 * format of F-RES-02: the conventions are the application's one CSV writer
 * (`apps/api/src/csv.ts`).
 *
 * `email;last_name;first_name;<one column per gradebook column>;mean`, the
 * columns in the table's order, one row per claimed STUDENT seat — the
 * table's staff seats stay out of the file (ADR-018, amended 2026-11-17). A cell is the grade at one decimal,
 * `a1.0` for the school's absence mark (1.0 marked as an absence, which counts
 * as 1.0 and must stay distinguishable from a real 1.0 in the file), or empty
 * — an excused cell too, which counts in no mean (#969).
 * The file says what the screen says: a column not released carries its
 * header's ` (unreleased)` suffix, and stays out of the mean.
 *
 * Two lines frame the students (#545): right under the header, `weight`
 * with each counted column's weight in whole percent (empty for a column
 * that does not count, and under `mean`); last, `class_mean` with each
 * column's class mean and the class's overall mean under `mean`. Both put
 * their label in the `email` field and leave the names empty.
 *
 * Once the course has components of the mean (ADR-131), one more column per
 * component, named after it, stands just before `mean` (still last), with
 * each student's mean of the component; a `component` line, right under the
 * header, names each column's component; the `weight` line carries the
 * components' weights under their columns, `class_mean` their class means,
 * and a column in no component carries no weight, since it counts in no
 * mean. Without a component the file is unchanged.
 */
import type { GradebookStaff, GradebookStaffCell } from "@quiz/contracts";
import { countsInMean } from "@quiz/domain";

import { csvFile, grade, HEADER_MAX, line, type NumericField } from "../../csv.js";

/** What a column header ends with while the column is not released: its grades are not in the mean. */
const UNRELEASED_SUFFIX = " (unreleased)";

const optionalGrade = (value: number | null): string | NumericField => (value === null ? "" : grade(value));

/** How a cell is written: its grade, the absence sigil, or nothing. */
function cellField(cell: GradebookStaffCell | undefined): string | NumericField {
  if (!cell) return "";
  if (cell.kind === "absent") return "a1.0";
  return cell.kind === "grade" && cell.grade !== null ? grade(cell.grade) : "";
}

export function gradebookCsv(table: GradebookStaff): string {
  const { components } = table;
  const header = [
    "email",
    "last_name",
    "first_name",
    ...table.columns.map((c) => `${c.title.slice(0, HEADER_MAX)}${c.released ? "" : UNRELEASED_SUFFIX}`),
    ...components.map((k) => k.name.slice(0, HEADER_MAX)),
    "mean",
  ];
  const names = new Map(components.map((k) => [k.id, k.name]));
  const componentLine =
    components.length === 0
      ? []
      : [line(["component", "", "", ...table.columns.map((c) => (c.componentId === null ? "" : (names.get(c.componentId) ?? ""))), ...components.map(() => ""), ""])];
  const weights = line([
    "weight",
    "",
    "",
    ...table.columns.map((c) => (countsInMean(c.counts, c.componentId, components.length > 0) ? { numeric: String(c.weight) } : "")),
    ...components.map((k) => ({ numeric: String(k.weight) })),
    "",
  ]);
  const rows = table.rows.filter((row) => !row.staff).map((row) =>
    line([
      row.email,
      row.nom,
      row.prenom,
      ...table.columns.map((c) => cellField(row.cells[c.activityId])),
      ...components.map((k) => optionalGrade(row.componentMeans[k.id] ?? null)),
      optionalGrade(row.mean),
    ]),
  );
  const classMeans = line([
    "class_mean",
    "",
    "",
    ...table.columns.map((c) => optionalGrade(c.classMean)),
    ...components.map((k) => optionalGrade(k.classMean)),
    optionalGrade(table.classMean),
  ]);
  return csvFile([line(header), ...componentLine, weights, ...rows, classMeans]);
}
