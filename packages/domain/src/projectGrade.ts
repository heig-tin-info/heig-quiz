/**
 * A project's score as a Swiss grade (F-PROJ-14, D05, spec 06 no. 49).
 *
 * A project has a scale of its own, distinct from an evaluation's (which is
 * linear only, ADR-052):
 *   - `linear` — Quiz's scale, the default: 1 + 5 × points / max, capped
 *     at 6, rounded to the tenth ({@link gradeFromPoints});
 *   - `score_is_grade` — the preset for a CI that already reports a mark
 *     out of 6 (heig-classroom read `max = 6` as a mark): the points ARE the
 *     grade, clamped to 1…6 and rounded to the tenth. Any other maximum
 *     falls back to the linear scale, and says so (`fellBack`), for the
 *     teacher's warning.
 *
 * Every score converts with its OWN maximum: a final score whose maximum
 * differs from the frozen one's is not rescaled first.
 */
import { gradeFromPoints, MAX_GRADE, MIN_GRADE } from "./grade.js";
import { clamp, roundToTenth, type Rounding } from "./round.js";

export const PROJECT_SCALE_KINDS = ["linear", "score_is_grade"] as const;
export type ProjectScaleKind = (typeof PROJECT_SCALE_KINDS)[number];

export interface ProjectScale {
  kind: ProjectScaleKind;
  rounding?: Rounding | undefined;
}

/** The maximum at which "the score is the grade" applies. */
export const SCORE_IS_GRADE_MAX = 6;

export interface ProjectGrade {
  grade: number;
  /** `score_is_grade` asked for, but the maximum is not 6: the linear scale was used. */
  fellBack: boolean;
}

/** points / max → Swiss grade 1.0 … 6.0 by the project's scale. */
export function projectGrade(points: number, max: number, scale: ProjectScale): ProjectGrade {
  const rounding = scale.rounding ?? "nearest";
  if (scale.kind === "score_is_grade") {
    if (max === SCORE_IS_GRADE_MAX) {
      return { grade: clamp(roundToTenth(points, rounding), MIN_GRADE, MAX_GRADE), fellBack: false };
    }
    return { grade: gradeFromPoints(points, max, { rounding }), fellBack: true };
  }
  return { grade: gradeFromPoints(points, max, { rounding }), fellBack: false };
}
