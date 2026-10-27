/**
 * A project's score as a Swiss grade (F-PROJ-14, D05, spec 06 no. 49).
 *
 * A project has a scale of its own, distinct from an evaluation's: linear,
 * 1 + 5 × points / max, capped at 6, rounded to the tenth by the project's
 * rounding ({@link gradeFromPoints}). The `score_is_grade` preset, which read
 * a score out of 6 as the grade, is gone: its scores were converted to their
 * linear equivalent (ADR-119 §11, migration 0120).
 *
 * Every score converts with its OWN maximum: a final score whose maximum
 * differs from the frozen one's is not rescaled first.
 */
import { gradeFromPoints } from "./grade.js";
import type { Rounding } from "./round.js";

export const PROJECT_SCALE_KINDS = ["linear"] as const;
export type ProjectScaleKind = (typeof PROJECT_SCALE_KINDS)[number];

export interface ProjectScale {
  kind: ProjectScaleKind;
  rounding?: Rounding | undefined;
}

export interface ProjectGrade {
  grade: number;
}

/**
 * heig-classroom's reading of a score out of 6: a mark, which its CI
 * (StudentScore 0.7.5) printed. Only the import still meets one.
 */
const MARK_MAX = 6;

/**
 * A score heig-classroom read as a mark, as points: `g` out of 6 becomes
 * `(g − 1)` out of 5, clamped to `[0, 5]`, so that the linear scale gives
 * `g` back (ADR-119 §11, the arithmetic of migration `0120`). Any other
 * maximum was already read linearly and is unchanged; so is a missing score.
 */
export function markAsPoints<T extends { points: number | null; max: number | null }>(score: T): T {
  if (score.max !== MARK_MAX || score.points === null) return score;
  return { ...score, points: Math.min(MARK_MAX - 1, Math.max(0, score.points - 1)), max: MARK_MAX - 1 };
}

/** points / max → Swiss grade 1.0 … 6.0 by the project's scale. */
export function projectGrade(points: number, max: number, scale: ProjectScale): ProjectGrade {
  return { grade: gradeFromPoints(points, max, { rounding: scale.rounding ?? "nearest" }) };
}
