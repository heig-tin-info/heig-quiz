/**
 * A teacher's adjustment of a project repository's grade (ADR-135): after a
 * talk with the student, or an explanation given afterwards, the grade
 * itself is moved — never the criteria nor their points. The third layer of
 * the grade's pipeline: the points (`resolveFinalScore`: teacher > criteria
 * > review > CI) → their grade by the project's scale (`projectScoreGrade`)
 * → THIS adjustment → the gradebook, where a teacher's stored mark still
 * wins (`resolveCell`).
 *
 * Two kinds:
 *   - `relative`: a delta, a multiple of 0.1 within ±5, never 0. It
 *     survives a regrade: the base moves, the delta stays.
 *   - `absolute`: a grade 1.0 … 6.0 at the tenth. It pins the grade; the
 *     base it was written over is kept, and a base that moved since is said
 *     to the staff ({@link AdjustedGrade.moved}) — never re-based
 *     silently.
 *
 * Computed live, never frozen: every view of the grade (the grading table,
 * the repository's sheet, the release, the gradebook, the student's
 * released grade) goes through {@link adjustGrade}.
 */
import { MAX_GRADE, MIN_GRADE } from "./grade.js";
import { clamp, roundToTenth } from "./round.js";

export const GRADE_ADJUSTMENT_KINDS = ["relative", "absolute"] as const;
export type GradeAdjustmentKind = (typeof GRADE_ADJUSTMENT_KINDS)[number];

/** The largest delta of a `relative` adjustment, either way. */
export const GRADE_ADJUSTMENT_DELTA_MAX = 5;
/** The justification's ceiling, in characters once trimmed. */
export const GRADE_ADJUSTMENT_COMMENT_MAX = 2000;

/** An adjustment as stored: its kind, its value, the base grade it was written over. */
export interface GradeAdjustment {
  kind: GradeAdjustmentKind;
  value: number;
  /** The base grade at the write; what tells an absolute pin that its base moved. */
  baseAtWrite: number | null;
}

/** A value read at the tenth, whatever float hair it carries (`4.3 + 0.2`). */
const sameTenth = (a: number, b: number) => Math.round(a * 10) === Math.round(b * 10);

/** A multiple of 0.1, up to a float hair (`0.1 * 3`); 3.55 is not one. */
const atTenth = (value: number) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-6;

/**
 * Whether `value` is a valid value of a `kind` adjustment: a multiple of 0.1
 * — a delta within ±{@link GRADE_ADJUSTMENT_DELTA_MAX}, never 0; a grade
 * within 1 … 6. The contract refuses the rest (invariant 7).
 */
export function validGradeAdjustment({ kind, value }: Pick<GradeAdjustment, "kind" | "value">): boolean {
  if (!Number.isFinite(value) || !atTenth(value)) return false;
  if (kind === "absolute") return value >= MIN_GRADE && value <= MAX_GRADE;
  return Math.abs(value) <= GRADE_ADJUSTMENT_DELTA_MAX && !sameTenth(value, 0);
}

/** A grade and the adjustment it went through. */
export interface AdjustedGrade {
  /** The grade before the adjustment: the points' grade by the project's scale. */
  base: number;
  /** The grade every view shows. */
  grade: number;
  /**
   * An absolute pin whose base moved since it was written — from the base
   * it was written over to the base of now —, null otherwise: the staff
   * keep it (written again) or clear it.
   */
  moved: { from: number; to: number } | null;
}

/**
 * The grade of a `base` through `adjustment`: unchanged without one; an
 * absolute pin's value; a relative one's `base + delta` clamped to 1 … 6
 * and rounded to the tenth (nearest, half away from zero) — the project's
 * own rounding already made the base. Null without a base: an adjustment
 * moves a grade, it never makes one (`409 no_grade`).
 */
export function adjustGrade(base: number | null, adjustment: GradeAdjustment | null): AdjustedGrade | null {
  if (base === null) return null;
  if (adjustment === null) return { base, grade: base, moved: null };
  if (adjustment.kind === "absolute") {
    const from = adjustment.baseAtWrite;
    const moved = from !== null && !sameTenth(from, base) ? { from, to: base } : null;
    return { base, grade: roundToTenth(adjustment.value), moved };
  }
  return { base, grade: roundToTenth(clamp(base + adjustment.value, MIN_GRADE, MAX_GRADE)), moved: null };
}
