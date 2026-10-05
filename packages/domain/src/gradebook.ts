/**
 * The gradebook's rules (F-GBOOK-01..06, D06, ADR-074; merge task M5-03a).
 * Pure: the `gradebook` module of the API loads the cells, these decide
 * what a cell holds and what a student's mean is.
 *
 * A cell is one of three things: a **grade** (the Swiss grade to the tenth,
 * read from the activity's own results), an **absence** (the school's
 * `a1.0`: 1.0 marked as an absence, which counts as 1.0), or **empty**
 * (nothing to count). Two sources make an absence — one derived, one
 * stored — and a stored mark wins over anything beneath it:
 *
 *   - derived: an **exam** released and not taken. An exercise not opened
 *     is an empty cell, never an absence;
 *   - stored: a staff mark `absent`, or a staff `score` — also the score of
 *     a student who never accepted a project, which would otherwise leave
 *     an empty cell (spec 06 no. 48).
 *
 * The **mean** is the weighted mean of the columns that count and in which
 * the student has a grade (an absence is a 1.0), computed from the cell
 * grades AS DISPLAYED (each rounded to the tenth), then rounded to the
 * tenth. No ranking anywhere.
 */
import { MIN_GRADE } from "./grade.js";
import { roundToTenth } from "./round.js";

/** What a staff mark says: the student was absent, or the teacher's own score. */
export const GRADEBOOK_MARK_KINDS = ["absent", "score"] as const;
export type GradebookMarkKind = (typeof GRADEBOOK_MARK_KINDS)[number];

/** An absence reads as the scale's minimum: `a1.0`. */
export const ABSENT_GRADE = MIN_GRADE;

/** A column's weight: 0 to 10, to the tenth; 1 by default. */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 10;
export const WEIGHT_DEFAULT = 1;

/** What a gradebook column is of: an evaluation's mode, or a project (a poll never has a column). */
export type GradebookColumnKind = "exam" | "exercise" | "project";

/**
 * Whether a column counts toward the mean before the teacher says: exams
 * and projects do, exercises are opt-in (D06).
 */
export function countsByDefault(kind: GradebookColumnKind): boolean {
  return kind !== "exercise";
}

/** What a cell holds, before any mark. */
export type CellOutcome = { kind: "grade"; grade: number } | { kind: "absent" } | { kind: "empty" };

/** A staff mark, as the rules read it: `score` carries the grade it converts to. */
export type MarkOutcome = { kind: "absent" } | { kind: "score"; grade: number };

/** The grade a cell counts as, or null when it has none: an absence is 1.0. */
export function cellGrade(cell: CellOutcome): number | null {
  if (cell.kind === "absent") return ABSENT_GRADE;
  return cell.kind === "grade" ? roundToTenth(cell.grade) : null;
}

/** Whether the cell counts as having a grade for the mean. */
export function hasGrade(cell: CellOutcome): boolean {
  return cellGrade(cell) !== null;
}

/** A mark wins over whatever lies beneath it (D06, 2026-10-05); no mark leaves the cell as it was. */
export function resolveCell(mark: MarkOutcome | null, beneath: CellOutcome): CellOutcome {
  if (mark === null) return beneath;
  return mark.kind === "absent" ? { kind: "absent" } : { kind: "grade", grade: mark.grade };
}

/**
 * The cell of a student for a RELEASED evaluation they did not take: an
 * exam is an absence, an exercise is empty.
 */
export function notTakenCell(mode: "exam" | "exercise"): CellOutcome {
  return mode === "exam" ? { kind: "absent" } : { kind: "empty" };
}

/** One column as the mean reads it. */
export interface MeanColumn {
  weight: number;
  counts: boolean;
  cell: CellOutcome;
}

/**
 * The weighted mean of the counted columns the student has a grade in, to
 * the tenth, or null when there is none (or every such weight is 0). The
 * arithmetic is in integer tenths — grades and weights alike — so the
 * half-tenth rounds up exactly, whatever the binary float of 4.35 is.
 */
export function gradebookMean(columns: readonly MeanColumn[]): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const { weight, counts, cell } of columns) {
    const grade = cellGrade(cell);
    if (!counts || grade === null) continue;
    const w = Math.round(weight * 10);
    numerator += w * Math.round(grade * 10);
    denominator += w;
  }
  if (denominator === 0) return null;
  return Math.floor((2 * numerator + denominator) / (2 * denominator)) / 10;
}

/** A weight the settings accept: 0 to 10, at most one decimal. */
export function validWeight(weight: number): boolean {
  return (
    Number.isFinite(weight) &&
    weight >= WEIGHT_MIN &&
    weight <= WEIGHT_MAX &&
    Math.abs(weight * 10 - Math.round(weight * 10)) < 1e-9
  );
}
