/**
 * The gradebook's rules (F-GBOOK-01..06, D06, ADR-074; merge task M5-03a).
 * Pure: the `gradebook` module of the API loads the cells, these decide
 * what a cell holds and what a student's mean is.
 *
 * A cell is one of four things: a **grade** (the Swiss grade to the tenth,
 * read from the activity's own results), an **absence** (the school's
 * `a1.0`: 1.0 marked as an absence, which counts as 1.0), **excused** (a
 * staff mark: the student is let off the activity, a justified absence or
 * an illness; named, and counted nowhere, like an empty cell — #969,
 * ADR-074 amendment of 2026-10-29), or **empty** (nothing to count). Two
 * sources make an absence — one derived, one stored — and a stored mark
 * wins over anything beneath it:
 *
 *   - derived: an **exam** released and not taken. An exercise not opened
 *     is an empty cell, never an absence;
 *   - stored: a staff mark `absent`, or a staff `score` — also the score of
 *     a student who never accepted a project, which would otherwise leave
 *     an empty cell (spec 06 no. 48).
 *
 * The **mean** is the weighted mean of the columns that count and in which
 * the student has a grade (an absence is a 1.0, an excused cell has none), computed from the cell
 * grades AS DISPLAYED (each rounded to the tenth), then rounded to the
 * tenth. A weight is a whole percentage, 0 to 100 (#545): RELATIVE, not a
 * budget — the weights need not sum to 100, the mean divides by the sum of
 * the weights it used, so a column the student has no grade in is skipped
 * and the others renormalised; 0 % keeps a column in view and out of the
 * mean. No ranking anywhere.
 *
 * **Components of the mean** (ADR-131): a course may name components
 * ("Labo", "Cours"), each with its own relative weight, and put each column
 * in one. As soon as the course has one, the mean has two levels: a
 * component's mean is the formula above over ITS columns, rounded to the
 * tenth, and the overall mean is the same formula over the component means,
 * weighted by the components' weights — a component without a mean for the
 * student skipped and the others renormalised; and a counted column in no
 * component counts in no mean ({@link countsInMean}). A course without a
 * component is the same computation over one implicit component that holds
 * every column, which gives exactly the one-level mean.
 *
 * The **class means** are the staff's alone: a column's is the plain mean
 * of the grades its cells count as (an absence a 1.0, as in a student's
 * mean; an empty or excused cell left out), the class's overall one the plain mean of
 * the students' means (a student with none left out).
 */
import type { EvaluationModeName } from "./evaluationConfig.js";
import { MIN_GRADE } from "./grade.js";
import { roundToTenth } from "./round.js";

/**
 * What a staff mark says: the student was absent (a1.0, counts), excused
 * (counts nowhere), or the teacher's own score.
 */
export const GRADEBOOK_MARK_KINDS = ["absent", "excused", "score"] as const;
export type GradebookMarkKind = (typeof GRADEBOOK_MARK_KINDS)[number];

/** An absence reads as the scale's minimum: `a1.0`. */
export const ABSENT_GRADE = MIN_GRADE;

/** A column's weight: a whole percentage, 0 to 100 (`GradebookWeight`, `@quiz/contracts`); 100 % by default (#545, ADR-074 amendment). */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 100;
export const WEIGHT_DEFAULT = 100;

/** What a gradebook column is of: an evaluation's mode, or a project (a poll never has a column). */
export const GRADEBOOK_COLUMN_KINDS = ["exam", "exercise", "project"] as const;
export type GradebookColumnKind = (typeof GRADEBOOK_COLUMN_KINDS)[number];

/**
 * Whether a column counts toward the mean before the teacher says: exams
 * and projects do, exercises are opt-in (D06).
 */
export function countsByDefault(kind: GradebookColumnKind): boolean {
  return kind !== "exercise";
}

/** The column kind of an evaluation's mode: an exam, or an exercise (a poll never has a column). */
export const evaluationColumnKind = (mode: EvaluationModeName): Exclude<GradebookColumnKind, "project"> => (mode === "exam" ? "exam" : "exercise");

/** What a cell holds, before any mark. */
export type CellOutcome = { kind: "grade"; grade: number } | { kind: "absent" } | { kind: "excused" } | { kind: "empty" };

/** A staff mark, as the rules read it: `score` carries the grade it converts to. */
export type MarkOutcome = { kind: "absent" } | { kind: "excused" } | { kind: "score"; grade: number };

/** The grade a cell counts as, or null when it has none: an absence is 1.0; an excused cell, like an empty one, has none. */
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
  return mark.kind === "score" ? { kind: "grade", grade: mark.grade } : { kind: mark.kind };
}

/**
 * The cell of a student for a RELEASED evaluation they did not take: an
 * exam is an absence, an exercise is empty.
 */
export function notTakenCell(mode: "exam" | "exercise"): CellOutcome {
  return mode === "exam" ? { kind: "absent" } : { kind: "empty" };
}

/** One column as the mean reads it. `componentId`: the component of the mean it is in (ADR-131), none by default. */
export interface MeanColumn {
  weight: number;
  counts: boolean;
  cell: CellOutcome;
  componentId?: string | null;
}

/** A component's name: trimmed, 1 to 40 characters, unique in its course whatever its case (ADR-131). */
export const COMPONENT_NAME_MAX = 40;

/** A component of the mean as the mean reads it: its id and its weight, a whole percentage relative to the others'. */
export interface MeanComponent {
  id: string;
  weight: number;
}

/**
 * THE rule of what counts toward a mean (ADR-131 §4): the column's own
 * `counts` flag and, once the course has a component of the mean, a
 * component — a counted column left in none counts in no mean, in every
 * classroom of the course. The staff's mean, the student's `counts` flag and
 * the rows of the student's Grades page all read it.
 */
export function countsInMean(counts: boolean, componentId: string | null | undefined, courseHasComponents: boolean): boolean {
  return counts && (!courseHasComponents || componentId != null);
}

/** A student's means: the overall one, and each component's by id (empty without a component). */
export interface GradebookMeans {
  mean: number | null;
  components: Record<string, number | null>;
}

/** The one component a course without any holds: every column, at any weight (it is alone). */
const IMPLICIT_COMPONENT: MeanComponent = { id: "", weight: WEIGHT_DEFAULT };

/**
 * A student's means over their columns (ADR-131 §3). Each component's mean is
 * {@link gradebookMean} over its counted columns, to the tenth; the overall
 * mean is the same formula over those rounded means, weighted by the
 * components' weights: a component with no mean is skipped, one at 0 % keeps
 * its own mean and is out of the overall one, all at 0 % give none. Without a
 * component, one implicit component holds every column, whose rounded mean is
 * the overall mean exactly: the one-level mean of ADR-074 §7.
 */
export function gradebookMeans(columns: readonly MeanColumn[], components: readonly MeanComponent[]): GradebookMeans {
  const explicit = components.length > 0;
  const parts = explicit ? components : [IMPLICIT_COMPONENT];
  const counted = columns.filter((c) => countsInMean(c.counts, c.componentId, explicit));
  const means = parts.map((part) => gradebookMean(counted.filter((c) => (explicit ? c.componentId === part.id : true))));
  const mean = gradebookMean(
    parts.map((part, i): MeanColumn => {
      const partMean = means[i] ?? null;
      return { weight: part.weight, counts: true, cell: partMean === null ? { kind: "empty" } : { kind: "grade", grade: partMean } };
    }),
  );
  return { mean, components: explicit ? Object.fromEntries(parts.map((part, i) => [part.id, means[i] ?? null])) : {} };
}

/**
 * `numerator / denominator` tenths as a grade, the half-tenth rounded up:
 * both are integers, so the rounding is exact whatever the binary float of
 * 4.35 is. Null for an empty denominator.
 */
function tenthsRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.floor((2 * numerator + denominator) / (2 * denominator)) / 10;
}

/**
 * The weighted mean of the counted columns the student has a grade in, to
 * the tenth, or null when there is none (or every such weight is 0):
 * `Σ(wᵢ·gᵢ) / Σ(wᵢ)`. The arithmetic is in integers — whole percentages
 * times grade tenths — so the half-tenth rounds up exactly.
 */
export function gradebookMean(columns: readonly MeanColumn[]): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const { weight, counts, cell } of columns) {
    const grade = cellGrade(cell);
    if (!counts || grade === null) continue;
    const w = Math.round(weight);
    numerator += w * Math.round(grade * 10);
    denominator += w;
  }
  return tenthsRatio(numerator, denominator);
}

/**
 * The class's mean of some grades, to the tenth, half up: a column's (the
 * grades its cells count as, `cellGrade`) or the class's overall one (the
 * students' means). A null is no grade and left out; none at all is null.
 */
export function classMean(grades: Iterable<number | null>): number | null {
  let sum = 0;
  let count = 0;
  for (const grade of grades) {
    if (grade === null) continue;
    sum += Math.round(grade * 10);
    count += 1;
  }
  return tenthsRatio(sum, count);
}
